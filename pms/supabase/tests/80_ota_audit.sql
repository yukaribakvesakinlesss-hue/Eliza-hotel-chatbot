-- =====================================================================
-- AXON PMS · Phase 6 database tests (OTA channel manager, retries, audit log)
-- Runs after 10–70 in the same database (reuses their users).
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
\set ORG '00000000-0000-4000-a000-000000000001'
\set OWNER '11111111-1111-4111-8111-111111111111'
\set FD '22222222-2222-4222-8222-222222222222'
\set HK '33333333-3333-4333-8333-333333333333'
\set OTHER '44444444-4444-4444-8444-444444444444'
\set SYS '00000000-0000-4000-a000-0000000000c1'
\set SECRET 'worker-secret-0123456789abcdef'

select (now() at time zone 'Europe/Istanbul')::date as today \gset
select (:'today'::date + 120) as d0 \gset
select id as rt_cdbl from public.room_types where property_id = :'PROP' and code = 'CDBL' \gset
select id as rt_ddbl from public.room_types where property_id = :'PROP' and code = 'DDBL' \gset
select id as rt_jste from public.room_types where property_id = :'PROP' and code = 'JSTE' \gset
select id as c_bdc from public.ota_connections where property_id = :'PROP' and channel_code = 'BOOKING' \gset
select id as c_exp from public.ota_connections where property_id = :'PROP' and channel_code = 'EXPEDIA' \gset

-- event builder for the tests
create or replace function pg_temp.ev(p_id text, p_kind text, p_res text, p_room text, p_in date, p_out date, p_total numeric,
  p_currency text default 'EUR', p_name text default 'Hans Müller') returns jsonb language sql as $$
  select jsonb_build_object('event_id', p_id, 'kind', p_kind, 'reservation_id', p_res, 'room_id', p_room, 'check_in', p_in, 'check_out', p_out,
    'adults', 2, 'total_amount', p_total, 'currency', p_currency, 'guest', jsonb_build_object('name', p_name, 'email', 'hans@example.de', 'phone', '+49 170 1234567'))
$$;

-- simulate as the current role; nulls become '' so psql \gset always sets the variables
create or replace function pg_temp.sim(p_prop uuid, p_ch text, p_ev jsonb)
returns table (id bigint, status text, outcome text, attempts int, last_error text, reservation_id text, next_attempt_at text) language sql as $$
  select e.id, e.status, coalesce(e.outcome, ''), e.attempts::int, coalesce(e.last_error, ''), coalesce(e.reservation_id::text, ''), coalesce(e.next_attempt_at::text, '')
  from public.ota_simulate_event(p_prop, p_ch, p_ev) e
$$;

-- ---------- defaults ----------
select pg_temp.check('ota: every property has Booking.com and Expedia connections',
  not exists (select 1 from public.properties p where (select count(*) from public.ota_connections c where c.property_id = p.id) <> 2));
select pg_temp.check('ota: new connections start in DEMO mode', (select bool_and(mode = 'DEMO') from public.ota_connections));
select pg_temp.check('ota: demo hotel room codes are mapped (3 per channel)',
  (select count(*) from public.ota_room_mappings where property_id = :'PROP') = 6);
select pg_temp.check('ari: mapping queues a full push and repeated changes coalesce (2 channels × 3 types × 366 nights)',
  (select count(*) from public.ota_outbox where property_id = :'PROP' and status in ('PENDING', 'FAILED')) = 2196);

-- ---------- ARI queue: claim and results ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select public.ota_claim_outbox(:'PROP', null, 3) as items \gset
reset role;   -- the owner identity (claim) stays; checks below read internal helpers
select pg_temp.check('ari: claim returns the requested batch', jsonb_array_length(:'items'::jsonb) = 3);
select pg_temp.check('ari: each item carries the current free rooms and rate from the database',
  (select bool_and((i->>'available')::int = (select count(*) from app_private.free_rooms(m.room_type_id, (i->>'date')::date, (i->>'date')::date + 1))
                   and (i->>'rate')::numeric = (app_private.quote_room_type(m.room_type_id, (i->>'date')::date, (i->>'date')::date + 1)->'nights'->0->>'rate')::numeric)
     from jsonb_array_elements(:'items'::jsonb) i join public.ota_room_mappings m on m.external_room_id = i->>'room_id' and m.property_id = :'PROP'));
select pg_temp.check('ari: claimed rows are leased (a second worker does not get them)',
  not exists (select 1 from jsonb_array_elements(public.ota_claim_outbox(:'PROP', null, 3)) b
              where b->>'id' in (select i->>'id' from jsonb_array_elements(:'items'::jsonb) i)));
