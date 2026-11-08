#!/usr/bin/env bash
# AXON PMS · database test runner.
# Builds a throwaway database on a plain PostgreSQL (15+) server, loads a minimal
# Supabase shim (auth schema, roles, realtime publication), applies every migration
# twice (idempotency), loads the seed and runs the RLS / status-engine tests.
#
# Usage: PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres bash supabase/tests/run.sh
# Never point this at a real Supabase project: it drops and recreates TEST_DB.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DB="${TEST_DB:-axon_pms_test}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

echo "▸ recreating database $TEST_DB"
"${PSQL[@]}" -d postgres -c "drop database if exists $TEST_DB with (force)" -c "create database $TEST_DB"

run() { PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d "$TEST_DB" -f "$1" > /dev/null; }

echo "▸ supabase shim";      run "$DIR/tests/00_supabase_shim.sql"
for pass in 1 2; do
  for f in "$DIR"/migrations/*.sql; do
    echo "▸ migration (pass $pass) $(basename "$f")"; run "$f"
  done
done
echo "▸ seed (x2)";          run "$DIR/seed.sql"; run "$DIR/seed.sql"
echo "▸ tests"
"${PSQL[@]}" -d "$TEST_DB" -f "$DIR/tests/10_rls_and_status_engine.sql"
echo "▸ reservation tests"
"${PSQL[@]}" -d "$TEST_DB" -f "$DIR/tests/20_reservations.sql"
echo "▸ concurrency tests"
TEST_DB="$TEST_DB" bash "$DIR/tests/30_concurrency.sh"
