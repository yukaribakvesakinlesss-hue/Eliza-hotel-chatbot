-- =====================================================================
-- AXON PMS · Phase 4 database tests (housekeeping tasks, inspection, roles)
-- Runs after 10–40 in the same database (reuses their users).
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
\set SUP '55555555-5555-4555-8555-555555555555'
\set HK2 '66666666-6666-4666-8666-666666666666'

insert into auth.users (id, email, raw_user_meta_data) values
  (:'SUP', 'supervisor@demo.test', '{"full_name": "Kat Şefi Derya"}'),
  (:'HK2', 'housekeeping2@demo.test', '{"full_name": "Ayten"}')
on conflict (id) do nothing;
select pg_temp.check('setup: a property-scoped hk_supervisor membership is allowed',
  pg_temp.try($q$select public.admin_add_member('supervisor@demo.test', 'axon-demo', 'hk_supervisor', 'AUR')$q$) is null);
select public.admin_add_member('housekeeping2@demo.test', 'axon-demo', 'housekeeping', 'AUR');
select pg_temp.check('setup: owners still cannot be property-scoped',
  pg_temp.try($q$insert into public.memberships (organization_id, user_id, property_id, role) values ('00000000-0000-4000-a000-000000000001', '55555555-5555-4555-8555-555555555555', '00000000-0000-4000-a000-000000000101', 'owner')$q$) is not null);

select (now() at time zone 'Europe/Istanbul')::date as today \gset
select pg_temp.check('backfill + insert: every room that is not clean has exactly one open task',
  (select count(*) from public.rooms r where r.housekeeping_status <> 'CLEAN'
     and (select count(*) from public.hk_tasks t where t.room_id = r.id and t.status in ('DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED')) <> 1) = 0);
select pg_temp.check('default: inspection is required', (select require_inspection from public.properties where id = :'PROP'));

-- free, clean rooms for this file
create temp table _hk as
  select r.id, r.number, row_number() over (order by r.number) as k from public.rooms r
  where r.property_id = :'PROP' and r.maintenance_status = 'OPERATIONAL'
    and not exists (select 1 from public.reservations x where x.room_id = r.id and x.status not in ('CANCELLED', 'NO_SHOW')
                    and x.stay && daterange(:'today'::date - 1, :'today'::date + 3));
grant select on _hk to public;
update public.rooms set occupancy_status = 'VACANT', housekeeping_status = 'CLEAN' where id in (select id from _hk where k <= 4);
select id as r1, number as n1 from _hk where k = 1 \gset
select id as r2 from _hk where k = 2 \gset
select id as r3 from _hk where k = 3 \gset
select id as r4 from _hk where k = 4 \gset
update public.rooms set occupancy_status = 'OCCUPIED' where id = :'r1';   -- a guest is in r1 (superuser setup)

-- ---------- check-out creates a task ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select public.create_reservation(:'PROP', :'r1', :'today'::date, :'today'::date + 1, 1, 0, 'Bugün Gelen');  -- next guest arrives today
select public.set_room_status(:'r1', 'occupancy', 'VACANT');  -- check-out on the room board
select id as t1 from public.hk_tasks where room_id = :'r1' and status = 'DIRTY' \gset
select pg_temp.check('check-out: room becomes DIRTY and a CHECKOUT task is created automatically',
  (select task_type = 'CHECKOUT' and status = 'DIRTY' from public.hk_tasks where id = :'t1')
  and (select housekeeping_status from public.rooms where id = :'r1') = 'DIRTY');
select pg_temp.check('check-out: a room with an arrival today gets priority 1',
  (select priority from public.hk_tasks where id = :'t1') = 1);
select pg_temp.check('create: a second open task for the same room is refused',
  pg_temp.try(format('select public.hk_create_task(%L)', :'r1')) like 'HK_OPEN_TASK:%');
reset role;

-- ---------- assignment ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'HK', false);
select pg_temp.check('assign: housekeeping staff cannot assign tasks',
  pg_temp.try(format('select public.hk_assign_task(%L, %L)', :'t1', :'HK')) like 'FORBIDDEN:%');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'SUP', false);
select pg_temp.check('assign: the supervisor assigns the task to a housekeeper',
  (select assigned_to from public.hk_assign_task(:'t1', :'HK2')) = :'HK2'::uuid);
select pg_temp.check('assign: only housekeeping staff can be assignees',
  pg_temp.try(format('select public.hk_assign_task(%L, %L)', :'t1', :'FD')) like 'HK_BAD_ASSIGNEE:%');
