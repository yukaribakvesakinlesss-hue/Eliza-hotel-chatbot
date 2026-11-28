-- =====================================================================
-- AXON Hotel PMS · Phase 5 · Guest CRM (360°) & AI omnichannel inbox
--
-- CRM: guests (per organization) linked automatically from reservation guests;
--   notes (preferences / special requests / alerts), VIP level, consent,
--   access log (who viewed / exported / anonymized), KVKK export + anonymize,
--   retention candidates. Guest data: owners, managers, front desk only.
-- Inbox: channel connections (WhatsApp / Instagram / web chat; DEMO or LIVE),
--   conversations, messages (idempotent on external ids), booking requests.
-- Assistant: the app extracts intent + slots from a guest message; THIS file
--   computes availability and prices from the database and writes the reply
--   text itself, so a reply can never contain an unverified room or price.
-- Rates: room_types.base_rate + rate_calendar overrides.
-- Idempotent: safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function app_private.sha256(p text) returns text
language sql immutable set search_path = '' as $$ select encode(extensions.digest(p, 'sha256'), 'hex') $$;

-- Turkish-friendly phone normalisation: digits only, 05xx… → 905xx…, 5xx… (10 digits) → 905xx…
create or replace function app_private.normalize_phone(p text) returns text
language sql immutable set search_path = '' as $$
  select case
    when d is null or length(d) < 7 then null
    when d like '00%' then substr(d, 3)
    when d like '0%' and length(d) = 11 then '9' || d
    when d like '5%' and length(d) = 10 then '90' || d
    else d end
  from (select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '') as d) x
$$;

create or replace function app_private.fmt_money(p_amount numeric, p_currency text, p_lang text) returns text
language sql immutable set search_path = '' as $$
  select case p_currency when 'EUR' then '€' when 'TRY' then '₺' when 'USD' then '$' when 'GBP' then '£' else p_currency || ' ' end
    || case when p_lang = 'en' then to_char(p_amount, 'FM999,999,990.00')
            else replace(replace(replace(to_char(p_amount, 'FM999,999,990.00'), ',', 'X'), '.', ','), 'X', '.') end
$$;

-- guest data: owners, managers and front desk of the organization
create or replace function app_private.can_see_guests(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.organization_id = p_org and m.user_id = auth.uid()
                 and m.role::text in ('owner', 'manager', 'front_desk'))
