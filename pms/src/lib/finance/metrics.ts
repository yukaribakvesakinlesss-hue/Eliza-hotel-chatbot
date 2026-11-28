/**
 * calculatePMSMetrics · the single place where hotel KPIs are computed.
 *
 * Pure function (no I/O): the dashboard loads raw rows from the database and passes them in;
 * tests pass hand-made rows. All money is handled in integer cents (no floating-point drift).
 *
 * Definitions (documented choices, see README):
 *   Available room-nights = rooms × days − out-of-order room-nights (dated OOO periods)
 *   Sold room-nights      = nights of CONFIRMED / CHECKED_IN / CHECKED_OUT stays, excluding complimentary
 *   Net room revenue      = posted room charges (ROOMS_TRANSIENT) + room allowances (discounts, negative)
 *                           + forecast for sold nights not posted yet (nightly rate, tax-exclusive)
 *   ADR       = Net room revenue / Sold room-nights
 *   RevPAR    = Net room revenue / Available room-nights
 *   Occupancy = Sold room-nights / Available room-nights × 100
 *   Cancelled stays never produce revenue. No-show and complimentary are reported separately and are
 *   not part of ADR/RevPAR (no-show revenue is in total revenue; comp nights are in "occupancy incl. comp").
 *   OTA commission = reservation net room revenue × commission rate snapshotted on the reservation;
 *   reported as a distribution cost (USALI-style "Rooms – commissions"), never netted inside revenue lines.
 * This is a mapping structure towards USALI categories, not a claim of full USALI compliance.
 */
import type { ReservationStatus } from '@/types/database';

export type MetricsRoom = { id: string };
export type MetricsOutOfOrder = { room_id: string; start_date: string; end_date: string | null };
export type MetricsReservation = {
  id: string;
  status: ReservationStatus;
  check_in: string;
  check_out: string;
  nightly_rate: number | string;
  channel_code: string;
  commission_rate: number | string;
  is_complimentary: boolean;
};
export type MetricsTransaction = {
  id: number | string;
  reservation_id: string;
  txn_type: 'ROOM_CHARGE' | 'TAX' | 'DISCOUNT' | 'EXTRA' | 'PAYMENT' | 'REFUND';
  account_code: string;
  amount: number | string;
  service_date: string;
  tax_code: 'VAT' | 'LODGING' | null;
  parent_id: number | string | null;
};
export type MetricsChannel = { code: string; name: string };

export type MetricsInput = {
  /** inclusive start date YYYY-MM-DD */
  from: string;
  /** exclusive end date YYYY-MM-DD */
  to: string;
  rooms: MetricsRoom[];
  outOfOrder: MetricsOutOfOrder[];
  reservations: MetricsReservation[];
  transactions: MetricsTransaction[];
  channels?: MetricsChannel[];
  /** property tax rates, used only for the forecast part of not-yet-posted nights */
  taxRates: { vatRooms: number; lodging: number };
};

export type ChannelMetrics = {
  code: string;
  name: string;
  soldRoomNights: number;
  roomRevenueNet: number;
  commission: number;
  /** weighted effective rate = commission / room revenue (0..1) */
  effectiveRate: number;
};

export type DailyMetrics = {
  date: string;
  availableRoomNights: number;
  outOfOrderRoomNights: number;
  soldRoomNights: number;
  complimentaryRoomNights: number;
  roomRevenueNet: number;
  occupancy: number;
  adr: number;
  revpar: number;
};

export type PMSMetrics = {
  period: { from: string; to: string; days: number };
  capacity: { physicalRoomNights: number; outOfOrderRoomNights: number; availableRoomNights: number };
  roomNights: { sold: number; complimentary: number; noShow: number; cancelled: number; pending: number };
  counts: { noShowReservations: number; cancelledReservations: number; complimentaryReservations: number };
  /** all money values are integer cents */
  revenue: {
    roomPosted: number;
    roomForecast: number;
    roomDiscounts: number;
    roomNet: number;
    noShowNet: number;
    extrasNet: number;
    extrasByAccount: Record<string, number>;
    totalNet: number;
    taxes: { vat: number; lodging: number; total: number; rooms: number; noShow: number; extras: number };
    roomGross: number;
    totalGross: number;
  };
  distribution: { commission: number; netAfterDistribution: number; roomNetAfterDistribution: number; byChannel: ChannelMetrics[] };
  settlements: { payments: number; refunds: number; net: number };
  kpi: { adr: number; revpar: number; occupancy: number; occupancyInclComp: number };
  daily: DailyMetrics[];
  /** account code → amount in cents (revenue, allowance, tax, settlement and commission expense) */
  usali: Record<string, number>;
};

const ACTIVE: ReadonlySet<ReservationStatus> = new Set(['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT']);
const EXTRA_ACCOUNTS = new Set(['FB_FOOD', 'FB_BEVERAGE', 'OOD_OTHER', 'MISC_INCOME']);
const DAY = 86_400_000;

