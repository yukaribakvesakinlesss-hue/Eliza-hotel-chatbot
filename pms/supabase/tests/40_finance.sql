-- =====================================================================
-- AXON PMS · Phase 3 database tests (folio ledger, taxes, channels, OOO)
-- Runs after 10/20 in the same database (reuses their users).
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

select (now() at time zone 'Europe/Istanbul')::date as today \gset
-- rooms that are free today and ready for a guest (earlier test files used some rooms)
create temp table _ready as
  select r.id, r.number, row_number() over (order by r.number) as k from public.rooms r
  where r.property_id = :'PROP' and r.occupancy_status = 'VACANT' and r.housekeeping_status = 'CLEAN' and r.maintenance_status = 'OPERATIONAL'
    and not exists (select 1 from public.reservations x where x.room_id = r.id and x.status not in ('CANCELLED', 'NO_SHOW')
                    and x.stay && daterange(:'today'::date - 5, :'today'::date + 10));
grant select on _ready to public;
-- free a few more rooms for this file (statuses from the seed are arbitrary)
update public.rooms set occupancy_status = 'VACANT', housekeeping_status = 'CLEAN'
 where property_id = :'PROP' and number in ('401', '402', '403', '405') and maintenance_status = 'OPERATIONAL';
insert into _ready select r.id, r.number, 100 + row_number() over (order by r.number) from public.rooms r
 where r.number in ('401', '402', '403', '405') and r.property_id = :'PROP'
   and not exists (select 1 from _ready x where x.id = r.id)
   and not exists (select 1 from public.reservations x where x.room_id = r.id and x.status not in ('CANCELLED', 'NO_SHOW')
                   and x.stay && daterange(:'today'::date - 5, :'today'::date + 10));
select id as ra from _ready order by k limit 1 offset 0 \gset
select id as rb from _ready order by k limit 1 offset 1 \gset
select id as rc from _ready order by k limit 1 offset 2 \gset
select id as rd from _ready order by k limit 1 offset 3 \gset
select pg_temp.check('setup: at least 4 free rooms for finance tests', (select count(*) from _ready) >= 4);

-- ---------- channels ----------
select pg_temp.check('channels: demo rates seeded (Direct 0, Booking 18%, Expedia 15%)',
  (select string_agg(code || '=' || commission_rate::text, ',' order by code) from public.distribution_channels where organization_id = :'ORG')
  = 'BOOKING=0.1800,DIRECT=0.0000,EXPEDIA=0.1500');
select pg_temp.check('channels: a newly created organization gets the default channels',
  (select count(*) from public.distribution_channels c join public.organizations o on o.id = c.organization_id where o.slug = 'other-hotels') = 3);
select pg_temp.check('ooo: the seeded out-of-order room has an open period',
  exists (select 1 from public.room_out_of_order_periods p join public.rooms r on r.id = p.room_id where r.number = '304' and p.end_date is null));

-- ---------- front desk ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);

select id as res1, commission_rate as cr1 from public.create_reservation(:'PROP', :'ra', :'today'::date, :'today'::date + 3, 2, 0, 'Folyo Misafir',
  null, null, null, 'ota', 'CONFIRMED', null, 100, 'BOOKING') \gset
select pg_temp.check('reservation: commission rate snapshotted from the channel (18%)', :'cr1'::numeric = 0.18);
select pg_temp.check('folio: created automatically and OPEN', (select status from public.folios where reservation_id = :'res1') = 'OPEN');
select pg_temp.check('reservation: unknown channel is rejected',
  pg_temp.try(format($q$select public.create_reservation(%L, %L, %L::date + 20, %L::date + 21, 1, 0, 'X Guest', null, null, null, 'ota', 'CONFIRMED', null, 50, 'AIRBNB')$q$, :'PROP', :'ra', :'today', :'today')) like 'RES_CHANNEL:%');
select pg_temp.check('reservation: complimentary forces the rate to 0',
  (select nightly_rate = 0 and is_complimentary from public.create_reservation(:'PROP', :'rb', :'today'::date, :'today'::date + 2, 1, 0, 'Comp Guest',
    null, null, null, 'direct', 'CONFIRMED', null, 999, 'DIRECT', true)));
select id as res_comp from public.reservations where room_id = :'rb' and check_in = :'today'::date and is_complimentary \gset
select pg_temp.check('folio: room charges cannot be posted before check-in',
  pg_temp.try(format('select public.post_room_charges(%L)', :'res1')) like 'FOLIO_NOT_IN_HOUSE:%');

