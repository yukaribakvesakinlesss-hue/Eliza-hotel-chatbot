-- =====================================================================
-- AXON PMS · Phase 5 database tests (guest CRM, KVKK, inbox, assistant)
-- Runs after 10–60 in the same database (reuses their users).
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
\set SUP '55555555-5555-4555-8555-555555555555'

select (now() at time zone 'Europe/Istanbul')::date as today \gset
select (:'today'::date + 200) as d0 \gset
select id as rt_ddbl from public.room_types where property_id = :'PROP' and code = 'DDBL' \gset
select id as rt_jste from public.room_types where property_id = :'PROP' and code = 'JSTE' \gset

-- ---------- rates & quotes ----------
select pg_temp.check('rates: demo base rates are set', (select string_agg(code || '=' || base_rate, ',' order by code) from public.room_types where property_id = :'PROP') = 'CDBL=90.00,DDBL=120.00,JSTE=180.00');
insert into public.rate_calendar (organization_id, property_id, room_type_id, stay_date, rate) values (:'ORG', :'PROP', :'rt_ddbl', :'d0'::date + 1, 150);
select app_private.quote_room_type(:'rt_ddbl', :'d0'::date, :'d0'::date + 3) as q \gset
select pg_temp.check('quote: calendar rate overrides the base rate (120 + 150 + 120 = 390 net)', (:'q'::jsonb->>'net')::numeric = 390);
select pg_temp.check('quote: taxes per night like the folio (KDV 39.00, konaklama 7.80, brüt 436.80)',
  (:'q'::jsonb->>'vat')::numeric = 39 and (:'q'::jsonb->>'lodging')::numeric = 7.80 and (:'q'::jsonb->>'gross')::numeric = 436.80);
update public.room_types set base_rate = null where id = :'rt_jste';
select pg_temp.check('quote: a night without any rate makes the quote incomplete (no total invented)',
  (select (q->>'complete')::boolean = false and q->>'gross' is null from (select app_private.quote_room_type(:'rt_jste', :'d0'::date, :'d0'::date + 2) q) x));
select pg_temp.check('availability: counts only free, operational rooms of the type',
  (select (e->>'available')::int from jsonb_array_elements(app_private.availability_options(:'PROP', :'d0'::date, :'d0'::date + 3, 2)) e where e->>'code' = 'DDBL')
  = (select count(*) from public.rooms r where r.room_type_id = :'rt_ddbl' and not exists (select 1 from public.room_out_of_order_periods o where o.room_id = r.id and o.end_date is null)));

-- ---------- guest CRM: automatic profiles ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select id as rid1 from public.create_reservation(:'PROP', (select id from public.rooms where room_type_id = :'rt_ddbl' order by number limit 1), :'d0'::date, :'d0'::date + 2, 2, 0,
  'Elif Kaya', 'Elif.Kaya@Example.com', '0532 111 22 33', null, 'phone', 'CONFIRMED', null, 120, 'DIRECT') \gset
select id as rid2 from public.create_reservation(:'PROP', (select id from public.rooms where room_type_id = :'rt_ddbl' order by number limit 1), :'d0'::date + 10, :'d0'::date + 12, 2, 0,
  'Elif K.', null, '+90 532 111 2233', null, 'phone', 'CONFIRMED', null, 120, 'DIRECT') \gset
select guest_id as g1 from public.reservation_guests where reservation_id = :'rid1' \gset
select pg_temp.check('crm: a profile is created from the reservation guest', :'g1' is not null);
select pg_temp.check('crm: the same phone in another format links to the same profile',
  (select guest_id from public.reservation_guests where reservation_id = :'rid2') = :'g1'::uuid);
select pg_temp.check('crm: e-mail is stored lower-case, phone normalised',
  (select email = 'elif.kaya@example.com' and phone_normalized = '905321112233' from public.guests where id = :'g1'));
select public.guest_profile(:'g1') as prof \gset
select pg_temp.check('profile: stay history and counters', (:'prof'::jsonb->'stats'->>'upcoming')::int = 2 and jsonb_array_length(:'prof'::jsonb->'stays') = 2);
select pg_temp.check('profile: front desk cannot set VIP',
  pg_temp.try(format($q$select public.guest_update(%L, '{"vip_level": 2}')$q$, :'g1')) like 'FORBIDDEN:%');