/** Exact decimal → integer cents (handles '100.10', 100.1, '-0.40'). */
export function toCents(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  const s = typeof v === 'number' ? v.toFixed(4) : v.trim();
  const neg = s.startsWith('-');
  const [i = '0', f = ''] = (neg ? s.slice(1) : s).split('.');
  const frac = (f + '000').slice(0, 3);
  const cents = Number(i) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  return neg ? -cents : cents;
}

/** Half-up rounding of cents × rate, same as Postgres round(numeric, 2). */
const mulRate = (cents: number, rate: number) => Math.sign(cents) * Math.round(Math.abs(cents) * rate + 1e-9);
const ratio = (num: number, den: number) => (den > 0 ? num / den : 0);
const parseDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function calculatePMSMetrics(input: MetricsInput): PMSMetrics {
  const fromMs = parseDay(input.from);
  const toMs = parseDay(input.to);
  if (!(toMs > fromMs)) throw new Error('calculatePMSMetrics: "to" must be after "from"');
  const days: string[] = [];
  for (let t = fromMs; t < toMs; t += DAY) days.push(isoDay(t));
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  const daily: DailyMetrics[] = days.map((date) => ({
    date, availableRoomNights: 0, outOfOrderRoomNights: 0, soldRoomNights: 0, complimentaryRoomNights: 0,
    roomRevenueNet: 0, occupancy: 0, adr: 0, revpar: 0
  }));

  // ---------- capacity ----------
  const roomIds = new Set(input.rooms.map((r) => r.id));
  for (const day of daily) {
    const ooo = new Set(
      input.outOfOrder
        .filter((p) => roomIds.has(p.room_id) && p.start_date <= day.date && (p.end_date === null || day.date < p.end_date))
        .map((p) => p.room_id)
    );
    day.outOfOrderRoomNights = ooo.size;
    day.availableRoomNights = roomIds.size - ooo.size;
  }

  // ---------- ledger (posted transactions inside the period; cancelled stays excluded) ----------
  const resById = new Map(input.reservations.map((r) => [r.id, r]));
  const txAccount = new Map(input.transactions.map((t) => [String(t.id), t.account_code]));
  const postedNights = new Set<string>(); // "reservation|date" with a room charge (incl. reversed)
  const resRoomPosted = new Map<string, number>(); // room net per reservation inside the period (for commission)
  const usali: Record<string, number> = {};
  let roomPosted = 0, roomDiscounts = 0, noShowNet = 0, payments = 0, refunds = 0;
  const extrasByAccount: Record<string, number> = {};
  const taxes = { vat: 0, lodging: 0, total: 0, rooms: 0, noShow: 0, extras: 0 };

  for (const t of input.transactions) {
    if (t.account_code === 'ROOMS_TRANSIENT' && t.txn_type === 'ROOM_CHARGE') postedNights.add(`${t.reservation_id}|${t.service_date}`);
    const di = dayIndex.get(t.service_date);
    if (di === undefined) continue;
    const res = resById.get(t.reservation_id);
    if (res?.status === 'CANCELLED') continue;
    const c = toCents(t.amount);
    usali[t.account_code] = (usali[t.account_code] ?? 0) + c;

    if (t.account_code === 'ROOMS_TRANSIENT' || t.account_code === 'ROOMS_ALLOWANCE') {
      if (t.account_code === 'ROOMS_TRANSIENT') roomPosted += c;
      else roomDiscounts += c;
      daily[di]!.roomRevenueNet += c;
      resRoomPosted.set(t.reservation_id, (resRoomPosted.get(t.reservation_id) ?? 0) + c);
    } else if (t.account_code === 'ROOMS_NO_SHOW') {
      noShowNet += c;
    } else if (EXTRA_ACCOUNTS.has(t.account_code)) {
      extrasByAccount[t.account_code] = (extrasByAccount[t.account_code] ?? 0) + c;
    } else if (t.txn_type === 'TAX') {
      if (t.tax_code === 'VAT') taxes.vat += c;
      else taxes.lodging += c;
      const parent = t.parent_id === null ? undefined : txAccount.get(String(t.parent_id));
      if (parent === 'ROOMS_NO_SHOW') taxes.noShow += c;
      else if (parent && EXTRA_ACCOUNTS.has(parent)) taxes.extras += c;
      else taxes.rooms += c;
    } else if (t.txn_type === 'PAYMENT') {
      payments -= c;
    } else if (t.txn_type === 'REFUND') {
      refunds += c;
    }
  }

  // ---------- room-nights and forecast ----------
  let sold = 0, comp = 0, noShowNights = 0, cancelledNights = 0, pending = 0;
  let noShowReservations = 0, cancelledReservations = 0, complimentaryReservations = 0;
  let roomForecast = 0;
  const channelMap = new Map<string, ChannelMetrics>();
  const channelNames = new Map((input.channels ?? []).map((c) => [c.code, c.name]));
  const channel = (code: string) => {
    let c = channelMap.get(code);
    if (!c) {
      c = { code, name: channelNames.get(code) ?? code, soldRoomNights: 0, roomRevenueNet: 0, commission: 0, effectiveRate: 0 };
      channelMap.set(code, c);
    }
    return c;
  };
  let commission = 0;

  for (const r of input.reservations) {
    const start = Math.max(parseDay(r.check_in), fromMs);
    const end = Math.min(parseDay(r.check_out), toMs);
    const nightsInRange = Math.max(0, Math.round((end - start) / DAY));
    const arrivesInRange = r.check_in >= input.from && r.check_in < input.to;

    if (r.status === 'CANCELLED') {
      cancelledNights += nightsInRange;
      if (arrivesInRange) cancelledReservations++;
      continue;
    }
    if (r.status === 'NO_SHOW') {
      noShowNights += nightsInRange;
      if (arrivesInRange) noShowReservations++;
      continue;
    }
    if (r.status === 'PENDING') {
      pending += nightsInRange;
      continue;
    }
    if (!ACTIVE.has(r.status) || nightsInRange === 0) continue;

    if (r.is_complimentary) {
      if (arrivesInRange || nightsInRange > 0) complimentaryReservations++;
      for (let t = start; t < end; t += DAY) daily[dayIndex.get(isoDay(t))!]!.complimentaryRoomNights++;
      comp += nightsInRange;
      continue;
    }

    const rate = toCents(r.nightly_rate);
    let forecast = 0;
    for (let t = start; t < end; t += DAY) {
      const d = isoDay(t);
      const day = daily[dayIndex.get(d)!]!;
      day.soldRoomNights++;
      if (!postedNights.has(`${r.id}|${d}`) && rate > 0) {
        forecast += rate;
        day.roomRevenueNet += rate;
        taxes.vat += mulRate(rate, input.taxRates.vatRooms);
        taxes.lodging += mulRate(rate, input.taxRates.lodging);
        taxes.rooms += mulRate(rate, input.taxRates.vatRooms) + mulRate(rate, input.taxRates.lodging);
      }
    }
    sold += nightsInRange;
    roomForecast += forecast;

    const resNet = (resRoomPosted.get(r.id) ?? 0) + forecast;
    const resCommission = mulRate(resNet, Number(r.commission_rate));
    commission += resCommission;
    const ch = channel(r.channel_code);
    ch.soldRoomNights += nightsInRange;
    ch.roomRevenueNet += resNet;
    ch.commission += resCommission;
  }

  for (const ch of channelMap.values()) ch.effectiveRate = ratio(ch.commission, ch.roomRevenueNet);
  taxes.total = taxes.vat + taxes.lodging;

  const roomNet = roomPosted + roomDiscounts + roomForecast;
  const extrasNet = Object.values(extrasByAccount).reduce((a, b) => a + b, 0);
  const totalNet = roomNet + noShowNet + extrasNet;
  const available = daily.reduce((a, d) => a + d.availableRoomNights, 0);
  const outOfOrder = daily.reduce((a, d) => a + d.outOfOrderRoomNights, 0);

  for (const d of daily) {
    d.occupancy = round2(ratio(d.soldRoomNights, d.availableRoomNights) * 100);
    d.adr = Math.round(ratio(d.roomRevenueNet, d.soldRoomNights));
    d.revpar = Math.round(ratio(d.roomRevenueNet, d.availableRoomNights));
  }

  if (roomForecast) usali.ROOMS_TRANSIENT = (usali.ROOMS_TRANSIENT ?? 0) + roomForecast;
  usali.TAX_VAT = taxes.vat;
  usali.TAX_LODGING = taxes.lodging;
  usali.ROOMS_COMMISSIONS = commission;

  return {
    period: { from: input.from, to: input.to, days: days.length },
    capacity: { physicalRoomNights: roomIds.size * days.length, outOfOrderRoomNights: outOfOrder, availableRoomNights: available },
    roomNights: { sold, complimentary: comp, noShow: noShowNights, cancelled: cancelledNights, pending },
    counts: { noShowReservations, cancelledReservations, complimentaryReservations },
    revenue: {
      roomPosted, roomForecast, roomDiscounts, roomNet, noShowNet, extrasNet, extrasByAccount, totalNet, taxes,
      roomGross: roomNet + taxes.rooms,
      totalGross: totalNet + taxes.total
    },
    distribution: {
      commission,
      netAfterDistribution: totalNet - commission,
      roomNetAfterDistribution: roomNet - commission,
      byChannel: [...channelMap.values()].sort((a, b) => b.roomRevenueNet - a.roomRevenueNet)
    },
    settlements: { payments, refunds, net: payments - refunds },
    kpi: {
      adr: Math.round(ratio(roomNet, sold)),
      revpar: Math.round(ratio(roomNet, available)),
      occupancy: round2(ratio(sold, available) * 100),
      occupancyInclComp: round2(ratio(sold + comp, available) * 100)
    },
    daily,
    usali
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** cents → "1.234,56" style string for display */
export function formatMoney(cents: number, currency = 'EUR', lang: 'tr' | 'en' = 'tr'): string {
  return new Intl.NumberFormat(lang === 'tr' ? 'tr-TR' : 'en-GB', { style: 'currency', currency, minimumFractionDigits: 2 }).format(cents / 100);
}
