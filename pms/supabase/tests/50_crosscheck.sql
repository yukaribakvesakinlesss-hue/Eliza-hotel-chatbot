-- =====================================================================
-- AXON PMS · cross-check fixture: raw rows for calculatePMSMetrics + KPIs computed
-- independently in SQL, for the demo hotel over [today − 30, today + 15).
-- Output: one JSON document (used by tests/db-crosscheck.test.ts).
-- =====================================================================
\set QUIET on
\pset tuples_only on
\pset format unaligned
with p as (
  select '00000000-0000-4000-a000-000000000101'::uuid as prop,
         (now() at time zone 'Europe/Istanbul')::date - 30 as f,
         (now() at time zone 'Europe/Istanbul')::date + 15 as t
),
days as (select generate_series(p.f, p.t - 1, interval '1 day')::date as d from p),
rooms as (select r.id from public.rooms r, p where r.property_id = p.prop),
ooo as (
  select count(*) as n from days, rooms rm
  where exists (select 1 from public.room_out_of_order_periods o where o.room_id = rm.id and o.start_date <= days.d and (o.end_date is null or days.d < o.end_date))
),
res as (select r.* from public.reservations r, p where r.property_id = p.prop and r.check_in < p.t and r.check_out > p.f),
nights as (select r.id, r.nightly_rate, r.status, r.is_complimentary, days.d from res r join days on days.d >= r.check_in and days.d < r.check_out),
active as (select * from nights where status in ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT')),
tx as (
  select t.* from public.folio_transactions t join public.reservations r on r.id = t.reservation_id, p
  where t.property_id = p.prop and t.service_date >= p.f and t.service_date < p.t
),
posted_night as (select distinct reservation_id, service_date from public.folio_transactions where txn_type = 'ROOM_CHARGE' and account_code = 'ROOMS_TRANSIENT'),
forecast as (
  select a.id, a.nightly_rate from active a
  where not a.is_complimentary and a.nightly_rate > 0
    and not exists (select 1 from posted_night pn where pn.reservation_id = a.id and pn.service_date = a.d)
),
room_rev_by_res as (
  select r.id, r.commission_rate,
    coalesce((select sum(t.amount) from tx t where t.reservation_id = r.id and t.account_code in ('ROOMS_TRANSIENT', 'ROOMS_ALLOWANCE')), 0)
    + coalesce((select sum(f.nightly_rate) from forecast f where f.id = r.id), 0) as net
  from res r
  where r.status in ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT') and not r.is_complimentary
),
k as (
  select
    (select count(*) from days) * (select count(*) from rooms) - (select n from ooo) as available,
    (select count(*) from active where not is_complimentary) as sold,
    (select count(*) from active where is_complimentary) as comp,
    (select coalesce(sum(amount), 0) from tx join public.reservations r on r.id = tx.reservation_id
      where r.status <> 'CANCELLED' and tx.account_code in ('ROOMS_TRANSIENT', 'ROOMS_ALLOWANCE')) as room_posted,
    (select coalesce(sum(nightly_rate), 0) from forecast) as room_forecast,
    (select coalesce(sum(round(nightly_rate * 0.10, 2)), 0) from forecast) as vat_forecast,
    (select coalesce(sum(amount), 0) from tx join public.reservations r on r.id = tx.reservation_id
      where r.status <> 'CANCELLED' and tx.tax_code = 'VAT') as vat_posted,
    (select coalesce(sum(round(net * commission_rate, 2)), 0) from room_rev_by_res) as commission
)
select json_build_object(
  'input', json_build_object(
    'from', (select f from p), 'to', (select t from p),
    'rooms', (select json_agg(json_build_object('id', id)) from rooms),
    'outOfOrder', coalesce((select json_agg(json_build_object('room_id', o.room_id, 'start_date', o.start_date, 'end_date', o.end_date))
                   from public.room_out_of_order_periods o, p where o.property_id = p.prop), '[]'::json),
    'reservations', (select json_agg(json_build_object('id', id, 'status', status, 'check_in', check_in, 'check_out', check_out,
                     'nightly_rate', nightly_rate::text, 'channel_code', channel_code, 'commission_rate', commission_rate::text, 'is_complimentary', is_complimentary)) from res),
    'transactions', coalesce((select json_agg(json_build_object('id', id, 'reservation_id', reservation_id, 'txn_type', txn_type, 'account_code', account_code,
                     'amount', amount::text, 'service_date', service_date, 'tax_code', tax_code, 'parent_id', parent_id)) from tx), '[]'::json),
    'channels', (select json_agg(json_build_object('code', code, 'name', name)) from public.distribution_channels where organization_id = '00000000-0000-4000-a000-000000000001'),
    'taxRates', json_build_object('vatRooms', 0.10, 'lodging', 0.02)
  ),
  'expected', (select json_build_object(
    'available', available, 'sold', sold, 'comp', comp,
    'roomNetCents', ((room_posted + room_forecast) * 100)::bigint,
    'adrCents', case when sold > 0 then round((room_posted + room_forecast) * 100 / sold) else 0 end,
    'revparCents', case when available > 0 then round((room_posted + room_forecast) * 100 / available) else 0 end,
    'occupancy', case when available > 0 then round(sold::numeric * 100 / available, 2) else 0 end,
    'vatCents', ((vat_posted + vat_forecast) * 100)::bigint,
    'commissionCents', (commission * 100)::bigint) from k)
);
