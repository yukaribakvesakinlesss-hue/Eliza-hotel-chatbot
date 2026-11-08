-- =====================================================================
-- AXON PMS · Phase 1 database tests (multi-tenancy, RLS, status engine)
-- Run: psql -v ON_ERROR_STOP=1 -f 10_rls_and_status_engine.sql
-- Every check prints PASS/FAIL; the script fails at the end if any FAIL.
-- =====================================================================
\set QUIET on
create temp table _results (n serial, name text, ok boolean, detail text);
grant all on _results to public;
grant all on sequence _results_n_seq to public;

create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into _results (name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail);
$$;
-- run a statement as a user and capture the error message (null = success)
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlerrm; end $$;
-- run a DML statement and return the number of affected rows (-1 on error)
create or replace function pg_temp.affected(p_sql text) returns int language plpgsql as $$
declare n int; begin execute p_sql; get diagnostics n = row_count; return n; exception when others then return -1; end $$;
\o /dev/null

-- ---------- fixtures (as superuser = service role) ----------
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'owner@demo.test'),
  ('22222222-2222-4222-8222-222222222222', 'frontdesk@demo.test'),
  ('33333333-3333-4333-8333-333333333333', 'housekeeping@demo.test'),
  ('44444444-4444-4444-8444-444444444444', 'owner@other.test');
select public.admin_add_member('owner@demo.test', 'axon-demo', 'owner');
select public.admin_add_member('frontdesk@demo.test', 'axon-demo', 'front_desk');
select public.admin_add_member('housekeeping@demo.test', 'axon-demo', 'housekeeping', 'AUR');

select pg_temp.check('auth trigger created public.users rows', (select count(*) from public.users) = 4);
select pg_temp.check('seed: 24 rooms in demo hotel', (select count(*) from public.rooms where property_id = '00000000-0000-4000-a000-000000000101') = 24);
select pg_temp.check('seed: out-of-order room is not occupied',
  not exists (select 1 from public.rooms where maintenance_status = 'OUT_OF_ORDER' and occupancy_status = 'OCCUPIED'));

-- ---------- second tenant: created through the onboarding RPC ----------
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
select pg_temp.check('tenant B: create_organization works',
  pg_temp.try($q$select public.create_organization('Other Hotels', 'other-hotels', 'Seaside Inn', 'SEA')$q$) is null);
select pg_temp.check('tenant B: sees only its own organization', (select count(*) from public.organizations) = 1
  and (select slug from public.organizations) = 'other-hotels');
select pg_temp.check('tenant B: sees 0 rooms of tenant A', (select count(*) from public.rooms) = 0);
select pg_temp.check('tenant B: cannot see tenant A users', (select count(*) from public.users) = 1);
select pg_temp.check('tenant B: update on tenant A room affects 0 rows',
  pg_temp.affected($q$update public.rooms set housekeeping_status = 'DIRTY' where property_id = '00000000-0000-4000-a000-000000000101'$q$) = 0);
select pg_temp.check('tenant B: cannot insert a room into tenant A',
  pg_temp.try($q$insert into public.rooms (organization_id, property_id, room_type_id, number)
     values ('00000000-0000-4000-a000-000000000001','00000000-0000-4000-a000-000000000101','00000000-0000-4000-a000-000000000201','999')$q$) is not null);
select pg_temp.check('tenant B: set_room_status on tenant A room is rejected',
  pg_temp.try($q$select public.set_room_status((select id from public.rooms limit 1), 'housekeeping', 'DIRTY')$q$) is not null
  or (select count(*) from public.rooms) = 0);
select pg_temp.check('tenant B: cannot read tenant A audit events', (select count(*) from public.room_status_events) = 0);
reset role;

-- B's property id for later
select id as b_prop from public.properties where code = 'SEA' \gset

-- ---------- anon ----------
set role anon;
select pg_temp.check('anon: no access to rooms', pg_temp.try('select count(*) from public.rooms') is not null);
select pg_temp.check('anon: cannot call set_room_status',
  pg_temp.try($q$select public.set_room_status('00000000-0000-0000-0000-000000000000', 'housekeeping', 'DIRTY')$q$) is not null);
reset role;

-- ---------- owner A ----------
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check('owner: sees 24 rooms', (select count(*) from public.rooms) = 24);
select pg_temp.check('owner: sees all 3 memberships of the org', (select count(*) from public.memberships) = 3);
select pg_temp.check('owner: can add a second property',
  pg_temp.try($q$insert into public.properties (id, organization_id, name, code) values ('00000000-0000-4000-a000-000000000102', '00000000-0000-4000-a000-000000000001', 'Aurelia Annex', 'ANX')$q$) is null);
select pg_temp.check('owner: can add room type + room in the annex',
  pg_temp.try($q$insert into public.room_types (id, organization_id, property_id, code, name) values ('00000000-0000-4000-a000-000000000204','00000000-0000-4000-a000-000000000001','00000000-0000-4000-a000-000000000102','STD','Standard')$q$) is null
  and pg_temp.try($q$insert into public.rooms (organization_id, property_id, room_type_id, number) values ('00000000-0000-4000-a000-000000000001','00000000-0000-4000-a000-000000000102','00000000-0000-4000-a000-000000000204','A1')$q$) is null);
select pg_temp.check('owner: cannot create a room with a room type of another property (composite FK)',
  pg_temp.try($q$insert into public.rooms (organization_id, property_id, room_type_id, number) values ('00000000-0000-4000-a000-000000000001','00000000-0000-4000-a000-000000000102','00000000-0000-4000-a000-000000000201','A2')$q$) is not null);