$$;
create or replace function app_private.require_guest_access(p_org uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Oturum açmanız gerekiyor.' using errcode = '42501'; end if;
  if not app_private.can_see_guests(p_org) then
    raise exception 'FORBIDDEN: Misafir verilerine erişim yetkiniz yok.' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Guest CRM
-- ---------------------------------------------------------------------
alter table public.organizations add column if not exists guest_retention_months smallint not null default 36
  check (guest_retention_months between 6 and 120);

create table if not exists public.guests (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations(id) on delete cascade,
  full_name                 text not null check (char_length(full_name) between 1 and 120),
  email                     text check (email is null or char_length(email) <= 160),
  phone                     text check (phone is null or char_length(phone) <= 30),
  phone_normalized          text,
  nationality               text check (nationality is null or char_length(nationality) <= 60),
  language                  text check (language is null or char_length(language) <= 10),
  vip_level                 smallint not null default 0 check (vip_level between 0 and 3),
  vip_note                  text check (vip_note is null or char_length(vip_note) <= 300),
  marketing_consent         boolean not null default false,
  marketing_consent_at      timestamptz,
  marketing_consent_source  text check (marketing_consent_source is null or char_length(marketing_consent_source) <= 60),
  kvkk_notice_at            timestamptz,
  anonymized_at             timestamptz,
  last_activity_at          timestamptz not null default now(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create unique index if not exists guests_org_email on public.guests (organization_id, lower(email)) where email is not null and anonymized_at is null;
create index if not exists guests_org_phone on public.guests (organization_id, phone_normalized) where phone_normalized is not null;
create index if not exists guests_org_name on public.guests (organization_id, lower(full_name));
drop trigger if exists guests_touch on public.guests;
create trigger guests_touch before update on public.guests for each row execute function app_private.touch_updated_at();

create table if not exists public.guest_notes (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  guest_id         uuid not null references public.guests(id) on delete cascade,
  category         text not null check (category in ('PREFERENCE', 'SPECIAL_REQUEST', 'ALERT')),
  body             text not null check (char_length(body) between 1 and 500),
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  archived_at      timestamptz
);
create index if not exists guest_notes_guest_idx on public.guest_notes (guest_id, id);

create table if not exists public.guest_access_log (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  guest_id         uuid,
  actor_id         uuid references public.users(id) on delete set null,
  action           text not null check (action in ('VIEW', 'UPDATE', 'EXPORT', 'ANONYMIZE')),
  created_at       timestamptz not null default now()
);
create index if not exists guest_access_log_idx on public.guest_access_log (organization_id, created_at desc);

alter table public.reservation_guests add column if not exists guest_id uuid references public.guests(id) on delete set null;
create index if not exists reservation_guests_guest_idx on public.reservation_guests (guest_id);

-- primary reservation guests are matched to a profile by e-mail or phone, or a profile is created
create or replace function app_private.link_reservation_guest() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_phone text := app_private.normalize_phone(new.phone);
begin
  if not new.is_primary or new.guest_id is not null then return new; end if;
  select id into v_id from public.guests g
   where g.organization_id = new.organization_id and g.anonymized_at is null
     and ((new.email is not null and lower(g.email) = lower(new.email)) or (v_phone is not null and g.phone_normalized = v_phone))
   order by (new.email is not null and lower(g.email) = lower(new.email)) desc, g.created_at
   limit 1;
  if v_id is null then
    insert into public.guests (organization_id, full_name, email, phone, phone_normalized, nationality)
    values (new.organization_id, new.full_name, lower(new.email), new.phone, v_phone, new.nationality)
    returning id into v_id;
  else
    update public.guests set last_activity_at = now(),
           email = coalesce(email, lower(new.email)), phone = coalesce(phone, new.phone), phone_normalized = coalesce(phone_normalized, v_phone)
     where id = v_id;
  end if;
  new.guest_id := v_id;
  return new;
end $$;
drop trigger if exists reservation_guests_link on public.reservation_guests;
create trigger reservation_guests_link before insert on public.reservation_guests
  for each row execute function app_private.link_reservation_guest();

-- existing primary guests get profiles
do $$ declare r record; v_id uuid; begin
  for r in select * from public.reservation_guests where is_primary and guest_id is null order by created_at loop
    select id into v_id from public.guests g where g.organization_id = r.organization_id and g.anonymized_at is null
      and ((r.email is not null and lower(g.email) = lower(r.email)) or (app_private.normalize_phone(r.phone) is not null and g.phone_normalized = app_private.normalize_phone(r.phone)))
      limit 1;
    if v_id is null then
      insert into public.guests (organization_id, full_name, email, phone, phone_normalized)
      values (r.organization_id, r.full_name, lower(r.email), r.phone, app_private.normalize_phone(r.phone)) returning id into v_id;
    end if;
    update public.reservation_guests set guest_id = v_id where id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Rates (the only source of prices the assistant may quote)
-- ---------------------------------------------------------------------
alter table public.room_types add column if not exists base_rate numeric(12,2) check (base_rate is null or base_rate between 0 and 1000000);

create table if not exists public.rate_calendar (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  property_id      uuid not null,
  room_type_id     uuid not null references public.room_types(id) on delete cascade,
  stay_date        date not null,
  rate             numeric(12,2) not null check (rate between 0 and 1000000),
  unique (room_type_id, stay_date)
);

-- price of a stay for one room type: per night calendar rate, else base rate; incomplete if any night has no rate
create or replace function app_private.quote_room_type(p_room_type uuid, p_in date, p_out date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_rt public.room_types; v_prop public.properties; d date; v_rate numeric; v_nights jsonb := '[]'::jsonb;
        v_net numeric := 0; v_vat numeric := 0; v_lodging numeric := 0; v_complete boolean := true;
begin
  select * into v_rt from public.room_types where id = p_room_type;
  select * into v_prop from public.properties where id = v_rt.property_id;
  d := p_in;
  while d < p_out loop
    select rate into v_rate from public.rate_calendar where room_type_id = p_room_type and stay_date = d;
    v_rate := coalesce(v_rate, v_rt.base_rate);
    if v_rate is null then
      v_complete := false;
    else
      v_net := v_net + v_rate;
      v_vat := v_vat + round(v_rate * v_prop.vat_rate_rooms, 2);
      v_lodging := v_lodging + round(v_rate * v_prop.lodging_tax_rate, 2);
    end if;
    v_nights := v_nights || jsonb_build_object('date', d, 'rate', v_rate);
    d := d + 1;
    v_rate := null;
  end loop;
  return jsonb_build_object('complete', v_complete, 'currency', v_prop.currency, 'nights', v_nights,
    'net', case when v_complete then v_net end, 'vat', case when v_complete then v_vat end,
    'lodging', case when v_complete then v_lodging end, 'gross', case when v_complete then v_net + v_vat + v_lodging end);
end $$;

-- rooms of a type that are sellable for the whole stay (no active booking, no out-of-order period)
create or replace function app_private.free_rooms(p_room_type uuid, p_in date, p_out date) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select r.id from public.rooms r
  where r.room_type_id = p_room_type
    and not exists (select 1 from public.reservations x where x.room_id = r.id and x.status not in ('CANCELLED', 'NO_SHOW')
                    and x.stay && daterange(p_in, p_out, '[)'))
    and not exists (select 1 from public.room_out_of_order_periods o where o.room_id = r.id
                    and o.start_date < p_out and (o.end_date is null or o.end_date > p_in))
  order by r.number
$$;

create or replace function app_private.availability_options(p_property uuid, p_in date, p_out date, p_adults int) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(o order by (o->>'sort')::numeric), '[]'::jsonb) from (
    select jsonb_build_object('room_type_id', rt.id, 'code', rt.code, 'name', rt.name, 'max_occupancy', rt.max_occupancy,
             'available', (select count(*) from app_private.free_rooms(rt.id, p_in, p_out)),
             'quote', app_private.quote_room_type(rt.id, p_in, p_out), 'sort', coalesce(rt.base_rate, 999999)) as o
    from public.room_types rt where rt.property_id = p_property and rt.max_occupancy >= coalesce(p_adults, 1)
  ) x
$$;

-- staff-facing availability check (front desk and up)
create or replace function public.check_availability(p_property_id uuid, p_check_in date, p_check_out date, p_adults int default 2)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.require_front_desk(p_property_id);
  if p_check_out <= p_check_in or p_check_out > p_check_in + 60 then
    raise exception 'RES_INVALID_DATES: Çıkış tarihi giriş tarihinden sonra olmalı (en fazla 60 gece).' using errcode = 'P0001';
  end if;
  return app_private.availability_options(p_property_id, p_check_in, p_check_out, p_adults);
end $$;

create or replace function public.set_room_type_rate(p_room_type_id uuid, p_base_rate numeric)
returns public.room_types language plpgsql security definer set search_path = '' as $$
declare v_rt public.room_types;
begin
  select * into v_rt from public.room_types where id = p_room_type_id;
  if v_rt.id is null or coalesce(app_private.property_role(v_rt.property_id)::text, '') not in ('owner', 'manager') then
    raise exception 'FORBIDDEN: Fiyatları yalnızca otel sahibi veya müdür değiştirebilir.' using errcode = '42501';
  end if;
  if p_base_rate is not null and (p_base_rate < 0 or p_base_rate > 1000000) then
    raise exception 'RES_INVALID_RATE: Fiyat 0 ile 1.000.000 arasında olmalı.' using errcode = 'P0001';
  end if;
  update public.room_types set base_rate = round(p_base_rate, 2) where id = v_rt.id returning * into v_rt;
  return v_rt;
end $$;

-- ---------------------------------------------------------------------
-- Inbox
-- ---------------------------------------------------------------------
create table if not exists public.channel_connections (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  property_id          uuid not null,
  channel              text not null check (channel in ('WHATSAPP', 'INSTAGRAM', 'WEBCHAT')),
  mode                 text not null default 'DEMO' check (mode in ('DEMO', 'LIVE')),
  external_account_id  text check (external_account_id is null or char_length(external_account_id) <= 100),
  display_name         text check (display_name is null or char_length(display_name) <= 100),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade,
  unique (property_id, channel)
);
-- secrets are never exposed through the API (app_private is not an exposed schema)
create table if not exists app_private.channel_secrets (
  connection_id  uuid primary key references public.channel_connections(id) on delete cascade,
  ingest_secret_hash text not null
);

insert into public.channel_connections (organization_id, property_id, channel, mode)
select p.organization_id, p.id, c.channel, case when c.channel = 'WEBCHAT' then 'LIVE' else 'DEMO' end
from public.properties p cross join (values ('WHATSAPP'), ('INSTAGRAM'), ('WEBCHAT')) c(channel)
on conflict (property_id, channel) do nothing;

create or replace function app_private.add_default_connections() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.channel_connections (organization_id, property_id, channel, mode)
  values (new.organization_id, new.id, 'WHATSAPP', 'DEMO'), (new.organization_id, new.id, 'INSTAGRAM', 'DEMO'), (new.organization_id, new.id, 'WEBCHAT', 'LIVE')
  on conflict (property_id, channel) do nothing;
  return null;
end $$;
drop trigger if exists properties_default_connections on public.properties;
create trigger properties_default_connections after insert on public.properties
  for each row execute function app_private.add_default_connections();

create table if not exists public.conversations (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  property_id         uuid not null,
  channel             text not null check (channel in ('WHATSAPP', 'INSTAGRAM', 'WEBCHAT')),
  external_thread_id  text not null check (char_length(external_thread_id) between 1 and 120),
  guest_id            uuid references public.guests(id) on delete set null,
  contact_name        text check (contact_name is null or char_length(contact_name) <= 120),
  contact_handle      text check (contact_handle is null or char_length(contact_handle) <= 120),
  status              text not null default 'AI' check (status in ('AI', 'HUMAN', 'CLOSED')),
  is_demo             boolean not null default false,
  context             jsonb not null default '{}'::jsonb,
  unread_count        integer not null default 0,
  last_message_at     timestamptz not null default now(),
  last_message_preview text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade,
  unique (property_id, channel, external_thread_id)
);
create index if not exists conversations_property_idx on public.conversations (property_id, last_message_at desc);
create index if not exists conversations_guest_idx on public.conversations (guest_id);
drop trigger if exists conversations_touch on public.conversations;
create trigger conversations_touch before update on public.conversations for each row execute function app_private.touch_updated_at();

create table if not exists app_private.webchat_sessions (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  token_hash      text not null
);

create table if not exists public.messages (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  property_id      uuid not null,
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  channel          text not null,
  direction        text not null check (direction in ('IN', 'OUT')),
  sender           text not null check (sender in ('GUEST', 'AI', 'STAFF', 'SYSTEM')),
  body             text not null check (char_length(body) between 1 and 4000),
  payload          jsonb,
  external_id      text check (external_id is null or char_length(external_id) <= 200),
  delivery_status  text not null default 'RECEIVED' check (delivery_status in ('RECEIVED', 'PENDING', 'SENT', 'DELIVERED', 'FAILED', 'DEMO_NOT_SENT')),
  author_id        uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now()
);
-- webhook / client retries: the same external message is stored once
create unique index if not exists messages_external_once on public.messages (property_id, channel, external_id) where external_id is not null;
create index if not exists messages_conversation_idx on public.messages (conversation_id, id);

create table if not exists public.booking_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,
  conversation_id  uuid references public.conversations(id) on delete set null,
  guest_id         uuid references public.guests(id) on delete set null,
  room_type_id     uuid not null references public.room_types(id),
  check_in         date not null,
  check_out        date not null,
  adults           smallint not null check (adults between 1 and 20),
  contact_name     text not null check (char_length(contact_name) between 2 and 120),
  contact_email    text,
  contact_phone    text,
  quote            jsonb not null,
  status           text not null default 'NEW' check (status in ('NEW', 'CONFIRMED', 'DECLINED')),
  reservation_id   uuid references public.reservations(id) on delete set null,
  handled_by       uuid references public.users(id) on delete set null,
  handled_at       timestamptz,
  decline_reason   text,
  created_at       timestamptz not null default now(),
  check (check_out > check_in),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade
);
create index if not exists booking_requests_property_idx on public.booking_requests (property_id, status, created_at desc);

create table if not exists public.property_faq (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  property_id      uuid not null,
  topic            text not null check (topic ~ '^[a-z_]{2,40}$'),
  answer_tr        text not null check (char_length(answer_tr) between 1 and 1000),
  answer_en        text not null check (char_length(answer_en) between 1 and 1000),
  unique (property_id, topic)
);

-- ---------------------------------------------------------------------
-- Inbox internals
-- ---------------------------------------------------------------------
create or replace function app_private.inbox_add_message(p_conv public.conversations, p_direction text, p_sender text, p_body text,
  p_payload jsonb default null, p_external_id text default null, p_status text default 'RECEIVED')
returns public.messages language plpgsql security definer set search_path = '' as $$
declare v_msg public.messages;
begin
  insert into public.messages (organization_id, property_id, conversation_id, channel, direction, sender, body, payload, external_id, delivery_status, author_id)
  values (p_conv.organization_id, p_conv.property_id, p_conv.id, p_conv.channel, p_direction, p_sender, left(p_body, 4000), p_payload, p_external_id, p_status,
          case when p_sender = 'STAFF' then auth.uid() end)
  on conflict (property_id, channel, external_id) where external_id is not null do nothing
  returning * into v_msg;
  if v_msg.id is not null then
    update public.conversations set last_message_at = now(), last_message_preview = left(p_body, 140),
           unread_count = case when p_direction = 'IN' then unread_count + 1 else unread_count end
     where id = p_conv.id;
  end if;
  return v_msg;  -- null id = duplicate (already stored)
end $$;

-- conversation access: staff of the property, the web chat session token, or the channel ingest secret
create or replace function app_private.inbox_authorized(p_conv public.conversations, p_token text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app_private.property_role(p_conv.property_id)::text in ('owner', 'manager', 'front_desk'), false)
      or (p_token is not null and exists (select 1 from app_private.webchat_sessions s where s.conversation_id = p_conv.id and s.token_hash = app_private.sha256(p_token)))
      or (p_token is not null and exists (select 1 from public.channel_connections c join app_private.channel_secrets s on s.connection_id = c.id
                                           where c.property_id = p_conv.property_id and c.channel = p_conv.channel and c.mode = 'LIVE'
                                             and s.ingest_secret_hash = app_private.sha256(p_token)))
$$;

create or replace function app_private.upsert_conversation(p_property uuid, p_channel text, p_thread text, p_name text, p_handle text, p_demo boolean)
returns public.conversations language plpgsql security definer set search_path = '' as $$
declare v_conv public.conversations; v_prop public.properties; v_guest uuid;
begin
  select * into v_prop from public.properties where id = p_property;
  insert into public.conversations (organization_id, property_id, channel, external_thread_id, contact_name, contact_handle, is_demo)
  values (v_prop.organization_id, p_property, p_channel, p_thread, nullif(trim(p_name), ''), nullif(trim(p_handle), ''), p_demo)
  on conflict (property_id, channel, external_thread_id) do update
     set contact_name = coalesce(public.conversations.contact_name, excluded.contact_name),
         status = case when public.conversations.status = 'CLOSED' then 'AI' else public.conversations.status end
  returning * into v_conv;
  if v_conv.guest_id is null and p_channel = 'WHATSAPP' then
    select id into v_guest from public.guests where organization_id = v_prop.organization_id and anonymized_at is null
       and phone_normalized = app_private.normalize_phone(p_thread) limit 1;
    if v_guest is not null then
      update public.conversations set guest_id = v_guest where id = v_conv.id returning * into v_conv;
    end if;
  end if;
  return v_conv;
end $$;

-- ---------------------------------------------------------------------
-- Public (anon) web chat
-- ---------------------------------------------------------------------
create or replace function public.webchat_start(p_org_slug text, p_property_code text, p_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_prop public.properties; v_conn public.channel_connections; v_conv public.conversations; v_token text;
begin
  select p.* into v_prop from public.properties p join public.organizations o on o.id = p.organization_id
   where o.slug = p_org_slug and p.code = upper(p_property_code);
  select * into v_conn from public.channel_connections where property_id = v_prop.id and channel = 'WEBCHAT';
  if v_prop.id is null or v_conn.id is null then
    raise exception 'INBOX_NOT_FOUND: Otel bulunamadı.' using errcode = 'P0001';
  end if;
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  v_conv := app_private.upsert_conversation(v_prop.id, 'WEBCHAT', 'web-' || encode(extensions.gen_random_bytes(8), 'hex'),
                                            left(p_name, 120), null, false);
  insert into app_private.webchat_sessions (conversation_id, token_hash) values (v_conv.id, app_private.sha256(v_token));
  return jsonb_build_object('conversation_id', v_conv.id, 'token', v_token, 'property_name', v_prop.name);
end $$;

create or replace function public.webchat_send(p_conversation_id uuid, p_token text, p_body text, p_client_message_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_conv public.conversations; v_msg public.messages;
begin
  select * into v_conv from public.conversations where id = p_conversation_id and channel = 'WEBCHAT';
  if v_conv.id is null or not exists (select 1 from app_private.webchat_sessions s where s.conversation_id = v_conv.id and s.token_hash = app_private.sha256(p_token)) then
    raise exception 'FORBIDDEN: Sohbet oturumu geçersiz.' using errcode = '42501';
  end if;
  if nullif(trim(p_body), '') is null or char_length(p_body) > 2000 then
    raise exception 'INBOX_INVALID: Mesaj 1–2000 karakter olmalı.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.messages where conversation_id = v_conv.id and direction = 'IN' and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'INBOX_RATE_LIMIT: Çok hızlı mesaj gönderiyorsunuz; lütfen biraz bekleyin.' using errcode = 'P0001';
  end if;
  v_msg := app_private.inbox_add_message(v_conv, 'IN', 'GUEST', trim(p_body), null, 'wc-' || p_conversation_id || '-' || left(p_client_message_id, 80));
  return jsonb_build_object('inserted', v_msg.id is not null, 'message_id', v_msg.id);
end $$;

create or replace function public.webchat_messages(p_conversation_id uuid, p_token text, p_after_id bigint default 0)
returns setof public.messages language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from app_private.webchat_sessions s where s.conversation_id = p_conversation_id and s.token_hash = app_private.sha256(p_token)) then
    raise exception 'FORBIDDEN: Sohbet oturumu geçersiz.' using errcode = '42501';
  end if;
  return query select * from public.messages where conversation_id = p_conversation_id and id > coalesce(p_after_id, 0) order by id limit 200;
end $$;

-- non-sensitive hotel facts the public chat needs (name, timezone, room type names)
create or replace function public.inbox_public_property(p_org_slug text, p_property_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('property_id', p.id, 'name', p.name, 'timezone', p.timezone, 'currency', p.currency,
           'room_types', coalesce((select jsonb_agg(jsonb_build_object('code', rt.code, 'name', rt.name) order by rt.code)
                                   from public.room_types rt where rt.property_id = p.id), '[]'::jsonb))
  from public.properties p join public.organizations o on o.id = p.organization_id
  where o.slug = p_org_slug and p.code = upper(p_property_code)
$$;

-- ---------------------------------------------------------------------
-- WhatsApp / Instagram ingest (webhook route, after the Meta signature check)
-- and the demo simulator (staff)
-- ---------------------------------------------------------------------
create or replace function public.inbox_ingest(p_org_slug text, p_property_code text, p_channel text, p_secret text,
  p_external_message_id text, p_thread_id text, p_contact_name text, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_prop public.properties; v_conn public.channel_connections; v_conv public.conversations; v_msg public.messages;
begin
  select p.* into v_prop from public.properties p join public.organizations o on o.id = p.organization_id
   where o.slug = p_org_slug and p.code = upper(p_property_code);
  select c.* into v_conn from public.channel_connections c join app_private.channel_secrets s on s.connection_id = c.id
   where c.property_id = v_prop.id and c.channel = p_channel and c.mode = 'LIVE' and s.ingest_secret_hash = app_private.sha256(p_secret);
  if v_conn.id is null then
    raise exception 'FORBIDDEN: Kanal bağlı değil veya gizli anahtar hatalı.' using errcode = '42501';
  end if;
  if nullif(p_external_message_id, '') is null or nullif(p_thread_id, '') is null then
    raise exception 'INBOX_INVALID: Mesaj kimliği eksik.' using errcode = 'P0001';
  end if;
  v_conv := app_private.upsert_conversation(v_prop.id, p_channel, p_thread_id, p_contact_name,
              case when p_channel = 'WHATSAPP' then '+' || p_thread_id else p_contact_name end, false);
  v_msg := app_private.inbox_add_message(v_conv, 'IN', 'GUEST', coalesce(nullif(trim(p_body), ''), '[medya]'), null, p_external_message_id);
  return jsonb_build_object('conversation_id', v_conv.id, 'inserted', v_msg.id is not null, 'message_id', v_msg.id, 'status', v_conv.status,
    'last_assistant_type', (select m.payload->>'type' from public.messages m where m.conversation_id = v_conv.id and m.sender = 'AI' order by m.id desc limit 1));
end $$;

create or replace function public.inbox_simulate_inbound(p_property_id uuid, p_channel text, p_thread_id text, p_contact_name text,
  p_body text, p_external_message_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_conv public.conversations; v_msg public.messages;
begin
  perform app_private.require_front_desk(p_property_id);
  if p_channel not in ('WHATSAPP', 'INSTAGRAM') then
    raise exception 'INBOX_INVALID: Simülasyon yalnızca WhatsApp ve Instagram için.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.channel_connections where property_id = p_property_id and channel = p_channel and mode = 'LIVE') then
    raise exception 'INBOX_INVALID: Kanal gerçek modda; simülasyon kapalı.' using errcode = 'P0001';
  end if;
  v_conv := app_private.upsert_conversation(p_property_id, p_channel, p_thread_id, p_contact_name,
              case when p_channel = 'WHATSAPP' then '+' || regexp_replace(p_thread_id, '\D', '', 'g') else '@' || p_thread_id end, true);
  v_msg := app_private.inbox_add_message(v_conv, 'IN', 'GUEST', trim(p_body), null, 'demo-' || p_external_message_id);
  return jsonb_build_object('conversation_id', v_conv.id, 'inserted', v_msg.id is not null, 'message_id', v_msg.id, 'status', v_conv.status);
end $$;

-- ---------------------------------------------------------------------
-- The assistant turn. Intent and slots come from the app; facts and the
-- wording come from here.
-- ---------------------------------------------------------------------
create or replace function public.inbox_assistant_turn(p_conversation_id uuid, p_token text, p_intent text, p_slots jsonb, p_lang text default 'tr')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_conv public.conversations; v_prop public.properties; v_ctx jsonb; v_lang text := case when p_lang = 'en' then 'en' else 'tr' end;
  v_in date; v_out date; v_adults int; v_opts jsonb; o jsonb; v_lines text := ''; v_text text; v_payload jsonb; v_msg public.messages;
  v_today date; v_nights int; v_choice jsonb; v_req public.booking_requests; v_name text; v_contact text; v_faq public.property_faq; v_avail int;
begin
  select * into v_conv from public.conversations where id = p_conversation_id for update;
  if v_conv.id is null or not app_private.inbox_authorized(v_conv, p_token) then
    raise exception 'FORBIDDEN: Sohbet oturumu geçersiz.' using errcode = '42501';
  end if;
  if v_conv.status <> 'AI' then
    return jsonb_build_object('replied', false, 'reason', v_conv.status);
  end if;
  select * into v_prop from public.properties where id = v_conv.property_id;
  v_today := (now() at time zone v_prop.timezone)::date;

  -- merge only known slot keys into the conversation memory
  v_ctx := v_conv.context || jsonb_strip_nulls(jsonb_build_object(
    'check_in', p_slots->>'check_in', 'check_out', p_slots->>'check_out',
    'adults', case when jsonb_typeof(p_slots->'adults') = 'number' and (p_slots->>'adults') ~ '^\d{1,2}$' then p_slots->'adults' end,
    'room_type', upper(p_slots->>'room_type'), 'name', left(p_slots->>'name', 120),
    'email', left(lower(p_slots->>'email'), 160), 'phone', left(p_slots->>'phone', 30)));
  begin
    v_in := (v_ctx->>'check_in')::date;
    v_out := (v_ctx->>'check_out')::date;
  exception when others then v_in := null; v_out := null; end;
  if v_in is not null and v_out is null and (p_slots->>'nights') ~ '^\d{1,2}$' then
    v_out := v_in + (p_slots->>'nights')::int;
    v_ctx := v_ctx || jsonb_build_object('check_out', v_out);
  end if;
  v_adults := least(greatest(coalesce((v_ctx->>'adults')::int, 2), 1), 10);

  if p_intent = 'HANDOFF' then
    update public.conversations set status = 'HUMAN', context = v_ctx where id = v_conv.id;
    v_text := case v_lang when 'en' then 'I am passing you to our front desk; a colleague will reply here shortly.'
                         else 'Sizi resepsiyonumuza aktarıyorum; bir arkadaşımız birazdan buradan yanıt verecek.' end;
    v_payload := jsonb_build_object('type', 'handoff');

  elsif p_intent = 'GREETING' then
    v_text := case v_lang when 'en' then format('Hello, welcome to %s! I can check availability and prices for your dates or pass you to the front desk. When would you like to stay?', v_prop.name)
                         else format('Merhaba, %s''e hoş geldiniz! Tarihlerinizi yazarsanız müsaitlik ve fiyatı kontrol edebilir ya da sizi resepsiyona bağlayabilirim. Hangi tarihlerde konaklamak istersiniz?', v_prop.name) end;

  elsif p_intent = 'FAQ' then
    select * into v_faq from public.property_faq where property_id = v_prop.id and topic = p_slots->>'topic';
    if v_faq.id is null then
      v_text := case v_lang when 'en' then 'I do not have verified information on that. Shall I pass you to the front desk? Just write "front desk".'
                           else 'Bu konuda doğrulanmış bir bilgim yok. Sizi resepsiyona aktarmamı ister misiniz? "Resepsiyon" yazmanız yeterli.' end;
    else
      v_text := case v_lang when 'en' then v_faq.answer_en else v_faq.answer_tr end;
    end if;
    v_payload := jsonb_build_object('type', 'faq', 'topic', p_slots->>'topic', 'verified', v_faq.id is not null);

  elsif p_intent in ('AVAILABILITY', 'BOOKING') then
    if v_in is null or v_out is null then
      v_text := case v_lang when 'en' then 'Which dates would you like? Please write your arrival and departure dates (e.g. 12.12 – 15.12) and the number of guests.'
                           else 'Hangi tarihler için bakayım? Giriş ve çıkış tarihlerinizi (örn. 12.12 – 15.12) ve kişi sayısını yazar mısınız?' end;
      v_payload := jsonb_build_object('type', 'ask_dates');
    elsif v_in < v_today or v_out <= v_in or v_out > v_in + 30 then
      v_text := case v_lang when 'en' then 'Those dates do not look right (past date, or departure before arrival, or more than 30 nights). Could you write them again?'
                           else 'Bu tarihler geçerli görünmüyor (geçmiş tarih, çıkışın girişten önce olması ya da 30 geceden uzun konaklama). Tekrar yazar mısınız?' end;
      v_payload := jsonb_build_object('type', 'ask_dates', 'invalid', true);
      v_ctx := v_ctx - 'check_in' - 'check_out';
    else
      v_nights := v_out - v_in;
      v_opts := app_private.availability_options(v_prop.id, v_in, v_out, v_adults);
      for o in select * from jsonb_array_elements(v_opts) loop
        v_avail := (o->>'available')::int;
        v_lines := v_lines || E'\n• ' || (o->>'name') || ': ' || case
          when v_avail = 0 then case v_lang when 'en' then 'not available' else 'müsait değil' end
          when (o->'quote'->>'complete')::boolean then
            case v_lang when 'en' then format('%s room(s) available, %s nights total %s incl. taxes', v_avail, v_nights, app_private.fmt_money((o->'quote'->>'gross')::numeric, v_prop.currency, 'en'))
                       else format('%s oda müsait, %s gece toplam %s (vergiler dahil)', v_avail, v_nights, app_private.fmt_money((o->'quote'->>'gross')::numeric, v_prop.currency, 'tr')) end
          else case v_lang when 'en' then format('%s room(s) available; the price is not in our system yet, the front desk will send it', v_avail)
                          else format('%s oda müsait; fiyat sistemde tanımlı değil, resepsiyon iletecek', v_avail) end
          end;
      end loop;
      v_payload := jsonb_build_object('type', 'availability', 'check_in', v_in, 'check_out', v_out, 'adults', v_adults, 'options', v_opts, 'checked_at', now());

      if jsonb_array_length(v_opts) = 0 or not exists (select 1 from jsonb_array_elements(v_opts) e where (e->>'available')::int > 0) then
        v_text := case v_lang when 'en' then format('Sorry, we have no room for %s guest(s) between %s and %s. I can pass you to the front desk for alternatives.', v_adults, app_private.fmt_date(v_in), app_private.fmt_date(v_out))
                             else format('Üzgünüm, %s – %s tarihleri arasında %s kişilik müsait odamız yok. Alternatifler için sizi resepsiyona aktarabilirim.', app_private.fmt_date(v_in), app_private.fmt_date(v_out), v_adults) end;
      elsif p_intent = 'AVAILABILITY' then
        v_text := case v_lang when 'en' then format('Live availability for %s – %s, %s guest(s):%s', app_private.fmt_date(v_in), app_private.fmt_date(v_out), v_adults, v_lines) || E'\nWould you like me to create a booking request?'
                             else format('%s – %s, %s kişi için güncel müsaitlik:%s', app_private.fmt_date(v_in), app_private.fmt_date(v_out), v_adults, v_lines) || E'\nRezervasyon talebi oluşturmamı ister misiniz?' end;
      else
        -- booking request: room type + contact are needed; the request is never a confirmed reservation
        select e into v_choice from jsonb_array_elements(v_opts) e
         where (e->>'available')::int > 0 and (v_ctx->>'room_type' is null or e->>'code' = v_ctx->>'room_type')
         order by (e->>'code' = coalesce(v_ctx->>'room_type', '')) desc limit 1;
        if v_ctx->>'room_type' is null and (select count(*) from jsonb_array_elements(v_opts) e where (e->>'available')::int > 0) > 1 then
          v_choice := null;
        end if;
        v_name := coalesce(v_ctx->>'name', v_conv.contact_name);
        v_contact := coalesce(v_ctx->>'phone', v_ctx->>'email', case when v_conv.channel <> 'WEBCHAT' then v_conv.contact_handle end);
        if v_choice is null then
          v_text := case v_lang when 'en' then 'Which room type would you like?' else 'Hangi oda tipini istersiniz?' end || v_lines;
          v_payload := v_payload || jsonb_build_object('type', 'ask_room_type');
        elsif v_name is null or char_length(v_name) < 2 or v_contact is null then
          v_text := case v_lang when 'en' then 'To create the request I need your full name and a phone number or e-mail.'
                               else 'Talebi oluşturmak için adınızı soyadınızı ve bir telefon ya da e-posta adresinizi yazar mısınız?' end;
          v_payload := v_payload || jsonb_build_object('type', 'ask_contact', 'room_type', v_choice->>'code');
          v_ctx := v_ctx || jsonb_build_object('room_type', v_choice->>'code');
        else
          select * into v_req from public.booking_requests where conversation_id = v_conv.id and status = 'NEW'
             and room_type_id = (v_choice->>'room_type_id')::uuid and check_in = v_in and check_out = v_out;
          if v_req.id is null then
            insert into public.booking_requests (organization_id, property_id, conversation_id, guest_id, room_type_id, check_in, check_out, adults,
                                                 contact_name, contact_email, contact_phone, quote)
            values (v_prop.organization_id, v_prop.id, v_conv.id, v_conv.guest_id, (v_choice->>'room_type_id')::uuid, v_in, v_out, v_adults,
                    v_name, v_ctx->>'email', coalesce(v_ctx->>'phone', case when v_conv.channel = 'WHATSAPP' then v_conv.contact_handle end), v_choice->'quote')
            returning * into v_req;
          end if;
          v_text := case v_lang
            when 'en' then format('Thank you %s, your booking request for a %s, %s – %s is recorded (request %s). Our front desk will re-check availability and confirm; it is not a confirmed reservation until then.',
                                  v_name, v_choice->>'name', app_private.fmt_date(v_in), app_private.fmt_date(v_out), left(v_req.id::text, 8))
            else format('Teşekkürler %s, %s için %s – %s rezervasyon talebiniz alındı (talep no %s). Resepsiyonumuz müsaitliği tekrar kontrol edip onaylayacak; onaylanana kadar rezervasyon kesinleşmiş değildir.',
                        v_name, v_choice->>'name', app_private.fmt_date(v_in), app_private.fmt_date(v_out), left(v_req.id::text, 8)) end;
          v_payload := v_payload || jsonb_build_object('type', 'booking_request', 'booking_request_id', v_req.id);
        end if;
      end if;
    end if;

  else
    v_text := case v_lang when 'en' then 'I could not fully understand. Write your dates for availability and prices, or "front desk" to talk to a colleague.'
                         else 'Mesajınızı tam anlayamadım. Müsaitlik ve fiyat için tarihlerinizi yazabilir ya da bir görevliyle konuşmak için "resepsiyon" yazabilirsiniz.' end;
    v_payload := jsonb_build_object('type', 'fallback');
  end if;

  update public.conversations set context = v_ctx where id = v_conv.id;
  v_msg := app_private.inbox_add_message(v_conv, 'OUT', 'AI', v_text, coalesce(v_payload, '{}'::jsonb) || jsonb_build_object('intent', p_intent), null,
             case when v_conv.channel = 'WEBCHAT' then 'DELIVERED' when v_conv.is_demo then 'DEMO_NOT_SENT' else 'PENDING' end);
  return jsonb_build_object('replied', true, 'message', to_jsonb(v_msg));
end $$;

-- ---------------------------------------------------------------------
-- Staff inbox actions
-- ---------------------------------------------------------------------
create or replace function app_private.lock_conversation(p_id uuid) returns public.conversations
language plpgsql security definer set search_path = '' as $$
declare v_conv public.conversations;
begin
  select * into v_conv from public.conversations where id = p_id for update;
  if v_conv.id is null or coalesce(app_private.property_role(v_conv.property_id)::text, '') not in ('owner', 'manager', 'front_desk') then
    raise exception 'INBOX_NOT_FOUND: Konuşma bulunamadı.' using errcode = 'P0001';
  end if;
  return v_conv;
end $$;

create or replace function public.inbox_send_staff_message(p_conversation_id uuid, p_body text, p_client_message_id text default null)
returns public.messages language plpgsql security definer set search_path = '' as $$
declare v_conv public.conversations; v_msg public.messages;
begin
  v_conv := app_private.lock_conversation(p_conversation_id);
  if nullif(trim(p_body), '') is null or char_length(p_body) > 4000 then
    raise exception 'INBOX_INVALID: Mesaj 1–4000 karakter olmalı.' using errcode = 'P0001';
  end if;
  update public.conversations set status = 'HUMAN', unread_count = 0 where id = v_conv.id;  -- a staff reply takes the conversation over
  v_msg := app_private.inbox_add_message(v_conv, 'OUT', 'STAFF', trim(p_body), null,
             case when p_client_message_id is not null then 'staff-' || p_conversation_id || '-' || left(p_client_message_id, 80) end,
             case when v_conv.channel = 'WEBCHAT' then 'DELIVERED' when v_conv.is_demo then 'DEMO_NOT_SENT' else 'PENDING' end);
  if v_msg.id is null then
    select * into v_msg from public.messages where property_id = v_conv.property_id and channel = v_conv.channel
       and external_id = 'staff-' || p_conversation_id || '-' || left(p_client_message_id, 80);
  end if;
  return v_msg;
end $$;

-- delivery result of an outgoing message (set by the server after the channel adapter call)
create or replace function public.inbox_set_delivery(p_message_id bigint, p_status text, p_token text default null)
returns public.messages language plpgsql security definer set search_path = '' as $$
declare v_msg public.messages; v_conv public.conversations;
begin
  select * into v_msg from public.messages where id = p_message_id;
  select * into v_conv from public.conversations where id = v_msg.conversation_id;
  if v_msg.id is null or not app_private.inbox_authorized(v_conv, p_token) then
    raise exception 'INBOX_NOT_FOUND: Mesaj bulunamadı.' using errcode = 'P0001';
  end if;
  if v_msg.direction <> 'OUT' or p_status not in ('SENT', 'DELIVERED', 'FAILED', 'DEMO_NOT_SENT') then
    raise exception 'INBOX_INVALID: Teslim durumu geçersiz.' using errcode = 'P0001';
  end if;
  update public.messages set delivery_status = p_status where id = v_msg.id returning * into v_msg;
  return v_msg;
end $$;

create or replace function public.inbox_set_status(p_conversation_id uuid, p_status text)
returns public.conversations language plpgsql security definer set search_path = '' as $$
declare v_conv public.conversations;
begin
  v_conv := app_private.lock_conversation(p_conversation_id);
  if p_status not in ('AI', 'HUMAN', 'CLOSED') then
    raise exception 'INBOX_INVALID: Durum geçersiz.' using errcode = 'P0001';
  end if;
  update public.conversations set status = p_status where id = v_conv.id returning * into v_conv;
  return v_conv;
end $$;

create or replace function public.inbox_mark_read(p_conversation_id uuid)
returns public.conversations language plpgsql security definer set search_path = '' as $$
declare v_conv public.conversations;
begin
  v_conv := app_private.lock_conversation(p_conversation_id);
  update public.conversations set unread_count = 0 where id = v_conv.id returning * into v_conv;
  return v_conv;
end $$;

create or replace function public.inbox_link_guest(p_conversation_id uuid, p_guest_id uuid)
returns public.conversations language plpgsql security definer set search_path = '' as $$
declare v_conv public.conversations; v_guest public.guests;
begin
  v_conv := app_private.lock_conversation(p_conversation_id);
  if p_guest_id is null then
    insert into public.guests (organization_id, full_name, phone, phone_normalized)
    values (v_conv.organization_id, coalesce(v_conv.contact_name, v_conv.contact_handle, 'Misafir'),
            case when v_conv.channel = 'WHATSAPP' then v_conv.contact_handle end,
            case when v_conv.channel = 'WHATSAPP' then app_private.normalize_phone(v_conv.contact_handle) end)
    returning * into v_guest;
  else
    select * into v_guest from public.guests where id = p_guest_id and organization_id = v_conv.organization_id and anonymized_at is null;
    if v_guest.id is null then raise exception 'GUEST_NOT_FOUND: Misafir bulunamadı.' using errcode = 'P0001'; end if;
  end if;
  update public.conversations set guest_id = v_guest.id where id = v_conv.id returning * into v_conv;
  update public.booking_requests set guest_id = v_guest.id where conversation_id = v_conv.id and guest_id is null;
  return v_conv;
end $$;

-- one click: request → reservation in the first free room of the requested type, at the quoted rate
create or replace function public.booking_request_confirm(p_request_id uuid)
returns public.booking_requests language plpgsql security definer set search_path = '' as $$
declare v_req public.booking_requests; v_room uuid; v_res public.reservations; v_conv public.conversations; v_rate numeric; v_nights int;
begin
  select * into v_req from public.booking_requests where id = p_request_id for update;
  if v_req.id is null or coalesce(app_private.property_role(v_req.property_id)::text, '') not in ('owner', 'manager', 'front_desk') then
    raise exception 'INBOX_NOT_FOUND: Talep bulunamadı.' using errcode = 'P0001';
  end if;
  if v_req.status = 'CONFIRMED' then return v_req; end if;  -- repeated click
  if v_req.status <> 'NEW' then
    raise exception 'INBOX_BAD_STATE: Bu talep reddedilmiş.' using errcode = 'P0001';
  end if;
  select f.room_id into v_room from app_private.free_rooms(v_req.room_type_id, v_req.check_in, v_req.check_out) as f(room_id) limit 1;
  if v_room is null then
    raise exception 'RES_CONFLICT: Bu oda tipinde seçilen tarihlerde artık müsait oda yok. Misafire alternatif önerin.' using errcode = 'P0001';
  end if;
  v_nights := v_req.check_out - v_req.check_in;
  -- current price from the database (the stored quote is what the guest saw; staff can see both)
  v_rate := round(((app_private.quote_room_type(v_req.room_type_id, v_req.check_in, v_req.check_out))->>'net')::numeric / v_nights, 2);
  v_res := public.create_reservation(v_req.property_id, v_room, v_req.check_in, v_req.check_out, v_req.adults, 0, v_req.contact_name,
             v_req.contact_email, v_req.contact_phone, 'Mesaj kutusundan oluşturuldu', 'website', 'CONFIRMED', 'br-' || v_req.id,
             coalesce(v_rate, 0), 'DIRECT', false);
  update public.booking_requests set status = 'CONFIRMED', reservation_id = v_res.id, handled_by = auth.uid(), handled_at = now(),
         guest_id = coalesce(guest_id, (select guest_id from public.reservation_guests where reservation_id = v_res.id and is_primary))
   where id = v_req.id returning * into v_req;
  if v_req.conversation_id is not null then
    select * into v_conv from public.conversations where id = v_req.conversation_id;
    update public.conversations set guest_id = coalesce(guest_id, v_req.guest_id) where id = v_conv.id;
    perform app_private.inbox_add_message(v_conv, 'OUT', 'SYSTEM',
      format('Rezervasyonunuz onaylandı: %s, %s – %s. / Your reservation is confirmed: %s.', v_res.code, app_private.fmt_date(v_res.check_in), app_private.fmt_date(v_res.check_out), v_res.code),
      jsonb_build_object('type', 'reservation_confirmed', 'reservation_id', v_res.id, 'code', v_res.code), 'confirm-' || v_req.id,
      case when v_conv.channel = 'WEBCHAT' then 'DELIVERED' when v_conv.is_demo then 'DEMO_NOT_SENT' else 'PENDING' end);
  end if;
  return v_req;
end $$;

create or replace function public.booking_request_decline(p_request_id uuid, p_reason text default null)
returns public.booking_requests language plpgsql security definer set search_path = '' as $$
declare v_req public.booking_requests;
begin
  select * into v_req from public.booking_requests where id = p_request_id for update;
  if v_req.id is null or coalesce(app_private.property_role(v_req.property_id)::text, '') not in ('owner', 'manager', 'front_desk') then
    raise exception 'INBOX_NOT_FOUND: Talep bulunamadı.' using errcode = 'P0001';
  end if;
  if v_req.status <> 'NEW' then raise exception 'INBOX_BAD_STATE: Talep zaten sonuçlanmış.' using errcode = 'P0001'; end if;
  update public.booking_requests set status = 'DECLINED', decline_reason = left(p_reason, 300), handled_by = auth.uid(), handled_at = now()
   where id = v_req.id returning * into v_req;
  return v_req;
end $$;

-- owners / managers switch a channel between DEMO and LIVE; the ingest secret is stored only as a hash
create or replace function public.channel_configure(p_property_id uuid, p_channel text, p_mode text, p_external_account_id text default null, p_ingest_secret text default null)
returns public.channel_connections language plpgsql security definer set search_path = '' as $$
declare v_conn public.channel_connections;
begin
  if coalesce(app_private.property_role(p_property_id)::text, '') not in ('owner', 'manager') then
    raise exception 'FORBIDDEN: Kanal ayarlarını yalnızca otel sahibi veya müdür değiştirebilir.' using errcode = '42501';
  end if;
  if p_channel not in ('WHATSAPP', 'INSTAGRAM') or p_mode not in ('DEMO', 'LIVE') then
    raise exception 'INBOX_INVALID: Kanal veya mod geçersiz.' using errcode = 'P0001';
  end if;
  if p_mode = 'LIVE' and (p_ingest_secret is null or char_length(p_ingest_secret) < 24) then
    raise exception 'INBOX_INVALID: Gerçek mod için en az 24 karakterlik gizli anahtar gerekli.' using errcode = 'P0001';
  end if;
  update public.channel_connections set mode = p_mode, external_account_id = coalesce(nullif(trim(p_external_account_id), ''), external_account_id)
   where property_id = p_property_id and channel = p_channel returning * into v_conn;
  if p_mode = 'LIVE' then
    insert into app_private.channel_secrets (connection_id, ingest_secret_hash) values (v_conn.id, app_private.sha256(p_ingest_secret))
    on conflict (connection_id) do update set ingest_secret_hash = excluded.ingest_secret_hash;
  else
    delete from app_private.channel_secrets where connection_id = v_conn.id;
  end if;
  return v_conn;
end $$;

-- ---------------------------------------------------------------------
-- Guest 360° and KVKK
-- ---------------------------------------------------------------------
create or replace function public.guest_profile(p_guest_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_guest public.guests; v_res jsonb;
begin
  select * into v_guest from public.guests where id = p_guest_id;
  if v_guest.id is null then raise exception 'GUEST_NOT_FOUND: Misafir bulunamadı.' using errcode = 'P0001'; end if;
  perform app_private.require_guest_access(v_guest.organization_id);
  insert into public.guest_access_log (organization_id, guest_id, actor_id, action) values (v_guest.organization_id, v_guest.id, auth.uid(), 'VIEW');
  select jsonb_build_object(
    'guest', to_jsonb(v_guest),
    'stats', (select jsonb_build_object(
        'stays', count(*) filter (where r.status = 'CHECKED_OUT'),
        'upcoming', count(*) filter (where r.status in ('PENDING', 'CONFIRMED')),
        'in_house', count(*) filter (where r.status = 'CHECKED_IN'),
        'cancellations', count(*) filter (where r.status = 'CANCELLED'),
        'no_shows', count(*) filter (where r.status = 'NO_SHOW'),
        'nights', coalesce(sum(r.check_out - r.check_in) filter (where r.status in ('CHECKED_IN', 'CHECKED_OUT')), 0),
        'first_stay', min(r.check_in) filter (where r.status in ('CHECKED_IN', 'CHECKED_OUT')),
        'last_stay', max(r.check_in) filter (where r.status in ('CHECKED_IN', 'CHECKED_OUT')),
        -- total spend = charges posted to the guest's folios incl. tax (payments and refunds are not spend)
        'total_spend', coalesce((select sum(t.amount) from public.folio_transactions t where t.reservation_id = any (array_agg(r.id))
                                   and t.txn_type in ('ROOM_CHARGE', 'TAX', 'DISCOUNT', 'EXTRA')), 0),
        'currency', (select p.currency from public.properties p where p.organization_id = v_guest.organization_id order by p.created_at limit 1))
      from public.reservations r join public.reservation_guests g on g.reservation_id = r.id and g.is_primary
      where g.guest_id = v_guest.id),
    'stays', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'status', r.status, 'check_in', r.check_in, 'check_out', r.check_out,
                         'room', rm.number, 'property', p.name, 'channel', r.channel_code,
                         'spend', coalesce((select sum(t.amount) from public.folio_transactions t where t.reservation_id = r.id and t.txn_type in ('ROOM_CHARGE', 'TAX', 'DISCOUNT', 'EXTRA')), 0))
                         order by r.check_in desc)
                       from public.reservations r join public.reservation_guests g on g.reservation_id = r.id and g.is_primary
                       join public.rooms rm on rm.id = r.room_id join public.properties p on p.id = r.property_id
                       where g.guest_id = v_guest.id), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(to_jsonb(n) order by n.id desc) from public.guest_notes n where n.guest_id = v_guest.id and n.archived_at is null), '[]'::jsonb),
    'conversations', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'channel', c.channel, 'status', c.status, 'last_message_at', c.last_message_at,
                         'preview', c.last_message_preview, 'is_demo', c.is_demo) order by c.last_message_at desc)
                       from public.conversations c where c.guest_id = v_guest.id), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'status', b.status, 'check_in', b.check_in, 'check_out', b.check_out, 'created_at', b.created_at) order by b.created_at desc)
                       from public.booking_requests b where b.guest_id = v_guest.id), '[]'::jsonb)
  ) into v_res;
  return v_res;
