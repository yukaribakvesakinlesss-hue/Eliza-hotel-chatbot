-- =====================================================================
-- AXON Hotel PMS · Phase 3 · Financial engine & folio
--
-- * folios (one per reservation) and folio_transactions: an append-only
--   guest ledger. Room charges, taxes, discounts, extras, payments and
--   refunds are separate transaction types. Corrections are reversals
--   (a new row with the opposite amount); UPDATE and DELETE are refused.
-- * usali_accounts: every transaction carries an account code that maps to
--   a USALI-style schedule (Rooms, F&B, Other Operated, Misc. Income,
--   balance-sheet tax / settlement accounts). This is a mapping structure,
--   NOT a claim of full USALI compliance.
-- * distribution_channels: commission rates per organization; the rate is
--   snapshotted on each reservation so later changes never rewrite history.
-- * room_out_of_order_periods: dated OOO history so capacity can be reported
--   for any past period.
-- Idempotent: safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Chart of accounts (global, read-only for clients)
-- ---------------------------------------------------------------------
create table if not exists public.usali_accounts (
  code            text primary key check (code ~ '^[A-Z_]{2,40}$'),
  name_tr         text not null,
  name_en         text not null,
  kind            text not null check (kind in ('REVENUE', 'ALLOWANCE', 'TAX_LIABILITY', 'SETTLEMENT', 'EXPENSE')),
  usali_schedule  text not null,
  sort_order      smallint not null default 0
);

insert into public.usali_accounts (code, name_tr, name_en, kind, usali_schedule, sort_order) values
  ('ROOMS_TRANSIENT',     'Oda geliri (konaklama)',      'Rooms revenue – transient',     'REVENUE',       'Rooms', 10),
  ('ROOMS_NO_SHOW',       'Oda geliri (no-show)',        'Rooms revenue – no-show',       'REVENUE',       'Rooms', 11),
  ('ROOMS_ALLOWANCE',     'Oda indirimleri',             'Rooms allowances',              'ALLOWANCE',     'Rooms', 12),
  ('FB_FOOD',             'Yiyecek geliri',              'Food revenue',                  'REVENUE',       'Food and Beverage', 20),
  ('FB_BEVERAGE',         'İçecek / minibar geliri',     'Beverage revenue',              'REVENUE',       'Food and Beverage', 21),
  ('OOD_OTHER',           'Diğer hizmet geliri',         'Other operated departments',    'REVENUE',       'Other Operated Departments', 30),
  ('MISC_INCOME',         'Diğer gelirler',              'Miscellaneous income',          'REVENUE',       'Miscellaneous Income', 40),
  ('TAX_VAT',             'KDV (tahsil edilen)',         'VAT payable',                   'TAX_LIABILITY', 'Balance sheet – taxes payable', 50),
  ('TAX_LODGING',         'Konaklama vergisi',           'Lodging tax payable',           'TAX_LIABILITY', 'Balance sheet – taxes payable', 51),
  ('SETTLEMENT_CASH',     'Tahsilat – nakit',            'Settlement – cash',             'SETTLEMENT',    'Balance sheet – cash / guest ledger', 60),
  ('SETTLEMENT_CARD',     'Tahsilat – kart',             'Settlement – card',             'SETTLEMENT',    'Balance sheet – cash / guest ledger', 61),
  ('SETTLEMENT_TRANSFER', 'Tahsilat – havale',           'Settlement – bank transfer',    'SETTLEMENT',    'Balance sheet – cash / guest ledger', 62),
  ('SETTLEMENT_OTA',      'Tahsilat – OTA (sanal kart)', 'Settlement – OTA collect',      'SETTLEMENT',    'Balance sheet – accounts receivable', 63),
  ('ROOMS_COMMISSIONS',   'Komisyon gideri (OTA)',       'Rooms expense – commissions',   'EXPENSE',       'Rooms – other expenses', 70)
on conflict (code) do update set name_tr = excluded.name_tr, name_en = excluded.name_en, kind = excluded.kind,
  usali_schedule = excluded.usali_schedule, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------
-- Property tax settings (demo defaults for Türkiye; confirm with an accountant)
-- ---------------------------------------------------------------------
alter table public.properties
  add column if not exists vat_rate_rooms        numeric(5,4) not null default 0.10 check (vat_rate_rooms between 0 and 0.5),
  add column if not exists lodging_tax_rate      numeric(5,4) not null default 0.02 check (lodging_tax_rate between 0 and 0.5),
  add column if not exists no_show_charge_nights smallint     not null default 1    check (no_show_charge_nights between 0 and 7);

