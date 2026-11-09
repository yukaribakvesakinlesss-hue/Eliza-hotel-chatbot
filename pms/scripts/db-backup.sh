#!/usr/bin/env bash
# AXON PMS · logical backup of the application data.
# Usage: DATABASE_URL='postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres' bash scripts/db-backup.sh [out-dir]
# Writes <out-dir>/axon-<UTC timestamp>.dump (pg_dump custom format) and a .sha256 next to it.
# Covers the schemas the app owns (public, app_private) and the auth users the app references.
# Supabase's own schemas (storage, realtime, …) are restored by Supabase, not by this file.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL (never commit it)}"
OUT="${1:-./backups}"
mkdir -p "$OUT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT/axon-$STAMP.dump"
# Privileges ARE kept on purpose: the GRANT/REVOKE lists are part of the security model
# (a restore without them leaves every table open to the API roles).
pg_dump "$DATABASE_URL" --format=custom --no-owner \
  --schema=public --schema=app_private --file="$FILE"
# auth.users rows the app points to (ids, e-mails, metadata) – separate so a restore can choose
pg_dump "$DATABASE_URL" --format=custom --data-only --table=auth.users --file="$OUT/axon-$STAMP.auth-users.dump"
( cd "$OUT" && sha256sum "axon-$STAMP.dump" "axon-$STAMP.auth-users.dump" > "axon-$STAMP.sha256" )
echo "backup: $FILE ($(du -h "$FILE" | cut -f1))"