end $$;

create or replace function public.guest_update(p_guest_id uuid, p_changes jsonb) returns public.guests
language plpgsql security definer set search_path = '' as $$
declare v_guest public.guests; v_role text;
begin
  select * into v_guest from public.guests where id = p_guest_id for update;
  if v_guest.id is null then raise exception 'GUEST_NOT_FOUND: Misafir bulunamadı.' using errcode = 'P0001'; end if;
  perform app_private.require_guest_access(v_guest.organization_id);
  if v_guest.anonymized_at is not null then raise exception 'GUEST_ANONYMIZED: Anonimleştirilmiş misafir düzenlenemez.' using errcode = 'P0001'; end if;
  v_role := app_private.org_role(v_guest.organization_id)::text;
  if (p_changes ? 'vip_level' or p_changes ? 'vip_note') and coalesce(v_role, '') not in ('owner', 'manager') then
    raise exception 'FORBIDDEN: VIP durumunu yalnızca müdür veya otel sahibi değiştirebilir.' using errcode = '42501';
  end if;
  update public.guests set
    full_name = coalesce(nullif(trim(p_changes->>'full_name'), ''), full_name),
    email = case when p_changes ? 'email' then nullif(lower(trim(p_changes->>'email')), '') else email end,
    phone = case when p_changes ? 'phone' then nullif(trim(p_changes->>'phone'), '') else phone end,
    phone_normalized = case when p_changes ? 'phone' then app_private.normalize_phone(p_changes->>'phone') else phone_normalized end,
    nationality = case when p_changes ? 'nationality' then nullif(trim(p_changes->>'nationality'), '') else nationality end,
    language = case when p_changes ? 'language' then nullif(trim(p_changes->>'language'), '') else language end,
    vip_level = coalesce((p_changes->>'vip_level')::smallint, vip_level),
    vip_note = case when p_changes ? 'vip_note' then nullif(trim(p_changes->>'vip_note'), '') else vip_note end,
    marketing_consent = coalesce((p_changes->>'marketing_consent')::boolean, marketing_consent),
    marketing_consent_at = case when p_changes ? 'marketing_consent' then now() else marketing_consent_at end,
    marketing_consent_source = case when p_changes ? 'marketing_consent' then coalesce(p_changes->>'marketing_consent_source', 'resepsiyon') else marketing_consent_source end,
    kvkk_notice_at = case when (p_changes->>'kvkk_notice')::boolean then now() else kvkk_notice_at end
  where id = v_guest.id returning * into v_guest;
  insert into public.guest_access_log (organization_id, guest_id, actor_id, action) values (v_guest.organization_id, v_guest.id, auth.uid(), 'UPDATE');
  return v_guest;
