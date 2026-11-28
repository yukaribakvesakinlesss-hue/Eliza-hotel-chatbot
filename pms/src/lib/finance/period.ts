/** Report period helpers. Periods are half-open [from, to) like stays. */
import { addDays, isIsoDate, nightsBetween } from '@/lib/reservations/dates';

export type Period = { from: string; to: string };
export type PresetKey = 'today' | 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'next30' | 'thisYear';

const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
const nextMonthStart = (iso: string) => {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

export function presetPeriod(key: PresetKey, today: string): Period {
  switch (key) {
    case 'today': return { from: today, to: addDays(today, 1) };
    case 'last7': return { from: addDays(today, -7), to: today };
    case 'last30': return { from: addDays(today, -30), to: today };
    case 'lastMonth': { const to = monthStart(today); return { from: monthStart(addDays(to, -1)), to }; }
    case 'next30': return { from: today, to: addDays(today, 30) };
    case 'thisYear': return { from: `${today.slice(0, 4)}-01-01`, to: `${Number(today.slice(0, 4)) + 1}-01-01` };
    default: return { from: monthStart(today), to: nextMonthStart(today) };
  }
}

/** Validates ?from=&to= (to exclusive); falls back to this month. Max 366 days. */
export function parsePeriod(from: unknown, to: unknown, today: string): Period & { invalid: boolean } {
  if (isIsoDate(from) && isIsoDate(to)) {
    const n = nightsBetween(from, to);
    if (n >= 1 && n <= 366) return { from, to, invalid: false };
  }
  const p = presetPeriod('thisMonth', today);
  return { ...p, invalid: from !== undefined || to !== undefined };
}
