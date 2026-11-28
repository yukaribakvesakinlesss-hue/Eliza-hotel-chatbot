/**
 * calculatePMSMetrics · every expected number below is worked out by hand in the comments,
 * so a wrong formula cannot "agree with itself".
 */
import { describe, expect, it } from 'vitest';
import { calculatePMSMetrics, toCents, type MetricsInput, type MetricsReservation, type MetricsTransaction } from '@/lib/finance/metrics';

const RATES = { vatRooms: 0.1, lodging: 0.02 };
let nextId = 1;
const tx = (reservation_id: string, txn_type: MetricsTransaction['txn_type'], account_code: string, amount: number | string, service_date: string,
  extra: Partial<MetricsTransaction> = {}): MetricsTransaction => ({ id: nextId++, reservation_id, txn_type, account_code, amount, service_date, tax_code: null, parent_id: null, ...extra });
/** room night + its two tax lines, exactly as the database posts them */
function night(res: string, date: string, rate: number): MetricsTransaction[] {
  const c = tx(res, 'ROOM_CHARGE', 'ROOMS_TRANSIENT', rate, date);
  return [c, tx(res, 'TAX', 'TAX_VAT', +(rate * 0.1).toFixed(2), date, { tax_code: 'VAT', parent_id: c.id }),
    tx(res, 'TAX', 'TAX_LODGING', +(rate * 0.02).toFixed(2), date, { tax_code: 'LODGING', parent_id: c.id })];
}
const res = (id: string, status: MetricsReservation['status'], check_in: string, check_out: string, nightly_rate: number, channel_code = 'DIRECT',
  commission_rate = 0, is_complimentary = false): MetricsReservation => ({ id, status, check_in, check_out, nightly_rate, channel_code, commission_rate, is_complimentary });

/*
 * Scenario: 5 rooms (A–E), period 2026-11-01 … 2026-11-05 (4 nights).
 *   E out of order 10-30 → 11-03 (exclusive) = 2 OOO nights; D out of order from 11-04 (open) = 1 → available 20 − 3 = 17
 *   r1 A CHECKED_OUT 10-30→11-03 100/night DIRECT  – in range 11-01, 11-02 posted
 *   r2 B CHECKED_IN  11-02→11-06 150/night BOOKING 18% – 11-02, 11-03 posted, 11-04 forecast; discount −30 on 11-03
 *   r3 C CONFIRMED   11-04→11-08 120/night EXPEDIA 15% – 11-04 forecast
 *   r4 C CANCELLED   11-01→11-03 (a stray posted night must be ignored)
 *   r5 D NO_SHOW     11-01→11-03 80/night EXPEDIA – no-show fee 80 + KDV 8
 *   r6 D CHECKED_OUT complimentary 11-02→11-04
 *   r7 A PENDING     11-03→11-05
 */
function scenario(): MetricsInput {
  nextId = 1;
  const disc = tx('r2', 'DISCOUNT', 'ROOMS_ALLOWANCE', -30, '2026-11-03');
  const extra = tx('r2', 'EXTRA', 'FB_BEVERAGE', 50, '2026-11-03');
  const noShow = tx('r5', 'ROOM_CHARGE', 'ROOMS_NO_SHOW', 80, '2026-11-01');
  return {
    from: '2026-11-01',
    to: '2026-11-05',
    rooms: ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id })),
    outOfOrder: [
      { room_id: 'E', start_date: '2026-10-30', end_date: '2026-11-03' },
      { room_id: 'D', start_date: '2026-11-04', end_date: null }
    ],
    reservations: [
      res('r1', 'CHECKED_OUT', '2026-10-30', '2026-11-03', 100),
      res('r2', 'CHECKED_IN', '2026-11-02', '2026-11-06', 150, 'BOOKING', 0.18),
      res('r3', 'CONFIRMED', '2026-11-04', '2026-11-08', 120, 'EXPEDIA', 0.15),
      res('r4', 'CANCELLED', '2026-11-01', '2026-11-03', 90, 'BOOKING', 0.18),
      res('r5', 'NO_SHOW', '2026-11-01', '2026-11-03', 80, 'EXPEDIA', 0.15),
      res('r6', 'CHECKED_OUT', '2026-11-02', '2026-11-04', 0, 'DIRECT', 0, true),
      res('r7', 'PENDING', '2026-11-03', '2026-11-05', 100)
    ],
    transactions: [
      ...night('r1', '2026-10-30', 100), ...night('r1', '2026-10-31', 100), // before the period
      ...night('r1', '2026-11-01', 100), ...night('r1', '2026-11-02', 100),
      ...night('r2', '2026-11-02', 150), ...night('r2', '2026-11-03', 150),
      disc, tx('r2', 'TAX', 'TAX_VAT', -3, '2026-11-03', { tax_code: 'VAT', parent_id: disc.id }),
      tx('r2', 'TAX', 'TAX_LODGING', -0.6, '2026-11-03', { tax_code: 'LODGING', parent_id: disc.id }),
      extra, tx('r2', 'TAX', 'TAX_VAT', 10, '2026-11-03', { tax_code: 'VAT', parent_id: extra.id }),
      tx('r1', 'EXTRA', 'OOD_OTHER', 40, '2026-10-31'), // outside the period
      ...night('r4', '2026-11-01', 90), // cancelled: must not count
      noShow, tx('r5', 'TAX', 'TAX_VAT', 8, '2026-11-01', { tax_code: 'VAT', parent_id: noShow.id }),
      tx('r1', 'PAYMENT', 'SETTLEMENT_CARD', -448, '2026-11-02', { }),
      tx('r2', 'PAYMENT', 'SETTLEMENT_CASH', -100, '2026-11-03'),
      tx('r2', 'REFUND', 'SETTLEMENT_CARD', 20, '2026-11-04')
    ],
    channels: [{ code: 'DIRECT', name: 'AXON Direct' }, { code: 'BOOKING', name: 'Booking.com' }, { code: 'EXPEDIA', name: 'Expedia' }],
    taxRates: RATES
  };
}

