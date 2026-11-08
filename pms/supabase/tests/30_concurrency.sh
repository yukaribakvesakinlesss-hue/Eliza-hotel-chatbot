#!/usr/bin/env bash
# AXON PMS · Phase 2 concurrency tests.
# Fires truly parallel database sessions (one psql process each, like parallel API
# requests hitting the RPC) and checks that exactly one booking survives.
# Called by run.sh after the SQL tests; expects PG* env vars and TEST_DB.
set -uo pipefail

DB="${TEST_DB:-axon_pms_test}"
PROP='00000000-0000-4000-a000-000000000101'
FD='22222222-2222-4222-8222-222222222222'
OWNER='11111111-1111-4111-8111-111111111111'
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAIL=0

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1 ${2:-}"; FAIL=$((FAIL + 1)); }

q() { psql -X -qtA -d "$DB" -c "$1"; }

# one "API request": its own session, signed in as $1, runs the SQL in $2
request() {
  psql -X -qtA -v ON_ERROR_STOP=1 -d "$DB" \
    -c "set role authenticated" \
    -c "do \$\$ begin perform set_config('request.jwt.claim.sub', '$1', false); end \$\$" \
    -c "$2"
}

ROOM=$(q "select id from public.rooms where property_id = '$PROP' and number = '205'")
D=$(q "select ((now() at time zone 'Europe/Istanbul')::date + 500)::text")

book_sql() { # $1 check_in offset, $2 check_out offset, $3 guest name, $4 idempotency key or empty
  local key="null"; [ -n "${4:-}" ] && key="'$4'"
  echo "select id from public.create_reservation('$PROP', '$ROOM', '$D'::date + $1, '$D'::date + $2, 1, 0, '$3', null, null, null, 'website', 'CONFIRMED', $key)"
}

# --- 1. two simultaneous requests for the same room and dates ---------------------
request "$FD"    "$(book_sql 0 3 'Paralel A')" > "$TMP/a.out" 2> "$TMP/a.err" &
request "$OWNER" "$(book_sql 1 4 'Paralel B')" > "$TMP/b.out" 2> "$TMP/b.err" &
wait
ok=$(grep -lc . "$TMP"/a.out "$TMP"/b.out 2>/dev/null | wc -l)
conflicts=$(grep -l "RES_CONFLICT" "$TMP"/a.err "$TMP"/b.err 2>/dev/null | wc -l)
rows=$(q "select count(*) from public.reservations where room_id = '$ROOM' and status <> 'CANCELLED' and stay && daterange('$D'::date, '$D'::date + 4)")
[ "$ok" = 1 ] && [ "$conflicts" = 1 ] && [ "$rows" = 1 ] \
  && pass "2 parallel overlapping requests: 1 created, 1 RES_CONFLICT, 1 row in DB" \
  || fail "2 parallel overlapping requests" "(created=$ok conflicts=$conflicts rows=$rows; $(cat "$TMP"/*.err | head -c 300))"
grep -h "RES_CONFLICT" "$TMP"/a.err "$TMP"/b.err | head -1 | sed 's/^/      message: /'

# --- 2. a slow first transaction holds the room lock; the second waits, then fails cleanly
rm -f "$TMP"/*
request "$FD" "begin; $(book_sql 10 12 'Yavas A'); select pg_sleep(1.5); commit;" > "$TMP/a.out" 2> "$TMP/a.err" &
sleep 0.4
start=$(date +%s.%N)
request "$OWNER" "$(book_sql 11 13 'Bekleyen B')" > "$TMP/b.out" 2> "$TMP/b.err"
waited=$(echo "$(date +%s.%N) - $start" | bc)
wait
if grep -q "RES_CONFLICT" "$TMP/b.err" && [ "$(echo "$waited > 0.8" | bc)" = 1 ] && grep -q . "$TMP/a.out"; then
  pass "row lock: second request waited ${waited%???????}s for the first, then got RES_CONFLICT"
else
  fail "row lock" "(waited=$waited; $(cat "$TMP"/*.err | head -c 300))"
fi

# --- 3. ten simultaneous requests ---------------------------------------------------
rm -f "$TMP"/*
for i in $(seq 1 10); do
  request "$FD" "$(book_sql 20 25 "Burst $i")" > "$TMP/$i.out" 2> "$TMP/$i.err" &
done
wait
ok=$(cat "$TMP"/*.out | grep -c .)
conflicts=$(grep -l "RES_CONFLICT" "$TMP"/*.err 2>/dev/null | wc -l)
rows=$(q "select count(*) from public.reservations where room_id = '$ROOM' and stay && daterange('$D'::date + 20, '$D'::date + 25)")
[ "$ok" = 1 ] && [ "$conflicts" = 9 ] && [ "$rows" = 1 ] \
  && pass "10 parallel requests: 1 created, 9 RES_CONFLICT, 1 row in DB" \
  || fail "10 parallel requests" "(created=$ok conflicts=$conflicts rows=$rows; $(cat "$TMP"/*.err | sort -u | head -c 300))"

# --- 4. the same request sent 5 times at once with one idempotency key (double-click / retry)
rm -f "$TMP"/*
for i in $(seq 1 5); do
  request "$FD" "$(book_sql 30 32 'Cift Tik' 'concurrent-idem-key-1')" > "$TMP/$i.out" 2> "$TMP/$i.err" &
done
wait
ids=$(cat "$TMP"/*.out | sort -u | grep -c .)
errs=$(cat "$TMP"/*.err | grep -c . || true)
rows=$(q "select count(*) from public.reservations where room_id = '$ROOM' and stay && daterange('$D'::date + 30, '$D'::date + 32)")
[ "$ids" = 1 ] && [ "$errs" = 0 ] && [ "$rows" = 1 ] \
  && pass "5 parallel retries with one idempotency key: all 5 got the same reservation, 1 row in DB" \
  || fail "parallel idempotency" "(distinct ids=$ids errors=$errs rows=$rows; $(cat "$TMP"/*.err | head -c 300))"

# --- 5. parallel extension vs new booking for the freed/claimed night -------------
rm -f "$TMP"/*
RES=$(request "$FD" "$(book_sql 40 42 'Uzatma')")
request "$FD"    "select check_out from public.update_reservation('$RES', p_check_out => '$D'::date + 44)" > "$TMP/a.out" 2> "$TMP/a.err" &
request "$OWNER" "$(book_sql 43 45 'Rakip')" > "$TMP/b.out" 2> "$TMP/b.err" &
wait
won=$(cat "$TMP"/a.out "$TMP"/b.out | grep -c .)
rows=$(q "select count(*) from public.reservations where room_id = '$ROOM' and status <> 'CANCELLED' and stay && daterange('$D'::date + 43, '$D'::date + 44)")
[ "$won" = 1 ] && [ "$rows" = 1 ] \
  && pass "parallel extension vs new booking: exactly one wins, night $((43)) sold once" \
  || fail "parallel extension vs booking" "(winners=$won rows=$rows; $(cat "$TMP"/*.err | head -c 300))"

echo
if [ "$FAIL" -gt 0 ]; then echo "$FAIL concurrency test(s) failed"; exit 1; fi
echo "ALL 5 CONCURRENCY TESTS PASSED"
