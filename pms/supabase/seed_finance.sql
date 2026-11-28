-- =====================================================================
-- AXON PMS · demo financial history for the demo hotel (axon-demo / AUR)
-- 60 days back and 30 days ahead: stays per room (never overlapping), channels,
-- cancellations, no-shows, complimentary stays, extras, discounts and payments,
-- posted through the same internal functions the app uses.
-- Every seeded reservation has notes = 'seed:finance'. Runs once (skips if present).
-- Remove with supabase/cleanup_demo_finance.sql (database owner only).
-- =====================================================================
do $$
declare
  v_org   uuid := '00000000-0000-4000-a000-000000000001';
  v_prop  uuid := '00000000-0000-4000-a000-000000000101';
  v_today date := (now() at time zone 'Europe/Istanbul')::date;
  v_names text[] := array['Ayşe Yılmaz','Lukas Weber','Mehmet Kaya','Sophie Martin','Elena Rossi','John Smith','Al-Farsi Ailesi','Zeynep Demir',
    'Anna Kowalska','Can Öztürk','Maria Garcia','Kenji Tanaka','Olivia Brown','Ahmet Şahin','Fatma Aydın','Pierre Dubois',
    'Hans Müller','Selin Arslan','Yuki Sato','Emre Koç','Laura Bianchi','David Cohen','Ivan Petrov','Noah Wilson'];
  r record; v_cursor date; v_in date; v_out date; v_nights int; v_roll float8; v_status public.reservation_status;
  v_ch text; v_cr numeric; v_comp boolean; v_rate numeric; v_res uuid; v_n int := 0; v_folio public.folios; v_id bigint;
  v_due numeric; v_method text; v_amt numeric; v_acc text; v_vat numeric; v_ooo205 date := v_today - 20;
