-- =====================================================================
-- AXON Hotel PMS · Phase 2 · Reservation engine & overbooking protection
--
-- Layers of protection against double booking:
--   1. EXCLUDE constraint (btree_gist): the database itself refuses two
--      active reservations of the same room whose [check_in, check_out)
--      ranges overlap. Nothing (API bug, SQL console, race) can bypass it.
--   2. Every write goes through a SECURITY DEFINER function that runs in
--      one transaction and takes SELECT ... FOR UPDATE on the room, so
--      concurrent requests for the same room are serialized and the loser
--      gets a clear Turkish error instead of a raw constraint violation.
--   3. Idempotency keys: a retried request (double click, network retry)
--      returns the reservation created the first time instead of a new one.
--
-- Error contract: every business error is raised as 'CODE: Türkçe mesaj'
-- (errcode P0001) so the API can show the message and map the code.
-- Idempotent: safe to run more than once.
-- =====================================================================

create extension if not exists btree_gist with schema extensions;

do $$ begin
  create type public.reservation_status as enum ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW');
exception when duplicate_object then null; end $$;

-- reservations reference (room, property) so a booking can never point at another hotel's room
do $$ begin
  alter table public.rooms add constraint rooms_id_property_key unique (id, property_id);
exception when duplicate_object or duplicate_table then null; end $$;

create sequence if not exists public.reservation_code_seq;

-- ---------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------
create table if not exists public.reservations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,
  room_id          uuid not null,
  code             text not null unique default ('R' || to_char(nextval('public.reservation_code_seq'), 'FM000000')),
  status           public.reservation_status not null default 'CONFIRMED',
  check_in         date not null,
  check_out        date not null,
  -- half-open range: the check-out day is free for the next guest
  stay             daterange generated always as (daterange(check_in, check_out, '[)')) stored,
  adults           smallint not null default 1 check (adults between 1 and 20),
  children         smallint not null default 0 check (children between 0 and 20),
  source           text not null default 'direct' check (source in ('direct', 'phone', 'walk_in', 'email', 'website', 'ota')),
  notes            text check (notes is null or char_length(notes) <= 1000),
  version          integer not null default 1,
  created_by       uuid references public.users(id) on delete set null,
  updated_by       uuid references public.users(id) on delete set null,
  checked_in_at    timestamptz,
  checked_out_at   timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text check (cancel_reason is null or char_length(cancel_reason) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade,
  foreign key (room_id, property_id) references public.rooms(id, property_id) on delete restrict,
  unique (id, property_id),
  constraint reservations_dates_valid check (check_out > check_in and check_out <= check_in + 365),
  -- THE overbooking guard. Cancelled and no-show bookings release the room.
  constraint reservations_no_overlap exclude using gist (room_id with =, stay with &&)
    where (status not in ('CANCELLED', 'NO_SHOW'))
);
create index if not exists reservations_property_dates_idx on public.reservations (property_id, check_in, check_out);
create index if not exists reservations_room_idx on public.reservations (room_id);