-- ---------------------------------------------------------------------
-- Distribution channels and commission rates
-- ---------------------------------------------------------------------
create table if not exists public.distribution_channels (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  code             text not null check (code ~ '^[A-Z0-9_]{2,20}$'),
  name             text not null check (char_length(name) between 2 and 60),
  commission_rate  numeric(5,4) not null default 0 check (commission_rate between 0 and 1),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, code)
);
drop trigger if exists distribution_channels_touch on public.distribution_channels;
create trigger distribution_channels_touch before update on public.distribution_channels for each row execute function app_private.touch_updated_at();

create or replace function app_private.add_default_channels(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.distribution_channels (organization_id, code, name, commission_rate) values
    (p_org, 'DIRECT', 'AXON Direct', 0),
    (p_org, 'BOOKING', 'Booking.com', 0.18),
    (p_org, 'EXPEDIA', 'Expedia', 0.15)
  on conflict (organization_id, code) do nothing;
$$;

create or replace function app_private.on_organization_created() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.add_default_channels(new.id);
  return new;
end $$;
drop trigger if exists organizations_default_channels on public.organizations;
create trigger organizations_default_channels after insert on public.organizations
  for each row execute function app_private.on_organization_created();

select app_private.add_default_channels(id) from public.organizations;

-- ---------------------------------------------------------------------
-- Reservations: rate, channel (with commission snapshot), complimentary flag
-- ---------------------------------------------------------------------
alter table public.reservations
  add column if not exists nightly_rate     numeric(12,2) not null default 0 check (nightly_rate between 0 and 1000000),
  add column if not exists channel_code     text not null default 'DIRECT',
  add column if not exists commission_rate  numeric(5,4) not null default 0 check (commission_rate between 0 and 1),
  add column if not exists is_complimentary boolean not null default false;

do $$ begin
  alter table public.reservations add constraint reservations_channel_fk
    foreign key (organization_id, channel_code) references public.distribution_channels(organization_id, code);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.reservations add constraint reservations_comp_no_rate check (not is_complimentary or nightly_rate = 0);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Out-of-order history (capacity for any past period)
-- ---------------------------------------------------------------------
create table if not exists public.room_out_of_order_periods (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  property_id      uuid not null,
  room_id          uuid not null references public.rooms(id) on delete cascade,
  start_date       date not null,
  end_date         date,           -- exclusive; null = still out of order
  reason           text check (reason is null or char_length(reason) <= 500),
  created_at       timestamptz not null default now(),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade,
  check (end_date is null or end_date >= start_date)
);
create unique index if not exists room_ooo_one_open on public.room_out_of_order_periods (room_id) where end_date is null;
create index if not exists room_ooo_property_idx on public.room_out_of_order_periods (property_id, start_date);

create or replace function app_private.track_out_of_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_today date;
begin
  if tg_op = 'INSERT' then
    if new.maintenance_status <> 'OUT_OF_ORDER' then return null; end if;
  elsif new.maintenance_status is not distinct from old.maintenance_status then
    return null;
  end if;
  select (now() at time zone p.timezone)::date into v_today from public.properties p where p.id = new.property_id;
  if new.maintenance_status = 'OUT_OF_ORDER' then
    insert into public.room_out_of_order_periods (organization_id, property_id, room_id, start_date, reason)
    values (new.organization_id, new.property_id, new.id, v_today, new.maintenance_note)
    on conflict (room_id) where end_date is null do nothing;
  else
    update public.room_out_of_order_periods set end_date = greatest(start_date, v_today)
     where room_id = new.id and end_date is null;
  end if;
  return null;
end $$;
drop trigger if exists rooms_track_ooo on public.rooms;
create trigger rooms_track_ooo after insert or update of maintenance_status on public.rooms
  for each row execute function app_private.track_out_of_order();

-- rooms already out of order get an open period starting today
insert into public.room_out_of_order_periods (organization_id, property_id, room_id, start_date, reason)
select r.organization_id, r.property_id, r.id, (now() at time zone p.timezone)::date, r.maintenance_note
from public.rooms r join public.properties p on p.id = r.property_id
where r.maintenance_status = 'OUT_OF_ORDER'
  and not exists (select 1 from public.room_out_of_order_periods o where o.room_id = r.id and o.end_date is null);

-- ---------------------------------------------------------------------
-- Folios and the append-only ledger
-- ---------------------------------------------------------------------
do $$ begin
  create type public.folio_txn_type as enum ('ROOM_CHARGE', 'TAX', 'DISCOUNT', 'EXTRA', 'PAYMENT', 'REFUND');
exception when duplicate_object then null; end $$;

create table if not exists public.folios (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,
  reservation_id   uuid not null unique,
  status           text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  currency         char(3) not null default 'EUR',
  closed_at        timestamptz,
  closed_by        uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade,
  foreign key (reservation_id, property_id) references public.reservations(id, property_id) on delete cascade,
  unique (id, property_id)
);

create table if not exists public.folio_transactions (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  property_id      uuid not null,
  folio_id         uuid not null,
  reservation_id   uuid not null,
  txn_type         public.folio_txn_type not null,
  account_code     text not null references public.usali_accounts(code),
  description      text not null check (char_length(description) between 1 and 200),
  service_date     date not null,
  amount           numeric(12,2) not null check (amount <> 0),
  tax_code         text check (tax_code in ('VAT', 'LODGING')),
  tax_rate         numeric(5,4) check (tax_rate between 0 and 0.5),
  parent_id        bigint references public.folio_transactions(id),
  reverses_id      bigint unique references public.folio_transactions(id),
  payment_method   text check (payment_method in ('CASH', 'CARD', 'TRANSFER', 'OTA')),
  idempotency_key  text check (idempotency_key is null or char_length(idempotency_key) between 8 and 100),
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  foreign key (folio_id, property_id) references public.folios(id, property_id) on delete restrict,
  unique (folio_id, idempotency_key),
  -- sign convention (effect on the guest balance): charges +, discounts and payments −
  constraint folio_txn_sign check (
    reverses_id is not null or txn_type = 'TAX'
    or (txn_type in ('ROOM_CHARGE', 'EXTRA', 'REFUND') and amount > 0)
    or (txn_type in ('DISCOUNT', 'PAYMENT') and amount < 0)),
  constraint folio_txn_tax_has_parent check (txn_type <> 'TAX' or (parent_id is not null and tax_code is not null))
);
create index if not exists folio_txn_folio_idx on public.folio_transactions (folio_id, id);
create index if not exists folio_txn_property_date_idx on public.folio_transactions (property_id, service_date);
create index if not exists folio_txn_reservation_idx on public.folio_transactions (reservation_id, service_date);

-- the ledger never changes: corrections are reversal rows
create or replace function app_private.folio_txn_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'FOLIO_IMMUTABLE: Folyo hareketleri değiştirilemez veya silinemez; düzeltme için ters kayıt kullanın.' using errcode = '42501';
end $$;
drop trigger if exists folio_txn_no_update on public.folio_transactions;
create trigger folio_txn_no_update before update or delete on public.folio_transactions
  for each row execute function app_private.folio_txn_immutable();
drop trigger if exists folio_txn_no_truncate on public.folio_transactions;
create trigger folio_txn_no_truncate before truncate on public.folio_transactions
  for each statement execute function app_private.folio_txn_immutable();

create or replace function app_private.folio_txn_open_only() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select status from public.folios where id = new.folio_id) <> 'OPEN' then
    raise exception 'FOLIO_CLOSED: Folyo kapatılmış; yeni hareket eklenemez.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists folio_txn_open_only on public.folio_transactions;
