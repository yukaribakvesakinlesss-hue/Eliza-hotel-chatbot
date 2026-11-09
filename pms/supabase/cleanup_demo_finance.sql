-- =====================================================================
-- Removes the demo financial history created by seed_finance.sql (demo hotel only).
-- The ledger is append-only, so this temporarily disables the immutability triggers.
-- Run as the database owner in the SQL editor; NEVER on real guest data.
-- =====================================================================
begin;
alter table public.folio_transactions disable trigger folio_txn_no_update;
delete from public.folio_transactions t using public.reservations r
 where r.id = t.reservation_id and r.notes = 'seed:finance';
alter table public.folio_transactions enable trigger folio_txn_no_update;
delete from public.reservations where notes = 'seed:finance';
delete from public.room_out_of_order_periods where reason = 'Boya (seed)';
-- 304: the seed moved its open out-of-order period 3 days back; restore the real start date
update public.room_out_of_order_periods p set start_date = (p.created_at at time zone 'Europe/Istanbul')::date
  from public.rooms rm where rm.id = p.room_id and rm.number = '304' and p.end_date is null;
-- the seed aligned room occupancy with its stays; with no stays left every operational room is vacant
-- (only correct when the demo hotel has no real reservations)
update public.rooms set occupancy_status = 'VACANT'
 where maintenance_status = 'OPERATIONAL' and occupancy_status <> 'VACANT'
   and not exists (select 1 from public.reservations x where x.room_id = rooms.id and x.status = 'CHECKED_IN');
commit;
