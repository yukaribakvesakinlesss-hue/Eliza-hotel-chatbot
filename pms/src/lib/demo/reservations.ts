/**
 * Demo reservations and ledger (demo mode only; never written anywhere).
 * Deterministic generator: same "today" → same data. Stays never overlap per room
 * (same rule as the database EXCLUDE constraint); dates are relative to "today".
 */
import type { FolioTransaction, OutOfOrderPeriod, ReservationStatus, ReservationWithGuest } from '@/types/database';
import { addDays, nightsBetween } from '@/lib/reservations/dates';
import { demoProperty, demoRooms } from './data';

const GUESTS = [
  'Ayşe Yılmaz', 'Lukas Weber', 'Mehmet Kaya', 'Sophie Martin', 'Elena Rossi', 'John Smith', 'Al-Farsi Ailesi', 'Zeynep Demir',
  'Anna Kowalska', 'Can Öztürk', 'Maria Garcia', 'Kenji Tanaka', 'Olivia Brown', 'Ahmet Şahin', 'Fatma Aydın', 'Pierre Dubois',
  'Hans Müller', 'Selin Arslan', 'Yuki Sato', 'Emre Koç', 'Laura Bianchi', 'David Cohen', 'Ivan Petrov', 'Noah Wilson'
];
const RATE_BY_TYPE: Record<string, number> = { CDBL: 90, DDBL: 120, JSTE: 180 };
export const DEMO_CHANNELS = [
  { code: 'DIRECT', name: 'AXON Direct', commission_rate: 0 },
  { code: 'BOOKING', name: 'Booking.com', commission_rate: 0.18 },
  { code: 'EXPEDIA', name: 'Expedia', commission_rate: 0.15 }
];
const VAT = demoProperty.vat_rate_rooms;
const LODGING = demoProperty.lodging_tax_rate;

