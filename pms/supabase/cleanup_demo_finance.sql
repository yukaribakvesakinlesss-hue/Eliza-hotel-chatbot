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
commit;