select pg_temp.check('notes: preference and special request are stored',
  (select category from public.guest_add_note(:'g1', 'PREFERENCE', 'Yüksek kat, sessiz oda')) = 'PREFERENCE'
  and (select category from public.guest_add_note(:'g1', 'SPECIAL_REQUEST', 'Doğum günü pastası')) = 'SPECIAL_REQUEST');
select pg_temp.check('notes: invalid category is rejected', pg_temp.try(format($q$select public.guest_add_note(%L, 'GOSSIP', 'x')$q$, :'g1')) like 'GUEST_INVALID:%');
select pg_temp.check('kvkk: front desk cannot export or anonymize',
  pg_temp.try(format('select public.kvkk_export_guest(%L)', :'g1')) like 'FORBIDDEN:%'
  and pg_temp.try(format('select public.kvkk_anonymize_guest(%L)', :'g1')) like 'FORBIDDEN:%');
-- spend from the ledger: check in today's stay and post a night + extra
select id as rid3 from public.create_reservation(:'PROP', (select id from public.rooms r where r.room_type_id = :'rt_ddbl' and r.housekeeping_status = 'CLEAN' and r.occupancy_status = 'VACANT'
   and not exists (select 1 from public.reservations x where x.room_id = r.id and x.status not in ('CANCELLED', 'NO_SHOW') and x.stay && daterange(:'today'::date, :'today'::date + 1))
   and not exists (select 1 from public.room_out_of_order_periods o where o.room_id = r.id and o.end_date is null) order by number limit 1),
  :'today'::date, :'today'::date + 1, 1, 0, 'Elif Kaya', 'elif.kaya@example.com', null, null, 'phone', 'CONFIRMED', null, 100, 'DIRECT') \gset
select public.set_reservation_status(:'rid3', 'CHECKED_IN');
select public.post_room_charges(:'rid3');
select public.post_folio_transaction(:'rid3', 'EXTRA', 20, 'Minibar', 'FB_BEVERAGE', null, 0.20);
select public.post_folio_transaction(:'rid3', 'PAYMENT', 50, 'Kart', null, null, null, 'CARD');
select pg_temp.check('profile: total spend = charges incl. tax (100 + 12 + 20 + 4 = 136), payments are not spend',
  (select (public.guest_profile(:'g1')->'stats'->>'total_spend')::numeric) = 136);
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select pg_temp.check('profile: manager/owner can set VIP', (select vip_level from public.guest_update(:'g1', '{"vip_level": 2, "vip_note": "Sadık misafir"}')) = 2);
select pg_temp.check('access log: views, updates are recorded with the actor',
  (select count(*) from public.guest_access_log where guest_id = :'g1' and action = 'VIEW') >= 2
  and exists (select 1 from public.guest_access_log where guest_id = :'g1' and action = 'UPDATE' and actor_id = :'OWNER'::uuid));
select public.kvkk_export_guest(:'g1') as exp \gset
select pg_temp.check('kvkk: export contains profile, reservations, notes; export is logged',
  :'exp'::jsonb->'guest'->>'email' = 'elif.kaya@example.com' and jsonb_array_length(:'exp'::jsonb->'reservations') = 3
  and jsonb_array_length(:'exp'::jsonb->'notes') = 2 and exists (select 1 from public.guest_access_log where guest_id = :'g1' and action = 'EXPORT'));
select pg_temp.check('kvkk: a guest with active or future stays cannot be anonymized',
  pg_temp.try(format('select public.kvkk_anonymize_guest(%L)', :'g1')) like 'GUEST_ACTIVE_STAY:%');
reset role;

-- ---------- RLS ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'HK', false);
select pg_temp.check('housekeeping: no guest data, conversations or messages',
  (select count(*) from public.guests) = 0 and (select count(*) from public.conversations) = 0 and (select count(*) from public.messages) = 0);
