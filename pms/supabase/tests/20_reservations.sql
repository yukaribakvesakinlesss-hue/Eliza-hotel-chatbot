-- =====================================================================
-- AXON PMS · Phase 2 database tests (reservation engine & overbooking)
-- Runs after 10_rls_and_status_engine.sql in the same database (reuses its users).
-- Every check prints PASS/FAIL; the script fails at the end if any FAIL.
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
\o /dev/null

\set PROP '00000000-0000-4000-a000-000000000101'
\set OWNER '11111111-1111-4111-8111-111111111111'
\set FD '22222222-2222-4222-8222-222222222222'
\set HK '33333333-3333-4333-8333-333333333333'
\set OTHER '44444444-4444-4444-8444-444444444444'

-- fixed rooms of the demo hotel (seed): 101 Classic Double (max 2), 106 Junior Suite (max 3), 304 out of order
select id as r101 from public.rooms where property_id = :'PROP' and number = '101' \gset
select id as r102 from public.rooms where property_id = :'PROP' and number = '102' \gset
select id as r106 from public.rooms where property_id = :'PROP' and number = '106' \gset
select id as r304 from public.rooms where property_id = :'PROP' and number = '304' \gset
-- a room that is vacant, clean and operational right now (for the check-in flow)
select id as rready from public.rooms where property_id = :'PROP' and occupancy_status = 'VACANT'
  and housekeeping_status = 'CLEAN' and maintenance_status = 'OPERATIONAL' and number not in ('101', '102', '106') order by number limit 1 \gset
select (now() at time zone 'Europe/Istanbul')::date + 30 as d0, (now() at time zone 'Europe/Istanbul')::date as today \gset

select pg_temp.check('schema: btree_gist extension installed', exists (select 1 from pg_extension where extname = 'btree_gist'));
select pg_temp.check('schema: exclusion constraint reservations_no_overlap exists',
  exists (select 1 from pg_constraint where conname = 'reservations_no_overlap' and contype = 'x'));
select pg_temp.check('schema: stay is daterange [) generated from check_in/check_out',
  (select pg_get_expr(adbin, adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = 'public.reservations'::regclass and a.attname = 'stay') like '%daterange(check_in, check_out, ''[)''%');

-- ---------- front desk ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);

-- helper to create a booking in one line
create or replace function pg_temp.book(p_room uuid, p_in date, p_out date, p_name text default 'Test Guest', p_key text default null, p_adults int default 2)
returns public.reservations language sql as $$
  select * from public.create_reservation('00000000-0000-4000-a000-000000000101', p_room, p_in, p_out, p_adults, 0, p_name,
    'guest@example.com', '+90 555 000 00 00', null, 'phone', 'CONFIRMED', p_key)
$$;

-- 1. Two overlapping bookings of the same room
select id as res1 from pg_temp.book(:'r101', :'d0'::date, :'d0'::date + 3, 'Ayşe Yılmaz') \gset
select pg_temp.check('create: first booking 101 [d0, d0+3) succeeds', :'res1' is not null);
select pg_temp.try(format('select pg_temp.book(%L, %L::date + 1, %L::date + 2)', :'r101', :'d0', :'d0')) as err \gset
select pg_temp.check('overlap: second booking inside the first is rejected with RES_CONFLICT', :'err' like 'RES_CONFLICT:%', :'err');
select pg_temp.check('overlap: error message is clear Turkish and names the room and booking',
  :'err' like '%Oda 101 seçilen tarihlerde dolu%çakışıyor%', :'err');
select pg_temp.check('overlap: partial overlap at the start is rejected',
  pg_temp.try(format('select pg_temp.book(%L, %L::date - 2, %L::date + 1)', :'r101', :'d0', :'d0')) like 'RES_CONFLICT:%');
select pg_temp.check('overlap: a booking covering the whole stay is rejected',
  pg_temp.try(format('select pg_temp.book(%L, %L::date - 1, %L::date + 9)', :'r101', :'d0', :'d0')) like 'RES_CONFLICT:%');
select pg_temp.check('overlap: same dates in a different room are fine',
  pg_temp.try(format('select pg_temp.book(%L, %L::date, %L::date + 3)', :'r102', :'d0', :'d0')) is null);
select pg_temp.check('overlap: only one active booking exists for 101 in that range',
  (select count(*) from public.reservations where room_id = :'r101' and status <> 'CANCELLED' and stay && daterange(:'d0'::date, :'d0'::date + 3)) = 1);