end $$;

create or replace function public.guest_add_note(p_guest_id uuid, p_category text, p_body text) returns public.guest_notes
language plpgsql security definer set search_path = '' as $$
declare v_guest public.guests; v_note public.guest_notes;
begin
  select * into v_guest from public.guests where id = p_guest_id;
  if v_guest.id is null then raise exception 'GUEST_NOT_FOUND: Misafir bulunamadı.' using errcode = 'P0001'; end if;
  perform app_private.require_guest_access(v_guest.organization_id);
  if v_guest.anonymized_at is not null then raise exception 'GUEST_ANONYMIZED: Anonimleştirilmiş misafire not eklenemez.' using errcode = 'P0001'; end if;
  if p_category not in ('PREFERENCE', 'SPECIAL_REQUEST', 'ALERT') or nullif(trim(p_body), '') is null or char_length(trim(p_body)) > 500 then
    raise exception 'GUEST_INVALID: Not türü veya metni geçersiz (en fazla 500 karakter).' using errcode = 'P0001';
  end if;
  insert into public.guest_notes (organization_id, guest_id, category, body, created_by)
  values (v_guest.organization_id, v_guest.id, p_category, trim(p_body), auth.uid()) returning * into v_note;
  return v_note;
end $$;

create or replace function public.guest_archive_note(p_note_id bigint) returns public.guest_notes
language plpgsql security definer set search_path = '' as $$
declare v_note public.guest_notes;
begin
  select * into v_note from public.guest_notes where id = p_note_id;
  if v_note.id is null then raise exception 'GUEST_NOT_FOUND: Not bulunamadı.' using errcode = 'P0001'; end if;
  perform app_private.require_guest_access(v_note.organization_id);
  update public.guest_notes set archived_at = now() where id = v_note.id returning * into v_note;
  return v_note;