select pg_temp.check('housekeeping: cannot open a guest profile', pg_temp.try(format('select public.guest_profile(%L)', :'g1')) like 'FORBIDDEN:%');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'SUP', false);
select pg_temp.check('housekeeping supervisor: no guest data', (select count(*) from public.guests) = 0);
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'OTHER', false);
select pg_temp.check('tenant B: sees no guests of tenant A', (select count(*) from public.guests where organization_id = :'ORG') = 0);
select pg_temp.check('tenant B: cannot open a tenant A profile', pg_temp.try(format('select public.guest_profile(%L)', :'g1')) like 'FORBIDDEN:%');
reset role;
set role anon;
select pg_temp.check('anon: no direct access to guests or messages',
  pg_temp.try('select count(*) from public.guests') is not null and pg_temp.try('select count(*) from public.messages') is not null);
select pg_temp.check('anon: channel secrets and chat tokens are unreachable',
  pg_temp.try('select count(*) from app_private.channel_secrets') is not null and pg_temp.try('select count(*) from app_private.webchat_sessions') is not null);

-- ---------- web chat (anon) ----------
select public.webchat_start('axon-demo', 'AUR', 'Web Misafir') as wc \gset
select (:'wc'::jsonb->>'conversation_id') as wc_id, (:'wc'::jsonb->>'token') as wc_tok \gset
select pg_temp.check('webchat: anonymous visitor starts a conversation and gets a token', :'wc_id' is not null and length(:'wc_tok') = 48);
select pg_temp.check('webchat: a wrong token is rejected', pg_temp.try(format($q$select public.webchat_send(%L, 'nope', 'merhaba', 'c1')$q$, :'wc_id')) like 'FORBIDDEN:%');
select (public.webchat_send(:'wc_id', :'wc_tok', 'Merhaba', 'c-1')->>'inserted') as send1 \gset
select (public.webchat_send(:'wc_id', :'wc_tok', 'Merhaba', 'c-1')->>'inserted') as send2 \gset
select pg_temp.check('webchat: send is idempotent per client message id',
  :'send1'::boolean and not :'send2'::boolean and (select count(*) from public.webchat_messages(:'wc_id', :'wc_tok')) = 1);

-- assistant: availability answer comes from the database
select public.inbox_assistant_turn(:'wc_id', :'wc_tok', 'AVAILABILITY', jsonb_build_object('check_in', :'d0'::date, 'check_out', :'d0'::date + 3, 'adults', 2), 'tr') as t1 \gset
select :'t1'::jsonb->'message'->>'body' as t1_body \gset
select pg_temp.check('assistant: availability reply quotes the database price for Deluxe Double (€436,80)',
  :'t1_body' like '%Deluxe Double: % oda müsait, 3 gece toplam €436,80 (vergiler dahil)%', :'t1_body');
select pg_temp.check('assistant: a room type without a rate gets NO price, only "fiyat sistemde tanımlı değil"',
  :'t1_body' like '%Junior Suite: % oda müsait; fiyat sistemde tanımlı değil, resepsiyon iletecek%' and :'t1_body' not like '%Junior Suite: %€%', :'t1_body');
select pg_temp.check('assistant: the reply stores the verified options as structured payload',
  (:'t1'::jsonb->'message'->'payload'->>'type') = 'availability' and jsonb_array_length(:'t1'::jsonb->'message'->'payload'->'options') = 3);
select pg_temp.check('assistant: a forged intent cannot change facts (asking with past dates is refused)',
  (select public.inbox_assistant_turn(:'wc_id', :'wc_tok', 'AVAILABILITY', jsonb_build_object('check_in', :'today'::date - 5, 'check_out', :'today'::date - 2), 'tr')->'message'->'payload'->>'type') = 'ask_dates');
