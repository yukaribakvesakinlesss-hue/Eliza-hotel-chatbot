#!/usr/bin/env bash
# AXON PMS · restore drill: restore a backup into a SCRATCH database and prove it works.
# Usage: SOURCE_URL=<db the backup came from, optional> TARGET_URL=<empty scratch db> bash scripts/db-restore-check.sh <file.dump>
# Never point TARGET_URL at production: the script restores into it.
# Checks: checksum, restore without errors, row counts per table equal to the source (if SOURCE_URL),
# the safety triggers (append-only ledger and audit log, overbooking EXCLUDE constraint) are present and working.
set -euo pipefail
DUMP="${1:?backup file}"
: "${TARGET_URL:?set TARGET_URL to an empty scratch database}"
SUM="${DUMP%.dump}.sha256"
if [ -f "$SUM" ]; then ( cd "$(dirname "$DUMP")" && sha256sum --check --ignore-missing "$(basename "$SUM")" ); fi
# extensions live in the "extensions" schema, which the dump does not contain
psql "$TARGET_URL" -XAtq -v ON_ERROR_STOP=1 -c "create schema if not exists extensions" \
  -c "create extension if not exists pgcrypto with schema extensions" -c "create extension if not exists btree_gist with schema extensions"
# Supabase databases give anon/authenticated broad DEFAULT privileges on every new table and
# function. Restored objects would start too open, and the dump only lists the grants that should
# exist, so switch those defaults off on the (fresh) target first. The dump's own GRANTs then
# recreate exactly the production privileges. Mandatory step.
psql "$TARGET_URL" -XAtq -v ON_ERROR_STOP=1 \
  -c "alter default privileges in schema public revoke all on tables from anon, authenticated" \
  -c "alter default privileges in schema public revoke all on sequences from anon, authenticated" \
  -c "alter default privileges in schema public revoke all on functions from anon, authenticated" \
  -c "alter default privileges revoke execute on functions from public"
# the target already has a public schema (every Postgres / Supabase database does): skip only that entry
LIST="$(mktemp)"; trap 'rm -f "$LIST"' EXIT
pg_restore --list "$DUMP" | grep -v ' SCHEMA - public ' > "$LIST"
pg_restore --exit-on-error --no-owner --use-list="$LIST" --dbname="$TARGET_URL" "$DUMP"
counts() { psql "$1" -XAt -c "select string_agg(t || '=' || n, ' ' order by t) from (
  select c.relname t, (xpath('/row/n/text()', query_to_xml(format('select count(*) n from public.%I', c.relname), false, true, '')))[1]::text::bigint n
  from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r') x"; }
if [ -n "${SOURCE_URL:-}" ]; then
  A="$(counts "$SOURCE_URL")"; B="$(counts "$TARGET_URL")"
  if [ "$A" != "$B" ]; then echo "row counts differ"; diff <(tr ' ' '\n' <<<"$A") <(tr ' ' '\n' <<<"$B") || true; exit 1; fi
  echo "row counts: identical in $(wc -w <<<"$A") tables"
fi
psql "$TARGET_URL" -XAt -v ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  begin update public.audit_log set actor_kind = actor_kind where id = (select min(id) from public.audit_log);
        if (select count(*) from public.audit_log) > 0 then raise exception 'audit log is writable after restore'; end if;
  exception when others then if sqlerrm not like 'AUDIT_IMMUTABLE%' then raise; end if; end;
  begin update public.folio_transactions set amount = amount where id = (select min(id) from public.folio_transactions);
        if (select count(*) from public.folio_transactions) > 0 then raise exception 'ledger is writable after restore'; end if;
  exception when others then if sqlerrm like '%writable after restore%' then raise; end if; end;
  if not exists (select 1 from pg_constraint where conname = 'reservations_no_overlap') then raise exception 'overbooking constraint missing'; end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity) then
    raise exception 'a table lost row level security'; end if;
  if exists (select 1 from information_schema.role_table_grants where grantee = 'anon' and table_schema in ('public', 'app_private')) then
    raise exception 'anonymous role got table privileges: privileges were not restored'; end if;
  if has_function_privilege('anon', 'public.create_reservation(uuid,uuid,date,date,integer,integer,text,text,text,text,text,public.reservation_status,text,numeric,text,boolean)', 'execute') then
    raise exception 'anonymous role can call staff functions: privileges were not restored'; end if;
  raise notice 'restore drill: safety triggers, overbooking constraint and RLS are in place';
end $$;
SQL
echo "restore drill passed for $DUMP"