describe('calculatePMSMetrics · capacity and room-nights', () => {
  const m = calculatePMSMetrics(scenario());
  it('deducts out-of-order rooms from capacity per night (20 physical − 3 OOO = 17)', () => {
    expect(m.capacity).toEqual({ physicalRoomNights: 20, outOfOrderRoomNights: 3, availableRoomNights: 17 });
    expect(m.daily.map((d) => d.availableRoomNights)).toEqual([4, 4, 5, 4]);
  });
  it('sold = r1 2 + r2 3 + r3 1 = 6; complimentary, no-show, cancelled and pending are separate', () => {
    expect(m.roomNights).toEqual({ sold: 6, complimentary: 2, noShow: 2, cancelled: 2, pending: 2 });
    expect(m.counts).toEqual({ noShowReservations: 1, cancelledReservations: 1, complimentaryReservations: 1 });
  });
});

describe('calculatePMSMetrics · revenue', () => {
  const m = calculatePMSMetrics(scenario());
  it('net room revenue = posted 500 − discount 30 + forecast (150 + 120) = 740.00', () => {
    expect(m.revenue.roomPosted).toBe(50000);
    expect(m.revenue.roomDiscounts).toBe(-3000);
    expect(m.revenue.roomForecast).toBe(27000);
    expect(m.revenue.roomNet).toBe(74000);
  });
  it('cancelled reservation revenue is excluded (its posted 90 does not appear)', () => {
    expect(m.revenue.roomPosted).toBe(50000);
    expect(m.usali.ROOMS_TRANSIENT).toBe(77000); // 500 posted + 270 forecast, no 90
  });
  it('no-show and extras are separate lines; total net = 740 + 80 + 50 = 870.00', () => {
    expect(m.revenue.noShowNet).toBe(8000);
    expect(m.revenue.extrasByAccount).toEqual({ FB_BEVERAGE: 5000 });
    expect(m.revenue.extrasNet).toBe(5000);
    expect(m.revenue.totalNet).toBe(87000);
  });
  it('taxes: KDV 92.00 and konaklama vergisi 14.80, split by source', () => {
    // KDV: r1 20 + r2 30 − 3 (discount) + no-show 8 + extra 10 + forecast 15 + 12 = 92.00
    // konaklama: r1 4 + r2 6 − 0.60 + forecast 3 + 2.40 = 14.80
    expect(m.revenue.taxes).toEqual({ vat: 9200, lodging: 1480, total: 10680, rooms: 8880, noShow: 800, extras: 1000 });
  });
  it('tax-inclusive and tax-exclusive figures', () => {
    expect(m.revenue.roomGross).toBe(74000 + 8880);
    expect(m.revenue.totalGross).toBe(87000 + 10680);
  });
});

describe('calculatePMSMetrics · KPIs (formulas from the brief)', () => {
  const m = calculatePMSMetrics(scenario());
  it('ADR = net room revenue / sold room-nights = 740 / 6 = 123.33', () => {
    expect(m.kpi.adr).toBe(12333);
  });
  it('RevPAR = net room revenue / available room-nights = 740 / 17 = 43.53', () => {
    expect(m.kpi.revpar).toBe(4353);
  });
  it('Occupancy = sold / available × 100 = 6 / 17 = 35.29 %; incl. comp 8 / 17 = 47.06 %', () => {
    expect(m.kpi.occupancy).toBe(35.29);
    expect(m.kpi.occupancyInclComp).toBe(47.06);
  });
  it('daily figures add up to the period totals', () => {
    expect(m.daily.map((d) => d.soldRoomNights)).toEqual([1, 2, 1, 2]);
    expect(m.daily.map((d) => d.roomRevenueNet)).toEqual([10000, 25000, 12000, 27000]);
    expect(m.daily.reduce((a, d) => a + d.roomRevenueNet, 0)).toBe(m.revenue.roomNet);
    expect(m.daily[1]).toMatchObject({ occupancy: 50, adr: 12500, revpar: 6250 });
  });
});