-- booking request: asks for room type, then contact, then records a request (never a confirmed reservation)
select public.inbox_assistant_turn(:'wc_id', :'wc_tok', 'BOOKING', jsonb_build_object('check_in', :'d0'::date, 'check_out', :'d0'::date + 3), 'tr') as t2 \gset
select pg_temp.check('booking: with several types available the assistant asks which one', (:'t2'::jsonb->'message'->'payload'->>'type') = 'ask_room_type');
select public.inbox_assistant_turn(:'wc_id', :'wc_tok', 'BOOKING', '{"room_type": "DDBL"}', 'tr') as t3 \gset
select pg_temp.check('booking: without contact details it asks for name and phone/e-mail', (:'t3'::jsonb->'message'->'payload'->>'type') = 'ask_contact');
select public.inbox_assistant_turn(:'wc_id', :'wc_tok', 'BOOKING', '{"name": "Deniz Ak", "email": "deniz@example.com"}', 'tr') as t4 \gset
select :'t4'::jsonb->'message'->>'body' as t4_body \gset
select (:'t4'::jsonb->'message'->'payload'->>'booking_request_id') as br1 \gset
reset role;  -- the checks below read tables directly (the guest calls above ran as anon)
select pg_temp.check('booking: a NEW request is recorded with the quote the guest saw', (select status = 'NEW' and (quote->>'gross')::numeric = 436.80 from public.booking_requests where id = :'br1'::uuid));
select pg_temp.check('booking: the reply says it is not confirmed yet', :'t4_body' like '%onaylanana kadar rezervasyon kesinleşmiş değildir%' and :'t4_body' not like '%onaylandı%', :'t4_body');
select pg_temp.check('booking: repeating the same request does not create a duplicate',
  (select public.inbox_assistant_turn(:'wc_id', :'wc_tok', 'BOOKING', '{}', 'tr')->'message'->'payload'->>'booking_request_id') = :'br1'
  and (select count(*) from public.booking_requests where conversation_id = :'wc_id'::uuid) = 1);
select pg_temp.check('faq: verified answers only; unknown topics are not invented',
  (select public.inbox_assistant_turn(:'wc_id', :'wc_tok', 'FAQ', '{"topic": "breakfast"}', 'tr')->'message'->>'body') like 'Kahvaltı 07:30%'
  and (select public.inbox_assistant_turn(:'wc_id', :'wc_tok', 'FAQ', '{"topic": "spa"}', 'tr')->'message'->'payload'->>'verified') = 'false');
select pg_temp.check('handoff: the conversation goes to a human and the assistant stops replying',
  (select public.inbox_assistant_turn(:'wc_id', :'wc_tok', 'HANDOFF', '{}', 'tr')->>'replied') = 'true'
  and (select public.inbox_assistant_turn(:'wc_id', :'wc_tok', 'GREETING', '{}', 'tr')->>'replied') = 'false');
reset role;

-- ---------- WhatsApp: ingest with secret, idempotent webhooks ----------
select id as wa_conn from public.channel_connections where property_id = :'PROP' and channel = 'WHATSAPP' \gset
set role anon;
select pg_temp.check('ingest: refused while the channel is DEMO (no secret configured)',
  pg_temp.try($q$select public.inbox_ingest('axon-demo', 'AUR', 'WHATSAPP', 'secret-1-xxxxxxxxxxxxxxxxxxxx', 'wamid.1', '905551112233', 'Ali', 'merhaba')$q$) like 'FORBIDDEN:%');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select pg_temp.check('channels: front desk cannot switch a channel to LIVE',
  pg_temp.try(format($q$select public.channel_configure(%L, 'WHATSAPP', 'LIVE', null, 'secret-1-xxxxxxxxxxxxxxxxxxxx')$q$, :'PROP')) like 'FORBIDDEN:%');
select set_config('request.jwt.claim.sub', :'OWNER', false);
select pg_temp.check('channels: a short secret is refused', pg_temp.try(format($q$select public.channel_configure(%L, 'WHATSAPP', 'LIVE', null, 'short')$q$, :'PROP')) like 'INBOX_INVALID:%');
select public.channel_configure(:'PROP', 'WHATSAPP', 'LIVE', '123456789', 'secret-1-xxxxxxxxxxxxxxxxxxxx');
reset role;
set role anon;
select pg_temp.check('ingest: a wrong secret is refused',
  pg_temp.try($q$select public.inbox_ingest('axon-demo', 'AUR', 'WHATSAPP', 'wrong', 'wamid.1', '905551112233', 'Ali', 'merhaba')$q$) like 'FORBIDDEN:%');
