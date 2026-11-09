-- =====================================================================
-- AXON PMS · Phase 6 security scan
-- Structural checks over the WHOLE schema (every table and function, so a
-- new object without RLS, with a stray grant or without an authorization
-- check fails here) plus generic tenant / role isolation probes that loop
-- over every table. Runs last, after 10–80 have filled the database.
-- =====================================================================
\set QUIET on
create temp table _results (n serial, name text, ok boolean, detail text);
grant all on _results to public;
grant all on sequence _results_n_seq to public;
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into _results (name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail);
$$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlerrm; end $$;
-- run a statement and report how many rows it touched, ALWAYS rolled back (-1 = refused)
create or replace function pg_temp.touched(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
    raise exception 'ROLLBACK:%', n;
  exception when others then
    if sqlerrm like 'ROLLBACK:%' then return substr(sqlerrm, 10)::int; end if;
    return -1;
  end;
end $$;
grant execute on function pg_temp.touched(text) to public;
grant execute on function pg_temp.try(text) to public;
grant execute on function pg_temp.check(text, boolean, text) to public;
\o /dev/null

\set ORG '00000000-0000-4000-a000-000000000001'
\set OWNER '11111111-1111-4111-8111-111111111111'
\set FD '22222222-2222-4222-8222-222222222222'
\set HK '33333333-3333-4333-8333-333333333333'
\set OTHER '44444444-4444-4444-8444-444444444444'

-- ---------- structure ----------
select pg_temp.check('rls: enabled on every table in the API schema',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  (select string_agg(relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity));
select pg_temp.check('grants: anonymous role has no table or column privilege at all',
  not exists (select 1 from information_schema.role_table_grants where grantee = 'anon' and table_schema in ('public', 'app_private'))
  and not exists (select 1 from information_schema.role_column_grants where grantee = 'anon' and table_schema in ('public', 'app_private')));
select pg_temp.check('grants: private schema tables (secrets, sessions) are closed to API roles',
  not exists (select 1 from information_schema.role_table_grants where grantee in ('anon', 'authenticated', 'PUBLIC') and table_schema = 'app_private'));
select string_agg(table_name || ':' || privs, ' ' order by table_name) as write_grants from (
  select table_name, string_agg(privilege_type, ',' order by privilege_type) privs from information_schema.role_table_grants
   where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE') group by table_name) x \gset
select pg_temp.check('grants: signed-in users may write directly only to these configuration tables (all other writes go through checked RPCs)',
  :'write_grants' = 'distribution_channels:INSERT,UPDATE memberships:DELETE,INSERT,UPDATE organizations:UPDATE properties:DELETE,INSERT,UPDATE property_faq:DELETE,INSERT,UPDATE rate_calendar:DELETE,INSERT,UPDATE room_types:DELETE,INSERT,UPDATE rooms:DELETE,INSERT,UPDATE',
  :'write_grants');
select pg_temp.check('grants: every directly writable table has row policies for writes',
  not exists (select 1 from information_schema.role_table_grants g where g.grantee = 'authenticated' and g.table_schema = 'public'
                and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
                and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = g.table_name and p.cmd in (g.privilege_type, 'ALL'))));
select string_agg(p.oid::regprocedure::text, ' ' order by p.oid::regprocedure::text) as anon_fns
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') \gset
select pg_temp.check('functions: exactly the public entry points are callable without login (web chat, webhooks, worker, health)',
  :'anon_fns' = 'health_check() inbox_assistant_turn(uuid,text,text,jsonb,text) inbox_due_deliveries(text,text,text,text) inbox_ingest(text,text,text,text,text,text,text,text) inbox_public_property(text,text) inbox_set_delivery(bigint,text,text) ota_claim_outbox(uuid,text,integer) ota_ingest_event(text,text,text,text,jsonb) ota_mark_pulled(uuid,text,text,text) ota_outbox_result(uuid,text,jsonb) ota_retry_due(uuid,text) ota_worker_context(text,text,text) webchat_messages(uuid,text,bigint) webchat_send(uuid,text,text,text) webchat_start(text,text,text)',
  :'anon_fns');
select pg_temp.check('functions: internal helpers callable by signed-in users are only the yes/no role checks used in row policies',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'app_private' and p.prorettype <> 'trigger'::regtype and has_function_privilege('authenticated', p.oid, 'execute')
                and p.proname not in ('org_role', 'is_org_member', 'property_role', 'has_property_access', 'is_org_admin', 'can_see_guests', 'my_property_ids', 'my_staff_property_ids', 'my_admin_org_ids')),
  (select string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prorettype <> 'trigger'::regtype and has_function_privilege('authenticated', p.oid, 'execute')
      and p.proname not in ('org_role', 'is_org_member', 'property_role', 'has_property_access', 'is_org_admin', 'can_see_guests', 'my_property_ids', 'my_staff_property_ids', 'my_admin_org_ids')));
select pg_temp.check('functions: every SECURITY DEFINER function pins search_path (no search_path hijacking)',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public', 'app_private') and p.prosecdef and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')));
select pg_temp.check('functions: no dynamic SQL inside any function (no injection surface)',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public', 'app_private') and p.prolang = (select oid from pg_language where lanname = 'plpgsql') and p.prosrc ~* '\mexecute\M'),
  (select string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private') and p.prolang = (select oid from pg_language where lanname = 'plpgsql') and p.prosrc ~* '\mexecute\M'));
-- every SECURITY DEFINER RPC must contain an authorization check; the few public-by-design ones are listed explicitly
select string_agg(p.proname, ' ' order by p.proname) as unchecked from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
   and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
   and p.prosrc !~ 'auth\.uid|require_|property_role|org_role|is_org_admin|is_org_member|ota_can_operate|inbox_authorized|lock_conversation|hk_lock_task|lock_folio_for|webchat_sessions|channel_secrets|ota_worker_secrets|can_see_guests|has_property_access' \gset
select pg_temp.check('functions: every RPC checks who is calling, except the deliberately public read-only ones',
  coalesce(:'unchecked', '') = 'health_check inbox_public_property', :'unchecked');
select pg_temp.check('secrets: only SHA-256 hashes are stored for tokens and channel secrets',
  not exists (select 1 from app_private.channel_secrets where ingest_secret_hash !~ '^[0-9a-f]{64}$')
  and not exists (select 1 from app_private.ota_worker_secrets where secret_hash !~ '^[0-9a-f]{64}$')
  and not exists (select 1 from app_private.webchat_sessions where token_hash !~ '^[0-9a-f]{64}$')
  and (select count(*) from app_private.webchat_sessions) > 0);
select pg_temp.check('service account: exists once and has no password',
  (select count(*) from public.users where id = '00000000-0000-4000-a000-0000000000c1') = 1
  and (select coalesce(to_jsonb(u)->>'encrypted_password', '') = '' from auth.users u where u.id = '00000000-0000-4000-a000-0000000000c1'));

-- ---------- generic isolation probes over every table ----------
create temp table _tables as
  select c.relname::text as t,
         exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'organization_id') as has_org
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r';
grant select on _tables to public;

-- the owner of tenant A sees data in most tables, so the "0 rows for tenant B" results below are not vacuous
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
create temp table _owner_counts as select t, 0::bigint as n from _tables where has_org;
do $$ declare r record; v bigint; begin
  for r in select t from _owner_counts loop
    execute format('select count(*) from public.%I where organization_id = %L', r.t, '00000000-0000-4000-a000-000000000001') into v;
    update _owner_counts set n = v where t = r.t;
  end loop;
end $$;
reset role;
select pg_temp.check('isolation probe is meaningful: tenant A owner sees own rows in at least 25 tenant tables',
  (select count(*) from _owner_counts where n > 0) >= 25, (select count(*) || ' of ' || (select count(*) from _owner_counts) from _owner_counts where n > 0));

set role authenticated;
select set_config('request.jwt.claim.sub', :'OTHER', false);
create temp table _leaks (t text, n bigint);
do $$ declare r record; v bigint; begin
  for r in select t from _tables where has_org loop
    begin
      execute format('select count(*) from public.%I where organization_id = %L', r.t, '00000000-0000-4000-a000-000000000001') into v;
    exception when insufficient_privilege then v := 0; end;
    if v > 0 then insert into _leaks values (r.t, v); end if;
  end loop;
end $$;
reset role;
select pg_temp.check('tenant isolation: owner of another hotel group reads 0 rows of tenant A in EVERY table',
  not exists (select 1 from _leaks), (select string_agg(t || '=' || n, ', ') from _leaks));
select pg_temp.check('tenant isolation: tenant A users and organization are invisible to tenant B',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false);
    do $d$ begin if (select count(*) from public.organizations where id = %L) + (select count(*) from public.users where id = %L) <> 0 then raise exception 'leak'; end if; end $d$$q$,
    :'OTHER', :'ORG', :'OWNER')) is null);
