-- =====================================================================
-- AXON Hotel PMS · state machine fixes (found in the implicit state machine review)
--
-- 1. Room occupancy vs reservation status could drift apart: anyone on the
--    room board could set a room VACANT while its guest was checked in, or
--    OCCUPIED for a guest arriving today without checking the reservation in
--    (no folio charges, wrong reports). Manual occupancy changes now respect
--    the reservation: the guard runs only for changes made by people
--    (role authenticated); the reservation functions run as the owner and are
--    not affected. Check-in explains a manually "occupied" room instead of a
--    generic error.
-- 2. A conversation closed by staff silently went back to the AI when the
--    guest wrote again. It now reopens for the front desk (HUMAN).
-- Idempotent: safe to run more than once.
-- =====================================================================

-- 1a. guard for manual occupancy changes (SECURITY INVOKER on purpose: current_user is the caller)
create or replace function app_private.occupancy_follows_reservation() returns trigger
language plpgsql set search_path = '' as $$
declare v_code text; v_today date;
begin
  if current_user <> 'authenticated' or new.occupancy_status is not distinct from old.occupancy_status then
    return new;
  end if;
  select x.code into v_code from public.reservations x where x.room_id = new.id and x.status = 'CHECKED_IN' limit 1;
  if v_code is not null then
    raise exception 'RULE_RESERVATION_IN_HOUSE: Oda % için % numaralı rezervasyonun misafiri konaklıyor; doluluk rezervasyondan değişir (çıkış işlemi).', new.number, v_code using errcode = '23514';
  end if;
  if new.occupancy_status = 'OCCUPIED' then
    select (now() at time zone p.timezone)::date into v_today from public.properties p where p.id = new.property_id;
    select x.code into v_code from public.reservations x
     where x.room_id = new.id and x.status in ('PENDING', 'CONFIRMED') and x.check_in <= v_today and x.check_out > v_today limit 1;
    if v_code is not null then
      raise exception 'RULE_USE_CHECK_IN: Bu odaya bugün % numaralı rezervasyon geliyor; girişi rezervasyondan yapın (folyo ve geçmiş için).', v_code using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists rooms_occupancy_follows_reservation on public.rooms;
create trigger rooms_occupancy_follows_reservation before update of occupancy_status on public.rooms
  for each row execute function app_private.occupancy_follows_reservation();
revoke all on function app_private.occupancy_follows_reservation() from public, anon, authenticated;

-- 1b. check-in: say why the room counts as occupied
create or replace function public.set_reservation_status(p_reservation_id uuid, p_status public.reservation_status)
returns public.reservations
language plpgsql security definer set search_path = '' as $$
declare
  v_old   public.reservations;
  v_res   public.reservations;
  v_room  public.rooms;
  v_today date;
  v_other text;
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
      select x.code into v_other from public.reservations x where x.room_id = v_room.id and x.status = 'CHECKED_IN' and x.id <> v_old.id limit 1;
      if v_other is not null then
        raise exception 'RES_ROOM_OCCUPIED: Oda % dolu: % numaralı rezervasyonun misafiri hâlâ odada. Önce onun çıkışını yapın.', v_room.number, v_other using errcode = 'P0001';
      end if;
      raise exception 'RES_ROOM_OCCUPIED: Oda % oda panosunda elle "dolu" işaretlenmiş, ama odada konaklayan bir rezervasyon yok. Oda gerçekten boşsa oda panosundan "Boş" yapıp girişi tekrarlayın; doluysa misafiri başka odaya alın.', v_room.number using errcode = 'P0001';
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

-- 2. a guest writing again to a closed conversation goes to the front desk, not back to the AI
create or replace function app_private.upsert_conversation(p_property uuid, p_channel text, p_thread text, p_name text, p_handle text, p_demo boolean)
returns public.conversations language plpgsql security definer set search_path = '' as $$
declare v_conv public.conversations; v_prop public.properties; v_guest uuid;
begin
  select * into v_prop from public.properties where id = p_property;
  insert into public.conversations (organization_id, property_id, channel, external_thread_id, contact_name, contact_handle, is_demo)
  values (v_prop.organization_id, p_property, p_channel, p_thread, nullif(trim(p_name), ''), nullif(trim(p_handle), ''), p_demo)
  on conflict (property_id, channel, external_thread_id) do update
     set contact_name = coalesce(public.conversations.contact_name, excluded.contact_name),
         status = case when public.conversations.status = 'CLOSED' then 'HUMAN' else public.conversations.status end
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