select public.inbox_ingest('axon-demo', 'AUR', 'WHATSAPP', 'secret-1-xxxxxxxxxxxxxxxxxxxx', 'wamid.1', '905551112233', 'Ali Veli', 'Müsait oda var mı?') as i1 \gset
select public.inbox_ingest('axon-demo', 'AUR', 'WHATSAPP', 'secret-1-xxxxxxxxxxxxxxxxxxxx', 'wamid.1', '905551112233', 'Ali Veli', 'Müsait oda var mı?') as i2 \gset
select public.inbox_assistant_turn((:'i1'::jsonb->>'conversation_id')::uuid, 'secret-1-xxxxxxxxxxxxxxxxxxxx', 'GREETING', '{}', 'tr') as wa_turn \gset
reset role;  -- table checks below
select pg_temp.check('webhook retry: the same WhatsApp message id is stored once (second delivery inserted=false)',
  (:'i1'::jsonb->>'inserted')::boolean and not (:'i2'::jsonb->>'inserted')::boolean
  and (select count(*) from public.messages where external_id = 'wamid.1') = 1);
select pg_temp.check('ingest: the ingest secret also authorizes the assistant reply for that conversation (called as anon)',
  (:'wa_turn'::jsonb->>'replied') = 'true');
select pg_temp.check('ingest: a reply on a LIVE channel waits for the adapter (PENDING)',
  (select delivery_status from public.messages where conversation_id = (:'i1'::jsonb->>'conversation_id')::uuid and sender = 'AI' order by id desc limit 1) = 'PENDING');
select pg_temp.check('channels: the secret is stored only as a hash',
  (select ingest_secret_hash = app_private.sha256('secret-1-xxxxxxxxxxxxxxxxxxxx') and ingest_secret_hash <> 'secret-1-xxxxxxxxxxxxxxxxxxxx' from app_private.channel_secrets where connection_id = :'wa_conn'));
update public.channel_connections set mode = 'DEMO' where id = :'wa_conn';
delete from app_private.channel_secrets where connection_id = :'wa_conn';

-- ---------- staff inbox ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select public.inbox_simulate_inbound(:'PROP', 'INSTAGRAM', 'ayse.travels', 'Ayşe', 'Kahvaltı dahil mi?', 'ig-1') as s1 \gset
select public.inbox_simulate_inbound(:'PROP', 'INSTAGRAM', 'ayse.travels', 'Ayşe', 'Kahvaltı dahil mi?', 'ig-1') as s2 \gset
select pg_temp.check('demo: simulated Instagram message is marked DEMO and idempotent',
  (select is_demo from public.conversations where id = (:'s1'::jsonb->>'conversation_id')::uuid)
  and (:'s1'::jsonb->>'inserted')::boolean and not (:'s2'::jsonb->>'inserted')::boolean);
select (:'s1'::jsonb->>'conversation_id') as ig_conv \gset
select pg_temp.check('demo: AI replies on a DEMO channel are marked DEMO_NOT_SENT (never claimed as sent)',
  (select public.inbox_assistant_turn(:'ig_conv', null, 'FAQ', '{"topic": "breakfast"}', 'tr')->'message'->>'delivery_status') = 'DEMO_NOT_SENT');
select sender as staff_sender from public.inbox_send_staff_message(:'ig_conv', 'Evet, kahvaltı dahildir.', 'k1') \gset
select pg_temp.check('staff: a reply takes the conversation over (HUMAN)',
  :'staff_sender' = 'STAFF' and (select status from public.conversations where id = :'ig_conv') = 'HUMAN');
select pg_temp.check('staff: the same reply sent twice (double click) is stored once',
  (select id from public.inbox_send_staff_message(:'ig_conv', 'Evet, kahvaltı dahildir.', 'k1'))
  = (select id from public.messages where conversation_id = :'ig_conv' and sender = 'STAFF' order by id limit 1)
  and (select count(*) from public.messages where conversation_id = :'ig_conv' and sender = 'STAFF') = 1);