select pg_temp.check('staff list: housekeepers and supervisor of the hotel (3)',
  (select count(*) from public.hk_list_staff(:'PROP')) = 3);
reset role;

-- ---------- cleaning flow with mandatory inspection ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'HK', false);
select pg_temp.check('start: another housekeeper cannot start a task assigned to someone else',
  pg_temp.try(format('select public.hk_start_task(%L)', :'t1')) like 'HK_NOT_YOURS:%');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'HK2', false);
-- (function call and the room check are separate statements: one statement reads a single snapshot)
select (status = 'IN_PROGRESS' and started_at is not null and started_by = :'HK2'::uuid) as ok from public.hk_start_task(:'t1') \gset
select pg_temp.check('start: assignee starts → IN_PROGRESS with start time; room follows',
  :'ok'::boolean and (select housekeeping_status from public.rooms where id = :'r1') = 'IN_PROGRESS');
select pg_temp.check('start: a double tap is refused (HK_BAD_STATE), not applied twice',
  pg_temp.try(format('select public.hk_start_task(%L)', :'t1')) like 'HK_BAD_STATE:%');
select pg_temp.check('note: the housekeeper adds a note',
  (select author_id = :'HK2'::uuid from public.hk_add_note(:'t1', 'Banyo lambası yanmıyor')));
select (status = 'INSPECTION_REQUIRED' and finished_at is not null) as ok from public.hk_finish_task(:'t1') \gset
select pg_temp.check('finish: with inspection required → INSPECTION_REQUIRED with finish time; room follows',
  :'ok'::boolean and (select housekeeping_status from public.rooms where id = :'r1') = 'INSPECTION_REQUIRED');
select pg_temp.check('inspect: a housekeeper cannot approve',
  pg_temp.try(format('select public.hk_inspect_task(%L, true)', :'t1')) like 'FORBIDDEN:%');
select pg_temp.check('rule: a housekeeper cannot mark the room CLEAN on the room board either (RULE_INSPECTION)',
  pg_temp.try(format('select public.set_room_status(%L, %L, %L)', :'r1', 'housekeeping', 'CLEAN')) like 'RULE_INSPECTION:%');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', :'SUP', false);
select pg_temp.check('inspect: rejecting needs a note',
  pg_temp.try(format('select public.hk_inspect_task(%L, false)', :'t1')) like 'HK_NOTE_REQUIRED:%');
select (status = 'DIRTY' and rework_count = 1 and started_at is null) as ok from public.hk_inspect_task(:'t1', false, 'Ayna lekeli') \gset
select pg_temp.check('inspect: rejected → back to DIRTY, rework counted, times cleared, room DIRTY',
  :'ok'::boolean and (select housekeeping_status from public.rooms where id = :'r1') = 'DIRTY');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'HK2', false);
select public.hk_start_task(:'t1');
select public.hk_finish_task(:'t1', 'Ayna silindi');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'SUP', false);
select (status = 'CLEAN' and inspected_by = :'SUP'::uuid and completed_at is not null) as ok from public.hk_inspect_task(:'t1', true) \gset
select pg_temp.check('inspect: approved → CLEAN with inspector and completion time; room CLEAN',
  :'ok'::boolean and (select housekeeping_status from public.rooms where id = :'r1') = 'CLEAN');
select pg_temp.check('history: every status change is logged with its actor',
  (select string_agg(to_status::text, '>' order by id) from public.hk_task_events where task_id = :'t1')
  = 'DIRTY>IN_PROGRESS>INSPECTION_REQUIRED>DIRTY>IN_PROGRESS>INSPECTION_REQUIRED>CLEAN'
  and (select actor_id from public.hk_task_events where task_id = :'t1' order by id desc limit 1) = :'SUP'::uuid);
select pg_temp.check('notes: 3 notes kept in order (2 from the housekeeper, 1 from the supervisor)',
  (select count(*) from public.hk_task_notes where task_id = :'t1') = 3);
select pg_temp.check('supervisor: cannot change occupancy', pg_temp.try(format('select public.set_room_status(%L, %L, %L)', :'r2', 'occupancy', 'OCCUPIED')) like 'FORBIDDEN:%');
select pg_temp.check('supervisor: sees no financial data', (select count(*) from public.folio_transactions) = 0);
reset role;