select (:'items'::jsonb->0->>'id')::bigint as o1, (:'items'::jsonb->1->>'id')::bigint as o2, (:'items'::jsonb->2->>'id')::bigint as o3 \gset
select public.ota_outbox_result(:'PROP', null, jsonb_build_array(
  jsonb_build_object('id', :o1, 'result', 'SENT', 'available', 3, 'rate', 90),
  jsonb_build_object('id', :o2, 'result', 'RETRY', 'error', 'HTTP 503'),
  jsonb_build_object('id', :o3, 'result', 'REJECTED', 'error', 'HTTP 400 unknown room'))) as r \gset
reset role;
select pg_temp.check('ari: SENT keeps what was pushed', (select status = 'SENT' and last_sent->>'rate' = '90' and sent_at is not null from public.ota_outbox where id = :o1));
select pg_temp.check('ari: RETRY backs off (attempt 1 → about 2 minutes)',
  (select status = 'FAILED' and attempts = 1 and next_attempt_at between now() + interval '100 seconds' and now() + interval '140 seconds' from public.ota_outbox where id = :o2));
select pg_temp.check('ari: REJECTED (4xx) stops retrying and needs a person', (select status = 'DEAD' and last_error like 'HTTP 400%' from public.ota_outbox where id = :o3));
select pg_temp.check('ari: unknown result is refused',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); select public.ota_outbox_result(%L, null, '[{"id":1,"result":"OK"}]')$q$, :'OWNER', :'PROP')) like 'OTA_INVALID:%');
reset role;
update public.ota_outbox set attempts = 9, next_attempt_at = now() where id = :o2;
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select public.ota_outbox_result(:'PROP', null, jsonb_build_array(jsonb_build_object('id', :o2, 'result', 'RETRY', 'error', 'timeout')));
reset role;
select pg_temp.check('ari: the 10th failed attempt gives up (DEAD)', (select status = 'DEAD' and attempts = 10 from public.ota_outbox where id = :o2));
select connection_id as dead_conn, room_type_id as dead_rt, stay_date as dead_date from public.ota_outbox where id = :o3 \gset
select app_private.ota_mark_dirty(:'PROP', :'dead_rt', :'dead_date'::date, :'dead_date'::date + 1);
select pg_temp.check('ari: a later change re-queues a night whose push had failed for good',
  exists (select 1 from public.ota_outbox where connection_id = :'dead_conn' and room_type_id = :'dead_rt' and stay_date = :'dead_date' and status = 'PENDING'));

-- clean slate for the trigger checks
update public.ota_outbox set status = 'SENT', sent_at = now() where property_id = :'PROP' and status in ('PENDING', 'FAILED');
select f as cdbl_room from app_private.free_rooms(:'rt_cdbl', :'d0'::date, :'d0'::date + 2) f limit 1 \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select id as r_fd, room_id as r_fd_room from public.create_reservation(:'PROP', :'cdbl_room',
  :'d0'::date, :'d0'::date + 2, 2, 0, 'Ayşe Demir', 'ayse@example.com', '0533 222 33 44', 'Geç giriş', 'phone', 'CONFIRMED', null, 90, 'DIRECT') \gset
reset role;
select pg_temp.check('ari: a new reservation marks its nights dirty for both channels (2 × 2)',
  (select count(*) from public.ota_outbox where property_id = :'PROP' and status = 'PENDING') = 4
  and (select bool_and(room_type_id = :'rt_cdbl' and stay_date in (:'d0'::date, :'d0'::date + 1)) from public.ota_outbox where property_id = :'PROP' and status = 'PENDING'));
update public.ota_outbox set status = 'SENT', sent_at = now() where property_id = :'PROP' and status = 'PENDING';
insert into public.rate_calendar (organization_id, property_id, room_type_id, stay_date, rate) values (:'ORG', :'PROP', :'rt_ddbl', :'d0'::date + 5, 140);
update public.rate_calendar set rate = 145 where room_type_id = :'rt_ddbl' and stay_date = :'d0'::date + 5;
select pg_temp.check('ari: a rate change queues that night once per channel even when edited twice',
  (select count(*) from public.ota_outbox where property_id = :'PROP' and status = 'PENDING' and room_type_id = :'rt_ddbl' and stay_date = :'d0'::date + 5) = 2
  and (select count(*) from public.ota_outbox where property_id = :'PROP' and status = 'PENDING') = 2);