/** small seeded PRNG (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

export type DemoFinance = {
  reservations: ReservationWithGuest[];
  transactions: FolioTransaction[];
  outOfOrder: OutOfOrderPeriod[];
};

const cache = new Map<string, DemoFinance>();

export function demoFinance(today: string): DemoFinance {
  const hit = cache.get(today);
  if (hit) return hit;
  const rooms = demoRooms();
  const reservations: ReservationWithGuest[] = [];
  const transactions: FolioTransaction[] = [];
  let txId = 1;
  let seq = 1;
  const oooRoom = rooms.find((r) => r.number === '304');
  const oooStart = addDays(today, -3);
  const outOfOrder: OutOfOrderPeriod[] = [];
  if (oooRoom) {
    outOfOrder.push({ id: 1, organization_id: demoProperty.organization_id, property_id: demoProperty.id, room_id: oooRoom.id, start_date: oooStart, end_date: null, reason: 'Air conditioning repair', created_at: `${today}T08:00:00.000Z` });
  }
  const room205 = rooms.find((r) => r.number === '205');
  if (room205) {
    outOfOrder.push({ id: 2, organization_id: demoProperty.organization_id, property_id: demoProperty.id, room_id: room205.id, start_date: addDays(today, -20), end_date: addDays(today, -16), reason: 'Boya', created_at: `${today}T08:00:00.000Z` });
  }

  const post = (r: ReservationWithGuest, type: FolioTransaction['txn_type'], account: string, amount: number, date: string, desc: string,
    extra: Partial<FolioTransaction> = {}): FolioTransaction => {
    const t: FolioTransaction = {
      id: txId++, organization_id: r.organization_id, property_id: r.property_id, folio_id: `folio-${r.id}`, reservation_id: r.id,
      txn_type: type, account_code: account, description: desc, service_date: date, amount: round2(amount), tax_code: null, tax_rate: null,
      parent_id: null, reverses_id: null, payment_method: null, idempotency_key: null, created_by: null, created_at: `${date}T12:00:00.000Z`, ...extra
    };
    transactions.push(t);
    return t;
  };
  const taxes = (r: ReservationWithGuest, parent: FolioTransaction, base: number, vat: number, lodging: number) => {
    if (vat) post(r, 'TAX', 'TAX_VAT', base * vat, parent.service_date, `KDV %${vat * 100}`, { tax_code: 'VAT', tax_rate: vat, parent_id: parent.id });
    if (lodging) post(r, 'TAX', 'TAX_LODGING', base * lodging, parent.service_date, `Konaklama vergisi %${lodging * 100}`, { tax_code: 'LODGING', tax_rate: lodging, parent_id: parent.id });
  };

  rooms.forEach((room, ri) => {
    const rand = rng(ri * 7919 + 17);
    const base = RATE_BY_TYPE[room.room_type?.code ?? 'CDBL'] ?? 90;
    let cursor = addDays(today, -60 + Math.floor(rand() * 3));
    while (cursor < addDays(today, 30)) {
      const nights = 1 + Math.floor(rand() * 4);
      const checkIn = cursor;
      const checkOut = addDays(checkIn, nights);
      cursor = addDays(checkOut, Math.floor(rand() * 3));
      // keep the out-of-order windows free
      if (room.id === oooRoom?.id && checkOut > oooStart) break;
      if (room.id === room205?.id && checkIn < addDays(today, -16) && checkOut > addDays(today, -20)) continue;

      const roll = rand();
      let status: ReservationStatus;
      if (checkOut <= today) status = roll < 0.05 ? 'NO_SHOW' : roll < 0.12 ? 'CANCELLED' : 'CHECKED_OUT';
      else if (checkIn <= today) status = 'CHECKED_IN';
      else status = roll < 0.08 ? 'PENDING' : roll < 0.14 ? 'CANCELLED' : 'CONFIRMED';
      const chRoll = rand();
      const channel = DEMO_CHANNELS[chRoll < 0.45 ? 0 : chRoll < 0.8 ? 1 : 2]!;
      const comp = status !== 'CANCELLED' && rand() < 0.03;
      const weekendBoost = new Date(`${checkIn}T00:00:00Z`).getUTCDay() >= 5 ? 1.15 : 1;
      const rate = comp ? 0 : Math.round(base * weekendBoost);
      const n = seq++;
      const r: ReservationWithGuest = {
        id: `00000000-0000-4000-c000-${String(n).padStart(12, '0')}`,
        organization_id: demoProperty.organization_id,
        property_id: demoProperty.id,
        room_id: room.id,
        code: `R${String(n).padStart(6, '0')}`,
        status,
        check_in: checkIn,
        check_out: checkOut,
        stay: `[${checkIn},${checkOut})`,
        adults: 2,
        children: 0,
        source: channel.code === 'DIRECT' ? 'direct' : 'ota',
        notes: null,
        version: 1,
        created_by: null,
        updated_by: null,
        checked_in_at: null,
        checked_out_at: null,
        cancelled_at: status === 'CANCELLED' ? `${today}T08:00:00.000Z` : null,
        cancel_reason: null,
        nightly_rate: rate,
        channel_code: channel.code,
        commission_rate: channel.commission_rate,
        is_complimentary: comp,
        created_at: `${addDays(checkIn, -14)}T08:00:00.000Z`,
        updated_at: `${today}T08:00:00.000Z`,
        guest_name: GUESTS[(ri * 5 + n) % GUESTS.length] ?? 'Misafir'
      };
      reservations.push(r);

      // ---- ledger (what the database would hold) ----
      if (status === 'NO_SHOW' && !comp) {
        const c = post(r, 'ROOM_CHARGE', 'ROOMS_NO_SHOW', rate, checkIn, 'No-show ücreti (1 gece)');
        taxes(r, c, rate, VAT, 0);
        post(r, 'PAYMENT', 'SETTLEMENT_CARD', -round2(rate * (1 + VAT)), checkIn, 'Kart (garanti)', { payment_method: 'CARD' });
      }
      if ((status === 'CHECKED_OUT' || status === 'CHECKED_IN') && !comp) {
        let due = 0;
        for (let d = checkIn; d < checkOut && d < today; d = addDays(d, 1)) {
          const c = post(r, 'ROOM_CHARGE', 'ROOMS_TRANSIENT', rate, d, `Konaklama ${d}`);
          taxes(r, c, rate, VAT, LODGING);
          due += rate * (1 + VAT + LODGING);
        }
        if (rand() < 0.35) {
          const amount = rand() < 0.5 ? 25 : 40;
          const account = amount === 25 ? 'FB_BEVERAGE' : 'FB_FOOD';
          const vat = account === 'FB_BEVERAGE' ? 0.2 : 0.1;
          const c = post(r, 'EXTRA', account, amount, checkIn, account === 'FB_BEVERAGE' ? 'Minibar' : 'Akşam yemeği');
          taxes(r, c, amount, vat, 0);
          due += amount * (1 + vat);
        }
        if (status === 'CHECKED_OUT' && nightsBetween(checkIn, checkOut) >= 3 && channel.code === 'DIRECT' && rand() < 0.4) {
          const d = round2(rate * 0.1);
          const c = post(r, 'DISCOUNT', 'ROOMS_ALLOWANCE', -d, addDays(checkIn, 1), 'Uzun konaklama indirimi %10');
          taxes(r, c, -d, VAT, LODGING);
          due -= d * (1 + VAT + LODGING);
        }
        if (status === 'CHECKED_OUT' && due > 0) {
          const method = channel.code === 'EXPEDIA' ? 'OTA' : rand() < 0.7 ? 'CARD' : 'CASH';
          post(r, 'PAYMENT', `SETTLEMENT_${method}`, -round2(due), addDays(checkOut, -1), 'Tahsilat', { payment_method: method });
        }
      }
    }
  });

  const result = { reservations, transactions, outOfOrder };
  cache.set(today, result);
  return result;
}

/** Reservations for the tape chart (demo mode). */
export function demoReservations(today: string): ReservationWithGuest[] {
  return demoFinance(today).reservations;
}

/** Demo rooms with occupancy that matches the demo stays (in house → OCCUPIED, arriving today → RESERVED). */
export function demoRoomsForToday(today: string) {
  const stays = demoReservations(today);
  return demoRooms().map((room) => {
    if (room.maintenance_status === 'OUT_OF_ORDER') return { ...room, occupancy_status: 'VACANT' as const };
    const inHouse = stays.some((r) => r.room_id === room.id && r.status === 'CHECKED_IN');
    const arriving = stays.some((r) => r.room_id === room.id && r.check_in === today && (r.status === 'CONFIRMED' || r.status === 'PENDING'));
    return { ...room, occupancy_status: inHouse ? ('OCCUPIED' as const) : arriving ? ('RESERVED' as const) : ('VACANT' as const) };
  });
}
