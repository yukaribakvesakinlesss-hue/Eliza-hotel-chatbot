-- =====================================================================
-- AXON PMS · state machine fixes (room occupancy follows the reservation; closed conversations)
-- Runs after the other suites in the same database (reuses their users).
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
grant execute on function pg_temp.check(text, boolean, text) to public;
grant execute on function pg_temp.try(text) to public;
\o /dev/null

\set PROP '00000000-0000-4000-a000-000000000101'
\set OWNER '11111111-1111-4111-8111-111111111111'
\set FD '22222222-2222-4222-8222-222222222222'

select (now() at time zone 'Europe/Istanbul')::date as today \gset
-- three clean, vacant, operational rooms without any stay overlapping today..+3
select array_agg(id order by number) as rooms from (
  select r.id, r.number from public.rooms r
   where r.property_id = :'PROP' and r.maintenance_status = 'OPERATIONAL'
     and not exists (select 1 from public.reservations x where x.room_id = r.id and x.status not in ('CANCELLED', 'NO_SHOW') and x.stay && daterange(:'today'::date, :'today'::date + 3))
   order by r.number limit 3) z \gset
select (:'rooms'::uuid[])[1] as r1, (:'rooms'::uuid[])[2] as r2, (:'rooms'::uuid[])[3] as r3 \gset
update public.rooms set occupancy_status = 'VACANT', housekeeping_status = 'CLEAN' where id in (:'r1', :'r2', :'r3');

set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
-- r1: guest checked in · r2: guest arriving today, not checked in · r3: no reservation
select id as res1 from public.create_reservation(:'PROP', :'r1', :'today'::date, :'today'::date + 2, 1, 0, 'In House Guest', null, null, null, 'phone', 'CONFIRMED', null, 100, 'DIRECT') \gset
select status from public.set_reservation_status(:'res1', 'CHECKED_IN') \gset
select id as res2 from public.create_reservation(:'PROP', :'r2', :'today'::date, :'today'::date + 2, 1, 0, 'Arriving Guest', null, null, null, 'phone', 'CONFIRMED', null, 100, 'DIRECT') \gset

select pg_temp.check('check-in through the reservation still sets the room occupied', (select occupancy_status = 'OCCUPIED' from public.rooms where id = :'r1'));
select pg_temp.check('room board cannot free a room whose guest is checked in',
  pg_temp.try(format($q$select public.set_room_status(%L, 'occupancy', 'VACANT')$q$, :'r1')) like 'RULE_RESERVATION_IN_HOUSE:%');
select pg_temp.check('room board cannot mark an arriving guest''s room occupied (check in the reservation instead)',
  pg_temp.try(format($q$select public.set_room_status(%L, 'occupancy', 'OCCUPIED')$q$, :'r2')) like 'RULE_USE_CHECK_IN:%');
select pg_temp.check('a room without reservations can still be set occupied by hand (walk-in, phase 1 behaviour)',
  pg_temp.try(format($q$select public.set_room_status(%L, 'occupancy', 'OCCUPIED')$q$, :'r3')) is null);
select pg_temp.check('direct table updates follow the same rule',
  pg_temp.try(format($q$update public.rooms set occupancy_status = 'VACANT' where id = %L$q$, :'r1')) like 'RULE_RESERVATION_IN_HOUSE:%');
select status as out_status from public.set_reservation_status(:'res1', 'CHECKED_OUT') \gset
select pg_temp.check('check-out through the reservation frees the room and marks it dirty',
  :'out_status' = 'CHECKED_OUT' and (select occupancy_status = 'VACANT' and housekeeping_status = 'DIRTY' from public.rooms where id = :'r1'));
reset role;

-- a room marked occupied by hand: the check-in error now says why
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select id as res3 from public.create_reservation(:'PROP', :'r3', :'today'::date + 1, :'today'::date + 3, 1, 0, 'Next Day Guest', null, null, null, 'phone', 'CONFIRMED', null, 100, 'DIRECT') \gset
reset role;
update public.reservations set check_in = :'today'::date where id = :'res3';
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select pg_temp.check('check-in into a room marked occupied by hand explains the cause',
  pg_temp.try(format($q$select public.set_reservation_status(%L, 'CHECKED_IN')$q$, :'res3')) like 'RES_ROOM_OCCUPIED:%elle "dolu"%');
select public.cancel_reservation(:'res2', 'test');
select public.cancel_reservation(:'res3', 'test');
reset role;
update public.rooms set occupancy_status = 'VACANT', housekeeping_status = 'CLEAN' where id in (:'r2', :'r3');

-- closed conversations reopen for the front desk
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select (public.inbox_simulate_inbound(:'PROP', 'WHATSAPP', '905550009999', 'Closed Test', 'Merhaba', 'sm-1'))->>'conversation_id' as cid \gset
select public.inbox_set_status(:'cid', 'CLOSED');
select public.inbox_simulate_inbound(:'PROP', 'WHATSAPP', '905550009999', 'Closed Test', 'Bir sorum daha var', 'sm-2') as again \gset
select public.inbox_assistant_turn(:'cid', null, 'GREETING', '{}', 'tr') as turn \gset
reset role;
select pg_temp.check('a guest writing to a closed conversation goes to the front desk (HUMAN), not back to the AI',
  :'again'::jsonb->>'status' = 'HUMAN' and (select status = 'HUMAN' from public.conversations where id = :'cid'));
select pg_temp.check('the AI does not answer the reopened conversation', (:'turn'::jsonb->>'replied')::boolean = false);

\o
\set QUIET off
select n, case when ok then 'PASS' else 'FAIL' end as result, name, left(detail, 160) as detail from _results order by n;
do $$ declare f int; begin
  select count(*) into f from _results where not ok;
  if f > 0 then raise exception '% test(s) failed', f; end if;
  raise notice 'ALL % STATE MACHINE TESTS PASSED', (select count(*) from _results);
end $$;