update public.ota_outbox set status = 'SENT', sent_at = now() where property_id = :'PROP' and status = 'PENDING';
insert into public.room_out_of_order_periods (organization_id, property_id, room_id, start_date, end_date, reason)
values (:'ORG', :'PROP', (select id from public.rooms where room_type_id = :'rt_jste' and maintenance_status = 'OPERATIONAL' order by number limit 1), :'d0'::date + 20, :'d0'::date + 23, 'Boya');
select pg_temp.check('ari: a planned out-of-order period queues its nights',
  (select count(*) from public.ota_outbox where property_id = :'PROP' and status = 'PENDING' and room_type_id = :'rt_jste') = 6);
update public.ota_outbox set status = 'SENT', sent_at = now() where property_id = :'PROP' and status = 'PENDING';
update public.room_types set base_rate = null where id = :'rt_jste';
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select public.ota_claim_outbox(:'PROP', null, 1000) as items \gset
reset role;
select pg_temp.check('ari: a night without a verified rate is sent as closed, never with a guessed price',
  jsonb_array_length(:'items'::jsonb) = 732 and (select bool_and((i->>'closed')::boolean and i->>'rate' is null) from jsonb_array_elements(:'items'::jsonb) i));
update public.room_types set base_rate = 180 where id = :'rt_jste';
update public.ota_outbox set status = 'SENT', sent_at = now() where property_id = :'PROP' and status in ('PENDING', 'FAILED');

-- ---------- permissions on the queue ----------
select pg_temp.check('perm: front desk cannot run the channel sync',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); select public.ota_claim_outbox(%L)$q$, :'FD', :'PROP')) like 'FORBIDDEN:%');
select pg_temp.check('perm: housekeeping cannot run the channel sync',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); select public.ota_claim_outbox(%L)$q$, :'HK', :'PROP')) like 'FORBIDDEN:%');
select pg_temp.check('perm: anonymous caller without the secret cannot',
  pg_temp.try(format($q$set role anon; select set_config('request.jwt.claim.sub', '', false); select public.ota_claim_outbox(%L, 'wrong-secret-xxxxxxxxxxxxxxxxxx')$q$, :'PROP')) like 'FORBIDDEN:%');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select pg_temp.check('config: a short worker secret is refused',
  pg_temp.try(format($q$select public.ota_configure(%L, 'EXPEDIA', 'DEMO', null, 'short')$q$, :'PROP')) like 'OTA_INVALID:%');
select pg_temp.check('config: LIVE needs the channel hotel id',
  pg_temp.try(format($q$select public.ota_configure(%L, 'EXPEDIA', 'LIVE', null, %L)$q$, :'PROP', :'SECRET')) like 'OTA_INVALID:%otel kimliği%');
select public.ota_configure(:'PROP', 'EXPEDIA', 'LIVE', '1234567', :'SECRET');
reset role;
select pg_temp.check('config: Expedia is LIVE and the secret is stored only as a hash',
  (select mode = 'LIVE' and external_hotel_id = '1234567' from public.ota_connections where id = :'c_exp')
  and (select secret_hash = app_private.sha256(:'SECRET') and secret_hash <> :'SECRET' from app_private.ota_worker_secrets where property_id = :'PROP'));
select pg_temp.check('config: going LIVE queues a full push for that hotel',
  (select count(*) from public.ota_outbox where property_id = :'PROP' and status = 'PENDING') = 2196);
update public.ota_outbox set status = 'SENT', sent_at = now() where property_id = :'PROP' and status = 'PENDING';
select pg_temp.check('perm: the server worker with the property secret can claim (anon key)',
  pg_temp.try(format($q$set role anon; select set_config('request.jwt.claim.sub', '', false); select public.ota_claim_outbox(%L, %L)$q$, :'PROP', :'SECRET')) is null);
reset role;
select pg_temp.check('perm: front desk cannot change channel settings',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); select public.ota_configure(%L, 'BOOKING', 'DEMO')$q$, :'FD', :'PROP')) like 'FORBIDDEN:%');
select pg_temp.check('perm: front desk cannot change room mappings',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); select public.ota_set_mapping(%L, 'BOOKING', %L, 'X1')$q$, :'FD', :'PROP', :'rt_cdbl')) like 'FORBIDDEN:%');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select pg_temp.check('mapping: invalid characters are refused',
  pg_temp.try(format($q$select public.ota_set_mapping(%L, 'BOOKING', %L, 'BAD CODE; drop')$q$, :'PROP', :'rt_cdbl')) like 'OTA_INVALID:%');