create trigger folio_txn_open_only before insert on public.folio_transactions
  for each row execute function app_private.folio_txn_open_only();

-- every reservation gets a folio
create or replace function app_private.create_folio() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.folios (organization_id, property_id, reservation_id, currency)
  select new.organization_id, new.property_id, new.id, p.currency from public.properties p where p.id = new.property_id
  on conflict (reservation_id) do nothing;
  return null;
end $$;
drop trigger if exists reservations_create_folio on public.reservations;
create trigger reservations_create_folio after insert on public.reservations
  for each row execute function app_private.create_folio();

insert into public.folios (organization_id, property_id, reservation_id, currency)
select r.organization_id, r.property_id, r.id, p.currency
from public.reservations r join public.properties p on p.id = r.property_id
on conflict (reservation_id) do nothing;

-- ---------------------------------------------------------------------
-- Internal posting helpers (no permission checks: callers check first)
-- ---------------------------------------------------------------------
create or replace function app_private.insert_folio_txn(
  p_folio public.folios, p_type public.folio_txn_type, p_account text, p_description text, p_service_date date,
  p_amount numeric, p_tax_code text default null, p_tax_rate numeric default null, p_parent bigint default null,
  p_reverses bigint default null, p_method text default null, p_key text default null
) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.folio_transactions (organization_id, property_id, folio_id, reservation_id, txn_type, account_code, description,
    service_date, amount, tax_code, tax_rate, parent_id, reverses_id, payment_method, idempotency_key, created_by)
  values (p_folio.organization_id, p_folio.property_id, p_folio.id, p_folio.reservation_id, p_type, p_account, p_description,
    p_service_date, round(p_amount, 2), p_tax_code, p_tax_rate, p_parent, p_reverses, p_method, p_key, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- tax lines for a charge (positive) or an allowance (negative); zero-amount lines are skipped
create or replace function app_private.insert_tax_lines(p_folio public.folios, p_parent bigint, p_base numeric, p_date date,
  p_vat numeric, p_lodging numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_vat, 0) > 0 and round(p_base * p_vat, 2) <> 0 then
    perform app_private.insert_folio_txn(p_folio, 'TAX', 'TAX_VAT', 'KDV %' || trim(to_char(p_vat * 100, 'FM990.##')), p_date,
      p_base * p_vat, 'VAT', p_vat, p_parent);
  end if;
  if coalesce(p_lodging, 0) > 0 and round(p_base * p_lodging, 2) <> 0 then
    perform app_private.insert_folio_txn(p_folio, 'TAX', 'TAX_LODGING', 'Konaklama vergisi %' || trim(to_char(p_lodging * 100, 'FM990.##')), p_date,
      p_base * p_lodging, 'LODGING', p_lodging, p_parent);
  end if;
end $$;

-- posts one room charge (+ taxes) per night in [p_from, p_through], skipping nights already posted
create or replace function app_private.post_room_nights(p_reservation_id uuid, p_from date, p_through date)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_res public.reservations; v_folio public.folios; v_prop public.properties;
  v_day date; v_id bigint; v_n int := 0;
begin
  select * into v_res from public.reservations where id = p_reservation_id;
  if v_res.is_complimentary or v_res.nightly_rate <= 0 then return 0; end if;
  select * into v_folio from public.folios where reservation_id = v_res.id for update;
  if v_folio.status <> 'OPEN' then return 0; end if;
  select * into v_prop from public.properties where id = v_res.property_id;
  v_day := greatest(p_from, v_res.check_in);
  while v_day <= least(p_through, v_res.check_out - 1) loop
    if not exists (
      select 1 from public.folio_transactions t
      where t.reservation_id = v_res.id and t.txn_type = 'ROOM_CHARGE' and t.account_code = 'ROOMS_TRANSIENT'
        and t.service_date = v_day and t.reverses_id is null
        and not exists (select 1 from public.folio_transactions r where r.reverses_id = t.id)) then
      v_id := app_private.insert_folio_txn(v_folio, 'ROOM_CHARGE', 'ROOMS_TRANSIENT', 'Konaklama ' || to_char(v_day, 'DD.MM.YYYY'),
        v_day, v_res.nightly_rate);
      perform app_private.insert_tax_lines(v_folio, v_id, v_res.nightly_rate, v_day, v_prop.vat_rate_rooms, v_prop.lodging_tax_rate);
      v_n := v_n + 1;
    end if;
    v_day := v_day + 1;
  end loop;
  return v_n;
end $$;

-- check-out posts the remaining nights; no-show posts the property's no-show charge
create or replace function app_private.reservation_financials() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_folio public.folios; v_prop public.properties; v_id bigint; v_nights int;
begin
  if new.status = old.status then return null; end if;
  if new.status = 'CHECKED_OUT' then
    perform app_private.post_room_nights(new.id, new.check_in, new.check_out - 1);
  elsif new.status = 'NO_SHOW' and not new.is_complimentary and new.nightly_rate > 0 then
    select * into v_prop from public.properties where id = new.property_id;
    v_nights := least(v_prop.no_show_charge_nights, new.check_out - new.check_in);
    if v_nights > 0 then
      select * into v_folio from public.folios where reservation_id = new.id for update;
      v_id := app_private.insert_folio_txn(v_folio, 'ROOM_CHARGE', 'ROOMS_NO_SHOW', 'No-show ücreti (' || v_nights || ' gece)',
        new.check_in, new.nightly_rate * v_nights);
      perform app_private.insert_tax_lines(v_folio, v_id, new.nightly_rate * v_nights, new.check_in, v_prop.vat_rate_rooms, 0);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists reservations_financials on public.reservations;
create trigger reservations_financials after update of status on public.reservations
  for each row execute function app_private.reservation_financials();

-- ---------------------------------------------------------------------
-- RPC: create_reservation now also takes rate, channel and complimentary flag
-- (replaces the Phase 2 signature; same rules and error messages)
-- ---------------------------------------------------------------------
drop function if exists public.create_reservation(uuid, uuid, date, date, int, int, text, text, text, text, text, public.reservation_status, text);

create or replace function public.create_reservation(
  p_property_id      uuid,
  p_room_id          uuid,
  p_check_in         date,
  p_check_out        date,
  p_adults           int,
  p_children         int default 0,
  p_guest_name       text default null,
  p_guest_email      text default null,
  p_guest_phone      text default null,
  p_notes            text default null,
  p_source           text default 'direct',
  p_status           public.reservation_status default 'CONFIRMED',
  p_idempotency_key  text default null,
  p_nightly_rate     numeric default 0,
  p_channel_code     text default 'DIRECT',
  p_is_complimentary boolean default false
) returns public.reservations
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_room    public.rooms;
  v_res     public.reservations;
  v_today   date;
  v_hash    text;
  v_idem    public.reservation_idempotency;
  v_channel public.distribution_channels;
  v_rate    numeric(12,2) := case when p_is_complimentary then 0 else round(coalesce(p_nightly_rate, 0), 2) end;
begin
  perform app_private.require_front_desk(p_property_id);

  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_property_id, p_room_id, p_check_in, p_check_out, p_adults, coalesce(p_children, 0),
                            lower(trim(coalesce(p_guest_name, ''))), lower(trim(coalesce(p_guest_email, ''))), p_status,
                            v_rate, upper(coalesce(p_channel_code, 'DIRECT')), coalesce(p_is_complimentary, false)));
    insert into public.reservation_idempotency (user_id, key, request_hash)
      values (v_uid, p_idempotency_key, v_hash)
      on conflict (user_id, key) do nothing;
    if not found then
      select * into v_idem from public.reservation_idempotency where user_id = v_uid and key = p_idempotency_key;
      if v_idem.request_hash <> v_hash then
        raise exception 'IDEMPOTENCY_MISMATCH: Bu işlem anahtarı farklı bir rezervasyon için kullanılmış. Formu yeniden açıp tekrar deneyin.' using errcode = 'P0001';
      end if;
      select * into v_res from public.reservations where id = v_idem.reservation_id;
      if v_res.id is null then
        raise exception 'IDEMPOTENCY_IN_PROGRESS: Aynı rezervasyon isteği hâlâ işleniyor. Birkaç saniye sonra tekrar deneyin.' using errcode = 'P0001';
      end if;
      return v_res;
    end if;
  end if;

  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in then
    raise exception 'RES_INVALID_DATES: Çıkış tarihi giriş tarihinden sonra olmalı.' using errcode = 'P0001';
  end if;
  if p_check_out > p_check_in + 365 then
    raise exception 'RES_INVALID_DATES: Bir rezervasyon en fazla 365 gece olabilir.' using errcode = 'P0001';
  end if;
  v_today := app_private.property_today(p_property_id);
  if p_check_in < v_today then
    raise exception 'RES_PAST_DATE: Geçmiş bir tarihe rezervasyon oluşturulamaz.' using errcode = 'P0001';
  end if;
  if p_status not in ('PENDING', 'CONFIRMED') then
    raise exception 'RES_BAD_STATE: Yeni rezervasyon yalnızca Beklemede veya Onaylı olarak oluşturulabilir.' using errcode = 'P0001';
  end if;
  if char_length(trim(coalesce(p_guest_name, ''))) < 2 then
    raise exception 'RES_GUEST_REQUIRED: Misafir adı en az 2 karakter olmalı.' using errcode = 'P0001';
  end if;
  if v_rate < 0 or v_rate > 1000000 then
    raise exception 'RES_INVALID_RATE: Gecelik fiyat 0 ile 1.000.000 arasında olmalı.' using errcode = 'P0001';
  end if;

  select * into v_room from public.rooms where id = p_room_id and property_id = p_property_id for update;
  if v_room.id is null then
    raise exception 'RES_ROOM_NOT_FOUND: Oda bulunamadı.' using errcode = 'P0001';
  end if;
  select * into v_channel from public.distribution_channels
   where organization_id = v_room.organization_id and code = upper(coalesce(p_channel_code, 'DIRECT')) and is_active;
  if v_channel.id is null then
    raise exception 'RES_CHANNEL: Satış kanalı bulunamadı veya pasif.' using errcode = 'P0001';
  end if;
  perform app_private.assert_room_fits(v_room, p_check_in, p_adults, p_children, v_today);
  perform app_private.assert_room_available(p_room_id, p_check_in, p_check_out, null);

  begin
    insert into public.reservations (organization_id, property_id, room_id, status, check_in, check_out, adults, children,
                                     source, notes, created_by, updated_by, nightly_rate, channel_code, commission_rate, is_complimentary)
    values (v_room.organization_id, p_property_id, p_room_id, p_status, p_check_in, p_check_out, p_adults, coalesce(p_children, 0),
            coalesce(p_source, 'direct'), nullif(trim(p_notes), ''), v_uid, v_uid,
            v_rate, v_channel.code, v_channel.commission_rate, coalesce(p_is_complimentary, false))
    returning * into v_res;
  exception when exclusion_violation then
    raise exception 'RES_CONFLICT: Oda % seçilen tarihlerde başka bir rezervasyonla çakışıyor.', v_room.number using errcode = 'P0001';
  end;

  insert into public.reservation_guests (organization_id, property_id, reservation_id, full_name, email, phone, is_primary)
  values (v_res.organization_id, p_property_id, v_res.id, trim(p_guest_name), nullif(lower(trim(p_guest_email)), ''),
          nullif(trim(p_guest_phone), ''), true);

  if p_idempotency_key is not null then
    update public.reservation_idempotency set reservation_id = v_res.id where user_id = v_uid and key = p_idempotency_key;
  end if;
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- RPC: folio operations (front desk and up)
-- ---------------------------------------------------------------------
create or replace function app_private.lock_folio_for(p_reservation_id uuid) returns public.folios
language plpgsql security definer set search_path = '' as $$
declare v_folio public.folios;
begin
  select * into v_folio from public.folios where reservation_id = p_reservation_id for update;
  if v_folio.id is null or app_private.property_role(v_folio.property_id) is null then
    raise exception 'FOLIO_NOT_FOUND: Folyo bulunamadı.' using errcode = 'P0001';
  end if;
  perform app_private.require_front_desk(v_folio.property_id);
  if v_folio.status <> 'OPEN' then
    raise exception 'FOLIO_CLOSED: Folyo kapatılmış; yeni hareket eklenemez.' using errcode = 'P0001';
  end if;
  return v_folio;