end $$;

-- data subject access request (KVKK m.11): everything stored about the guest
create or replace function public.kvkk_export_guest(p_guest_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_guest public.guests;
begin
  select * into v_guest from public.guests where id = p_guest_id;
  if v_guest.id is null then raise exception 'GUEST_NOT_FOUND: Misafir bulunamadı.' using errcode = 'P0001'; end if;
  if coalesce(app_private.org_role(v_guest.organization_id)::text, '') not in ('owner', 'manager') then
    raise exception 'FORBIDDEN: Kişisel veri dışa aktarımını yalnızca müdür veya otel sahibi yapabilir.' using errcode = '42501';
  end if;
  insert into public.guest_access_log (organization_id, guest_id, actor_id, action) values (v_guest.organization_id, v_guest.id, auth.uid(), 'EXPORT');
  return jsonb_build_object(
    'exported_at', now(),
    'guest', to_jsonb(v_guest),
    'reservations', coalesce((select jsonb_agg(jsonb_build_object('code', r.code, 'status', r.status, 'check_in', r.check_in, 'check_out', r.check_out,
                       'name', g.full_name, 'email', g.email, 'phone', g.phone)) from public.reservation_guests g join public.reservations r on r.id = g.reservation_id
                       where g.guest_id = v_guest.id), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'body', body, 'created_at', created_at)) from public.guest_notes where guest_id = v_guest.id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('channel', m.channel, 'direction', m.direction, 'sender', m.sender, 'body', m.body, 'at', m.created_at) order by m.id)
                       from public.messages m join public.conversations c on c.id = m.conversation_id where c.guest_id = v_guest.id), '[]'::jsonb));