begin
  if exists (select 1 from public.reservations where property_id = v_prop and notes = 'seed:finance') then
    raise notice 'seed_finance: already present, skipped';
    return;
  end if;
  perform setseed(0.4242);

  -- dated out-of-order history: 205 was painted 20–16 days ago; 304 has been broken for 3 days
  insert into public.room_out_of_order_periods (organization_id, property_id, room_id, start_date, end_date, reason)
  select v_org, v_prop, id, v_ooo205, v_ooo205 + 4, 'Boya (seed)' from public.rooms where property_id = v_prop and number = '205';
  update public.room_out_of_order_periods p set start_date = v_today - 3
    from public.rooms rm where rm.id = p.room_id and rm.number = '304' and p.end_date is null and p.start_date > v_today - 3;

  for r in select rm.id, rm.number, rm.maintenance_status, rt.code as tcode
           from public.rooms rm join public.room_types rt on rt.id = rm.room_type_id
           where rm.property_id = v_prop order by rm.number loop
    v_cursor := v_today - 60 + floor(random() * 3)::int;
    while v_cursor < v_today + 30 loop
      v_nights := 1 + floor(random() * 4)::int;
      v_in := v_cursor; v_out := v_in + v_nights;
      v_cursor := v_out + floor(random() * 3)::int;
      if r.maintenance_status = 'OUT_OF_ORDER' and v_out > v_today - 3 then exit; end if;
      if r.number = '205' and v_in < v_ooo205 + 4 and v_out > v_ooo205 then continue; end if;
      if exists (select 1 from public.reservations x where x.room_id = r.id and x.status not in ('CANCELLED', 'NO_SHOW')
                 and x.stay && daterange(v_in, v_out)) then continue; end if;

      v_roll := random();
      if v_out <= v_today then v_status := case when v_roll < 0.05 then 'NO_SHOW' when v_roll < 0.12 then 'CANCELLED' else 'CHECKED_OUT' end;
      elsif v_in <= v_today then v_status := 'CHECKED_IN';
      else v_status := case when v_roll < 0.08 then 'PENDING' when v_roll < 0.14 then 'CANCELLED' else 'CONFIRMED' end;
      end if;
      v_roll := random();
      v_ch := case when v_roll < 0.45 then 'DIRECT' when v_roll < 0.80 then 'BOOKING' else 'EXPEDIA' end;
      select commission_rate into v_cr from public.distribution_channels where organization_id = v_org and code = v_ch;
      v_comp := v_status <> 'CANCELLED' and random() < 0.03;
      v_rate := case when v_comp then 0 else round((case r.tcode when 'JSTE' then 180 when 'DDBL' then 120 else 90 end)
                 * (case when extract(isodow from v_in) in (5, 6) then 1.15 else 1 end)) end;
      v_n := v_n + 1;

      insert into public.reservations (organization_id, property_id, room_id, status, check_in, check_out, adults, children, source, notes,
        nightly_rate, channel_code, commission_rate, is_complimentary, cancelled_at, checked_in_at, checked_out_at)
      values (v_org, v_prop, r.id, v_status, v_in, v_out, 2, 0, case when v_ch = 'DIRECT' then 'direct' else 'ota' end, 'seed:finance',
        v_rate, v_ch, v_cr, v_comp,
        case when v_status = 'CANCELLED' then now() end,
        case when v_status in ('CHECKED_IN', 'CHECKED_OUT') then v_in::timestamptz + interval '14 hours' end,
        case when v_status = 'CHECKED_OUT' then v_out::timestamptz + interval '11 hours' end)
      returning id into v_res;
      insert into public.reservation_guests (organization_id, property_id, reservation_id, full_name, is_primary)
      values (v_org, v_prop, v_res, v_names[1 + (v_n % array_length(v_names, 1))], true);

      select * into v_folio from public.folios where reservation_id = v_res;
      if v_status = 'NO_SHOW' and not v_comp then
        v_id := app_private.insert_folio_txn(v_folio, 'ROOM_CHARGE', 'ROOMS_NO_SHOW', 'No-show ücreti (1 gece)', v_in, v_rate);
        perform app_private.insert_tax_lines(v_folio, v_id, v_rate, v_in, 0.10, 0);
        perform app_private.insert_folio_txn(v_folio, 'PAYMENT', 'SETTLEMENT_CARD', 'Kart (garanti)', v_in, -round(v_rate * 1.10, 2),
          null, null, null, null, 'CARD');
      elsif v_status in ('CHECKED_IN', 'CHECKED_OUT') and not v_comp then
        perform app_private.post_room_nights(v_res, v_in, least(v_out - 1, v_today - 1));
        if random() < 0.35 then
          v_amt := case when random() < 0.5 then 25 else 40 end;
          v_acc := case when v_amt = 25 then 'FB_BEVERAGE' else 'FB_FOOD' end;
          v_vat := case when v_acc = 'FB_BEVERAGE' then 0.20 else 0.10 end;
          v_id := app_private.insert_folio_txn(v_folio, 'EXTRA', v_acc, case when v_acc = 'FB_BEVERAGE' then 'Minibar' else 'Akşam yemeği' end, v_in, v_amt);
          perform app_private.insert_tax_lines(v_folio, v_id, v_amt, v_in, v_vat, 0);
        end if;
        if v_status = 'CHECKED_OUT' and v_nights >= 3 and v_ch = 'DIRECT' and random() < 0.4 then
          v_id := app_private.insert_folio_txn(v_folio, 'DISCOUNT', 'ROOMS_ALLOWANCE', 'Uzun konaklama indirimi %10', v_in + 1, -round(v_rate * 0.10, 2));
          perform app_private.insert_tax_lines(v_folio, v_id, -round(v_rate * 0.10, 2), v_in + 1, 0.10, 0.02);
        end if;
        if v_status = 'CHECKED_OUT' then
          select coalesce(sum(amount), 0) into v_due from public.folio_transactions where folio_id = v_folio.id;
          if v_due > 0 then
            v_method := case when v_ch = 'EXPEDIA' then 'OTA' when random() < 0.7 then 'CARD' else 'CASH' end;
            perform app_private.insert_folio_txn(v_folio, 'PAYMENT', 'SETTLEMENT_' || v_method, 'Tahsilat', v_out - 1, -v_due,
              null, null, null, null, v_method);
          end if;
        end if;
      end if;
      if v_status in ('CHECKED_OUT', 'CANCELLED', 'NO_SHOW')
         and (select coalesce(sum(amount), 0) from public.folio_transactions where folio_id = v_folio.id) = 0 then
        update public.folios set status = 'CLOSED', closed_at = now() where id = v_folio.id;
      end if;
    end loop;
  end loop;

  -- room board consistent with the bookings: in house → OCCUPIED, arriving today → RESERVED, else VACANT
  update public.rooms rm set occupancy_status = case
      when exists (select 1 from public.reservations x where x.room_id = rm.id and x.status = 'CHECKED_IN') then 'OCCUPIED'
      when exists (select 1 from public.reservations x where x.room_id = rm.id and x.check_in = v_today and x.status in ('CONFIRMED', 'PENDING')) then 'RESERVED'
      else 'VACANT' end::public.occupancy_status
   where rm.property_id = v_prop and rm.maintenance_status = 'OPERATIONAL';

  raise notice 'seed_finance: % reservations created', v_n;
end $$;