drop trigger if exists reservations_touch on public.reservations;
create trigger reservations_touch before update on public.reservations for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- Reservation guests (exactly one primary guest per reservation)
-- ---------------------------------------------------------------------
create table if not exists public.reservation_guests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,
  reservation_id   uuid not null,
  full_name        text not null check (char_length(full_name) between 2 and 120),
  email            text check (email is null or (char_length(email) <= 160 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone            text check (phone is null or char_length(phone) <= 30),
  nationality      text check (nationality is null or char_length(nationality) <= 60),
  is_primary       boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade,
  foreign key (reservation_id, property_id) references public.reservations(id, property_id) on delete cascade
);
create index if not exists reservation_guests_reservation_idx on public.reservation_guests (reservation_id);
create unique index if not exists reservation_guests_one_primary on public.reservation_guests (reservation_id) where is_primary;

drop trigger if exists reservation_guests_touch on public.reservation_guests;
create trigger reservation_guests_touch before update on public.reservation_guests for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- Idempotency keys (per user). Only the reservation functions touch this.
-- ---------------------------------------------------------------------
create table if not exists public.reservation_idempotency (
  user_id         uuid not null references public.users(id) on delete cascade,
  key             text not null check (char_length(key) between 8 and 100),
  request_hash    text not null,
  reservation_id  uuid references public.reservations(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------------------------------------------------------------------
-- RLS: everyone on the property may read bookings (housekeeping needs
-- arrivals/departures); guest contact data only for front desk and up.
-- No INSERT/UPDATE/DELETE policies: writes only through the functions below.
-- ---------------------------------------------------------------------
alter table public.reservations enable row level security;
alter table public.reservation_guests enable row level security;
alter table public.reservation_idempotency enable row level security;

drop policy if exists res_select on public.reservations;
create policy res_select on public.reservations for select to authenticated
  using (app_private.has_property_access(property_id));

drop policy if exists resg_select on public.reservation_guests;
create policy resg_select on public.reservation_guests for select to authenticated
  using (app_private.property_role(property_id) in ('owner', 'manager', 'front_desk'));

revoke all on public.reservations, public.reservation_guests, public.reservation_idempotency from anon, authenticated;
revoke all on sequence public.reservation_code_seq from anon, authenticated;
grant select on public.reservations, public.reservation_guests to authenticated;

-- ---------------------------------------------------------------------
-- Internal helpers (not exposed to clients)
-- ---------------------------------------------------------------------
create or replace function app_private.fmt_date(d date) returns text
language sql immutable set search_path = '' as $$ select to_char(d, 'DD.MM.YYYY') $$;

create or replace function app_private.require_front_desk(p_property uuid)
returns public.member_role language plpgsql stable security definer set search_path = '' as $$
declare v_role public.member_role;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED: Oturum açmanız gerekiyor.' using errcode = '42501';
  end if;
  v_role := app_private.property_role(p_property);
  if v_role is null or v_role not in ('owner', 'manager', 'front_desk') then
    raise exception 'FORBIDDEN: Rezervasyon işlemleri için yetkiniz yok.' using errcode = '42501';
  end if;
  return v_role;
end $$;

-- Today in the hotel's own timezone (a booking for "today" in Istanbul must not depend on UTC)
create or replace function app_private.property_today(p_property uuid)
returns date language sql stable security definer set search_path = '' as $$
  select (now() at time zone p.timezone)::date from public.properties p where p.id = p_property
$$;

-- Friendly pre-check. The EXCLUDE constraint stays the final authority.
create or replace function app_private.assert_room_available(p_room uuid, p_check_in date, p_check_out date, p_exclude uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v record;
begin
  select r.code, r.check_in, r.check_out, rm.number into v
  from public.reservations r join public.rooms rm on rm.id = r.room_id
  where r.room_id = p_room
    and r.status not in ('CANCELLED', 'NO_SHOW')
    and r.stay && daterange(p_check_in, p_check_out, '[)')
    and (p_exclude is null or r.id <> p_exclude)
  order by r.check_in
  limit 1;
  if found then
    raise exception 'RES_CONFLICT: Oda % seçilen tarihlerde dolu. % – % tarihlerindeki % numaralı rezervasyonla çakışıyor.',
      v.number, app_private.fmt_date(v.check_in), app_private.fmt_date(v.check_out), v.code
      using errcode = 'P0001';
  end if;
end $$;

create or replace function app_private.assert_room_fits(p_room public.rooms, p_check_in date, p_adults int, p_children int, p_today date)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_max smallint;
begin
  select rt.max_occupancy into v_max from public.room_types rt where rt.id = p_room.room_type_id;
  if coalesce(p_adults, 0) < 1 then
    raise exception 'RES_INVALID_GUESTS: En az bir yetişkin misafir gerekli.' using errcode = 'P0001';
  end if;
  if p_adults + coalesce(p_children, 0) > v_max then
    raise exception 'RES_CAPACITY: Oda % en fazla % kişi alır.', p_room.number, v_max using errcode = 'P0001';
  end if;
  if p_room.maintenance_status = 'OUT_OF_ORDER' and p_check_in <= p_today then
    raise exception 'RES_ROOM_OUT_OF_ORDER: Oda % şu an arızalı; bugün başlayan bir konaklama verilemez.', p_room.number using errcode = 'P0001';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- RPC: create a reservation
-- ---------------------------------------------------------------------
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
  p_idempotency_key  text default null
) returns public.reservations
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_room  public.rooms;
  v_res   public.reservations;
  v_today date;
  v_hash  text;
  v_idem  public.reservation_idempotency;
begin
  perform app_private.require_front_desk(p_property_id);

  -- 1. Idempotency: the first request with a key wins; a retry gets the same booking back.
  if p_idempotency_key is not null then
    v_hash := md5(concat_ws('|', p_property_id, p_room_id, p_check_in, p_check_out, p_adults, coalesce(p_children, 0),
                            lower(trim(coalesce(p_guest_name, ''))), lower(trim(coalesce(p_guest_email, ''))), p_status));
    -- a concurrent request with the same key waits here until the first one commits or rolls back
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
      return v_res; -- replay: same reservation, nothing new created
    end if;
  end if;

  -- 2. Validation
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

  -- 3. Lock the room: concurrent bookings of this room queue up here
  select * into v_room from public.rooms where id = p_room_id and property_id = p_property_id for update;
  if v_room.id is null then
    raise exception 'RES_ROOM_NOT_FOUND: Oda bulunamadı.' using errcode = 'P0001';
  end if;
  perform app_private.assert_room_fits(v_room, p_check_in, p_adults, p_children, v_today);
  perform app_private.assert_room_available(p_room_id, p_check_in, p_check_out, null);

  -- 4. Write (the EXCLUDE constraint is the last line of defence)
  begin
    insert into public.reservations (organization_id, property_id, room_id, status, check_in, check_out, adults, children,
                                     source, notes, created_by, updated_by)
    values (v_room.organization_id, p_property_id, p_room_id, p_status, p_check_in, p_check_out, p_adults, coalesce(p_children, 0),
            coalesce(p_source, 'direct'), nullif(trim(p_notes), ''), v_uid, v_uid)
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
-- RPC: change dates / room / guests (extension, shortening, room move)
-- ---------------------------------------------------------------------
create or replace function public.update_reservation(
  p_reservation_id    uuid,
  p_room_id           uuid default null,
  p_check_in          date default null,
  p_check_out         date default null,
  p_adults            int  default null,
  p_children          int  default null,
  p_notes             text default null,
  p_expected_version  int  default null
) returns public.reservations
language plpgsql security definer set search_path = '' as $$
declare
  v_old    public.reservations;
  v_res    public.reservations;
  v_room   public.rooms;
  v_today  date;
  v_room_id uuid; v_in date; v_out date; v_adults int; v_children int;
begin
  select * into v_old from public.reservations where id = p_reservation_id for update;
  if v_old.id is null or app_private.property_role(v_old.property_id) is null then
    raise exception 'RES_NOT_FOUND: Rezervasyon bulunamadı.' using errcode = 'P0001';
  end if;
  perform app_private.require_front_desk(v_old.property_id);

  if p_expected_version is not null and p_expected_version <> v_old.version then
    raise exception 'RES_STALE: Rezervasyon bu arada başka biri tarafından değiştirildi. Sayfayı yenileyip tekrar deneyin.' using errcode = 'P0001';
  end if;
  if v_old.status not in ('PENDING', 'CONFIRMED', 'CHECKED_IN') then
    raise exception 'RES_BAD_STATE: % durumundaki bir rezervasyon değiştirilemez.', v_old.status using errcode = 'P0001';
  end if;

  v_room_id  := coalesce(p_room_id, v_old.room_id);
  v_in       := coalesce(p_check_in, v_old.check_in);
  v_out      := coalesce(p_check_out, v_old.check_out);
  v_adults   := coalesce(p_adults, v_old.adults);
  v_children := coalesce(p_children, v_old.children);
  v_today    := app_private.property_today(v_old.property_id);

  if v_out <= v_in then
    raise exception 'RES_INVALID_DATES: Çıkış tarihi giriş tarihinden sonra olmalı.' using errcode = 'P0001';
  end if;
  if v_out > v_in + 365 then
    raise exception 'RES_INVALID_DATES: Bir rezervasyon en fazla 365 gece olabilir.' using errcode = 'P0001';
  end if;
  if v_old.status = 'CHECKED_IN' and (v_in <> v_old.check_in or v_room_id <> v_old.room_id) then
    raise exception 'RES_BAD_STATE: Konaklayan misafirin giriş tarihi veya odası buradan değiştirilemez; yalnızca çıkış tarihi değişebilir.' using errcode = 'P0001';
  end if;
  if v_in <> v_old.check_in and v_in < v_today then
    raise exception 'RES_PAST_DATE: Giriş tarihi geçmişe alınamaz.' using errcode = 'P0001';
  end if;
  if v_old.status = 'CHECKED_IN' and v_out < v_today then
    raise exception 'RES_PAST_DATE: Konaklayan misafirin çıkış tarihi bugünden önce olamaz.' using errcode = 'P0001';
  end if;

  -- lock the target room, then re-check availability for the NEW dates (excluding this booking)
  select * into v_room from public.rooms where id = v_room_id and property_id = v_old.property_id for update;
  if v_room.id is null then
    raise exception 'RES_ROOM_NOT_FOUND: Oda bulunamadı.' using errcode = 'P0001';
  end if;
  if v_old.status = 'CHECKED_IN' then
    perform app_private.assert_room_fits(v_room, v_today + 1, v_adults, v_children, v_today); -- in-house: OOO already handled at check-in
  else
    perform app_private.assert_room_fits(v_room, v_in, v_adults, v_children, v_today);
  end if;
  perform app_private.assert_room_available(v_room_id, v_in, v_out, v_old.id);

  begin
    update public.reservations
       set room_id = v_room_id, check_in = v_in, check_out = v_out, adults = v_adults, children = v_children,
           notes = case when p_notes is null then notes else nullif(trim(p_notes), '') end,
           version = version + 1, updated_by = auth.uid()
     where id = v_old.id
     returning * into v_res;
  exception when exclusion_violation then
    raise exception 'RES_CONFLICT: Oda % yeni tarihlerde başka bir rezervasyonla çakışıyor.', v_room.number using errcode = 'P0001';
  end;
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- RPC: cancel (releases the room for new bookings). Repeating it is harmless.
-- ---------------------------------------------------------------------
create or replace function public.cancel_reservation(p_reservation_id uuid, p_reason text default null)
returns public.reservations
language plpgsql security definer set search_path = '' as $$
declare v_old public.reservations; v_res public.reservations;
begin
  select * into v_old from public.reservations where id = p_reservation_id for update;
  if v_old.id is null or app_private.property_role(v_old.property_id) is null then
    raise exception 'RES_NOT_FOUND: Rezervasyon bulunamadı.' using errcode = 'P0001';
  end if;
  perform app_private.require_front_desk(v_old.property_id);
  if v_old.status = 'CANCELLED' then
    return v_old;
  end if;
  if v_old.status not in ('PENDING', 'CONFIRMED') then
    raise exception 'RES_BAD_STATE: Yalnızca beklemede veya onaylı rezervasyonlar iptal edilebilir (şu an: %).', v_old.status using errcode = 'P0001';
  end if;
  update public.reservations
     set status = 'CANCELLED', cancelled_at = now(), cancel_reason = nullif(trim(p_reason), ''),
         version = version + 1, updated_by = auth.uid()
   where id = v_old.id
   returning * into v_res;
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- RPC: status workflow (confirm, check-in, check-out, no-show).
-- Check-in / check-out also drive the Phase 1 room status engine.
-- ---------------------------------------------------------------------
create or replace function public.set_reservation_status(p_reservation_id uuid, p_status public.reservation_status)
returns public.reservations
language plpgsql security definer set search_path = '' as $$
declare
  v_old   public.reservations;
  v_res   public.reservations;
  v_room  public.rooms;
  v_today date;
begin
  select * into v_old from public.reservations where id = p_reservation_id for update;
  if v_old.id is null or app_private.property_role(v_old.property_id) is null then
    raise exception 'RES_NOT_FOUND: Rezervasyon bulunamadı.' using errcode = 'P0001';
  end if;
  perform app_private.require_front_desk(v_old.property_id);
  if p_status = v_old.status then
    return v_old;
  end if;
  v_today := app_private.property_today(v_old.property_id);

  if p_status = 'CONFIRMED' and v_old.status = 'PENDING' then
    update public.reservations set status = 'CONFIRMED', version = version + 1, updated_by = auth.uid()
      where id = v_old.id returning * into v_res;

  elsif p_status = 'CHECKED_IN' and v_old.status in ('PENDING', 'CONFIRMED') then
    if v_old.check_in > v_today then
      raise exception 'RES_TOO_EARLY: Giriş tarihi %; misafir bu tarihten önce giriş yapamaz. Önce tarihi değiştirin.', app_private.fmt_date(v_old.check_in) using errcode = 'P0001';
    end if;
    if v_old.check_out <= v_today then
      raise exception 'RES_TOO_LATE: Bu rezervasyonun çıkış tarihi geçmiş; giriş yapılamaz.' using errcode = 'P0001';
    end if;
    select * into v_room from public.rooms where id = v_old.room_id for update;
    if v_room.occupancy_status = 'OCCUPIED' then
      raise exception 'RES_ROOM_OCCUPIED: Oda % hâlâ dolu görünüyor. Önceki misafirin çıkışını yapın.', v_room.number using errcode = 'P0001';
    end if;
    if v_room.maintenance_status = 'OUT_OF_ORDER' then
      raise exception 'RES_ROOM_OUT_OF_ORDER: Oda % arızalı; misafir giriş yapamaz.', v_room.number using errcode = 'P0001';
    end if;
    if v_room.housekeeping_status <> 'CLEAN' then
      raise exception 'RES_ROOM_NOT_READY: Oda % henüz hazır değil (temizlik durumu temiz değil).', v_room.number using errcode = 'P0001';
    end if;
    update public.rooms set occupancy_status = 'OCCUPIED' where id = v_room.id;
    update public.reservations set status = 'CHECKED_IN', checked_in_at = now(), version = version + 1, updated_by = auth.uid()
      where id = v_old.id returning * into v_res;

  elsif p_status = 'CHECKED_OUT' and v_old.status = 'CHECKED_IN' then
    select * into v_room from public.rooms where id = v_old.room_id for update;
    -- early departure: release the unused nights
    update public.reservations
       set status = 'CHECKED_OUT', checked_out_at = now(),
           check_out = least(check_out, greatest(v_today, check_in + 1)),
           version = version + 1, updated_by = auth.uid()
     where id = v_old.id returning * into v_res;
    update public.rooms set occupancy_status = 'VACANT' where id = v_room.id; -- the room engine marks it DIRTY

  elsif p_status = 'NO_SHOW' and v_old.status in ('PENDING', 'CONFIRMED') then
    if v_old.check_in > v_today then
      raise exception 'RES_TOO_EARLY: Giriş günü gelmeden rezervasyon "gelmedi" olarak işaretlenemez.' using errcode = 'P0001';
    end if;
    update public.reservations set status = 'NO_SHOW', version = version + 1, updated_by = auth.uid()
      where id = v_old.id returning * into v_res;

  elsif p_status = 'CANCELLED' then
    raise exception 'RES_BAD_STATE: İptal için cancel_reservation kullanılmalı.' using errcode = 'P0001';
  else
    raise exception 'RES_BAD_TRANSITION: % durumundan % durumuna geçilemez.', v_old.status, p_status using errcode = 'P0001';
  end if;
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- Function privileges: only signed-in users, never anon
-- ---------------------------------------------------------------------
revoke all on function app_private.fmt_date(date) from public;
revoke all on function app_private.require_front_desk(uuid) from public, authenticated;
revoke all on function app_private.property_today(uuid) from public, authenticated;
revoke all on function app_private.assert_room_available(uuid, date, date, uuid) from public, authenticated;
revoke all on function app_private.assert_room_fits(public.rooms, date, int, int, date) from public, authenticated;

revoke all on function public.create_reservation(uuid, uuid, date, date, int, int, text, text, text, text, text, public.reservation_status, text) from public, anon;
revoke all on function public.update_reservation(uuid, uuid, date, date, int, int, text, int) from public, anon;
revoke all on function public.cancel_reservation(uuid, text) from public, anon;
revoke all on function public.set_reservation_status(uuid, public.reservation_status) from public, anon;
grant execute on function public.create_reservation(uuid, uuid, date, date, int, int, text, text, text, text, text, public.reservation_status, text) to authenticated;
grant execute on function public.update_reservation(uuid, uuid, date, date, int, int, text, int) to authenticated;
grant execute on function public.cancel_reservation(uuid, text) to authenticated;
grant execute on function public.set_reservation_status(uuid, public.reservation_status) to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: the tape chart follows reservation changes (RLS applies)
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.reservations; exception when duplicate_object then null; end;
  end if;
end $$;
