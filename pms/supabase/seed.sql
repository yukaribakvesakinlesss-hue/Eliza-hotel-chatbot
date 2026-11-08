-- =====================================================================
-- AXON Hotel PMS · demo data (same hotel as the website demo)
-- Run in a demo/dev project only. Safe to re-run.
-- To give your account access after signing up:
--   select public.admin_add_member('you@example.com', 'axon-demo', 'owner');
-- =====================================================================
insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-a000-000000000001', 'AXON Demo Hotels', 'axon-demo')
on conflict (id) do nothing;

insert into public.properties (id, organization_id, name, code, timezone, currency)
values ('00000000-0000-4000-a000-000000000101', '00000000-0000-4000-a000-000000000001', 'Aurelia Boutique Hotel', 'AUR', 'Europe/Istanbul', 'EUR')
on conflict (id) do nothing;

insert into public.room_types (id, organization_id, property_id, code, name, base_occupancy, max_occupancy, description) values
  ('00000000-0000-4000-a000-000000000201', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000101', 'CDBL', 'Classic Double', 2, 2, '22 m², city side'),
  ('00000000-0000-4000-a000-000000000202', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000101', 'DDBL', 'Deluxe Double', 2, 2, '28 m², city view'),
  ('00000000-0000-4000-a000-000000000203', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000101', 'JSTE', 'Junior Suite', 2, 3, '38 m², sitting area')
on conflict (id) do nothing;

-- 24 rooms over 4 floors with a realistic mix of statuses
insert into public.rooms (organization_id, property_id, room_type_id, number, floor, occupancy_status, housekeeping_status, maintenance_status, maintenance_note)
select '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000101',
       case when n % 6 = 0 then '00000000-0000-4000-a000-000000000203'::uuid
            when n % 2 = 0 then '00000000-0000-4000-a000-000000000202'::uuid
            else '00000000-0000-4000-a000-000000000201'::uuid end,
       (f * 100 + n)::text, f,
       case when f = 3 and n = 4 then 'VACANT'
            else (array['OCCUPIED','OCCUPIED','VACANT','RESERVED','OCCUPIED','VACANT'])[1 + (f * 7 + n) % 6] end::public.occupancy_status,
       (array['CLEAN','DIRTY','CLEAN','IN_PROGRESS','CLEAN','INSPECTION_REQUIRED','CLEAN'])[1 + (f * 5 + n) % 7]::public.housekeeping_status,
       case when f = 3 and n = 4 then 'OUT_OF_ORDER' else 'OPERATIONAL' end::public.maintenance_status,
       case when f = 3 and n = 4 then 'Air conditioning repair' end
from generate_series(1, 4) f, generate_series(1, 6) n
on conflict (property_id, number) do nothing;

-- Phase 5 demo data: rates (demo values) and verified answers for the assistant
update public.room_types set base_rate = case code when 'CDBL' then 90 when 'DDBL' then 120 when 'JSTE' then 180 end
 where property_id = '00000000-0000-4000-a000-000000000101' and base_rate is null;
insert into public.property_faq (organization_id, property_id, topic, answer_tr, answer_en) values
  ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000101', 'checkin_time',
   'Giriş saatimiz 14:00, çıkış saatimiz 12:00''dir. Erken giriş ve geç çıkış müsaitliğe bağlıdır.',
   'Check-in is from 14:00 and check-out until 12:00. Early check-in and late check-out depend on availability.'),
  ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000101', 'breakfast',
   'Kahvaltı 07:30–10:30 arasında açık büfe olarak servis edilir.', 'Breakfast is a buffet served from 07:30 to 10:30.'),
  ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000101', 'wifi',
   'Tüm otelde ücretsiz Wi-Fi vardır; şifre odanızdaki kartta yazar.', 'Free Wi-Fi throughout the hotel; the password is on the card in your room.'),
  ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000101', 'parking',
   'Otelimizin kendi otoparkı yoktur; 200 m mesafede ücretli otopark bulunur.', 'We have no private parking; there is a paid car park 200 m away.')
on conflict (property_id, topic) do nothing;