select public.set_reservation_status(:'res1', 'CHECKED_IN');
select pg_temp.check('posting: tonight is posted once (1 night)', (select public.post_room_charges(:'res1')) = 1);
select pg_temp.check('posting: posting again posts nothing (idempotent)', (select public.post_room_charges(:'res1')) = 0);
select pg_temp.check('posting: night audit for tonight finds nothing new', (select public.run_night_audit(:'PROP', :'today'::date)) = 0);
select pg_temp.check('posting: room charge 100.00 + KDV 10.00 + konaklama vergisi 2.00',
  (select string_agg(txn_type || ':' || account_code || ':' || amount::text, ',' order by id) from public.folio_transactions where reservation_id = :'res1')
  = 'ROOM_CHARGE:ROOMS_TRANSIENT:100.00,TAX:TAX_VAT:10.00,TAX:TAX_LODGING:2.00');
select pg_temp.check('posting: night audit cannot run for a future night',
  pg_temp.try(format('select public.run_night_audit(%L, %L::date + 1)', :'PROP', :'today')) like 'FOLIO_FUTURE_DATE:%');

-- extras, discount, payment, refund
select public.post_folio_transaction(:'res1', 'EXTRA', 50, 'Minibar', 'FB_BEVERAGE', null, 0.20) as extra_id \gset
select pg_temp.check('extra: minibar 50.00 + KDV %20 = 10.00 as a child tax line',
  (select string_agg(amount::text || '/' || coalesce(parent_id::text, '-'), ',' order by id) from public.folio_transactions where id = :'extra_id' or parent_id = :'extra_id')
  = '50.00/-,10.00/' || :'extra_id');
select pg_temp.check('extra: an invalid account is rejected',
  pg_temp.try(format($q$select public.post_folio_transaction(%L, 'EXTRA', 10, 'x', 'ROOMS_TRANSIENT')$q$, :'res1')) like 'FOLIO_BAD_ACCOUNT:%');
select pg_temp.check('manual ROOM_CHARGE / TAX postings are refused',
  pg_temp.try(format($q$select public.post_folio_transaction(%L, 'ROOM_CHARGE', 10)$q$, :'res1')) like 'FOLIO_BAD_TYPE:%');
select public.post_folio_transaction(:'res1', 'DISCOUNT', 20, 'Sadakat indirimi') as disc_id \gset
select pg_temp.check('discount: -20.00 with proportional tax reductions (-2.00 KDV, -0.40 konaklama)',
  (select string_agg(amount::text, ',' order by id) from public.folio_transactions where id = :'disc_id' or parent_id = :'disc_id') = '-20.00,-2.00,-0.40');
select pg_temp.check('discount: cannot exceed the posted room charges',
  pg_temp.try(format($q$select public.post_folio_transaction(%L, 'DISCOUNT', 500)$q$, :'res1')) like 'FOLIO_DISCOUNT_EXCEEDS:%');
select public.post_folio_transaction(:'res1', 'PAYMENT', 100, 'Kart', null, null, null, 'CARD', 'pay-key-00000001') as pay1 \gset
select public.post_folio_transaction(:'res1', 'PAYMENT', 100, 'Kart', null, null, null, 'CARD', 'pay-key-00000001') as pay2 \gset
select pg_temp.check('payment: same idempotency key returns the same row (no double charge)',
  :'pay1' = :'pay2' and (select count(*) from public.folio_transactions where reservation_id = :'res1' and txn_type = 'PAYMENT') = 1);
select pg_temp.check('payment: key reused with a different amount is rejected',
  pg_temp.try(format($q$select public.post_folio_transaction(%L, 'PAYMENT', 99, 'Kart', null, null, null, 'CARD', 'pay-key-00000001')$q$, :'res1')) like 'FOLIO_IDEMPOTENCY_MISMATCH:%');
select pg_temp.check('payment: stored as -100.00 on SETTLEMENT_CARD',
  (select amount = -100 and account_code = 'SETTLEMENT_CARD' from public.folio_transactions where id = :'pay1'));
select pg_temp.check('payment: method is required',
  pg_temp.try(format($q$select public.post_folio_transaction(%L, 'PAYMENT', 5)$q$, :'res1')) like 'FOLIO_BAD_METHOD:%');
select pg_temp.check('refund: cannot exceed net payments',
  pg_temp.try(format($q$select public.post_folio_transaction(%L, 'REFUND', 150, 'İade', null, null, null, 'CARD')$q$, :'res1')) like 'FOLIO_REFUND_EXCEEDS:%');
select pg_temp.check('refund: 30.00 within payments is accepted',
  pg_temp.try(format($q$select public.post_folio_transaction(%L, 'REFUND', 30, 'İade', null, null, null, 'CARD')$q$, :'res1')) is null);
select pg_temp.check('amount: zero or negative input is rejected',
  pg_temp.try(format($q$select public.post_folio_transaction(%L, 'PAYMENT', -5, 'x', null, null, null, 'CASH')$q$, :'res1')) like 'FOLIO_INVALID_AMOUNT:%');