-- 2. Same-day check-out and check-in
select pg_temp.check('turnover: check-in on the check-out day of the previous guest is allowed',
  pg_temp.try(format('select pg_temp.book(%L, %L::date + 3, %L::date + 5, %L)', :'r101', :'d0', :'d0', 'Next Guest')) is null);
select pg_temp.check('turnover: check-out on the check-in day of the next guest is allowed',
  pg_temp.try(format('select pg_temp.book(%L, %L::date - 2, %L::date, %L)', :'r101', :'d0', :'d0', 'Prev Guest')) is null);

-- 3. Cancellation releases the room
select status as st from public.cancel_reservation(:'res1', 'Misafir vazgeçti') \gset
select pg_temp.check('cancel: status becomes CANCELLED', :'st' = 'CANCELLED');
select pg_temp.check('cancel: cancelling twice is harmless',
  (select status from public.cancel_reservation(:'res1')) = 'CANCELLED');
select pg_temp.check('cancel: cancelled dates can be booked again',
  pg_temp.try(format('select pg_temp.book(%L, %L::date, %L::date + 3, %L)', :'r101', :'d0', :'d0', 'Rebook Guest')) is null);
select pg_temp.check('cancel: cancelled booking keeps reason and timestamp',
  (select cancel_reason = 'Misafir vazgeçti' and cancelled_at is not null from public.reservations where id = :'res1'));

-- 4. Extension (date change re-checks availability)
select id as res_ext, version as v_ext from pg_temp.book(:'r106', :'d0'::date + 10, :'d0'::date + 12, 'Uzatan Misafir') \gset
select id as res_block from pg_temp.book(:'r106', :'d0'::date + 15, :'d0'::date + 17, 'Sonraki Misafir') \gset
select pg_temp.check('extend: extending into free nights works',
  (select check_out from public.update_reservation(:'res_ext', p_check_out => :'d0'::date + 15)) = :'d0'::date + 15);
select pg_temp.try(format('select public.update_reservation(%L, p_check_out => %L::date + 16)', :'res_ext', :'d0')) as err \gset
select pg_temp.check('extend: extending over the next booking is rejected with RES_CONFLICT', :'err' like 'RES_CONFLICT:%yeni tarihlerde%' or :'err' like 'RES_CONFLICT:%', :'err');
select pg_temp.check('extend: a rejected extension leaves the booking unchanged',
  (select check_out from public.reservations where id = :'res_ext') = :'d0'::date + 15);
select pg_temp.check('extend: version increases on every change',
  (select version from public.reservations where id = :'res_ext') = :'v_ext'::int + 1);
select pg_temp.check('update: stale version is rejected with RES_STALE',
  pg_temp.try(format('select public.update_reservation(%L, p_check_out => %L::date + 14, p_expected_version => %s)', :'res_ext', :'d0', :'v_ext')) like 'RES_STALE:%');
select pg_temp.check('update: moving to a free room works',
  (select room_id from public.update_reservation(:'res_block', p_room_id => :'r102')) = :'r102'::uuid);
select pg_temp.check('update: shrinking dates then booking the freed night works',
  pg_temp.try(format('select public.update_reservation(%L, p_check_out => %L::date + 14)', :'res_ext', :'d0')) is null
  and pg_temp.try(format('select pg_temp.book(%L, %L::date + 14, %L::date + 15, %L, null, 3)', :'r106', :'d0', :'d0', 'Gap Guest')) is null);

-- 5. Idempotency
select id as idem1 from pg_temp.book(:'r102', :'d0'::date + 40, :'d0'::date + 42, 'Idem Guest', 'idem-key-0001') \gset
select id as idem2 from pg_temp.book(:'r102', :'d0'::date + 40, :'d0'::date + 42, 'Idem Guest', 'idem-key-0001') \gset
select pg_temp.check('idempotency: the same key returns the same reservation', :'idem1' = :'idem2');
select pg_temp.check('idempotency: no duplicate row was created',
  (select count(*) from public.reservations r join public.reservation_guests g on g.reservation_id = r.id where g.full_name = 'Idem Guest') = 1);