reset role;

-- writes: every directly writable table, update and delete aimed at tenant A, always rolled back
set role authenticated;
select set_config('request.jwt.claim.sub', :'OTHER', false);
create temp table _write_leaks (t text, op text, n int);
grant all on _write_leaks to public;
do $$ declare r record; v int; begin
  for r in select distinct table_name t from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('UPDATE', 'DELETE') loop
    if r.t = 'organizations' then
      v := pg_temp.touched(format('update public.organizations set name = name where id = %L', '00000000-0000-4000-a000-000000000001'));
      if v > 0 then insert into _write_leaks values (r.t, 'update', v); end if;
      continue;
    end if;
    v := pg_temp.touched(format('update public.%I set organization_id = organization_id where organization_id = %L', r.t, '00000000-0000-4000-a000-000000000001'));
    if v > 0 then insert into _write_leaks values (r.t, 'update', v); end if;
    v := pg_temp.touched(format('delete from public.%I where organization_id = %L', r.t, '00000000-0000-4000-a000-000000000001'));
    if v > 0 then insert into _write_leaks values (r.t, 'delete', v); end if;
  end loop;
end $$;
reset role;
select pg_temp.check('tenant isolation: another hotel group can update or delete 0 rows of tenant A in every writable table',
  not exists (select 1 from _write_leaks), (select string_agg(t || ':' || op || '=' || n, ', ') from _write_leaks));