-- reversals
select public.reverse_folio_transaction(:'extra_id', 'yanlış oda') as rev_id \gset
select pg_temp.check('reversal: extra and its tax are reversed by new rows (-50.00, -10.00)',
  (select string_agg(amount::text, ',' order by id) from public.folio_transactions where id = :'rev_id' or parent_id = :'rev_id') = '-50.00,-10.00');
select pg_temp.check('reversal: the original rows are still in the ledger unchanged',
  (select amount from public.folio_transactions where id = :'extra_id') = 50);
select pg_temp.check('reversal: reversing twice is refused',
  pg_temp.try(format('select public.reverse_folio_transaction(%s)', :'extra_id')) like 'FOLIO_ALREADY_REVERSED:%');
select pg_temp.check('reversal: a reversal cannot be reversed',
  pg_temp.try(format('select public.reverse_folio_transaction(%s)', :'rev_id')) like 'FOLIO_BAD_REVERSAL:%');
select pg_temp.check('reversal: a tax line alone cannot be reversed',
  pg_temp.try(format('select public.reverse_folio_transaction(%s)', (select id from public.folio_transactions where parent_id = :'disc_id' limit 1))) like 'FOLIO_BAD_REVERSAL:%');

-- immutability for clients
select pg_temp.check('immutable: front desk cannot UPDATE a transaction',
  pg_temp.try(format('update public.folio_transactions set amount = 1 where id = %s', :'pay1')) is not null);
select pg_temp.check('immutable: front desk cannot DELETE a transaction',
  pg_temp.try(format('delete from public.folio_transactions where id = %s', :'pay1')) is not null);
select pg_temp.check('immutable: front desk cannot INSERT directly',
  pg_temp.try(format($q$insert into public.folio_transactions (organization_id, property_id, folio_id, reservation_id, txn_type, account_code, description, service_date, amount)
     select organization_id, property_id, id, reservation_id, 'PAYMENT', 'SETTLEMENT_CASH', 'x', current_date, -1 from public.folios where reservation_id = %L$q$, :'res1')) is not null);

-- closing
select pg_temp.check('close: refused while the guest is in house',
  pg_temp.try(format('select public.close_folio(%L)', :'res1')) like 'FOLIO_STAY_ACTIVE:%');
select public.set_reservation_status(:'res1', 'CHECKED_OUT');
select pg_temp.check('check-out: early departure keeps exactly the 1 posted night',
  (select count(*) from public.folio_transactions where reservation_id = :'res1' and txn_type = 'ROOM_CHARGE' and reverses_id is null) = 1);
select pg_temp.check('balance: 100+12 (room) −22.40 (discount) −100 (payment) +30 (refund), extra reversed = 19.60',
  (select sum(amount) from public.folio_transactions where reservation_id = :'res1') = 19.60);
select pg_temp.check('close: refused while the balance is not zero',
  pg_temp.try(format('select public.close_folio(%L)', :'res1')) like 'FOLIO_BALANCE_NOT_ZERO:%');
select public.post_folio_transaction(:'res1', 'PAYMENT', 19.60, 'Nakit', null, null, null, 'CASH');
select pg_temp.check('close: settled folio closes', (select status from public.close_folio(:'res1')) = 'CLOSED');
select pg_temp.check('close: no postings on a closed folio',
  pg_temp.try(format($q$select public.post_folio_transaction(%L, 'PAYMENT', 5, 'x', null, null, null, 'CASH')$q$, :'res1')) like 'FOLIO_CLOSED:%');

-- complimentary stay: no charges
select public.set_reservation_status(:'res_comp', 'CHECKED_IN');
select public.set_reservation_status(:'res_comp', 'CHECKED_OUT');
select pg_temp.check('complimentary: check-in/out posts no room charge',
  not exists (select 1 from public.folio_transactions where reservation_id = :'res_comp'));

-- no-show
select id as res_ns from public.create_reservation(:'PROP', :'rc', :'today'::date, :'today'::date + 2, 1, 0, 'No Show',
  null, null, null, 'ota', 'CONFIRMED', null, 80, 'EXPEDIA') \gset
select public.set_reservation_status(:'res_ns', 'NO_SHOW');
select pg_temp.check('no-show: 1 night charged on ROOMS_NO_SHOW with KDV only (80.00 + 8.00)',
  (select string_agg(account_code || ':' || amount::text, ',' order by id) from public.folio_transactions where reservation_id = :'res_ns')
  = 'ROOMS_NO_SHOW:80.00,TAX_VAT:8.00');

-- OOO history
select public.set_room_status(:'rd', 'maintenance', 'OUT_OF_ORDER', 'Su kaçağı');
select pg_temp.check('ooo: going out of order opens a dated period',
  exists (select 1 from public.room_out_of_order_periods where room_id = :'rd' and start_date = :'today'::date and end_date is null and reason = 'Su kaçağı'));