select pg_temp.check('idempotency: reusing a key for a different request is rejected',
  pg_temp.try(format('select pg_temp.book(%L, %L::date + 50, %L::date + 52, %L, %L)', :'r102', :'d0', :'d0', 'Idem Guest', 'idem-key-0001')) like 'IDEMPOTENCY_MISMATCH:%');
select pg_temp.check('idempotency: table is not readable by clients', pg_temp.try('select count(*) from public.reservation_idempotency') is not null);

-- 6. Validation
select pg_temp.check('validation: check-out before check-in is rejected',
  pg_temp.try(format('select pg_temp.book(%L, %L::date + 70, %L::date + 70)', :'r101', :'d0', :'d0')) like 'RES_INVALID_DATES:%');
select pg_temp.check('validation: past check-in is rejected',
  pg_temp.try(format('select pg_temp.book(%L, %L::date - 1, %L::date + 1)', :'r101', :'today', :'today')) like 'RES_PAST_DATE:%');
select pg_temp.check('validation: more guests than the room holds is rejected',
  pg_temp.try(format('select pg_temp.book(%L, %L::date + 80, %L::date + 81, %L, null, 3)', :'r101', :'d0', :'d0', 'Big Group')) like 'RES_CAPACITY:%');
select pg_temp.check('validation: guest name is required',
  pg_temp.try(format('select pg_temp.book(%L, %L::date + 80, %L::date + 81, %L)', :'r101', :'d0', :'d0', ' ')) like 'RES_GUEST_REQUIRED:%');
select pg_temp.check('validation: out-of-order room cannot be booked from today',
  pg_temp.try(format('select pg_temp.book(%L, %L::date, %L::date + 1)', :'r304', :'today', :'today')) like 'RES_ROOM_OUT_OF_ORDER:%');
select pg_temp.check('validation: out-of-order room can be booked for a future date',
  pg_temp.try(format('select pg_temp.book(%L, %L::date + 60, %L::date + 61)', :'r304', :'d0', :'d0')) is null);
select pg_temp.check('validation: a room of another property is rejected',
  pg_temp.try(format($q$select public.create_reservation('00000000-0000-4000-a000-000000000102', %L, %L::date, %L::date + 1, 1, 0, 'X Guest')$q$, :'r101', :'d0', :'d0')) is not null);

-- 7. Status workflow + Phase 1 room engine
select id as res_today from pg_temp.book(:'rready', :'today'::date, :'today'::date + 2, 'Walk In') \gset
select pg_temp.check('check-in: reservation becomes CHECKED_IN',
  (select status from public.set_reservation_status(:'res_today', 'CHECKED_IN')) = 'CHECKED_IN');
select pg_temp.check('check-in: room becomes OCCUPIED', (select occupancy_status from public.rooms where id = :'rready') = 'OCCUPIED');
select pg_temp.check('check-in: cancelling an in-house guest is rejected',
  pg_temp.try(format('select public.cancel_reservation(%L)', :'res_today')) like 'RES_BAD_STATE:%');
select pg_temp.check('check-in: extending an in-house stay works',
  (select check_out from public.update_reservation(:'res_today', p_check_out => :'today'::date + 4)) = :'today'::date + 4);
select pg_temp.check('check-out: reservation becomes CHECKED_OUT',
  (select status from public.set_reservation_status(:'res_today', 'CHECKED_OUT')) = 'CHECKED_OUT');
select pg_temp.check('check-out: early departure releases the unused nights',
  (select check_out from public.reservations where id = :'res_today') = :'today'::date + 1);
select pg_temp.check('check-out: room becomes VACANT + DIRTY (room engine)',
  (select occupancy_status = 'VACANT' and housekeeping_status = 'DIRTY' from public.rooms where id = :'rready'));
select pg_temp.check('check-in: a future booking cannot check in yet',
  pg_temp.try(format('select public.set_reservation_status(%L, %L)', :'res_block', 'CHECKED_IN')) like 'RES_TOO_EARLY:%');
select pg_temp.check('workflow: invalid transition is rejected',
  pg_temp.try(format('select public.set_reservation_status(%L, %L)', :'res1', 'CHECKED_IN')) like 'RES_BAD_TRANSITION:%');
-- no-show releases the room
select id as res_ns from pg_temp.book(:'r106', :'today'::date, :'today'::date + 1, 'No Show Guest', null, 1) \gset
select pg_temp.check('no-show: today''s booking can be marked NO_SHOW',
  (select status from public.set_reservation_status(:'res_ns', 'NO_SHOW')) = 'NO_SHOW');