select pg_temp.check('mapping: one channel room code cannot belong to two room types',
  pg_temp.try(format($q$select public.ota_set_mapping(%L, 'BOOKING', %L, 'BDC-DDBL')$q$, :'PROP', :'rt_cdbl')) like 'OTA_INVALID:%başka bir oda tipine%');
reset role;

-- ---------- inbound: DEMO simulation through the real processing path ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select * from pg_temp.sim(:'PROP', 'BOOKING', pg_temp.ev('E1', 'NEW', 'BK1', 'BDC-CDBL', :'d0'::date + 40, :'d0'::date + 43, 300)) \gset e1_
reset role;
select pg_temp.check('inbound: a channel booking becomes a reservation', :'e1_status' = 'PROCESSED' and :'e1_outcome' = 'CREATED', :'e1_last_error');
select pg_temp.check('inbound: reservation carries channel, commission, rate and the channel number',
  (select channel_code = 'BOOKING' and source = 'ota' and commission_rate = (select commission_rate from public.distribution_channels where organization_id = organization_id and code = 'BOOKING' and distribution_channels.organization_id = reservations.organization_id) and nightly_rate = 100 and external_ref = 'demo-BK1' and status = 'CONFIRMED'
     from public.reservations where id = :'e1_reservation_id'));
select pg_temp.check('inbound: created by the channel-manager service account, guest stored on the reservation',
  (select created_by = :'SYS'::uuid from public.reservations where id = :'e1_reservation_id')
  and (select full_name = 'Hans Müller' and email = 'hans@example.de' from public.reservation_guests where reservation_id = :'e1_reservation_id' and is_primary));
select pg_temp.check('inbound: the caller identity is restored after processing',
  (select current_setting('request.jwt.claim.sub', true)) = :'FD');
select pg_temp.check('kvkk: guest data is removed from the stored channel message after processing',
  (select not (payload ? 'guest') from public.ota_inbound_events where id = :e1_id));
select pg_temp.check('inbound: the room is in the mapped type and has a folio',
  (select r.room_type_id = :'rt_cdbl'::uuid from public.reservations x join public.rooms r on r.id = x.room_id where x.id = :'e1_reservation_id')
  and exists (select 1 from public.folios where reservation_id = :'e1_reservation_id'));
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select id as e1b from pg_temp.sim(:'PROP', 'BOOKING', pg_temp.ev('E1', 'NEW', 'BK1', 'BDC-CDBL', :'d0'::date + 40, :'d0'::date + 43, 300)) \gset
select * from pg_temp.sim(:'PROP', 'BOOKING', pg_temp.ev('E1-again', 'NEW', 'BK1', 'BDC-CDBL', :'d0'::date + 40, :'d0'::date + 43, 300)) \gset e2_
reset role;
select pg_temp.check('idempotency: the same event id is stored once', :e1b = :e1_id
  and (select count(*) from public.ota_inbound_events where external_event_id = 'demo-E1') = 1);
select pg_temp.check('idempotency: a second message for the same channel booking creates no second reservation',
  :'e2_status' = 'IGNORED' and :'e2_outcome' = 'DUPLICATE' and (select count(*) from public.reservations where external_ref = 'demo-BK1') = 1);

set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select * from pg_temp.sim(:'PROP', 'BOOKING', pg_temp.ev('E3', 'MODIFY', 'BK1', 'BDC-CDBL', :'d0'::date + 40, :'d0'::date + 44, 440)) \gset e3_
reset role;
select pg_temp.check('modify: extension applied, new nightly rate before arrival',
  :'e3_status' = 'PROCESSED' and (select check_out = :'d0'::date + 44 and nightly_rate = 110 from public.reservations where id = :'e1_reservation_id'), :'e3_last_error');
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select * from pg_temp.sim(:'PROP', 'BOOKING', pg_temp.ev('E4', 'MODIFY', 'BK1', 'BDC-DDBL', :'d0'::date + 40, :'d0'::date + 44, 480)) \gset e4_
reset role;
select pg_temp.check('modify: room type change moves the booking to a free room of the new type',
  :'e4_outcome' = 'MODIFIED_ROOM_CHANGED'
  and (select r.room_type_id = :'rt_ddbl'::uuid from public.reservations x join public.rooms r on r.id = x.room_id where x.id = :'e1_reservation_id'), :'e4_last_error');
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select * from pg_temp.sim(:'PROP', 'BOOKING', pg_temp.ev('E5', 'CANCEL', 'BK1', null, null, null, null)) \gset e5_
select * from pg_temp.sim(:'PROP', 'BOOKING', pg_temp.ev('E6', 'CANCEL', 'BK1', null, null, null, null)) \gset e6_
reset role;
select pg_temp.check('cancel: channel cancellation cancels the reservation',
  :'e5_status' = 'PROCESSED' and (select status = 'CANCELLED' and cancel_reason like 'Kanal iptali%' from public.reservations where id = :'e1_reservation_id'));