select public.set_room_status(:'rd', 'maintenance', 'OPERATIONAL');
select pg_temp.check('ooo: repair closes the period',
  exists (select 1 from public.room_out_of_order_periods where room_id = :'rd' and end_date = :'today'::date));
reset role;

-- ---------- multi-night posting (past arrival created directly by the superuser) ----------
insert into public.reservations (organization_id, property_id, room_id, status, check_in, check_out, nightly_rate, channel_code, commission_rate)
values (:'ORG', :'PROP', :'rd', 'CHECKED_IN', :'today'::date - 3, :'today'::date + 1, 120, 'DIRECT', 0) returning id as res_past \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select pg_temp.check('night audit: posts last night for the in-house guest', (select public.run_night_audit(:'PROP', :'today'::date - 1)) >= 1);
select public.set_reservation_status(:'res_past', 'CHECKED_OUT');
select pg_temp.check('check-out: all remaining past nights posted (3 nights, today is the departure day)',
  (select count(*) from public.folio_transactions where reservation_id = :'res_past' and txn_type = 'ROOM_CHARGE') = 3
  and (select check_out from public.reservations where id = :'res_past') = :'today'::date);
reset role;

-- ---------- immutability holds even for the database owner ----------
select pg_temp.check('immutable: UPDATE refused by trigger even for the owner of the database',
  pg_temp.try(format('update public.folio_transactions set amount = 1 where reservation_id = %L', :'res_past')) like 'FOLIO_IMMUTABLE:%');
select pg_temp.check('immutable: DELETE refused by trigger', pg_temp.try('delete from public.folio_transactions') like 'FOLIO_IMMUTABLE:%');
select pg_temp.check('immutable: TRUNCATE refused by trigger', pg_temp.try('truncate public.folio_transactions cascade') like 'FOLIO_IMMUTABLE:%');
select pg_temp.check('immutable: a reservation with financial history cannot be deleted',
  pg_temp.try(format('delete from public.reservations where id = %L', :'res_past')) is not null);

-- ---------- channel snapshot ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'OWNER', false);
update public.distribution_channels set commission_rate = 0.20 where organization_id = :'ORG' and code = 'BOOKING';
select pg_temp.check('channels: owner can change a rate; existing bookings keep their snapshot (18%)',
  (select commission_rate from public.distribution_channels where organization_id = :'ORG' and code = 'BOOKING') = 0.20
  and (select commission_rate from public.reservations where id = :'res1') = 0.18);
update public.distribution_channels set commission_rate = 0.18 where organization_id = :'ORG' and code = 'BOOKING';
reset role;

-- ---------- roles and tenants ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'FD', false);
select pg_temp.check('front desk: cannot change commission rates',
  coalesce((select count(*) from public.distribution_channels where code = 'BOOKING' and organization_id = :'ORG'), 0) = 1
  and pg_temp.try($q$update public.distribution_channels set commission_rate = 0 where code = 'BOOKING'$q$) is null
  and (select commission_rate from public.distribution_channels where organization_id = :'ORG' and code = 'BOOKING') = 0.18);
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'HK', false);
select pg_temp.check('housekeeping: sees no folios or transactions',
  (select count(*) from public.folios) = 0 and (select count(*) from public.folio_transactions) = 0);
select pg_temp.check('housekeeping: cannot post to a folio',
  pg_temp.try(format($q$select public.post_folio_transaction(%L, 'PAYMENT', 5, 'x', null, null, null, 'CASH')$q$, :'res_ns')) like 'FORBIDDEN:%');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'OTHER', false);
select pg_temp.check('tenant B: sees no folios, transactions or channels of tenant A',
  (select count(*) from public.folio_transactions) = 0 and (select count(*) from public.folios) = 0
  and (select count(*) from public.distribution_channels where organization_id = :'ORG') = 0);
select pg_temp.check('tenant B: cannot post to a tenant A folio',
  pg_temp.try(format($q$select public.post_folio_transaction(%L, 'PAYMENT', 5, 'x', null, null, null, 'CASH')$q$, :'res_ns')) like 'FOLIO_NOT_FOUND:%');
reset role;
set role anon;
select pg_temp.check('anon: no access to folio data', pg_temp.try('select count(*) from public.folio_transactions') is not null);
reset role;

\o
\set QUIET off
select n, case when ok then 'PASS' else 'FAIL' end as result, name, detail from _results order by n;
do $$ declare f int; begin
  select count(*) into f from _results where not ok;
  if f > 0 then raise exception '% test(s) failed', f; end if;
  raise notice 'ALL % FINANCE TESTS PASSED', (select count(*) from _results);
end $$;
