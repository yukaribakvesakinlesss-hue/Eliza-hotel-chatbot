-- =====================================================================
-- AXON PMS · Phase 6 performance check (local PostgreSQL, not Supabase)
-- Builds a larger hotel (60 rooms, ~3 years of history ≈ 20 000 bookings)
-- and times the hot paths. Limits are generous on purpose: this catches
-- missing indexes and accidental full scans, not micro-regressions.
-- =====================================================================
\set QUIET on
create temp table _results (n serial, name text, ok boolean, detail text);
grant all on _results to public;
grant all on sequence _results_n_seq to public;
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into _results (name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail);
$$;
\o /dev/null

\set ORG '00000000-0000-4000-a000-000000000001'
\set OWNER '11111111-1111-4111-8111-111111111111'
\set PERF '00000000-0000-4000-a000-0000000009f1'

insert into public.properties (id, organization_id, name, code, timezone, currency)
values (:'PERF', :'ORG', 'Perf Test Hotel', 'PERF', 'Europe/Istanbul', 'EUR') on conflict (id) do nothing;
insert into public.room_types (organization_id, property_id, code, name, base_occupancy, max_occupancy, base_rate)
select :'ORG', :'PERF', c, c || ' room', 2, 3, 100 + i * 20 from unnest(array['STD', 'DLX', 'STE']) with ordinality as x(c, i)
on conflict (property_id, code) do nothing;
insert into public.rooms (organization_id, property_id, room_type_id, number, floor)
select :'ORG', :'PERF', (select id from public.room_types where property_id = :'PERF' order by code offset (n % 3) limit 1), 'P' || n, n / 20
from generate_series(1, 60) n on conflict (property_id, number) do nothing;
insert into public.ota_room_mappings (organization_id, property_id, connection_id, room_type_id, external_room_id)
select c.organization_id, c.property_id, c.id, rt.id, c.channel_code || '-' || rt.code
from public.ota_connections c join public.room_types rt on rt.property_id = c.property_id where c.property_id = :'PERF'
on conflict (connection_id, room_type_id) do nothing;

-- ~3 years of back-to-back stays of 1–4 nights in every room (direct load, as the database owner)
select clock_timestamp() as t0 \gset
insert into public.reservations (organization_id, property_id, room_id, status, check_in, check_out, adults, source, nightly_rate, channel_code, commission_rate)
select :'ORG', :'PERF', r.id,
       case when s.ci < current_date - 1 then 'CHECKED_OUT' else 'CONFIRMED' end::public.reservation_status,
       s.ci, s.ci + s.len, 2, 'direct', 120, 'DIRECT', 0
from public.rooms r
cross join lateral (
  select current_date - 730 + (sum(len) over (order by k))::int - len as ci, len
  from (select k, 1 + ((k * 7 + abs(hashtext(r.id::text))) % 4) as len from generate_series(1, 450) k) z
) s
where r.property_id = :'PERF' and s.ci < current_date + 365;
select count(*) as n_res, extract(epoch from clock_timestamp() - :'t0'::timestamptz) as load_s from public.reservations where property_id = :'PERF' \gset
analyze;
select pg_temp.check('dataset: large hotel loaded', :n_res > 15000, :n_res || ' bookings in ' || round(:load_s::numeric, 1) || ' s (incl. folio, audit and channel-queue triggers)');

-- timing helper: median of N runs in ms
create or replace function pg_temp.ms(p_sql text, p_runs int default 7) returns numeric language plpgsql as $$
declare t timestamptz; a numeric[] := '{}'; i int;
begin
  for i in 1..p_runs loop
    t := clock_timestamp();
    execute p_sql;
    a := a || (extract(epoch from clock_timestamp() - t) * 1000)::numeric;
  end loop;
  return (select percentile_cont(0.5) within group (order by x) from unnest(a) x);
end $$;
grant execute on function pg_temp.ms(text, int) to public;

set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select pg_temp.ms(format($q$select public.check_availability(%L, current_date + 30, current_date + 37, 2)$q$, :'PERF')) as t_avail \gset
select pg_temp.ms(format($q$select * from public.reservations where property_id = %L and check_in < current_date + 14 and check_out > current_date and status not in ('CANCELLED', 'NO_SHOW')$q$, :'PERF')) as t_tape \gset
select pg_temp.ms(format($q$select id, status, check_in, check_out, nightly_rate, channel_code, commission_rate, is_complimentary from public.reservations where property_id = %L and check_in < current_date and check_out > current_date - 365$q$, :'PERF')) as t_report \gset
select pg_temp.ms(format($q$select public.audit_feed(%L)$q$, :'ORG')) as t_audit \gset
select pg_temp.ms(format($q$select count(*) from public.rooms where property_id = %L$q$, :'PERF')) as t_board \gset
reset role;
select pg_temp.ms(format($q$select app_private.availability_options(%L, current_date + 100, current_date + 103, 2)$q$, :'PERF')) as t_ai \gset
select pg_temp.ms(format($q$select sum(n) from (select (select count(*) from app_private.free_rooms(m.room_type_id, d::date, d::date + 1)) as n from public.ota_room_mappings m, generate_series(current_date, current_date + 499 / 6, interval '1 day') d where m.property_id = %L) x$q$, :'PERF'), 3) as t_ari \gset

-- a fresh booking at the end of the loaded calendar (write path with all triggers)
select r.id as free_room from public.rooms r where r.property_id = :'PERF'
 and not exists (select 1 from public.reservations x where x.room_id = r.id and x.stay && daterange(current_date + 400, current_date + 402)) limit 1 \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select pg_temp.ms(format($q$select public.cancel_reservation((public.create_reservation(%L, %L, current_date + 400, current_date + 402, 2, 0, 'Perf Guest', null, null, null, 'phone', 'CONFIRMED', null, 120, 'DIRECT')).id, 'perf')$q$, :'PERF', :'free_room'), 5) as t_create \gset
reset role;

select pg_temp.check('perf: availability check for a week (front desk)', :t_avail < 150, round(:t_avail, 1) || ' ms');
select pg_temp.check('perf: tape chart window (14 days)', :t_tape < 50, round(:t_tape, 1) || ' ms');
select pg_temp.check('perf: finance report rows for a full year (as the app loads them)', :t_report < 300, round(:t_report, 1) || ' ms');
select pg_temp.check('perf: room board', :t_board < 20, round(:t_board, 1) || ' ms');
select pg_temp.check('perf: assistant availability + prices (3 nights, all room types)', :t_ai < 150, round(:t_ai, 1) || ' ms');
select pg_temp.check('perf: channel push batch (≈500 nights of free-room counts)', :t_ari < 1500, round(:t_ari, 1) || ' ms');
select pg_temp.check('perf: create + cancel a booking with folio, audit and channel queue', :t_create < 200, round(:t_create, 1) || ' ms');
select pg_temp.check('perf: audit feed (latest 100)', :t_audit < 100, round(:t_audit, 1) || ' ms');

-- clean up (perf data must not stay in the test database's later steps)
delete from public.reservations where property_id = :'PERF';
delete from public.ota_outbox where property_id = :'PERF';
delete from public.properties where id = :'PERF';

\o
\set QUIET off
select n, case when ok then 'PASS' else 'FAIL' end as result, name, detail from _results order by n;
do $$ declare f int; begin
  select count(*) into f from _results where not ok;
  if f > 0 then raise exception '% test(s) failed', f; end if;
  raise notice 'ALL % PERFORMANCE CHECKS PASSED', (select count(*) from _results);
end $$;
