-- =====================================================================
-- AXON Hotel PMS · Phase 6 · OTA channel manager, retries, audit log, ops
--
-- * ota_connections / ota_room_mappings: Booking.com and Expedia per property,
--   DEMO until an owner/manager switches a channel to LIVE.
-- * ota_outbox: "dirty dates" queue for availability + rate (ARI) pushes.
--   Triggers mark dates dirty; the worker reads the CURRENT availability and
--   rate when it sends, so a queued row can never push stale numbers.
-- * ota_inbound_events: reservations / modifications / cancellations from the
--   channels. Unique per (connection, external event id), so a redelivered
--   webhook or a repeated pull is stored once. Processing runs as the
--   channel-manager service account through the normal reservation RPCs
--   (same overbooking guard, folio, audit). Transient failures are retried
--   with exponential backoff; business failures (no free room, unknown room
--   code) wait for staff as NEEDS_ATTENTION.
-- * messages: delivery retries for WhatsApp / Instagram replies.
-- * audit_log: append-only change log for configuration, rooms, rates,
--   reservations, guests, memberships and channel settings (PII redacted).
-- * health_check(): liveness of the database for monitoring.
-- Idempotent: safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Channel-manager service account (cannot log in: no password, banned,
-- undeliverable e-mail). Reservations from OTAs are attributed to it.
-- ---------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-4000-a000-0000000000c1', 'channel-manager@axon.invalid', '{"full_name": "AXON Kanal Yöneticisi"}'::jsonb)
on conflict (id) do nothing;
do $$ begin
  execute 'update auth.users set banned_until = ''2999-01-01'' where id = ''00000000-0000-4000-a000-0000000000c1''';
exception when undefined_column then null; end $$;
insert into public.users (id, email, full_name)
values ('00000000-0000-4000-a000-0000000000c1', 'channel-manager@axon.invalid', 'AXON Kanal Yöneticisi')
on conflict (id) do nothing;

create or replace function app_private.channel_manager_id() returns uuid
language sql immutable set search_path = '' as $$ select '00000000-0000-4000-a000-0000000000c1'::uuid $$;

-- ---------------------------------------------------------------------
-- Reservations: link to the channel's own reservation id
-- ---------------------------------------------------------------------
alter table public.reservations add column if not exists external_ref text
  check (external_ref is null or external_ref ~ '^[A-Za-z0-9_.:-]{1,60}$');
create unique index if not exists reservations_external_ref_key
  on public.reservations (property_id, channel_code, external_ref) where external_ref is not null;