end $$;

-- posts room nights up to p_through (default: tonight) for an in-house or departed guest
create or replace function public.post_room_charges(p_reservation_id uuid, p_through date default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v_folio public.folios; v_res public.reservations;
begin
  v_folio := app_private.lock_folio_for(p_reservation_id);
  select * into v_res from public.reservations where id = p_reservation_id;
  if v_res.status not in ('CHECKED_IN', 'CHECKED_OUT') then
    raise exception 'FOLIO_NOT_IN_HOUSE: Konaklama ücreti yalnızca giriş yapmış misafire işlenir.' using errcode = 'P0001';
  end if;
  return app_private.post_room_nights(p_reservation_id, v_res.check_in,
    coalesce(p_through, least(v_res.check_out - 1, app_private.property_today(v_res.property_id))));
end $$;

-- night audit: post the given night for every in-house guest of the property
create or replace function public.run_night_audit(p_property_id uuid, p_business_date date default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v_date date; v_n int := 0; r record;
begin
  perform app_private.require_front_desk(p_property_id);
  v_date := coalesce(p_business_date, app_private.property_today(p_property_id));
  if v_date > app_private.property_today(p_property_id) then
    raise exception 'FOLIO_FUTURE_DATE: Gelecek bir gece için gece denetimi yapılamaz.' using errcode = 'P0001';
  end if;
  for r in select id from public.reservations
            where property_id = p_property_id and status = 'CHECKED_IN' and check_in <= v_date and check_out > v_date
            order by id loop
    v_n := v_n + app_private.post_room_nights(r.id, v_date, v_date);
  end loop;
  return v_n;
end $$;

-- extras, discounts, payments and refunds (amount is always entered as a positive number)
create or replace function public.post_folio_transaction(
  p_reservation_id  uuid,
  p_type            public.folio_txn_type,
  p_amount          numeric,
  p_description     text default null,
  p_account_code    text default null,
  p_service_date    date default null,
  p_tax_rate        numeric default null,
  p_payment_method  text default null,
  p_idempotency_key text default null
) returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_folio public.folios; v_prop public.properties; v_id bigint; v_existing public.folio_transactions;
  v_amount numeric(12,2) := round(coalesce(p_amount, 0), 2);
  v_date date; v_account text; v_desc text := nullif(trim(coalesce(p_description, '')), '');
  v_room_net numeric; v_paid numeric;
begin
  v_folio := app_private.lock_folio_for(p_reservation_id);
  select * into v_prop from public.properties where id = v_folio.property_id;

  if p_idempotency_key is not null then
    select * into v_existing from public.folio_transactions where folio_id = v_folio.id and idempotency_key = p_idempotency_key;
    if v_existing.id is not null then
      if v_existing.txn_type <> p_type or abs(v_existing.amount) <> v_amount then
        raise exception 'FOLIO_IDEMPOTENCY_MISMATCH: Bu işlem anahtarı farklı bir hareket için kullanılmış.' using errcode = 'P0001';
      end if;
      return v_existing.id; -- replay: nothing posted twice
    end if;
  end if;

  if v_amount <= 0 or v_amount > 1000000 then
    raise exception 'FOLIO_INVALID_AMOUNT: Tutar 0''dan büyük ve en fazla 1.000.000 olmalı.' using errcode = 'P0001';
  end if;
  v_date := coalesce(p_service_date, app_private.property_today(v_folio.property_id));

  if p_type = 'EXTRA' then
    v_account := coalesce(p_account_code, 'OOD_OTHER');
    if v_account not in ('FB_FOOD', 'FB_BEVERAGE', 'OOD_OTHER', 'MISC_INCOME') then
      raise exception 'FOLIO_BAD_ACCOUNT: Ek hizmet için geçersiz hesap.' using errcode = 'P0001';
    end if;
    if coalesce(p_tax_rate, 0) < 0 or coalesce(p_tax_rate, 0) > 0.5 then
      raise exception 'FOLIO_BAD_TAX: KDV oranı 0 ile %%50 arasında olmalı.' using errcode = 'P0001';
    end if;
    v_id := app_private.insert_folio_txn(v_folio, 'EXTRA', v_account, coalesce(v_desc, 'Ek hizmet'), v_date, v_amount,
      null, null, null, null, null, p_idempotency_key);
    perform app_private.insert_tax_lines(v_folio, v_id, v_amount, v_date, coalesce(p_tax_rate, 0), 0);

  elsif p_type = 'DISCOUNT' then
    select coalesce(sum(amount), 0) into v_room_net from public.folio_transactions
     where folio_id = v_folio.id and account_code in ('ROOMS_TRANSIENT', 'ROOMS_ALLOWANCE');
    if v_amount > v_room_net then
      raise exception 'FOLIO_DISCOUNT_EXCEEDS: İndirim, işlenmiş oda ücretini (% %) aşamaz.', v_room_net, v_folio.currency using errcode = 'P0001';
    end if;
    v_id := app_private.insert_folio_txn(v_folio, 'DISCOUNT', 'ROOMS_ALLOWANCE', coalesce(v_desc, 'Oda indirimi'), v_date, -v_amount,
      null, null, null, null, null, p_idempotency_key);
    perform app_private.insert_tax_lines(v_folio, v_id, -v_amount, v_date, v_prop.vat_rate_rooms, v_prop.lodging_tax_rate);

  elsif p_type in ('PAYMENT', 'REFUND') then
    if p_payment_method not in ('CASH', 'CARD', 'TRANSFER', 'OTA') or p_payment_method is null then
      raise exception 'FOLIO_BAD_METHOD: Ödeme yöntemi nakit, kart, havale veya OTA olmalı.' using errcode = 'P0001';
    end if;
    v_account := 'SETTLEMENT_' || p_payment_method;
    if p_type = 'REFUND' then
      select coalesce(-sum(amount), 0) into v_paid from public.folio_transactions
       where folio_id = v_folio.id and txn_type in ('PAYMENT', 'REFUND');
      if v_amount > v_paid then
        raise exception 'FOLIO_REFUND_EXCEEDS: İade tutarı, alınan net ödemeyi (% %) aşamaz.', v_paid, v_folio.currency using errcode = 'P0001';
      end if;
    end if;
    v_id := app_private.insert_folio_txn(v_folio, p_type, v_account,
      coalesce(v_desc, case when p_type = 'PAYMENT' then 'Tahsilat' else 'İade' end), v_date,
      case when p_type = 'PAYMENT' then -v_amount else v_amount end, null, null, null, null, p_payment_method, p_idempotency_key);
  else
    raise exception 'FOLIO_BAD_TYPE: Konaklama ücreti ve vergi satırları otomatik işlenir; bu türde elle hareket eklenemez.' using errcode = 'P0001';
  end if;
  return v_id;
end $$;

-- correction = reversal row(s); the original stays in the ledger
create or replace function public.reverse_folio_transaction(p_transaction_id bigint, p_reason text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_txn public.folio_transactions; v_folio public.folios; v_id bigint; c record;
begin
  select * into v_txn from public.folio_transactions where id = p_transaction_id;
  if v_txn.id is null then
    raise exception 'FOLIO_TXN_NOT_FOUND: Hareket bulunamadı.' using errcode = 'P0001';
  end if;
  v_folio := app_private.lock_folio_for(v_txn.reservation_id);
  if v_txn.reverses_id is not null then
    raise exception 'FOLIO_BAD_REVERSAL: Ters kayıt yeniden ters çevrilemez.' using errcode = 'P0001';
  end if;
  if v_txn.parent_id is not null then
    raise exception 'FOLIO_BAD_REVERSAL: Vergi satırı tek başına iptal edilemez; ana hareketi iptal edin.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.folio_transactions where reverses_id = v_txn.id) then
    raise exception 'FOLIO_ALREADY_REVERSED: Bu hareket zaten iptal edilmiş.' using errcode = 'P0001';
  end if;
  v_id := app_private.insert_folio_txn(v_folio, v_txn.txn_type, v_txn.account_code,
    left('İptal: ' || v_txn.description || coalesce(' (' || nullif(trim(p_reason), '') || ')', ''), 200),
    v_txn.service_date, -v_txn.amount, null, null, null, v_txn.id, v_txn.payment_method);
  for c in select * from public.folio_transactions where parent_id = v_txn.id and reverses_id is null loop
    perform app_private.insert_folio_txn(v_folio, c.txn_type, c.account_code, left('İptal: ' || c.description, 200),
      c.service_date, -c.amount, c.tax_code, c.tax_rate, v_id, c.id);
  end loop;
  return v_id;
end $$;

-- close a settled folio of a finished stay
create or replace function public.close_folio(p_reservation_id uuid)
returns public.folios language plpgsql security definer set search_path = '' as $$
declare v_folio public.folios; v_balance numeric; v_status public.reservation_status;
begin
  v_folio := app_private.lock_folio_for(p_reservation_id);
  select status into v_status from public.reservations where id = p_reservation_id;
  if v_status not in ('CHECKED_OUT', 'CANCELLED', 'NO_SHOW') then
    raise exception 'FOLIO_STAY_ACTIVE: Folyo, konaklama bitmeden kapatılamaz.' using errcode = 'P0001';
  end if;
  select coalesce(sum(amount), 0) into v_balance from public.folio_transactions where folio_id = v_folio.id;
  if v_balance <> 0 then
    raise exception 'FOLIO_BALANCE_NOT_ZERO: Folyo bakiyesi sıfır değil (% %). Önce tahsilat veya iade yapın.', v_balance, v_folio.currency using errcode = 'P0001';
  end if;
  update public.folios set status = 'CLOSED', closed_at = now(), closed_by = auth.uid() where id = v_folio.id returning * into v_folio;
  return v_folio;
end $$;

-- ---------------------------------------------------------------------
-- RLS and privileges
-- ---------------------------------------------------------------------
alter table public.usali_accounts enable row level security;
alter table public.distribution_channels enable row level security;
alter table public.room_out_of_order_periods enable row level security;
alter table public.folios enable row level security;
alter table public.folio_transactions enable row level security;

drop policy if exists acc_select on public.usali_accounts;
create policy acc_select on public.usali_accounts for select to authenticated using (true);

drop policy if exists ch_select on public.distribution_channels;
create policy ch_select on public.distribution_channels for select to authenticated
  using (app_private.is_org_member(organization_id));
drop policy if exists ch_write on public.distribution_channels;
create policy ch_write on public.distribution_channels for all to authenticated
  using (app_private.is_org_admin(organization_id)) with check (app_private.is_org_admin(organization_id));

drop policy if exists ooo_select on public.room_out_of_order_periods;
create policy ooo_select on public.room_out_of_order_periods for select to authenticated
  using (app_private.has_property_access(property_id));

-- financial data: front desk and up (not housekeeping)
drop policy if exists folio_select on public.folios;
create policy folio_select on public.folios for select to authenticated
  using (app_private.property_role(property_id) in ('owner', 'manager', 'front_desk'));
drop policy if exists ftx_select on public.folio_transactions;
create policy ftx_select on public.folio_transactions for select to authenticated
  using (app_private.property_role(property_id) in ('owner', 'manager', 'front_desk'));

revoke all on public.usali_accounts, public.distribution_channels, public.room_out_of_order_periods,
              public.folios, public.folio_transactions from anon, authenticated;
grant select on public.usali_accounts, public.room_out_of_order_periods, public.folios, public.folio_transactions to authenticated;
grant select, insert, update on public.distribution_channels to authenticated;

revoke all on function app_private.add_default_channels(uuid) from public, authenticated;
revoke all on function app_private.insert_folio_txn(public.folios, public.folio_txn_type, text, text, date, numeric, text, numeric, bigint, bigint, text, text) from public, authenticated;
revoke all on function app_private.insert_tax_lines(public.folios, bigint, numeric, date, numeric, numeric) from public, authenticated;
revoke all on function app_private.post_room_nights(uuid, date, date) from public, authenticated;
revoke all on function app_private.lock_folio_for(uuid) from public, authenticated;

revoke all on function public.create_reservation(uuid, uuid, date, date, int, int, text, text, text, text, text, public.reservation_status, text, numeric, text, boolean) from public, anon;
revoke all on function public.post_room_charges(uuid, date) from public, anon;
revoke all on function public.run_night_audit(uuid, date) from public, anon;
revoke all on function public.post_folio_transaction(uuid, public.folio_txn_type, numeric, text, text, date, numeric, text, text) from public, anon;
revoke all on function public.reverse_folio_transaction(bigint, text) from public, anon;
revoke all on function public.close_folio(uuid) from public, anon;
grant execute on function public.create_reservation(uuid, uuid, date, date, int, int, text, text, text, text, text, public.reservation_status, text, numeric, text, boolean) to authenticated;
grant execute on function public.post_room_charges(uuid, date) to authenticated;
grant execute on function public.run_night_audit(uuid, date) to authenticated;
grant execute on function public.post_folio_transaction(uuid, public.folio_txn_type, numeric, text, text, date, numeric, text, text) to authenticated;
grant execute on function public.reverse_folio_transaction(bigint, text) to authenticated;
grant execute on function public.close_folio(uuid) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.folio_transactions; exception when duplicate_object then null; end;
  end if;
end $$;