select pg_temp.check('no-show: the room can be sold again for those dates',
  pg_temp.try(format('select pg_temp.book(%L, %L::date, %L::date + 1, %L, null, 1)', :'r106', :'today', :'today', 'Late Guest')) is null);
reset role;

-- ---------- the constraint itself (no function involved) ----------
select pg_temp.check('constraint: a direct overlapping INSERT is refused by the database (exclusion_violation)',
  pg_temp.try(format($q$insert into public.reservations (organization_id, property_id, room_id, check_in, check_out)
    values ('00000000-0000-4000-a000-000000000001', %L, %L, %L::date + 1, %L::date + 2)$q$, :'PROP', :'r101', :'d0', :'d0'))
  like '%reservations_no_overlap%');
select pg_temp.check('constraint: a direct overlapping INSERT with status CANCELLED is accepted',
  pg_temp.try(format($q$insert into public.reservations (organization_id, property_id, room_id, status, check_in, check_out)
    values ('00000000-0000-4000-a000-000000000001', %L, %L, 'CANCELLED', %L::date + 1, %L::date + 2)$q$, :'PROP', :'r101', :'d0', :'d0')) is null);
select pg_temp.check('constraint: re-activating that CANCELLED row is refused',
  pg_temp.try(format($q$update public.reservations set status = 'CONFIRMED' where room_id = %L and status = 'CANCELLED' and check_in = %L::date + 1$q$, :'r101', :'d0'))
  like '%reservations_no_overlap%');

-- ---------- roles and tenants ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select pg_temp.check('front desk: cannot INSERT reservations directly (functions only)',
  pg_temp.try(format($q$insert into public.reservations (organization_id, property_id, room_id, check_in, check_out)
    values ('00000000-0000-4000-a000-000000000001', %L, %L, %L::date + 100, %L::date + 101)$q$, :'PROP', :'r101', :'d0', :'d0')) is not null);
select pg_temp.check('front desk: cannot UPDATE reservations directly',
  pg_temp.try(format($q$update public.reservations set check_out = check_out + 1 where id = %L$q$, :'res_ext')) is not null);
select pg_temp.check('front desk: sees guest contact data', (select count(*) from public.reservation_guests) > 0);
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', :'HK', false);
select pg_temp.check('housekeeping: can read reservations (arrivals/departures)', (select count(*) from public.reservations) > 0);
select pg_temp.check('housekeeping: cannot read guest contact data', (select count(*) from public.reservation_guests) = 0);
select pg_temp.check('housekeeping: cannot create reservations',
  pg_temp.try(format('select pg_temp.book(%L, %L::date + 200, %L::date + 201)', :'r101', :'d0', :'d0')) like 'FORBIDDEN:%');
select pg_temp.check('housekeeping: cannot cancel reservations',
  pg_temp.try(format('select public.cancel_reservation(%L)', :'res_block')) like 'FORBIDDEN:%');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', :'OTHER', false);
select pg_temp.check('tenant B: sees 0 reservations of tenant A', (select count(*) from public.reservations) = 0);
select pg_temp.check('tenant B: cannot cancel a tenant A reservation',
  pg_temp.try(format('select public.cancel_reservation(%L)', :'res_block')) like 'RES_NOT_FOUND:%');
select pg_temp.check('tenant B: cannot book a tenant A room',
  pg_temp.try(format('select pg_temp.book(%L, %L::date + 300, %L::date + 301)', :'r101', :'d0', :'d0')) like 'FORBIDDEN:%');
reset role;

set role anon;
select pg_temp.check('anon: cannot call create_reservation',
  pg_temp.try(format($q$select public.create_reservation(%L, %L, current_date + 1, current_date + 2, 1)$q$, :'PROP', :'r101')) is not null);
select pg_temp.check('anon: cannot read reservations', pg_temp.try('select count(*) from public.reservations') is not null);
reset role;

select pg_temp.check('realtime: reservations are published',
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'reservations'));

\o
\set QUIET off
select n, case when ok then 'PASS' else 'FAIL' end as result, name, detail from _results order by n;
do $$ declare f int; begin
  select count(*) into f from _results where not ok;
  if f > 0 then raise exception '% test(s) failed', f; end if;
  raise notice 'ALL % RESERVATION TESTS PASSED', (select count(*) from _results);
end $$;