end $$;

-- right to erasure: personal data is removed, bookings and the financial ledger stay (legal retention of accounts)
create or replace function public.kvkk_anonymize_guest(p_guest_id uuid) returns public.guests
language plpgsql security definer set search_path = '' as $$
declare v_guest public.guests;
begin
  select * into v_guest from public.guests where id = p_guest_id for update;
  if v_guest.id is null then raise exception 'GUEST_NOT_FOUND: Misafir bulunamadı.' using errcode = 'P0001'; end if;
  if coalesce(app_private.org_role(v_guest.organization_id)::text, '') not in ('owner', 'manager') then
    raise exception 'FORBIDDEN: Anonimleştirmeyi yalnızca müdür veya otel sahibi yapabilir.' using errcode = '42501';
  end if;
  if v_guest.anonymized_at is not null then return v_guest; end if;
  if exists (select 1 from public.reservation_guests g join public.reservations r on r.id = g.reservation_id
             where g.guest_id = v_guest.id and r.status in ('PENDING', 'CONFIRMED', 'CHECKED_IN')) then
    raise exception 'GUEST_ACTIVE_STAY: Aktif veya gelecek rezervasyonu olan misafir anonimleştirilemez.' using errcode = 'P0001';
  end if;
  update public.reservation_guests set full_name = 'Anonim misafir', email = null, phone = null, nationality = null where guest_id = v_guest.id;
  update public.messages m set body = '[KVKK: anonimleştirildi]', payload = null
    from public.conversations c where c.id = m.conversation_id and c.guest_id = v_guest.id and m.sender = 'GUEST';
  update public.conversations set contact_name = 'Anonim misafir', contact_handle = null, context = '{}'::jsonb where guest_id = v_guest.id;
  update public.booking_requests set contact_name = 'Anonim misafir', contact_email = null, contact_phone = null where guest_id = v_guest.id;
  delete from public.guest_notes where guest_id = v_guest.id;
  update public.guests set full_name = 'Anonim misafir', email = null, phone = null, phone_normalized = null, nationality = null, language = null,
         vip_note = null, marketing_consent = false, marketing_consent_source = null, anonymized_at = now()
   where id = v_guest.id returning * into v_guest;
  insert into public.guest_access_log (organization_id, guest_id, actor_id, action) values (v_guest.organization_id, v_guest.id, auth.uid(), 'ANONYMIZE');
  return v_guest;