describe('calculatePMSMetrics · distribution cost (OTA commission)', () => {
  const m = calculatePMSMetrics(scenario());
  it('commission per channel: Booking 420 × 18% = 75.60, Expedia 120 × 15% = 18.00, Direct 0', () => {
    expect(m.distribution.byChannel.map((c) => [c.code, c.soldRoomNights, c.roomRevenueNet, c.commission])).toEqual([
      ['BOOKING', 3, 42000, 7560],
      ['DIRECT', 2, 20000, 0],
      ['EXPEDIA', 1, 12000, 1800]
    ]);
    expect(m.distribution.commission).toBe(9360);
    expect(m.usali.ROOMS_COMMISSIONS).toBe(9360);
  });
  it('gross → tax → net → commission → net after distribution', () => {
    expect(m.revenue.totalGross - m.revenue.taxes.total).toBe(m.revenue.totalNet);
    expect(m.distribution.netAfterDistribution).toBe(87000 - 9360);
    expect(m.distribution.roomNetAfterDistribution).toBe(74000 - 9360);
  });
  it('settlements are cash, not revenue', () => {
    expect(m.settlements).toEqual({ payments: 54800, refunds: 2000, net: 52800 });
    expect(m.usali.SETTLEMENT_CARD).toBe(-44800 + 2000);
  });
});

describe('calculatePMSMetrics · edge cases', () => {
  it('a reversed night counts as posted (no forecast) and nets to zero revenue', () => {
    nextId = 100;
    const [charge] = night('x', '2026-11-01', 100);
    const m = calculatePMSMetrics({
      from: '2026-11-01', to: '2026-11-02', rooms: [{ id: 'A' }], outOfOrder: [], taxRates: RATES,
      reservations: [res('x', 'CHECKED_OUT', '2026-11-01', '2026-11-02', 100)],
      transactions: [charge!, { ...charge!, id: 999, amount: -100 }]
    });
    expect(m.revenue.roomForecast).toBe(0);
    expect(m.revenue.roomNet).toBe(0);
    expect(m.roomNights.sold).toBe(1);
  });
  it('no division by zero: empty hotel, fully out-of-order hotel', () => {
    const empty = calculatePMSMetrics({ from: '2026-11-01', to: '2026-11-08', rooms: [], outOfOrder: [], reservations: [], transactions: [], taxRates: RATES });
    expect(empty.kpi).toEqual({ adr: 0, revpar: 0, occupancy: 0, occupancyInclComp: 0 });
    const ooo = calculatePMSMetrics({ from: '2026-11-01', to: '2026-11-02', rooms: [{ id: 'A' }], outOfOrder: [{ room_id: 'A', start_date: '2026-01-01', end_date: null }], reservations: [], transactions: [], taxRates: RATES });
    expect(ooo.capacity.availableRoomNights).toBe(0);
    expect(ooo.kpi.occupancy).toBe(0);
  });
  it('stays are clipped to the period; the check-out day is not a sold night', () => {
    const m = calculatePMSMetrics({
      from: '2026-11-03', to: '2026-11-04', rooms: [{ id: 'A' }, { id: 'B' }], outOfOrder: [], taxRates: RATES, transactions: [],
      reservations: [res('a', 'CONFIRMED', '2026-11-01', '2026-11-03', 100), res('b', 'CONFIRMED', '2026-11-03', '2026-11-05', 100)]
    });
    expect(m.roomNights.sold).toBe(1);
    expect(m.revenue.roomForecast).toBe(10000);
  });
  it('rejects an empty or reversed period', () => {
    expect(() => calculatePMSMetrics({ from: '2026-11-02', to: '2026-11-02', rooms: [], outOfOrder: [], reservations: [], transactions: [], taxRates: RATES })).toThrow();
  });
  it('forecast taxes use half-up rounding like Postgres round(…, 2)', () => {
    const m = calculatePMSMetrics({
      from: '2026-11-01', to: '2026-11-02', rooms: [{ id: 'A' }], outOfOrder: [], transactions: [], taxRates: RATES,
      reservations: [res('a', 'CONFIRMED', '2026-11-01', '2026-11-02', 100.05)]
    });
    expect(m.revenue.taxes.vat).toBe(1001); // 10.005 → 10.01
    expect(m.revenue.taxes.lodging).toBe(200); // 2.001 → 2.00
  });
});

describe('toCents', () => {
  it('parses Postgres numeric strings and numbers exactly', () => {
    expect(toCents('100.10')).toBe(10010);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents('-0.40')).toBe(-40);
    expect(toCents('19.6')).toBe(1960);
    expect(toCents(null)).toBe(0);
    expect(toCents('1234567.89')).toBe(123456789);
  });
});