-- roles inside the hotel: front desk and housekeeping cannot change configuration tables
create temp table _role_writes (who text, t text, op text, n int);
grant all on _role_writes to public;
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
do $$ declare t text; v int; begin
  foreach t in array array['distribution_channels', 'memberships', 'properties', 'property_faq', 'rate_calendar', 'room_types'] loop
    v := pg_temp.touched(format('update public.%I set organization_id = organization_id', t));
    if v > 0 then insert into _role_writes values ('front_desk', t, 'update', v); end if;
    v := pg_temp.touched(format('delete from public.%I', t));
    if v > 0 then insert into _role_writes values ('front_desk', t, 'delete', v); end if;
  end loop;
  v := pg_temp.touched('delete from public.rooms');
  if v > 0 then insert into _role_writes values ('front_desk', 'rooms', 'delete', v); end if;
  v := pg_temp.touched('update public.organizations set name = name');
  if v > 0 then insert into _role_writes values ('front_desk', 'organizations', 'update', v); end if;
end $$;
select set_config('request.jwt.claim.sub', :'HK', false);
do $$ declare t text; v int; begin
  foreach t in array array['distribution_channels', 'memberships', 'properties', 'property_faq', 'rate_calendar', 'room_types', 'rooms'] loop
    v := pg_temp.touched(format('delete from public.%I', t));
    if v > 0 then insert into _role_writes values ('housekeeping', t, 'delete', v); end if;
  end loop;
  v := pg_temp.touched('update public.rate_calendar set rate = 0');
  if v > 0 then insert into _role_writes values ('housekeeping', 'rate_calendar', 'update', v); end if;
end $$;
reset role;
select pg_temp.check('roles: front desk and housekeeping change 0 rows of configuration, rates, rooms and memberships',
  not exists (select 1 from _role_writes), (select string_agg(who || ' ' || t || ':' || op || '=' || n, ', ') from _role_writes));

-- housekeeping reads no guest, message, finance-ledger or audit data
set role authenticated;
select set_config('request.jwt.claim.sub', :'HK', false);
create temp table _hk_reads (t text, n bigint);
do $$ declare t text; v bigint; begin
  foreach t in array array['guests', 'guest_notes', 'guest_access_log', 'reservation_guests', 'conversations', 'messages', 'booking_requests',
                           'channel_connections', 'ota_inbound_events', 'ota_outbox', 'ota_connections', 'audit_log', 'folio_transactions', 'folios'] loop
    begin execute format('select count(*) from public.%I', t) into v; exception when insufficient_privilege then v := 0; end;
    if v > 0 then insert into _hk_reads values (t, v); end if;
  end loop;
end $$;
reset role;
select pg_temp.check('roles: housekeeping staff read 0 rows of guest data, messages, channel data, folios and the audit log',
  not exists (select 1 from _hk_reads), (select string_agg(t || '=' || n, ', ') from _hk_reads));