select pg_temp.check('cancel: a repeated cancellation is harmless', :'e6_status' = 'IGNORED' and :'e6_outcome' = 'ALREADY_CANCELLED');

-- out of order delivery: the change arrives before the booking
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select * from pg_temp.sim(:'PROP', 'BOOKING', pg_temp.ev('E8', 'MODIFY', 'BK2', 'BDC-CDBL', :'d0'::date + 50, :'d0'::date + 53, 300)) \gset e8_
reset role;
select pg_temp.check('retry: a change for a booking not yet received is retried later (not lost, not an alarm)',
  :'e8_status' = 'FAILED' and :'e8_attempts' = '1' and :'e8_last_error' like 'OTA_NOT_FOUND:%'
  and (select next_attempt_at > now() from public.ota_inbound_events where id = :e8_id));
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select status as e7_status from pg_temp.sim(:'PROP', 'BOOKING', pg_temp.ev('E7', 'NEW', 'BK2', 'BDC-CDBL', :'d0'::date + 50, :'d0'::date + 52, 200)) \gset
reset role;
update public.ota_inbound_events set next_attempt_at = now() - interval '1 second' where id = :e8_id;
select pg_temp.check('retry: front desk cannot run the retry job',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); select public.ota_retry_due(%L)$q$, :'FD', :'PROP')) like 'FORBIDDEN:%');
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select public.ota_retry_due(:'PROP', :'SECRET') as rd \gset
reset role;
select pg_temp.check('retry: the worker retries due events and the late change is applied',
  :'e7_status' = 'PROCESSED' and (:'rd'::jsonb->>'succeeded')::int >= 1
  and (select status = 'PROCESSED' and attempts = 2 from public.ota_inbound_events where id = :e8_id)
  and (select check_out = :'d0'::date + 53 from public.reservations where external_ref = 'demo-BK2'));
update public.ota_inbound_events set status = 'FAILED', attempts = 7, next_attempt_at = now() - interval '1 second', last_error = 'OTA_NOT_FOUND: x'
 where id = (select id from public.ota_inbound_events where external_event_id = 'demo-E8');
-- make the retry fail again: the booking it refers to disappears from the lookup
update public.reservations set external_ref = 'demo-BK2-moved' where external_ref = 'demo-BK2';
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select public.ota_retry_due(:'PROP', :'SECRET');
reset role;
select pg_temp.check('retry: after 8 failed attempts the event is marked DEAD for a person', (select status = 'DEAD' and attempts = 8 from public.ota_inbound_events where id = :e8_id));
update public.reservations set external_ref = 'demo-BK2' where external_ref = 'demo-BK2-moved';

-- business failures wait for staff
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select * from pg_temp.sim(:'PROP', 'BOOKING', pg_temp.ev('E9', 'NEW', 'BK9', 'BDC-UNKNOWN', :'d0'::date + 60, :'d0'::date + 61, 100)) \gset e9_
select * from pg_temp.sim(:'PROP', 'BOOKING', pg_temp.ev('E10', 'NEW', 'BK10', 'BDC-CDBL', :'d0'::date + 60, :'d0'::date + 61, 100, 'USD')) \gset e10_
reset role;
select pg_temp.check('attention: unknown channel room code', :'e9_status' = 'NEEDS_ATTENTION' and :'e9_last_error' like 'OTA_MAPPING:%' and :'e9_next_attempt_at' = '');
select pg_temp.check('attention: other currency than the hotel', :'e10_status' = 'NEEDS_ATTENTION' and :'e10_last_error' like 'OTA_CURRENCY:%');

-- overbooking: the channel sells more junior suites than are free
select count(*) as jste_free from app_private.free_rooms(:'rt_jste', :'d0'::date + 70, :'d0'::date + 72) \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select public.ota_simulate_event(:'PROP', 'BOOKING', pg_temp.ev('OB' || n, 'NEW', 'OB' || n, 'BDC-JSTE', :'d0'::date + 70, :'d0'::date + 72, 360))
  from generate_series(1, :jste_free + 1) n;