end $$;

-- guests past the organization's retention period with nothing upcoming
create or replace function public.kvkk_retention_candidates(p_organization_id uuid)
returns table (guest_id uuid, full_name text, last_activity_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(app_private.org_role(p_organization_id)::text, '') not in ('owner', 'manager') then
    raise exception 'FORBIDDEN: Yalnızca müdür veya otel sahibi.' using errcode = '42501';
  end if;
  return query
    select g.id, g.full_name, g.last_activity_at from public.guests g, public.organizations o
    where o.id = p_organization_id and g.organization_id = o.id and g.anonymized_at is null
      and g.last_activity_at < now() - make_interval(months => o.guest_retention_months)
      -- still relevant: an active/upcoming booking, or a stay that ended inside the retention period (cancellations do not count)
      and not exists (select 1 from public.reservation_guests rg join public.reservations r on r.id = rg.reservation_id
                      where rg.guest_id = g.id and (r.status in ('PENDING', 'CONFIRMED', 'CHECKED_IN')
                        or (r.status in ('CHECKED_OUT', 'NO_SHOW') and r.check_out > (now() - make_interval(months => o.guest_retention_months))::date)))
    order by g.last_activity_at;
end $$;

-- ---------------------------------------------------------------------
-- RLS and privileges
-- ---------------------------------------------------------------------
alter table public.guests enable row level security;
alter table public.guest_notes enable row level security;
alter table public.guest_access_log enable row level security;
alter table public.rate_calendar enable row level security;
alter table public.channel_connections enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.booking_requests enable row level security;
alter table public.property_faq enable row level security;

drop policy if exists guests_select on public.guests;
create policy guests_select on public.guests for select to authenticated using (app_private.can_see_guests(organization_id));
drop policy if exists guest_notes_select on public.guest_notes;
create policy guest_notes_select on public.guest_notes for select to authenticated using (app_private.can_see_guests(organization_id) and archived_at is null);
drop policy if exists guest_log_select on public.guest_access_log;
create policy guest_log_select on public.guest_access_log for select to authenticated using (app_private.is_org_admin(organization_id));
drop policy if exists rate_cal_select on public.rate_calendar;
create policy rate_cal_select on public.rate_calendar for select to authenticated using (app_private.has_property_access(property_id));
drop policy if exists rate_cal_write on public.rate_calendar;
create policy rate_cal_write on public.rate_calendar for all to authenticated
  using (app_private.is_org_admin(organization_id)) with check (app_private.is_org_admin(organization_id));
drop policy if exists chan_select on public.channel_connections;
create policy chan_select on public.channel_connections for select to authenticated
  using (app_private.property_role(property_id)::text in ('owner', 'manager', 'front_desk'));
drop policy if exists conv_select on public.conversations;
create policy conv_select on public.conversations for select to authenticated
  using (app_private.property_role(property_id)::text in ('owner', 'manager', 'front_desk'));
drop policy if exists msg_select on public.messages;
create policy msg_select on public.messages for select to authenticated
  using (app_private.property_role(property_id)::text in ('owner', 'manager', 'front_desk'));
drop policy if exists br_select on public.booking_requests;
create policy br_select on public.booking_requests for select to authenticated
  using (app_private.property_role(property_id)::text in ('owner', 'manager', 'front_desk'));
drop policy if exists faq_select on public.property_faq;
create policy faq_select on public.property_faq for select to authenticated using (app_private.has_property_access(property_id));
drop policy if exists faq_write on public.property_faq;
create policy faq_write on public.property_faq for all to authenticated
  using (app_private.is_org_admin(organization_id)) with check (app_private.is_org_admin(organization_id));

revoke all on public.guests, public.guest_notes, public.guest_access_log, public.rate_calendar, public.channel_connections,
              public.conversations, public.messages, public.booking_requests, public.property_faq from anon, authenticated;
grant select on public.guests, public.guest_notes, public.guest_access_log, public.channel_connections,
               public.conversations, public.messages, public.booking_requests to authenticated;
grant select, insert, update, delete on public.rate_calendar, public.property_faq to authenticated;
revoke all on app_private.channel_secrets, app_private.webchat_sessions from public, anon, authenticated;

do $$ declare f text; begin
  -- internal helpers: no direct calls from clients
  foreach f in array array[
    'app_private.sha256(text)', 'app_private.normalize_phone(text)', 'app_private.fmt_money(numeric, text, text)',
    'app_private.require_guest_access(uuid)', 'app_private.link_reservation_guest()',
    'app_private.quote_room_type(uuid, date, date)', 'app_private.free_rooms(uuid, date, date)', 'app_private.availability_options(uuid, date, date, integer)',
    'app_private.add_default_connections()', 'app_private.inbox_add_message(public.conversations, text, text, text, jsonb, text, text)',
    'app_private.inbox_authorized(public.conversations, text)', 'app_private.upsert_conversation(uuid, text, text, text, text, boolean)',
    'app_private.lock_conversation(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- used inside RLS policies, so the querying role must be able to execute it (it only answers yes/no for the caller)
  grant execute on function app_private.can_see_guests(uuid) to authenticated;
  -- staff RPCs
  foreach f in array array[
    'public.check_availability(uuid, date, date, integer)', 'public.set_room_type_rate(uuid, numeric)',
    'public.channel_configure(uuid, text, text, text, text)',
    'public.inbox_simulate_inbound(uuid, text, text, text, text, text)', 'public.inbox_send_staff_message(uuid, text, text)',
    'public.inbox_set_status(uuid, text)', 'public.inbox_mark_read(uuid)', 'public.inbox_link_guest(uuid, uuid)',
    'public.booking_request_confirm(uuid)', 'public.booking_request_decline(uuid, text)',
    'public.guest_profile(uuid)', 'public.guest_update(uuid, jsonb)', 'public.guest_add_note(uuid, text, text)', 'public.guest_archive_note(bigint)',
    'public.kvkk_export_guest(uuid)', 'public.kvkk_anonymize_guest(uuid)', 'public.kvkk_retention_candidates(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- public entry points (web chat guests and verified webhooks); each checks its own token / secret
  foreach f in array array[
    'public.inbox_public_property(text, text)',
    'public.webchat_start(text, text, text)', 'public.webchat_send(uuid, text, text, text)', 'public.webchat_messages(uuid, text, bigint)',
    'public.inbox_ingest(text, text, text, text, text, text, text, text)', 'public.inbox_assistant_turn(uuid, text, text, jsonb, text)',
    'public.inbox_set_delivery(bigint, text, text)'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.conversations; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.booking_requests; exception when duplicate_object then null; end;
  end if;
end $$;