-- ---------------------------------------------------------------------
-- OTA connections and room mappings
-- ---------------------------------------------------------------------
create table if not exists public.ota_connections (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  property_id        uuid not null,
  channel_code       text not null check (channel_code in ('BOOKING', 'EXPEDIA')),
  mode               text not null default 'DEMO' check (mode in ('DEMO', 'LIVE')),
  enabled            boolean not null default true,
  external_hotel_id  text check (external_hotel_id is null or external_hotel_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  last_push_at       timestamptz,
  last_pull_at       timestamptz,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade,
  foreign key (organization_id, channel_code) references public.distribution_channels(organization_id, code),
  unique (property_id, channel_code),
  unique (id, property_id)
);
drop trigger if exists ota_connections_touch on public.ota_connections;
create trigger ota_connections_touch before update on public.ota_connections for each row execute function app_private.touch_updated_at();

-- one worker secret per property (stored as a hash; the plain value lives only in the server env)
create table if not exists app_private.ota_worker_secrets (
  property_id  uuid primary key references public.properties(id) on delete cascade,
  secret_hash  text not null
);

create table if not exists public.ota_room_mappings (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  property_id           uuid not null,
  connection_id         uuid not null,
  room_type_id          uuid not null,
  external_room_id      text not null check (external_room_id ~ '^[A-Za-z0-9_.:-]{1,40}$'),
  external_rate_plan_id text not null default 'BAR' check (external_rate_plan_id ~ '^[A-Za-z0-9_.:-]{1,40}$'),
  created_at            timestamptz not null default now(),
  foreign key (connection_id, property_id) references public.ota_connections(id, property_id) on delete cascade,
  foreign key (room_type_id, property_id) references public.room_types(id, property_id) on delete cascade,
  unique (connection_id, room_type_id),
  unique (connection_id, external_room_id)
);

-- every property gets a Booking.com and an Expedia connection in DEMO mode
insert into public.ota_connections (organization_id, property_id, channel_code)
select p.organization_id, p.id, c.code from public.properties p
join public.distribution_channels c on c.organization_id = p.organization_id and c.code in ('BOOKING', 'EXPEDIA')
on conflict (property_id, channel_code) do nothing;

create or replace function app_private.add_default_ota_connections() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ota_connections (organization_id, property_id, channel_code)
  select new.organization_id, new.id, c.code from public.distribution_channels c
   where c.organization_id = new.organization_id and c.code in ('BOOKING', 'EXPEDIA')
  on conflict (property_id, channel_code) do nothing;
  return null;
end $$;
drop trigger if exists properties_default_ota on public.properties;
create trigger properties_default_ota after insert on public.properties
  for each row execute function app_private.add_default_ota_connections();

-- ---------------------------------------------------------------------
-- ARI outbox ("dirty dates")
-- ---------------------------------------------------------------------
create table if not exists public.ota_outbox (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  property_id      uuid not null,
  connection_id    uuid not null,
  room_type_id     uuid not null,
  stay_date        date not null,
  status           text not null default 'PENDING' check (status in ('PENDING', 'FAILED', 'SENT', 'DEMO_SKIPPED', 'DEAD')),
  attempts         smallint not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  last_sent        jsonb,
  queued_at        timestamptz not null default now(),
  sent_at          timestamptz,
  foreign key (connection_id, property_id) references public.ota_connections(id, property_id) on delete cascade,
  foreign key (room_type_id, property_id) references public.room_types(id, property_id) on delete cascade
);
-- at most one open row per connection / room type / night: repeated changes coalesce
create unique index if not exists ota_outbox_open_key on public.ota_outbox (connection_id, room_type_id, stay_date)
  where status in ('PENDING', 'FAILED');
create index if not exists ota_outbox_due_idx on public.ota_outbox (property_id, next_attempt_at) where status in ('PENDING', 'FAILED');

create or replace function app_private.ota_mark_dirty(p_property uuid, p_room_type uuid, p_from date, p_to date) returns void
language plpgsql security definer set search_path = '' as $$
declare v_today date; v_from date; v_to date;
begin
  if p_property is null then return; end if;
  v_today := app_private.property_today(p_property);
  if v_today is null then return; end if;            -- property being deleted
  v_from := greatest(coalesce(p_from, v_today), v_today);
  v_to := least(coalesce(p_to, v_today + 366), v_today + 366);   -- channels take 365 nights ahead
  if v_to <= v_from then return; end if;
  insert into public.ota_outbox (organization_id, property_id, connection_id, room_type_id, stay_date)
  select c.organization_id, c.property_id, c.id, m.room_type_id, d::date
    from public.ota_connections c
    join public.ota_room_mappings m on m.connection_id = c.id
    cross join generate_series(v_from, v_to - 1, interval '1 day') d
   where c.property_id = p_property and c.enabled and (p_room_type is null or m.room_type_id = p_room_type)
  on conflict (connection_id, room_type_id, stay_date) where status in ('PENDING', 'FAILED') do update set queued_at = now();
end $$;

create or replace function app_private.ota_on_reservation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.room_id = old.room_id and new.check_in = old.check_in and new.check_out = old.check_out
     and (new.status in ('CANCELLED', 'NO_SHOW')) = (old.status in ('CANCELLED', 'NO_SHOW')) then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    perform app_private.ota_mark_dirty(old.property_id, (select room_type_id from public.rooms where id = old.room_id), old.check_in, old.check_out);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform app_private.ota_mark_dirty(new.property_id, (select room_type_id from public.rooms where id = new.room_id), new.check_in, new.check_out);
  end if;
  return null;
end $$;
drop trigger if exists reservations_ota_ari on public.reservations;
create trigger reservations_ota_ari after insert or delete or update of room_id, check_in, check_out, status on public.reservations
  for each row execute function app_private.ota_on_reservation();

create or replace function app_private.ota_on_ooo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform app_private.ota_mark_dirty(old.property_id, (select room_type_id from public.rooms where id = old.room_id), old.start_date, old.end_date);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform app_private.ota_mark_dirty(new.property_id, (select room_type_id from public.rooms where id = new.room_id), new.start_date, new.end_date);
  end if;
  return null;
end $$;
drop trigger if exists ooo_ota_ari on public.room_out_of_order_periods;
create trigger ooo_ota_ari after insert or update or delete on public.room_out_of_order_periods
  for each row execute function app_private.ota_on_ooo();

create or replace function app_private.ota_on_room() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform app_private.ota_mark_dirty(old.property_id, old.room_type_id, null, null); end if;
  if tg_op in ('INSERT', 'UPDATE') then perform app_private.ota_mark_dirty(new.property_id, new.room_type_id, null, null); end if;
  return null;
end $$;
drop trigger if exists rooms_ota_ari on public.rooms;
create trigger rooms_ota_ari after insert or delete or update of room_type_id on public.rooms
  for each row execute function app_private.ota_on_room();

create or replace function app_private.ota_on_rate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'room_types' then
    perform app_private.ota_mark_dirty(new.property_id, new.id, null, null);
  else
    if tg_op in ('UPDATE', 'DELETE') then perform app_private.ota_mark_dirty(old.property_id, old.room_type_id, old.stay_date, old.stay_date + 1); end if;
    if tg_op in ('INSERT', 'UPDATE') then perform app_private.ota_mark_dirty(new.property_id, new.room_type_id, new.stay_date, new.stay_date + 1); end if;
  end if;
  return null;
end $$;
drop trigger if exists rate_calendar_ota_ari on public.rate_calendar;
create trigger rate_calendar_ota_ari after insert or update or delete on public.rate_calendar
  for each row execute function app_private.ota_on_rate();
drop trigger if exists room_types_ota_ari on public.room_types;
create trigger room_types_ota_ari after update of base_rate on public.room_types
  for each row when (new.base_rate is distinct from old.base_rate) execute function app_private.ota_on_rate();

create or replace function app_private.ota_on_mapping() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    delete from public.ota_outbox where connection_id = old.connection_id and room_type_id = old.room_type_id and status in ('PENDING', 'FAILED');
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform app_private.ota_mark_dirty(new.property_id, new.room_type_id, null, null);   -- initial full sync of the mapped room type
  end if;
  return null;
end $$;
drop trigger if exists ota_mappings_ari on public.ota_room_mappings;
create trigger ota_mappings_ari after insert or update or delete on public.ota_room_mappings
  for each row execute function app_private.ota_on_mapping();

-- ---------------------------------------------------------------------
-- Inbound events (reservations from the channels)
-- ---------------------------------------------------------------------
create table if not exists public.ota_inbound_events (
  id                       bigint generated always as identity primary key,
  organization_id          uuid not null,
  property_id              uuid not null,
  connection_id            uuid not null,
  external_event_id        text not null check (external_event_id ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  kind                     text not null check (kind in ('NEW', 'MODIFY', 'CANCEL')),
  external_reservation_id  text not null check (external_reservation_id ~ '^[A-Za-z0-9_.:-]{1,60}$'),
  payload                  jsonb not null,
  is_demo                  boolean not null default false,
  status                   text not null default 'RECEIVED'
                           check (status in ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED', 'NEEDS_ATTENTION', 'DEAD', 'DISMISSED')),
  outcome                  text,
  attempts                 smallint not null default 0,
  next_attempt_at          timestamptz,
  last_error               text,
  reservation_id           uuid references public.reservations(id) on delete set null,
  received_at              timestamptz not null default now(),
  processed_at             timestamptz,
  handled_by               uuid references public.users(id) on delete set null,
  foreign key (connection_id, property_id) references public.ota_connections(id, property_id) on delete cascade,
  unique (connection_id, external_event_id)
);
create index if not exists ota_events_property_idx on public.ota_inbound_events (property_id, received_at desc);
create index if not exists ota_events_due_idx on public.ota_inbound_events (next_attempt_at) where status = 'FAILED';

-- ---------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------
-- owner / manager of the property, or the server worker holding the property's secret
create or replace function app_private.ota_can_operate(p_property uuid, p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app_private.property_role(p_property)::text in ('owner', 'manager'), false)
      or (p_secret is not null and exists (select 1 from app_private.ota_worker_secrets s
                                           where s.property_id = p_property and s.secret_hash = app_private.sha256(p_secret)))
$$;

-- ---------------------------------------------------------------------
-- Applying one event. Runs as the channel-manager service account so the
-- standard reservation RPCs (role checks, overbooking guard, folio,
-- audit) are used unchanged.
-- ---------------------------------------------------------------------
create or replace function app_private.ota_become_system(p_property uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.properties where id = p_property;
  insert into public.memberships (organization_id, user_id, property_id, role)
  select v_org, app_private.channel_manager_id(), p_property, 'front_desk'
   where not exists (select 1 from public.memberships m where m.user_id = app_private.channel_manager_id() and m.property_id = p_property);
  -- transaction-local; reverted with the surrounding sub-transaction
  perform set_config('request.jwt.claims', jsonb_build_object('sub', app_private.channel_manager_id(), 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', app_private.channel_manager_id()::text, true);
end $$;

create or replace function app_private.ota_apply(p_ev public.ota_inbound_events) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_conn public.ota_connections; v_prop public.properties; v_map public.ota_room_mappings; v_res public.reservations; v_new public.reservations;
  p jsonb := p_ev.payload; v_in date; v_out date; v_nights int; v_total numeric; v_rate numeric; v_room uuid; v_cur_type uuid;
  v_adults int; v_children int; v_moved boolean := false; v_try int := 0; v_name text;
begin
  select * into v_conn from public.ota_connections where id = p_ev.connection_id;
  select * into v_prop from public.properties where id = p_ev.property_id;
  select * into v_res from public.reservations
   where property_id = p_ev.property_id and channel_code = v_conn.channel_code and external_ref = p_ev.external_reservation_id;

  if p_ev.kind = 'CANCEL' then
    if v_res.id is null then
      raise exception 'OTA_NOT_FOUND: % rezervasyonu % henüz sistemde yok.', v_conn.channel_code, p_ev.external_reservation_id using errcode = 'P0001';
    end if;
    if v_res.status = 'CANCELLED' then return jsonb_build_object('outcome', 'ALREADY_CANCELLED', 'reservation_id', v_res.id); end if;
    perform public.cancel_reservation(v_res.id, 'Kanal iptali (' || v_conn.channel_code || ' ' || p_ev.external_reservation_id || ')');
    return jsonb_build_object('outcome', 'CANCELLED', 'reservation_id', v_res.id);
  end if;

  -- NEW / MODIFY need stay data
  begin
    v_in := (p->>'check_in')::date;
    v_out := (p->>'check_out')::date;
    v_adults := coalesce((p->>'adults')::int, 2);
    v_children := coalesce((p->>'children')::int, 0);
    v_total := (p->>'total_amount')::numeric;
  exception when others then
    raise exception 'OTA_INVALID: Kanal mesajında tarih, kişi veya tutar okunamadı.' using errcode = 'P0001';
  end;
  if v_in is null or v_out is null or v_out <= v_in then
    raise exception 'OTA_INVALID: Kanal mesajındaki tarihler geçersiz.' using errcode = 'P0001';
  end if;
  if v_total is null or v_total < 0 then
    raise exception 'OTA_INVALID: Kanal mesajında toplam tutar yok.' using errcode = 'P0001';
  end if;
  if upper(coalesce(p->>'currency', v_prop.currency)) <> v_prop.currency then
    raise exception 'OTA_CURRENCY: Kanal % para birimiyle gönderdi; otel para birimi %.', p->>'currency', v_prop.currency using errcode = 'P0001';
  end if;
  select * into v_map from public.ota_room_mappings where connection_id = v_conn.id and external_room_id = p->>'room_id';
  if v_map.id is null then
    raise exception 'OTA_MAPPING: Kanal oda kodu "%" hiçbir oda tipiyle eşleşmiyor.', p->>'room_id' using errcode = 'P0001';
  end if;
  v_nights := v_out - v_in;
  v_rate := round(v_total / v_nights, 2);
  v_name := coalesce(nullif(trim(p->'guest'->>'name'), ''), 'Misafir (' || v_conn.channel_code || ')');

  if p_ev.kind = 'NEW' then
    if v_res.id is not null then
      return jsonb_build_object('outcome', 'DUPLICATE', 'reservation_id', v_res.id);
    end if;
    -- first free room of the mapped type; another booking may win a room in between, so try the next one
    for v_room in select f.room_id from app_private.free_rooms(v_map.room_type_id, v_in, v_out) as f(room_id) limit 5 loop
      begin
        v_new := public.create_reservation(p_ev.property_id, v_room, v_in, v_out, v_adults, v_children, v_name,
                   p->'guest'->>'email', p->'guest'->>'phone',
                   left(concat_ws(' · ', v_conn.channel_code || ' ' || p_ev.external_reservation_id,
                                  case when p_ev.is_demo then 'DEMO kanal simülasyonu' end, nullif(p->>'notes', '')), 1000),
                   'ota', 'CONFIRMED', left('ota-' || v_conn.id || '-' || p_ev.external_reservation_id, 100), v_rate, v_conn.channel_code, false);
        exit;
      exception when others then
        if sqlerrm not like 'RES_CONFLICT%' then raise; end if;
      end;
    end loop;
    if v_new.id is null then
      raise exception 'OTA_NO_ROOM: % için % – % arasında boş % odası yok. Kanal oda sattı: aşırı rezervasyon, hemen müdahale edin.',
        v_conn.channel_code, app_private.fmt_date(v_in), app_private.fmt_date(v_out),
        (select name from public.room_types where id = v_map.room_type_id) using errcode = 'P0001';
    end if;
    update public.reservations set external_ref = p_ev.external_reservation_id where id = v_new.id;
    return jsonb_build_object('outcome', 'CREATED', 'reservation_id', v_new.id);
  end if;

  -- MODIFY
  if v_res.id is null then
    raise exception 'OTA_NOT_FOUND: Değiştirilecek % rezervasyonu % henüz sistemde yok.', v_conn.channel_code, p_ev.external_reservation_id using errcode = 'P0001';
  end if;
  if v_res.status not in ('PENDING', 'CONFIRMED', 'CHECKED_IN') then
    raise exception 'OTA_BAD_STATE: % durumundaki rezervasyon kanaldan değiştirilemez.', v_res.status using errcode = 'P0001';
  end if;
  select room_type_id into v_cur_type from public.rooms where id = v_res.room_id;
  if v_cur_type = v_map.room_type_id then
    begin
      perform public.update_reservation(v_res.id, null, v_in, v_out, v_adults, v_children, null, null);
    exception when others then
      if sqlerrm not like 'RES_CONFLICT%' then raise; end if;
      v_moved := true;
    end;
  else
    v_moved := true;
  end if;
  if v_moved then
    v_moved := false;
    for v_room in select f.room_id from app_private.free_rooms(v_map.room_type_id, v_in, v_out) as f(room_id) limit 5 loop
      begin
        perform public.update_reservation(v_res.id, v_room, v_in, v_out, v_adults, v_children, null, null);
        v_moved := true;
        exit;
      exception when others then
        if sqlerrm not like 'RES_CONFLICT%' then raise; end if;
      end;
    end loop;
    if not v_moved then
      raise exception 'OTA_NO_ROOM: Değişiklik için % – % arasında boş oda yok; rezervasyon eski haliyle duruyor.',
        app_private.fmt_date(v_in), app_private.fmt_date(v_out) using errcode = 'P0001';
    end if;
  end if;
  -- new price applies to nights not yet posted (only before check-in; in-house changes stay with the front desk)
  select * into v_res from public.reservations where id = v_res.id;
  if v_res.status in ('PENDING', 'CONFIRMED') and v_res.nightly_rate <> v_rate then
    update public.reservations set nightly_rate = v_rate, version = version + 1, updated_by = auth.uid() where id = v_res.id;
  end if;
  if nullif(trim(p->'guest'->>'name'), '') is not null then
    update public.reservation_guests set full_name = left(trim(p->'guest'->>'name'), 120),
           email = coalesce(nullif(lower(trim(p->'guest'->>'email')), ''), email), phone = coalesce(nullif(trim(p->'guest'->>'phone'), ''), phone)
     where reservation_id = v_res.id and is_primary;
  end if;
  return jsonb_build_object('outcome', case when v_moved then 'MODIFIED_ROOM_CHANGED' else 'MODIFIED' end, 'reservation_id', v_res.id);
end $$;

create or replace function app_private.ota_process(p_event_id bigint) returns public.ota_inbound_events
language plpgsql security definer set search_path = '' as $$
declare
  v_ev public.ota_inbound_events; v_out jsonb; v_state text; v_msg text; v_transient boolean;
  v_claims text := current_setting('request.jwt.claims', true); v_sub text := current_setting('request.jwt.claim.sub', true);
begin
  select * into v_ev from public.ota_inbound_events where id = p_event_id for update;
  if v_ev.id is null or v_ev.status in ('PROCESSED', 'IGNORED', 'DISMISSED') then return v_ev; end if;
  begin
    perform app_private.ota_become_system(v_ev.property_id);
    v_out := app_private.ota_apply(v_ev);
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
    update public.ota_inbound_events
       set status = case when v_out->>'outcome' in ('DUPLICATE', 'ALREADY_CANCELLED') then 'IGNORED' else 'PROCESSED' end,
           outcome = v_out->>'outcome', reservation_id = (v_out->>'reservation_id')::uuid, processed_at = now(),
           attempts = attempts + 1, next_attempt_at = null, last_error = null,
           payload = payload - 'guest'          -- guest data now lives on the reservation (KVKK: no extra copy)
     where id = v_ev.id returning * into v_ev;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
    v_transient := v_state in ('40001', '40P01', '55P03', '57014', '53300') or v_msg like 'OTA_NOT_FOUND%';
    update public.ota_inbound_events
       set attempts = attempts + 1,
           status = case when not v_transient then 'NEEDS_ATTENTION' when attempts + 1 >= 8 then 'DEAD' else 'FAILED' end,
           next_attempt_at = case when v_transient and attempts + 1 < 8
                                  then now() + least(power(2, attempts + 1) * interval '1 minute', interval '6 hours') end,
           last_error = left(v_msg, 500)
     where id = v_ev.id returning * into v_ev;
  end;
  return v_ev;
end $$;

-- stores an event once; returns (id, inserted)
create or replace function app_private.ota_store_event(p_conn public.ota_connections, p_event jsonb, p_demo boolean)
returns table (event_id bigint, inserted boolean) language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_ext text := p_event->>'event_id'; v_kind text := upper(p_event->>'kind');
begin
  if jsonb_typeof(p_event) <> 'object' or pg_column_size(p_event) > 20000 then
    raise exception 'OTA_INVALID: Kanal mesajı geçersiz veya çok büyük.' using errcode = 'P0001';
  end if;
  if v_ext is null or v_ext !~ '^[A-Za-z0-9_.:-]{1,70}$' or v_kind not in ('NEW', 'MODIFY', 'CANCEL')
     or coalesce(p_event->>'reservation_id', '') !~ '^[A-Za-z0-9_.:-]{1,50}$' then
    raise exception 'OTA_INVALID: Mesaj kimliği, türü (NEW/MODIFY/CANCEL) veya rezervasyon numarası geçersiz.' using errcode = 'P0001';
  end if;
  insert into public.ota_inbound_events (organization_id, property_id, connection_id, external_event_id, kind, external_reservation_id, payload, is_demo)
  values (p_conn.organization_id, p_conn.property_id, p_conn.id, case when p_demo then 'demo-' else '' end || v_ext, v_kind,
          case when p_demo then 'demo-' else '' end || (p_event->>'reservation_id'),
          jsonb_strip_nulls(jsonb_build_object('room_id', p_event->>'room_id', 'rate_plan_id', p_event->>'rate_plan_id',
            'check_in', p_event->>'check_in', 'check_out', p_event->>'check_out', 'adults', p_event->'adults', 'children', p_event->'children',
            'total_amount', p_event->'total_amount', 'currency', p_event->>'currency', 'notes', left(p_event->>'notes', 300),
            'guest', jsonb_strip_nulls(jsonb_build_object('name', left(p_event->'guest'->>'name', 120), 'email', left(p_event->'guest'->>'email', 160),
                                                          'phone', left(p_event->'guest'->>'phone', 30))))),
          p_demo)
  on conflict (connection_id, external_event_id) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.ota_inbound_events
     where connection_id = p_conn.id and external_event_id = case when p_demo then 'demo-' else '' end || v_ext;
    return query select v_id, false;
  else
    return query select v_id, true;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Public RPCs: worker (secret) and staff
-- ---------------------------------------------------------------------
create or replace function public.ota_worker_context(p_org_slug text, p_property_code text, p_secret text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_prop public.properties;
begin
  select p.* into v_prop from public.properties p join public.organizations o on o.id = p.organization_id
   where o.slug = p_org_slug and p.code = upper(p_property_code);
  if v_prop.id is null or not app_private.ota_can_operate(v_prop.id, p_secret) then
    raise exception 'FORBIDDEN: Kanal yöneticisi anahtarı hatalı.' using errcode = '42501';
  end if;
  return jsonb_build_object('property_id', v_prop.id, 'timezone', v_prop.timezone, 'currency', v_prop.currency,
    'connections', coalesce((select jsonb_agg(jsonb_build_object('channel', c.channel_code, 'mode', c.mode, 'enabled', c.enabled,
                     'hotel_id', c.external_hotel_id, 'last_pull_at', c.last_pull_at) order by c.channel_code)
                   from public.ota_connections c where c.property_id = v_prop.id), '[]'::jsonb));
end $$;

-- inbound event from a channel (webhook push or the worker's pull); stored once, processed at once
create or replace function public.ota_ingest_event(p_org_slug text, p_property_code text, p_channel text, p_secret text, p_event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_prop public.properties; v_conn public.ota_connections; v_id bigint; v_ins boolean; v_ev public.ota_inbound_events;
begin
  select p.* into v_prop from public.properties p join public.organizations o on o.id = p.organization_id
   where o.slug = p_org_slug and p.code = upper(p_property_code);
  select * into v_conn from public.ota_connections where property_id = v_prop.id and channel_code = upper(p_channel) and mode = 'LIVE' and enabled;
  if v_conn.id is null or p_secret is null
     or not exists (select 1 from app_private.ota_worker_secrets s where s.property_id = v_prop.id and s.secret_hash = app_private.sha256(p_secret)) then
    raise exception 'FORBIDDEN: Kanal gerçek modda değil veya anahtar hatalı.' using errcode = '42501';
  end if;
  select s.event_id, s.inserted into v_id, v_ins from app_private.ota_store_event(v_conn, p_event, false) s;
  if v_ins then
    v_ev := app_private.ota_process(v_id);
  else
    select * into v_ev from public.ota_inbound_events where id = v_id;
  end if;
  return jsonb_build_object('event_id', v_ev.id, 'inserted', v_ins, 'status', v_ev.status, 'outcome', v_ev.outcome,
                            'reservation_id', v_ev.reservation_id, 'error', v_ev.last_error);
end $$;

-- DEMO: staff simulate a channel booking / change / cancellation (never on a LIVE channel)
create or replace function public.ota_simulate_event(p_property_id uuid, p_channel text, p_event jsonb)
returns public.ota_inbound_events language plpgsql security definer set search_path = '' as $$
declare v_conn public.ota_connections; v_id bigint; v_ins boolean; v_ev public.ota_inbound_events;
begin
  perform app_private.require_front_desk(p_property_id);
  select * into v_conn from public.ota_connections where property_id = p_property_id and channel_code = upper(p_channel);
  if v_conn.id is null then raise exception 'OTA_INVALID: Kanal bulunamadı.' using errcode = 'P0001'; end if;
  if v_conn.mode <> 'DEMO' then
    raise exception 'OTA_INVALID: Kanal gerçek modda; simülasyon kapalı.' using errcode = 'P0001';
  end if;
  select s.event_id, s.inserted into v_id, v_ins from app_private.ota_store_event(v_conn, p_event, true) s;
  if v_ins then return app_private.ota_process(v_id); end if;
  select * into v_ev from public.ota_inbound_events where id = v_id;
  return v_ev;
end $$;

-- staff: retry one event now (after fixing a mapping or moving a room)
create or replace function public.ota_retry_event(p_event_id bigint)
returns public.ota_inbound_events language plpgsql security definer set search_path = '' as $$
declare v_ev public.ota_inbound_events;
begin
  select * into v_ev from public.ota_inbound_events where id = p_event_id for update;
  if v_ev.id is null or coalesce(app_private.property_role(v_ev.property_id)::text, '') not in ('owner', 'manager', 'front_desk') then
    raise exception 'OTA_NOT_FOUND: Kanal mesajı bulunamadı.' using errcode = 'P0001';
  end if;
  if v_ev.status not in ('FAILED', 'NEEDS_ATTENTION', 'DEAD') then return v_ev; end if;
  update public.ota_inbound_events set status = 'FAILED', handled_by = auth.uid() where id = v_ev.id;
  return app_private.ota_process(v_ev.id);
end $$;

-- staff: the event was handled by hand (e.g. guest relocated); keeps the record, stops the alarm
create or replace function public.ota_dismiss_event(p_event_id bigint, p_note text)
returns public.ota_inbound_events language plpgsql security definer set search_path = '' as $$
declare v_ev public.ota_inbound_events;
begin
  select * into v_ev from public.ota_inbound_events where id = p_event_id for update;
  if v_ev.id is null or coalesce(app_private.property_role(v_ev.property_id)::text, '') not in ('owner', 'manager') then
    raise exception 'OTA_NOT_FOUND: Kanal mesajı bulunamadı veya yetkiniz yok.' using errcode = 'P0001';
  end if;
  if char_length(trim(coalesce(p_note, ''))) < 3 then
    raise exception 'OTA_INVALID: Kapatmak için ne yapıldığını yazın.' using errcode = 'P0001';
  end if;
  if v_ev.status not in ('FAILED', 'NEEDS_ATTENTION', 'DEAD') then
    raise exception 'OTA_BAD_STATE: Yalnızca hatalı mesajlar kapatılabilir.' using errcode = 'P0001';
  end if;
  update public.ota_inbound_events set status = 'DISMISSED', outcome = 'MANUAL: ' || left(trim(p_note), 200), handled_by = auth.uid(),
         processed_at = now(), next_attempt_at = null, payload = payload - 'guest'
   where id = v_ev.id returning * into v_ev;
  return v_ev;
end $$;

-- worker: retry due inbound events, purge old sent outbox rows
create or replace function public.ota_retry_due(p_property_id uuid, p_secret text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_ev public.ota_inbound_events; v_done int := 0; v_ok int := 0; v_purged int;
begin
  if not app_private.ota_can_operate(p_property_id, p_secret) then
    raise exception 'FORBIDDEN: Kanal senkronizasyonu için yetkiniz yok.' using errcode = '42501';
  end if;
  for v_id in select id from public.ota_inbound_events where property_id = p_property_id and status = 'FAILED' and next_attempt_at <= now()
               order by id limit 50 for update skip locked loop
    v_ev := app_private.ota_process(v_id);
    v_done := v_done + 1;
    if v_ev.status in ('PROCESSED', 'IGNORED') then v_ok := v_ok + 1; end if;
  end loop;
  delete from public.ota_outbox where property_id = p_property_id and status in ('SENT', 'DEMO_SKIPPED') and sent_at < now() - interval '30 days';
  get diagnostics v_purged = row_count;
  return jsonb_build_object('retried', v_done, 'succeeded', v_ok, 'purged', v_purged);
end $$;

-- worker: claim due ARI rows with the CURRENT availability and rate (2-minute lease)
create or replace function public.ota_claim_outbox(p_property_id uuid, p_secret text default null, p_limit int default 500) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_items jsonb;
begin
  if not app_private.ota_can_operate(p_property_id, p_secret) then
    raise exception 'FORBIDDEN: Kanal senkronizasyonu için yetkiniz yok.' using errcode = '42501';
  end if;
  with due as (
    select o.id from public.ota_outbox o
     where o.property_id = p_property_id and o.status in ('PENDING', 'FAILED') and o.next_attempt_at <= now()
     order by o.stay_date, o.id limit least(greatest(coalesce(p_limit, 500), 1), 1000)
     for update skip locked
  ), claimed as (
    update public.ota_outbox o set next_attempt_at = now() + interval '2 minutes' from due where o.id = due.id
    returning o.id, o.connection_id, o.room_type_id, o.stay_date, o.attempts
  ), ari as (
    select c.*, k.channel_code, k.mode, k.external_hotel_id, m.external_room_id, m.external_rate_plan_id, p.currency,
           (select count(*) from app_private.free_rooms(c.room_type_id, c.stay_date, c.stay_date + 1))::int as available,
           (app_private.quote_room_type(c.room_type_id, c.stay_date, c.stay_date + 1)->'nights'->0->>'rate')::numeric as rate
      from claimed c
      join public.ota_connections k on k.id = c.connection_id
      join public.ota_room_mappings m on m.connection_id = c.connection_id and m.room_type_id = c.room_type_id
      join public.properties p on p.id = k.property_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'channel', channel_code, 'mode', mode, 'hotel_id', external_hotel_id,
           'room_id', external_room_id, 'rate_plan_id', external_rate_plan_id, 'date', stay_date, 'available', available,
           'rate', rate, 'currency', currency,
           -- no verified price → the night is closed on the channel, never sold at a guessed price
           'closed', rate is null, 'attempts', attempts) order by channel_code, stay_date), '[]'::jsonb)
    into v_items from ari;
  return v_items;
end $$;

-- worker: record results. result: SENT | DEMO | RETRY (network, 5xx, 429) | REJECTED (4xx: wrong ids, needs a person)
create or replace function public.ota_outbox_result(p_property_id uuid, p_secret text, p_results jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; v_n int := 0;
begin
  if not app_private.ota_can_operate(p_property_id, p_secret) then
    raise exception 'FORBIDDEN: Kanal senkronizasyonu için yetkiniz yok.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_results) <> 'array' or jsonb_array_length(p_results) > 1000 then
    raise exception 'OTA_INVALID: Sonuç listesi geçersiz.' using errcode = 'P0001';
  end if;
  for r in select * from jsonb_array_elements(p_results) loop
    if r->>'result' not in ('SENT', 'DEMO', 'RETRY', 'REJECTED') then
      raise exception 'OTA_INVALID: Bilinmeyen sonuç %.', r->>'result' using errcode = 'P0001';
    end if;
    update public.ota_outbox o set
      status = case r->>'result' when 'SENT' then 'SENT' when 'DEMO' then 'DEMO_SKIPPED' when 'REJECTED' then 'DEAD'
                                 else case when o.attempts + 1 >= 10 then 'DEAD' else 'FAILED' end end,
      attempts = o.attempts + case when r->>'result' in ('RETRY', 'REJECTED') then 1 else 0 end,
      next_attempt_at = case when r->>'result' = 'RETRY' then now() + least(power(2, o.attempts + 1) * interval '1 minute', interval '6 hours') else o.next_attempt_at end,
      last_error = case when r->>'result' in ('RETRY', 'REJECTED') then left(r->>'error', 500) end,
      last_sent = case when r->>'result' in ('SENT', 'DEMO') then jsonb_strip_nulls(jsonb_build_object('available', r->'available', 'rate', r->'rate', 'closed', r->'closed')) else o.last_sent end,
      sent_at = case when r->>'result' in ('SENT', 'DEMO') then now() else o.sent_at end
    where o.id = (r->>'id')::bigint and o.property_id = p_property_id and o.status in ('PENDING', 'FAILED');
    if found then v_n := v_n + 1; end if;
  end loop;
  update public.ota_connections c set last_push_at = now(),
         last_error = (select left(x->>'error', 300) from jsonb_array_elements(p_results) x where x->>'result' in ('RETRY', 'REJECTED') limit 1)
   where c.property_id = p_property_id
     and c.id in (select o.connection_id from public.ota_outbox o where o.id in (select (x->>'id')::bigint from jsonb_array_elements(p_results) x));
  return jsonb_build_object('updated', v_n);
end $$;

create or replace function public.ota_mark_pulled(p_property_id uuid, p_secret text, p_channel text, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.ota_can_operate(p_property_id, p_secret) then
    raise exception 'FORBIDDEN: Kanal senkronizasyonu için yetkiniz yok.' using errcode = '42501';
  end if;
  update public.ota_connections set last_pull_at = case when p_error is null then now() else last_pull_at end, last_error = left(p_error, 300)
   where property_id = p_property_id and channel_code = upper(p_channel);
end $$;

-- owners / managers: DEMO ↔ LIVE, hotel id, worker secret
create or replace function public.ota_configure(p_property_id uuid, p_channel text, p_mode text, p_hotel_id text default null,
  p_secret text default null, p_enabled boolean default true)
returns public.ota_connections language plpgsql security definer set search_path = '' as $$
declare v_conn public.ota_connections;
begin
  if coalesce(app_private.property_role(p_property_id)::text, '') not in ('owner', 'manager') then
    raise exception 'FORBIDDEN: Kanal ayarlarını yalnızca otel sahibi veya müdür değiştirebilir.' using errcode = '42501';
  end if;
  if upper(p_channel) not in ('BOOKING', 'EXPEDIA') or p_mode not in ('DEMO', 'LIVE') then
    raise exception 'OTA_INVALID: Kanal veya mod geçersiz.' using errcode = 'P0001';
  end if;
  if p_hotel_id is not null and p_hotel_id !~ '^[A-Za-z0-9_-]{1,40}$' then
    raise exception 'OTA_INVALID: Otel kimliği yalnızca harf, rakam, - ve _ içerebilir.' using errcode = 'P0001';
  end if;
  if p_secret is not null then
    if char_length(p_secret) < 24 then
      raise exception 'OTA_INVALID: Gizli anahtar en az 24 karakter olmalı.' using errcode = 'P0001';
    end if;
    insert into app_private.ota_worker_secrets (property_id, secret_hash) values (p_property_id, app_private.sha256(p_secret))
    on conflict (property_id) do update set secret_hash = excluded.secret_hash;
  end if;
  select * into v_conn from public.ota_connections where property_id = p_property_id and channel_code = upper(p_channel) for update;
  if p_mode = 'LIVE' then
    if coalesce(nullif(p_hotel_id, ''), v_conn.external_hotel_id) is null then
      raise exception 'OTA_INVALID: Gerçek mod için kanalın otel kimliği gerekli.' using errcode = 'P0001';
    end if;
    if not exists (select 1 from app_private.ota_worker_secrets where property_id = p_property_id) then
      raise exception 'OTA_INVALID: Gerçek mod için sunucu gizli anahtarı tanımlanmalı.' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.ota_room_mappings where connection_id = v_conn.id) then
      raise exception 'OTA_INVALID: Gerçek moddan önce en az bir oda tipini kanal oda koduyla eşleştirin.' using errcode = 'P0001';
    end if;
  end if;
  update public.ota_connections set mode = p_mode, enabled = coalesce(p_enabled, true),
         external_hotel_id = coalesce(nullif(trim(p_hotel_id), ''), external_hotel_id)
   where id = v_conn.id returning * into v_conn;
  if p_mode = 'LIVE' then
    perform app_private.ota_mark_dirty(p_property_id, null, null, null);   -- full push when a channel goes live
  end if;
  return v_conn;
end $$;

create or replace function public.ota_set_mapping(p_property_id uuid, p_channel text, p_room_type_id uuid, p_external_room_id text,
  p_rate_plan_id text default 'BAR')
returns public.ota_room_mappings language plpgsql security definer set search_path = '' as $$
declare v_conn public.ota_connections; v_map public.ota_room_mappings;
begin
  if coalesce(app_private.property_role(p_property_id)::text, '') not in ('owner', 'manager') then
    raise exception 'FORBIDDEN: Oda eşleştirmesini yalnızca otel sahibi veya müdür değiştirebilir.' using errcode = '42501';
  end if;
  select * into v_conn from public.ota_connections where property_id = p_property_id and channel_code = upper(p_channel);
  if v_conn.id is null or not exists (select 1 from public.room_types where id = p_room_type_id and property_id = p_property_id) then
    raise exception 'OTA_INVALID: Kanal veya oda tipi bulunamadı.' using errcode = 'P0001';
  end if;
  if nullif(trim(p_external_room_id), '') is null then
    delete from public.ota_room_mappings where connection_id = v_conn.id and room_type_id = p_room_type_id returning * into v_map;
    return v_map;
  end if;
  if trim(p_external_room_id) !~ '^[A-Za-z0-9_.:-]{1,40}$' or coalesce(trim(p_rate_plan_id), 'BAR') !~ '^[A-Za-z0-9_.:-]{1,40}$' then
    raise exception 'OTA_INVALID: Kanal oda / fiyat planı kodu yalnızca harf, rakam ve . _ : - içerebilir.' using errcode = 'P0001';
  end if;
  begin
    insert into public.ota_room_mappings (organization_id, property_id, connection_id, room_type_id, external_room_id, external_rate_plan_id)
    values (v_conn.organization_id, p_property_id, v_conn.id, p_room_type_id, trim(p_external_room_id), coalesce(nullif(trim(p_rate_plan_id), ''), 'BAR'))
    on conflict (connection_id, room_type_id) do update
       set external_room_id = excluded.external_room_id, external_rate_plan_id = excluded.external_rate_plan_id
    returning * into v_map;
  exception when unique_violation then
    raise exception 'OTA_INVALID: Bu kanal oda kodu başka bir oda tipine bağlı.' using errcode = 'P0001';
  end;
  return v_map;
end $$;

-- owners / managers: queue a full 365-night push (e.g. after the channel fixed something on their side)
create or replace function public.ota_full_resync(p_property_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if coalesce(app_private.property_role(p_property_id)::text, '') not in ('owner', 'manager') then
    raise exception 'FORBIDDEN: Yalnızca otel sahibi veya müdür.' using errcode = '42501';
  end if;
  update public.ota_outbox set status = 'FAILED', next_attempt_at = now(), attempts = 0 where property_id = p_property_id and status = 'DEAD'
     and not exists (select 1 from public.ota_outbox x where x.connection_id = ota_outbox.connection_id and x.room_type_id = ota_outbox.room_type_id
                     and x.stay_date = ota_outbox.stay_date and x.status in ('PENDING', 'FAILED'));
  perform app_private.ota_mark_dirty(p_property_id, null, null, null);
  select count(*) into v_n from public.ota_outbox where property_id = p_property_id and status in ('PENDING', 'FAILED');
  return jsonb_build_object('queued', v_n);
end $$;

-- ---------------------------------------------------------------------
-- WhatsApp / Instagram: delivery retries for outgoing messages
-- ---------------------------------------------------------------------
alter table public.messages add column if not exists delivery_attempts smallint not null default 0;
alter table public.messages add column if not exists next_delivery_at timestamptz;
create index if not exists messages_redeliver_idx on public.messages (property_id, next_delivery_at) where delivery_status in ('FAILED', 'PENDING');

create or replace function public.inbox_set_delivery(p_message_id bigint, p_status text, p_token text default null)
returns public.messages language plpgsql security definer set search_path = '' as $$
declare v_msg public.messages; v_conv public.conversations;
begin
  select * into v_msg from public.messages where id = p_message_id for update;
  select * into v_conv from public.conversations where id = v_msg.conversation_id;
  if v_msg.id is null or not app_private.inbox_authorized(v_conv, p_token) then
    raise exception 'INBOX_NOT_FOUND: Mesaj bulunamadı.' using errcode = 'P0001';
  end if;
  if v_msg.direction <> 'OUT' or p_status not in ('SENT', 'DELIVERED', 'FAILED', 'DEMO_NOT_SENT') then
    raise exception 'INBOX_INVALID: Teslim durumu geçersiz.' using errcode = 'P0001';
  end if;
  update public.messages set delivery_status = p_status,
         delivery_attempts = delivery_attempts + case when p_status in ('SENT', 'FAILED') then 1 else 0 end,
         -- failed sends are retried 2, 4, 8, 16 minutes later; after 5 attempts staff see "not delivered"
         next_delivery_at = case when p_status = 'FAILED' and delivery_attempts + 1 < 5
                                 then now() + power(2, delivery_attempts + 1) * interval '1 minute' end
   where id = v_msg.id returning * into v_msg;
  return v_msg;
end $$;

-- worker: outgoing messages of a LIVE channel that are due for (re)delivery
create or replace function public.inbox_due_deliveries(p_org_slug text, p_property_code text, p_channel text, p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_prop public.properties;
begin
  select p.* into v_prop from public.properties p join public.organizations o on o.id = p.organization_id
   where o.slug = p_org_slug and p.code = upper(p_property_code);
  if v_prop.id is null or p_secret is null or not exists (
       select 1 from public.channel_connections c join app_private.channel_secrets s on s.connection_id = c.id
        where c.property_id = v_prop.id and c.channel = upper(p_channel) and c.mode = 'LIVE' and s.ingest_secret_hash = app_private.sha256(p_secret)) then
    raise exception 'FORBIDDEN: Kanal bağlı değil veya gizli anahtar hatalı.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'delivery_status', m.delivery_status,
                                                       'thread_id', c.external_thread_id, 'attempts', m.delivery_attempts) order by m.id)
    from public.messages m join public.conversations c on c.id = m.conversation_id
   where m.property_id = v_prop.id and m.channel = upper(p_channel) and m.direction = 'OUT' and not c.is_demo
     and ((m.delivery_status = 'FAILED' and m.next_delivery_at <= now())
          -- the server stopped between storing and sending
          or (m.delivery_status = 'PENDING' and m.delivery_attempts = 0 and m.created_at < now() - interval '5 minutes'))
     and m.created_at > now() - interval '24 hours'),   -- Meta only allows free-form replies inside 24 h
   '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- Audit log (append-only; personal data redacted)
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id               bigint generated always as identity primary key,
  organization_id  uuid,
  property_id      uuid,
  actor_id         uuid,
  actor_kind       text not null check (actor_kind in ('USER', 'SYSTEM', 'DB')),
  action           text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  table_name       text not null,
  row_id           text,
  changes          jsonb not null,
  at               timestamptz not null default now()
);
create index if not exists audit_log_org_idx on public.audit_log (organization_id, id desc);
create index if not exists audit_log_row_idx on public.audit_log (table_name, row_id);

create or replace function app_private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_row jsonb;
  v_changes jsonb := '{}'::jsonb;
  k text;
  v_ignore text[] := array['updated_at', 'version', 'updated_by', 'created_at'] || tg_argv;
  v_redact text[] := array['full_name', 'email', 'phone', 'phone_normalized', 'nationality', 'contact_name', 'contact_email',
                           'contact_phone', 'contact_handle', 'vip_note', 'notes', 'cancel_reason', 'answer_tr', 'answer_en'];
  v_uid uuid := auth.uid();
begin
  v_row := coalesce(v_new, v_old);
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      continue when k = any(v_ignore) or (v_old->k) is not distinct from (v_new->k);
      v_changes := v_changes || jsonb_build_object(k, case when k = any(v_redact) then jsonb_build_object('changed', true)
                                                           else jsonb_build_object('old', v_old->k, 'new', v_new->k) end);
    end loop;
    if v_changes = '{}'::jsonb then return null; end if;
  else
    for k in select jsonb_object_keys(v_row) loop
      continue when k = any(v_ignore) or v_row->k = 'null'::jsonb;
      v_changes := v_changes || jsonb_build_object(k, case when k = any(v_redact) then '"•••"'::jsonb else v_row->k end);
    end loop;
  end if;
  insert into public.audit_log (organization_id, property_id, actor_id, actor_kind, action, table_name, row_id, changes)
  values (coalesce((v_row->>'organization_id')::uuid, case when tg_table_name = 'organizations' then (v_row->>'id')::uuid end),
          coalesce((v_row->>'property_id')::uuid, case when tg_table_name = 'properties' then (v_row->>'id')::uuid end),
          v_uid, case when v_uid is null then 'DB' when v_uid = app_private.channel_manager_id() then 'SYSTEM' else 'USER' end,
          tg_op, tg_table_name, v_row->>'id', v_changes);
  return null;
end $$;

create or replace function app_private.audit_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'AUDIT_IMMUTABLE: Denetim kaydı değiştirilemez veya silinemez.' using errcode = 'P0001';
end $$;
drop trigger if exists audit_log_no_update on public.audit_log;
create trigger audit_log_no_update before update or delete on public.audit_log for each row execute function app_private.audit_immutable();
drop trigger if exists audit_log_no_truncate on public.audit_log;
create trigger audit_log_no_truncate before truncate on public.audit_log for each statement execute function app_private.audit_immutable();

do $$
declare t record;
begin
  for t in select * from (values
    ('organizations', array[]::text[]),
    ('properties', array[]::text[]),
    ('memberships', array[]::text[]),
    ('room_types', array[]::text[]),
    -- room statuses have their own log (room_status_events)
    ('rooms', array['occupancy_status', 'housekeeping_status', 'maintenance_status', 'maintenance_note', 'status_updated_at', 'status_updated_by']),
    ('reservations', array[]::text[]),
    ('reservation_guests', array[]::text[]),
    ('rate_calendar', array[]::text[]),
    ('distribution_channels', array[]::text[]),
    ('folios', array[]::text[]),
    ('guests', array['last_activity_at']),
    ('booking_requests', array['quote']),
    ('channel_connections', array[]::text[]),
    ('property_faq', array[]::text[]),
    ('ota_connections', array['last_push_at', 'last_pull_at', 'last_error']),
    ('ota_room_mappings', array[]::text[])
  ) as x(tbl, ignore_cols) loop
    execute format('drop trigger if exists audit_row on public.%I', t.tbl);
    execute format('create trigger audit_row after insert or update or delete on public.%I for each row execute function app_private.audit_row(%s)',
                   t.tbl, (select coalesce(string_agg(quote_literal(c), ', '), '') from unnest(t.ignore_cols) c));
  end loop;
end $$;

-- owners / managers: readable feed with the actor's name
create or replace function public.audit_feed(p_organization_id uuid, p_table text default null, p_before_id bigint default null, p_limit int default 100)
returns table (id bigint, at timestamptz, actor_kind text, actor_name text, action text, table_name text, row_id text, property_id uuid, changes jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(app_private.is_org_admin(p_organization_id), false) then
    raise exception 'FORBIDDEN: Denetim kaydını yalnızca otel sahibi veya müdür görebilir.' using errcode = '42501';
  end if;
  return query
    select a.id, a.at, a.actor_kind, coalesce(u.full_name, u.email, case a.actor_kind when 'DB' then 'Veritabanı' else '—' end),
           a.action, a.table_name, a.row_id, a.property_id, a.changes
      from public.audit_log a left join public.users u on u.id = a.actor_id
     where a.organization_id = p_organization_id
       and (p_table is null or a.table_name = p_table)
       and (p_before_id is null or a.id < p_before_id)
     order by a.id desc
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

-- ---------------------------------------------------------------------
-- Health check for monitoring (no data)
-- ---------------------------------------------------------------------
create or replace function public.health_check() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', true, 'db_time', now(), 'schema', '20261108000700')
$$;

-- ---------------------------------------------------------------------
-- RLS and privileges
-- ---------------------------------------------------------------------
alter table public.ota_connections enable row level security;
alter table public.ota_room_mappings enable row level security;
alter table public.ota_outbox enable row level security;
alter table public.ota_inbound_events enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists ota_conn_select on public.ota_connections;
create policy ota_conn_select on public.ota_connections for select to authenticated
  using (app_private.property_role(property_id)::text in ('owner', 'manager', 'front_desk'));
drop policy if exists ota_map_select on public.ota_room_mappings;
create policy ota_map_select on public.ota_room_mappings for select to authenticated
  using (app_private.property_role(property_id)::text in ('owner', 'manager', 'front_desk'));
drop policy if exists ota_outbox_select on public.ota_outbox;
create policy ota_outbox_select on public.ota_outbox for select to authenticated
  using (app_private.property_role(property_id)::text in ('owner', 'manager', 'front_desk'));
drop policy if exists ota_events_select on public.ota_inbound_events;
create policy ota_events_select on public.ota_inbound_events for select to authenticated
  using (app_private.property_role(property_id)::text in ('owner', 'manager', 'front_desk'));
drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log for select to authenticated using (app_private.is_org_admin(organization_id));

revoke all on public.ota_connections, public.ota_room_mappings, public.ota_outbox, public.ota_inbound_events, public.audit_log from anon, authenticated;
grant select on public.ota_connections, public.ota_room_mappings, public.ota_outbox, public.ota_inbound_events, public.audit_log to authenticated;
revoke all on app_private.ota_worker_secrets from public, anon, authenticated;

do $$ declare f text; begin
  foreach f in array array[
    'app_private.channel_manager_id()', 'app_private.add_default_ota_connections()', 'app_private.ota_mark_dirty(uuid, uuid, date, date)',
    'app_private.ota_on_reservation()', 'app_private.ota_on_ooo()', 'app_private.ota_on_room()', 'app_private.ota_on_rate()',
    'app_private.ota_on_mapping()', 'app_private.ota_can_operate(uuid, text)', 'app_private.ota_become_system(uuid)',
    'app_private.ota_apply(public.ota_inbound_events)', 'app_private.ota_process(bigint)',
    'app_private.ota_store_event(public.ota_connections, jsonb, boolean)', 'app_private.audit_row()', 'app_private.audit_immutable()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.ota_simulate_event(uuid, text, jsonb)', 'public.ota_retry_event(bigint)', 'public.ota_dismiss_event(bigint, text)',
    'public.ota_configure(uuid, text, text, text, text, boolean)', 'public.ota_set_mapping(uuid, text, uuid, text, text)',
    'public.ota_full_resync(uuid)', 'public.audit_feed(uuid, text, bigint, integer)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- server worker entry points (anon key + property secret); each checks the secret or the caller's role
  foreach f in array array[
    'public.ota_worker_context(text, text, text)', 'public.ota_ingest_event(text, text, text, text, jsonb)',
    'public.ota_retry_due(uuid, text)', 'public.ota_claim_outbox(uuid, text, integer)', 'public.ota_outbox_result(uuid, text, jsonb)',
    'public.ota_mark_pulled(uuid, text, text, text)', 'public.inbox_set_delivery(bigint, text, text)',
    'public.inbox_due_deliveries(text, text, text, text)', 'public.health_check()'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- RLS performance: the read policies of the busy tables called a role
-- function for EVERY row (measured: 14-day tape chart 2 ms without RLS,
-- 30 ms with it; a year of finance rows would take seconds). The same
-- rules are now expressed as "property_id in (the caller's properties)",
-- which PostgreSQL evaluates once per query. Same meaning:
--   my_property_ids()       = has_property_access(property_id)
--   my_staff_property_ids() = property_role(property_id) in (owner, manager, front_desk)
--   my_admin_org_ids()      = is_org_admin(organization_id)
-- ---------------------------------------------------------------------
create or replace function app_private.my_property_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct p.id from public.memberships m join public.properties p on p.organization_id = m.organization_id
   where m.user_id = auth.uid() and (m.property_id is null or m.property_id = p.id)
$$;
create or replace function app_private.my_staff_property_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct p.id from public.memberships m join public.properties p on p.organization_id = m.organization_id
   where m.user_id = auth.uid() and (m.property_id is null or m.property_id = p.id) and m.role in ('owner', 'manager', 'front_desk')
$$;
create or replace function app_private.my_admin_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct m.organization_id from public.memberships m
   where m.user_id = auth.uid() and m.property_id is null and m.role in ('owner', 'manager')
$$;
revoke all on function app_private.my_property_ids() from public, anon;
revoke all on function app_private.my_staff_property_ids() from public, anon;
revoke all on function app_private.my_admin_org_ids() from public, anon;
grant execute on function app_private.my_property_ids() to authenticated;
grant execute on function app_private.my_staff_property_ids() to authenticated;
grant execute on function app_private.my_admin_org_ids() to authenticated;

do $$
declare r record;
begin
  for r in select * from (values
    ('reservations', 'res_select', 'property_id in (select app_private.my_property_ids())'),
    ('rooms', 'rooms_select', 'property_id in (select app_private.my_property_ids())'),
    ('room_types', 'rt_select', 'property_id in (select app_private.my_property_ids())'),
    ('rate_calendar', 'rate_cal_select', 'property_id in (select app_private.my_property_ids())'),
    ('room_out_of_order_periods', 'ooo_select', 'property_id in (select app_private.my_property_ids())'),
    ('room_status_events', 'rse_select', 'property_id in (select app_private.my_property_ids())'),
    ('hk_tasks', 'hk_tasks_select', 'property_id in (select app_private.my_property_ids())'),
    ('hk_task_notes', 'hk_notes_select', 'property_id in (select app_private.my_property_ids())'),
    ('hk_task_events', 'hk_events_select', 'property_id in (select app_private.my_property_ids())'),
    ('property_faq', 'faq_select', 'property_id in (select app_private.my_property_ids())'),
    ('folios', 'folio_select', 'property_id in (select app_private.my_staff_property_ids())'),
    ('folio_transactions', 'ftx_select', 'property_id in (select app_private.my_staff_property_ids())'),
    ('reservation_guests', 'resg_select', 'property_id in (select app_private.my_staff_property_ids())'),
    ('booking_requests', 'br_select', 'property_id in (select app_private.my_staff_property_ids())'),
    ('channel_connections', 'chan_select', 'property_id in (select app_private.my_staff_property_ids())'),
    ('conversations', 'conv_select', 'property_id in (select app_private.my_staff_property_ids())'),
    ('messages', 'msg_select', 'property_id in (select app_private.my_staff_property_ids())'),
    ('ota_connections', 'ota_conn_select', 'property_id in (select app_private.my_staff_property_ids())'),
    ('ota_room_mappings', 'ota_map_select', 'property_id in (select app_private.my_staff_property_ids())'),
    ('ota_outbox', 'ota_outbox_select', 'property_id in (select app_private.my_staff_property_ids())'),
    ('ota_inbound_events', 'ota_events_select', 'property_id in (select app_private.my_staff_property_ids())'),
    ('audit_log', 'audit_select', 'organization_id in (select app_private.my_admin_org_ids())'),
    ('guest_access_log', 'guest_log_select', 'organization_id in (select app_private.my_admin_org_ids())')
  ) as x(tbl, pol, expr) loop
    execute format('drop policy if exists %I on public.%I', r.pol, r.tbl);
    execute format('create policy %I on public.%I for select to authenticated using (%s)', r.pol, r.tbl, r.expr);
  end loop;
end $$;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.ota_inbound_events; exception when duplicate_object then null; end;
  end if;
end $$;