reset role;
select pg_temp.check('overbooking: the extra channel booking is not squeezed in; it raises an alarm',
  (select count(*) from public.ota_inbound_events where external_event_id like 'demo-OB%' and status = 'PROCESSED') = :jste_free
  and (select status = 'NEEDS_ATTENTION' and last_error like 'OTA_NO_ROOM:%aşırı rezervasyon%' from public.ota_inbound_events where external_event_id = 'demo-OB' || (:jste_free + 1)));
select pg_temp.check('overbooking: no two active reservations share a junior suite night',
  not exists (select 1 from public.reservations a join public.reservations b on a.room_id = b.room_id and a.id < b.id
              where a.status not in ('CANCELLED', 'NO_SHOW') and b.status not in ('CANCELLED', 'NO_SHOW') and a.stay && b.stay));
select id as ob_last from public.ota_inbound_events where external_event_id = 'demo-OB' || (:jste_free + 1) \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select public.cancel_reservation((select id from public.reservations where external_ref = 'demo-OB1'), 'test');
select (public.ota_retry_event(:ob_last)).status as ob_retry \gset
reset role;
select pg_temp.check('attention: after a room is freed, staff retry the event and it goes through', :'ob_retry' = 'PROCESSED');
select pg_temp.check('dismiss: front desk cannot close an alarm',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); select public.ota_dismiss_event(%s, 'handled')$q$, :'FD', :e9_id)) like 'OTA_NOT_FOUND:%');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select pg_temp.check('dismiss: a note is required', pg_temp.try(format('select public.ota_dismiss_event(%s, %L)', :e9_id, '')) like 'OTA_INVALID:%');
select (public.ota_dismiss_event(:e9_id, 'Booking.com oda kodu düzeltildi, misafir telefonla onaylandı')).status as e9_dis \gset
reset role;
select pg_temp.check('dismiss: owner closes the alarm with a note', :'e9_dis' = 'DISMISSED');

-- LIVE ingest (what the webhook / pull worker calls)
select pg_temp.check('live: simulation is refused on a LIVE channel',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); select public.ota_simulate_event(%L, 'EXPEDIA', '{}')$q$, :'FD', :'PROP')) like 'OTA_INVALID:%gerçek modda%');
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select public.ota_ingest_event('axon-demo', 'AUR', 'EXPEDIA', :'SECRET', pg_temp.ev('X-1', 'NEW', 'EX1', 'EXP-DDBL', :'d0'::date + 80, :'d0'::date + 82, 250)) as x1 \gset
select public.ota_ingest_event('axon-demo', 'AUR', 'EXPEDIA', :'SECRET', pg_temp.ev('X-1', 'NEW', 'EX1', 'EXP-DDBL', :'d0'::date + 80, :'d0'::date + 82, 250)) as x1b \gset
reset role;
select pg_temp.check('live: Expedia booking via the ingest entry point', :'x1'::jsonb->>'status' = 'PROCESSED' and (:'x1'::jsonb->>'inserted')::boolean,
  :'x1'::jsonb->>'error');
select pg_temp.check('live: redelivered webhook acknowledged without a second booking',
  not (:'x1b'::jsonb->>'inserted')::boolean and (select count(*) from public.reservations where external_ref = 'EX1') = 1
  and (select r.commission_rate = c.commission_rate from public.reservations r join public.distribution_channels c on c.organization_id = r.organization_id and c.code = 'EXPEDIA' where r.external_ref = 'EX1'));
select pg_temp.check('live: wrong secret is refused',
  pg_temp.try(format($q$set role anon; select public.ota_ingest_event('axon-demo', 'AUR', 'EXPEDIA', 'wrong-secret-xxxxxxxxxxxxxxxx', %L)$q$,
    pg_temp.ev('X-2', 'NEW', 'EX2', 'EXP-DDBL', :'d0'::date + 80, :'d0'::date + 82, 250))) like 'FORBIDDEN:%');
select pg_temp.check('live: a DEMO channel does not accept real messages',
  pg_temp.try(format($q$set role anon; select public.ota_ingest_event('axon-demo', 'AUR', 'BOOKING', %L, %L)$q$, :'SECRET',
    pg_temp.ev('X-3', 'NEW', 'BX3', 'BDC-DDBL', :'d0'::date + 80, :'d0'::date + 82, 250))) like 'FORBIDDEN:%');