select pg_temp.check('staff: give back to AI', (select status from public.inbox_set_status(:'ig_conv', 'AI')) = 'AI');
select pg_temp.check('staff: cannot write messages directly',
  pg_temp.try(format($q$insert into public.messages (organization_id, property_id, conversation_id, channel, direction, sender, body) values (%L, %L, %L, 'INSTAGRAM', 'OUT', 'AI', 'fake price €1')$q$, :'ORG', :'PROP', :'ig_conv')) is not null);
select pg_temp.check('staff: link a conversation to a new guest profile', (select guest_id is not null from public.inbox_link_guest(:'ig_conv', null)));

-- one-click booking from the request
select pg_temp.check('one click: the request becomes a CONFIRMED reservation in a free room of the type',
  (select status = 'CONFIRMED' and reservation_id is not null from public.booking_request_confirm(:'br1'::uuid)));
select reservation_id as rr from public.booking_requests where id = :'br1'::uuid \gset
select pg_temp.check('one click: reservation matches the request (dates, type, quoted average rate 130.00)',
  (select r.check_in = :'d0'::date and r.check_out = :'d0'::date + 3 and r.nightly_rate = 130 and rm.room_type_id = :'rt_ddbl'
   from public.reservations r join public.rooms rm on rm.id = r.room_id where r.id = :'rr'::uuid));
select pg_temp.check('one click: a second click returns the same reservation',
  (select reservation_id from public.booking_request_confirm(:'br1'::uuid)) = :'rr'::uuid
  and (select count(*) from public.reservations where notes = 'Mesaj kutusundan oluşturuldu') = 1);
select pg_temp.check('one click: the guest gets a confirmation message in the chat',
  exists (select 1 from public.messages where conversation_id = :'wc_id'::uuid and sender = 'SYSTEM' and body like 'Rezervasyonunuz onaylandı:%'));
reset role;

-- ---------- KVKK: anonymize & retention ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select id as rid_old from public.create_reservation(:'PROP', (select id from public.rooms where room_type_id = :'rt_ddbl' order by number desc limit 1),
  :'d0'::date + 40, :'d0'::date + 41, 1, 0, 'Eski Misafir', 'eski@example.com', '+44 7700 900123', null, 'email', 'CONFIRMED', null, 100, 'DIRECT') \gset
select guest_id as g_old from public.reservation_guests where reservation_id = :'rid_old' \gset
select public.cancel_reservation(:'rid_old', 'test');
reset role;
update public.conversations set guest_id = :'g_old' where id = :'ig_conv';
update public.guests set last_activity_at = now() - interval '40 months' where id = :'g_old';
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
select pg_temp.check('retention: an inactive guest past the retention period is listed',
  exists (select 1 from public.kvkk_retention_candidates(:'ORG') where guest_id = :'g_old'::uuid));
select (anonymized_at is not null and email is null and phone is null and full_name = 'Anonim misafir') as anon_ok from public.kvkk_anonymize_guest(:'g_old') \gset
select pg_temp.check('anonymize: personal data is removed from profile, bookings and chats',
  :'anon_ok'::boolean
  and (select email is null and phone is null from public.reservation_guests where reservation_id = :'rid_old')
  and not exists (select 1 from public.messages where conversation_id = :'ig_conv' and sender = 'GUEST' and body <> '[KVKK: anonimleştirildi]')
  and (select contact_handle is null from public.conversations where id = :'ig_conv'));
select pg_temp.check('anonymize: the reservation itself is kept (accounting), and the action is logged',
  exists (select 1 from public.reservations where id = :'rid_old') and exists (select 1 from public.guest_access_log where guest_id = :'g_old' and action = 'ANONYMIZE'));
reset role;

select pg_temp.check('realtime: conversations, messages, booking requests are published',
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('conversations', 'messages', 'booking_requests')) = 3);
update public.room_types set base_rate = 180 where id = :'rt_jste';

\o
\set QUIET off
select n, case when ok then 'PASS' else 'FAIL' end as result, name, detail from _results order by n;
do $$ declare f int; begin
  select count(*) into f from _results where not ok;
  if f > 0 then raise exception '% test(s) failed', f; end if;
  raise notice 'ALL % CRM/INBOX TESTS PASSED', (select count(*) from _results);
end $$;