-- anonymous API calls with guessed ids / tokens get nothing
set role anon;
select set_config('request.jwt.claim.sub', '', false);
create temp table _anon (name text, err text);
insert into _anon values
  ('webchat_send', pg_temp.try($q$select public.webchat_send(gen_random_uuid(), repeat('a', 48), 'hi', 'abcdefgh')$q$)),
  ('webchat_messages', pg_temp.try($q$select public.webchat_messages((select gen_random_uuid()), repeat('b', 48), 0)$q$)),
  ('inbox_assistant_turn', pg_temp.try($q$select public.inbox_assistant_turn(gen_random_uuid(), 'x', 'GREETING', '{}', 'tr')$q$)),
  ('inbox_set_delivery', pg_temp.try($q$select public.inbox_set_delivery(1, 'SENT', 'guess')$q$)),
  ('inbox_ingest', pg_temp.try($q$select public.inbox_ingest('axon-demo', 'AUR', 'WHATSAPP', 'guess', 'm1', '1', 'x', 'hi')$q$)),
  ('inbox_due_deliveries', pg_temp.try($q$select public.inbox_due_deliveries('axon-demo', 'AUR', 'WHATSAPP', 'guess')$q$)),
  ('ota_worker_context', pg_temp.try($q$select public.ota_worker_context('axon-demo', 'AUR', 'guess')$q$)),
  ('ota_claim_outbox', pg_temp.try($q$select public.ota_claim_outbox('00000000-0000-4000-a000-000000000101', 'guess')$q$)),
  ('ota_outbox_result', pg_temp.try($q$select public.ota_outbox_result('00000000-0000-4000-a000-000000000101', 'guess', '[]')$q$)),
  ('ota_retry_due', pg_temp.try($q$select public.ota_retry_due('00000000-0000-4000-a000-000000000101', 'guess')$q$)),
  ('ota_mark_pulled', pg_temp.try($q$select public.ota_mark_pulled('00000000-0000-4000-a000-000000000101', 'guess', 'BOOKING')$q$)),
  ('ota_ingest_event', pg_temp.try($q$select public.ota_ingest_event('axon-demo', 'AUR', 'BOOKING', 'guess', '{}')$q$)),
  ('create_reservation', pg_temp.try($q$select public.create_reservation('00000000-0000-4000-a000-000000000101', gen_random_uuid(), current_date, current_date + 1, 1)$q$)),
  ('guest_profile', pg_temp.try($q$select public.guest_profile(gen_random_uuid())$q$)),
  ('audit_feed', pg_temp.try($q$select public.audit_feed('00000000-0000-4000-a000-000000000001')$q$)),
  ('select reservations', pg_temp.try($q$select count(*) from public.reservations$q$)),
  ('select guests', pg_temp.try($q$select count(*) from public.guests$q$));
reset role;
select pg_temp.check('anon: every entry point refuses guessed tokens / secrets, staff RPCs and tables are closed',
  not exists (select 1 from _anon where err is null or err !~ '^(FORBIDDEN|INBOX_NOT_FOUND|AUTH_REQUIRED)|permission denied'),
  (select string_agg(name || ' → ' || coalesce(left(err, 40), 'ALLOWED'), '; ') from _anon where err is null or err !~ '^(FORBIDDEN|INBOX_NOT_FOUND|AUTH_REQUIRED)|permission denied'));
select pg_temp.check('injection: quotes and SQL in text inputs are treated as data',
  pg_temp.try($q$set role anon; do $d$ begin if public.inbox_public_property('axon-demo'' or ''1''=''1', 'AUR') is not null then raise exception 'matched'; end if; end $d$$q$) is null
  and pg_temp.try($q$set role anon; select public.webchat_start('x''; drop table public.rooms; --', 'AUR')$q$) like 'INBOX_NOT_FOUND:%'
  and (select count(*) from public.rooms) > 0);
reset role;

\o
\set QUIET off
select n, case when ok then 'PASS' else 'FAIL' end as result, name, left(detail, 160) as detail from _results order by n;
do $$ declare f int; begin
  select count(*) into f from _results where not ok;
  if f > 0 then raise exception '% test(s) failed', f; end if;
  raise notice 'ALL % SECURITY SCAN CHECKS PASSED', (select count(*) from _results);
end $$;