select pg_temp.check('validation: unknown kind, bad ids and oversized messages are refused',
  pg_temp.try(format($q$set role anon; select public.ota_ingest_event('axon-demo', 'AUR', 'EXPEDIA', %L, '{"event_id":"a b","kind":"NEW","reservation_id":"1"}')$q$, :'SECRET')) like 'OTA_INVALID:%'
  and pg_temp.try(format($q$set role anon; select public.ota_ingest_event('axon-demo', 'AUR', 'EXPEDIA', %L, '{"event_id":"ok1","kind":"DROP","reservation_id":"1"}')$q$, :'SECRET')) like 'OTA_INVALID:%'
  and pg_temp.try(format($q$set role anon; select public.ota_ingest_event('axon-demo', 'AUR', 'EXPEDIA', %L, %L)$q$, :'SECRET',
        jsonb_build_object('event_id', 'big', 'kind', 'NEW', 'reservation_id', 'B1', 'notes', repeat(md5(random()::text), 2000))::text)) like 'OTA_INVALID:%');
reset role;

-- tenant isolation and roles for channel data
select pg_temp.check('tenant: another hotel group sees none of these channel messages or queue rows',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false);
     do $d$ begin if (select count(*) from public.ota_inbound_events where property_id = %L) + (select count(*) from public.ota_outbox where property_id = %L)
                    + (select count(*) from public.ota_connections where property_id = %L) <> 0 then raise exception 'leak'; end if; end $d$$q$,
     :'OTHER', :'PROP', :'PROP', :'PROP')) is null);
select pg_temp.check('tenant: another hotel group cannot retry this hotel''s event',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); select public.ota_retry_event(%s)$q$, :'OTHER', :ob_last)) like 'OTA_NOT_FOUND:%');
select pg_temp.check('role: housekeeping cannot simulate channel bookings',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); select public.ota_simulate_event(%L, 'BOOKING', '{}')$q$, :'HK', :'PROP')) like 'FORBIDDEN:%');
select pg_temp.check('role: housekeeping cannot read channel messages (guest data)',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false);
     do $d$ begin if (select count(*) from public.ota_inbound_events) <> 0 then raise exception 'leak'; end if; end $d$$q$, :'HK')) is null);
select pg_temp.check('role: clients cannot write channel tables directly',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); update public.ota_connections set mode = 'LIVE'$q$, :'OWNER')) like '%permission denied%'
  and pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); delete from public.ota_outbox$q$, :'OWNER')) like '%permission denied%');
reset role;

-- ---------- audit log ----------
select pg_temp.check('audit: front desk reservation is logged with the user',
  exists (select 1 from public.audit_log where table_name = 'reservations' and row_id = :'r_fd' and action = 'INSERT' and actor_id = :'FD'::uuid and actor_kind = 'USER'));
select pg_temp.check('audit: channel booking is logged as SYSTEM (channel manager)',
  exists (select 1 from public.audit_log where table_name = 'reservations' and row_id = :'e1_reservation_id' and action = 'INSERT' and actor_kind = 'SYSTEM'));
select pg_temp.check('audit: a change stores old and new values',
  exists (select 1 from public.audit_log where table_name = 'rate_calendar' and action = 'UPDATE' and changes->'rate'->>'old' = '140.00' and changes->'rate'->>'new' = '145.00'));
select pg_temp.check('audit: cancellation is logged as a status change',
  exists (select 1 from public.audit_log where table_name = 'reservations' and row_id = :'e1_reservation_id' and changes->'status'->>'new' = 'CANCELLED'));
select pg_temp.check('audit: free-text and contact fields are redacted',
  (select changes->>'notes' = '•••' from public.audit_log where table_name = 'reservations' and row_id = :'r_fd' and action = 'INSERT')
  and exists (select 1 from public.audit_log where table_name = 'reservation_guests' and changes->>'full_name' = '•••'));
select pg_temp.check('kvkk: no e-mail address or phone number anywhere in the audit log',
  not exists (select 1 from public.audit_log where changes::text ~ '@|5321112233|170 ?1234567|222 ?33 ?44'));
select count(*) as audit_before from public.audit_log where table_name = 'rooms' \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select public.set_room_status((select id from public.rooms where property_id = :'PROP' and number = '101'), 'housekeeping', 'DIRTY');
reset role;
select pg_temp.check('audit: room status changes stay in their own log (no duplicate audit rows)',
  (select count(*) from public.audit_log where table_name = 'rooms') = :audit_before);
select pg_temp.check('audit: append-only even for the database owner',
  pg_temp.try('update public.audit_log set actor_kind = ''DB''') like 'AUDIT_IMMUTABLE:%'
  and pg_temp.try('delete from public.audit_log') like 'AUDIT_IMMUTABLE:%'
  and pg_temp.try('truncate public.audit_log') like 'AUDIT_IMMUTABLE:%');