select pg_temp.check('owner: cannot move a room to another tenant',
  pg_temp.try(format($q$update public.rooms set organization_id = (select organization_id from public.properties where id = %L), property_id = %L where number = '101'$q$, :'b_prop', :'b_prop')) is not null);
select pg_temp.check('owner: cannot write audit events directly',
  pg_temp.try($q$insert into public.room_status_events (organization_id, property_id, room_id, dimension, to_value) select organization_id, property_id, id, 'occupancy', 'VACANT' from public.rooms limit 1$q$) is not null);
-- business rules
select pg_temp.check('rule: cannot check a guest into an out-of-order room',
  pg_temp.try($q$select public.set_room_status((select id from public.rooms where maintenance_status = 'OUT_OF_ORDER' limit 1), 'occupancy', 'OCCUPIED')$q$) like 'RULE_OUT_OF_ORDER%');
select pg_temp.check('rule: cannot set an occupied room out of order',
  pg_temp.try($q$select public.set_room_status((select id from public.rooms where occupancy_status = 'OCCUPIED' and property_id = '00000000-0000-4000-a000-000000000101' limit 1), 'maintenance', 'OUT_OF_ORDER', 'leak')$q$) like 'RULE_OCCUPIED%');
select id as occ_room from public.rooms where occupancy_status = 'OCCUPIED' and housekeeping_status = 'CLEAN' and property_id = '00000000-0000-4000-a000-000000000101' limit 1 \gset
select public.set_room_status(:'occ_room', 'occupancy', 'VACANT');
select pg_temp.check('rule: check-out (OCCUPIED → VACANT) marks the room DIRTY',
  (select housekeeping_status from public.rooms where id = :'occ_room') = 'DIRTY');
select pg_temp.check('audit: check-out logged two events by the owner',
  (select count(*) from public.room_status_events where room_id = :'occ_room' and changed_by = '11111111-1111-4111-8111-111111111111') = 2);
select pg_temp.check('audit: status_updated_by set to the owner',
  (select status_updated_by from public.rooms where id = :'occ_room') = '11111111-1111-4111-8111-111111111111');
select pg_temp.check('rpc: invalid dimension rejected',
  pg_temp.try(format($q$select public.set_room_status(%L, 'color', 'RED')$q$, :'occ_room')) like 'INVALID_DIMENSION%');
select pg_temp.check('enum: invalid value rejected',
  pg_temp.try(format($q$select public.set_room_status(%L, 'housekeeping', 'SPARKLING')$q$, :'occ_room')) is not null);
reset role;

-- ---------- front desk ----------
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.check('front desk: sees rooms of both properties (org-wide)', (select count(*) from public.rooms) = 25);
select pg_temp.check('front desk: can check a guest in',
  pg_temp.try(format($q$select public.set_room_status(%L, 'occupancy', 'OCCUPIED')$q$, :'occ_room')) is null);
select pg_temp.check('front desk: cannot rename a room',
  pg_temp.try(format($q$update public.rooms set number = '9999' where id = %L$q$, :'occ_room')) like 'FORBIDDEN%');
select pg_temp.check('front desk: cannot see other members', (select count(*) from public.memberships) = 1);
select pg_temp.check('front desk: cannot add members',
  pg_temp.try($q$insert into public.memberships (organization_id, user_id, role) values ('00000000-0000-4000-a000-000000000001', '22222222-2222-4222-8222-222222222222', 'owner')$q$) is not null);
select pg_temp.check('front desk: cannot create rooms',
  pg_temp.try($q$insert into public.rooms (organization_id, property_id, room_type_id, number) values ('00000000-0000-4000-a000-000000000001','00000000-0000-4000-a000-000000000101','00000000-0000-4000-a000-000000000201','998')$q$) is not null);
reset role;

-- ---------- housekeeping (scoped to property AUR) ----------
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
select pg_temp.check('housekeeping: sees only its property (24 rooms, not the annex)', (select count(*) from public.rooms) = 24);
select pg_temp.check('housekeeping: can change housekeeping status',
  pg_temp.try(format($q$select public.set_room_status(%L, 'housekeeping', 'IN_PROGRESS')$q$, :'occ_room')) is null);
select pg_temp.check('housekeeping: cannot change occupancy',
  pg_temp.try(format($q$select public.set_room_status(%L, 'occupancy', 'VACANT')$q$, :'occ_room')) like 'FORBIDDEN%');
select pg_temp.check('housekeeping: cannot set out of order',
  pg_temp.try($q$select public.set_room_status((select id from public.rooms where occupancy_status = 'VACANT' and maintenance_status = 'OPERATIONAL' limit 1), 'maintenance', 'OUT_OF_ORDER', 'x')$q$) like 'FORBIDDEN%');
reset role;

-- ---------- realtime ----------
select pg_temp.check('realtime: rooms and room_status_events are published',
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('rooms', 'room_status_events')) = 2);

-- ---------- report ----------
\o
\set QUIET off
select n, case when ok then 'PASS' else 'FAIL' end as result, name, detail from _results order by n;
do $$ declare f int; begin
  select count(*) into f from _results where not ok;
  if f > 0 then raise exception '% test(s) failed', f; end if;
  raise notice 'ALL % TESTS PASSED', (select count(*) from _results);
end $$;