-- ---------- optional inspection ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'HK', false);
select pg_temp.check('setting: housekeeping cannot change the inspection setting',
  pg_temp.try(format('select public.hk_set_require_inspection(%L, false)', :'PROP')) like 'FORBIDDEN:%');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select public.hk_set_require_inspection(:'PROP', false);
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select id as t2 from public.hk_create_task(:'r2', 'STAYOVER') \gset
select pg_temp.check('front desk: creates a stayover task; the clean room becomes DIRTY',
  (select housekeeping_status from public.rooms where id = :'r2') = 'DIRTY');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'HK', false);
select pg_temp.check('claim: starting an unassigned task assigns it to the housekeeper',
  (select assigned_to from public.hk_start_task(:'t2')) = :'HK'::uuid);
select (status = 'CLEAN' and completed_at is not null) as ok from public.hk_finish_task(:'t2') \gset
select pg_temp.check('finish: with inspection optional → CLEAN directly; room CLEAN',
  :'ok'::boolean and (select housekeeping_status from public.rooms where id = :'r2') = 'CLEAN');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select public.hk_set_require_inspection(:'PROP', true);
reset role;

-- ---------- room board stays in sync ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select public.set_room_status(:'r3', 'housekeeping', 'DIRTY');
select pg_temp.check('sync: marking a room dirty on the room board opens a task',
  exists (select 1 from public.hk_tasks where room_id = :'r3' and status = 'DIRTY'));
select public.set_room_status(:'r3', 'housekeeping', 'CLEAN');
select pg_temp.check('sync: marking it clean on the room board closes the task',
  not exists (select 1 from public.hk_tasks where room_id = :'r3' and status in ('DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED'))
  and exists (select 1 from public.hk_tasks where room_id = :'r3' and status = 'CLEAN'));
-- reservation check-out (Phase 2 workflow) also creates a task
select id as res4 from public.create_reservation(:'PROP', :'r4', :'today'::date, :'today'::date + 2, 1, 0, 'Erken Çıkan') \gset
select public.set_reservation_status(:'res4', 'CHECKED_IN');
select public.set_reservation_status(:'res4', 'CHECKED_OUT');
select pg_temp.check('reservation check-out → room DIRTY → CHECKOUT task',
  exists (select 1 from public.hk_tasks where room_id = :'r4' and status = 'DIRTY' and task_type = 'CHECKOUT'));
select id as t4 from public.hk_tasks where room_id = :'r4' and status = 'DIRTY' \gset
select pg_temp.check('cancel: front desk cannot cancel a task',
  pg_temp.try(format('select public.hk_cancel_task(%L)', :'t4')) like 'FORBIDDEN:%');
select pg_temp.check('front desk: sees housekeeping tasks', (select count(*) from public.hk_tasks) > 0);
select pg_temp.check('direct writes: front desk cannot insert or update tasks directly',
  pg_temp.try(format($q$update public.hk_tasks set status = 'CLEAN' where id = %L$q$, :'t4')) is not null
  and pg_temp.try(format($q$insert into public.hk_tasks (organization_id, property_id, room_id, business_date) values ('00000000-0000-4000-a000-000000000001', %L, %L, current_date)$q$, :'PROP', :'r4')) is not null);
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'SUP', false);
select pg_temp.check('cancel: the supervisor can cancel', (select status from public.hk_cancel_task(:'t4')) = 'CANCELLED');
reset role;

-- ---------- tenants ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'OTHER', false);
select pg_temp.check('tenant B: sees no tasks, notes or events of tenant A',
  (select count(*) from public.hk_tasks) = 0 and (select count(*) from public.hk_task_notes) = 0 and (select count(*) from public.hk_task_events) = 0);
select pg_temp.check('tenant B: cannot start a tenant A task', pg_temp.try(format('select public.hk_start_task(%L)', :'t4')) like 'HK_NOT_FOUND:%');
select pg_temp.check('tenant B: cannot list tenant A staff', pg_temp.try(format('select * from public.hk_list_staff(%L)', :'PROP')) like 'FORBIDDEN:%');
reset role;
set role anon;
select pg_temp.check('anon: no access to tasks', pg_temp.try('select count(*) from public.hk_tasks') is not null);
reset role;
select pg_temp.check('realtime: hk_tasks and hk_task_notes are published',
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('hk_tasks', 'hk_task_notes')) = 2);

\o
\set QUIET off
select n, case when ok then 'PASS' else 'FAIL' end as result, name, detail from _results order by n;
do $$ declare f int; begin
  select count(*) into f from _results where not ok;
  if f > 0 then raise exception '% test(s) failed', f; end if;
  raise notice 'ALL % HOUSEKEEPING TESTS PASSED', (select count(*) from _results);
end $$;
