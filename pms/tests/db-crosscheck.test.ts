/**
 * Cross-check: calculatePMSMetrics on real database rows must equal the KPIs computed
 * independently in SQL (supabase/tests/50_crosscheck.sql). Runs as part of `npm run db:test`,
 * which sets PMS_CROSSCHECK_FILE; without a database it is reported as skipped (not passed).
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculatePMSMetrics, type MetricsInput } from '@/lib/finance/metrics';

const file = process.env.PMS_CROSSCHECK_FILE;
const run = file && existsSync(file) ? describe : describe.skip;

run('calculatePMSMetrics vs. independent SQL on the seeded database', () => {
  const doc = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { input: MetricsInput; expected: Record<string, number> }) : null;
  const m = doc ? calculatePMSMetrics(doc.input) : null;
  const e = doc?.expected ?? {};

  it('the fixture has real data (not an empty hotel)', () => {
    expect(doc!.input.reservations.length).toBeGreaterThan(50);
    expect(doc!.input.transactions.length).toBeGreaterThan(100);
  });
  it('available room-nights (OOO deducted) match', () => expect(m!.capacity.availableRoomNights).toBe(e.available));
  it('sold and complimentary room-nights match', () => {
    expect(m!.roomNights.sold).toBe(e.sold);
    expect(m!.roomNights.complimentary).toBe(e.comp);
  });
  it('net room revenue matches to the cent', () => expect(m!.revenue.roomNet).toBe(Number(e.roomNetCents)));
  it('ADR, RevPAR and occupancy match', () => {
    expect(m!.kpi.adr).toBe(Number(e.adrCents));
    expect(m!.kpi.revpar).toBe(Number(e.revparCents));
    expect(m!.kpi.occupancy).toBe(Number(e.occupancy));
  });
  it('VAT (posted + forecast) and OTA commission match to the cent', () => {
    expect(m!.revenue.taxes.vat).toBe(Number(e.vatCents));
    expect(m!.distribution.commission).toBe(Number(e.commissionCents));
  });
});