select pg_temp.check('audit: clients cannot insert audit rows',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false);
     insert into public.audit_log (actor_kind, action, table_name, changes) values ('USER', 'INSERT', 'x', '{}')$q$, :'OWNER')) like '%permission denied%');
reset role;
select pg_temp.check('audit: owner reads the feed with actor names',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false);
     do $d$ begin if not exists (select 1 from public.audit_feed(%L) f where f.actor_name = 'AXON Kanal Yöneticisi') then raise exception 'no feed'; end if; end $d$$q$,
     :'OWNER', :'ORG')) is null);
select pg_temp.check('audit: front desk cannot read the audit feed or table',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false); select public.audit_feed(%L)$q$, :'FD', :'ORG')) like 'FORBIDDEN:%'
  and pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false);
     do $d$ begin if (select count(*) from public.audit_log) <> 0 then raise exception 'leak'; end if; end $d$$q$, :'FD')) is null);
select pg_temp.check('audit: another hotel group sees none of this group''s audit rows',
  pg_temp.try(format($q$set role authenticated; select set_config('request.jwt.claim.sub', %L, false);
     do $d$ begin if (select count(*) from public.audit_log where organization_id = %L) <> 0 then raise exception 'leak'; end if; end $d$$q$, :'OTHER', :'ORG')) is null);
reset role;

-- ---------- WhatsApp delivery retries ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select public.channel_configure(:'PROP', 'WHATSAPP', 'LIVE', '1234', 'inbox-secret-0123456789abcdef');
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select public.inbox_ingest('axon-demo', 'AUR', 'WHATSAPP', 'inbox-secret-0123456789abcdef', 'wamid.RETRY1', '905550000001', 'Deniz', 'Merhaba') as ing \gset
select (public.inbox_assistant_turn((:'ing'::jsonb->>'conversation_id')::uuid, 'inbox-secret-0123456789abcdef', 'GREETING', '{}', 'tr')->'message'->>'id')::bigint as wa_msg \gset
select public.inbox_set_delivery(:wa_msg, 'FAILED', 'inbox-secret-0123456789abcdef');
select jsonb_array_length(public.inbox_due_deliveries('axon-demo', 'AUR', 'WHATSAPP', 'inbox-secret-0123456789abcdef')) as due_now \gset
reset role;
select pg_temp.check('delivery: a failed send is scheduled again in about 2 minutes (not immediately)',
  (select delivery_attempts = 1 and next_delivery_at between now() + interval '100 seconds' and now() + interval '140 seconds' from public.messages where id = :wa_msg)
  and :due_now = 0);
update public.messages set next_delivery_at = now() - interval '1 second' where id = :wa_msg;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select public.inbox_due_deliveries('axon-demo', 'AUR', 'WHATSAPP', 'inbox-secret-0123456789abcdef') as due \gset
select public.inbox_set_delivery(:wa_msg, 'FAILED', 'inbox-secret-0123456789abcdef') from generate_series(1, 4);
reset role;
select pg_temp.check('delivery: once due, the worker gets it with the WhatsApp number',
  exists (select 1 from jsonb_array_elements(:'due'::jsonb) d where (d->>'id')::bigint = :wa_msg and d->>'thread_id' = '905550000001'));
select pg_temp.check('delivery: after 5 failed attempts it stops and stays visible as FAILED',
  (select delivery_status = 'FAILED' and delivery_attempts = 5 and next_delivery_at is null from public.messages where id = :wa_msg));
select pg_temp.check('delivery: wrong secret cannot list messages',
  pg_temp.try($q$set role anon; select public.inbox_due_deliveries('axon-demo', 'AUR', 'WHATSAPP', 'wrong-secret-xxxxxxxxxxxxxxxxxx')$q$) like 'FORBIDDEN:%');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select public.channel_configure(:'PROP', 'WHATSAPP', 'DEMO');
select public.ota_configure(:'PROP', 'EXPEDIA', 'DEMO');
reset role;

-- ---------- health ----------
set role anon;
select public.health_check() as hc \gset
reset role;
select pg_temp.check('health: anonymous health check answers without data', (:'hc'::jsonb->>'ok')::boolean and :'hc'::jsonb ? 'db_time' and not (:'hc'::jsonb ? 'property_id'));

\o
\set QUIET off
select n, case when ok then 'PASS' else 'FAIL' end as result, name, left(detail, 120) as detail from _results order by n;
do $$ declare f int; begin
  select count(*) into f from _results where not ok;
  if f > 0 then raise exception '% test(s) failed', f; end if;
  raise notice 'ALL % OTA/AUDIT TESTS PASSED', (select count(*) from _results);
end $$;
