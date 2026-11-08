/**
 * Guest message understanding (rule-based, Turkish + English).
 * Extracts intent and slots only. It never produces availability or prices: those are computed
 * and worded by the database (public.inbox_assistant_turn) from real rooms and rates.
 */
export type Intent = 'GREETING' | 'AVAILABILITY' | 'BOOKING' | 'HANDOFF' | 'FAQ' | 'UNKNOWN';
export type Slots = {
  check_in?: string;
  check_out?: string;
  nights?: number;
  adults?: number;
  room_type?: string;
  name?: string;
  email?: string;
  phone?: string;
  topic?: string;
};
export type Parsed = { lang: 'tr' | 'en'; intent: Intent; slots: Slots };
export type RoomTypeHint = { code: string; name: string };

const MONTHS: Record<string, number> = {
  ocak: 1, subat: 2, şubat: 2, mart: 3, nisan: 4, mayis: 5, mayıs: 5, haziran: 6, temmuz: 7, agustos: 8, ağustos: 8,
  eylul: 9, eylül: 9, ekim: 10, kasim: 11, kasım: 11, aralik: 12, aralık: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};
const NUMBER_WORDS: Record<string, number> = {
  bir: 1, iki: 2, üç: 3, uc: 3, dört: 4, dort: 4, beş: 5, bes: 5, altı: 6, alti: 6,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, single: 1, double: 2, couple: 2
};
const FAQ_TOPICS: [string, RegExp][] = [
  ['checkin_time', /(giri[sş] saat|[çc][ıi]k[ıi][sş] saat|check[- ]?in|check[- ]?out|ka[çc]ta giri[sş]|erken giri[sş]|ge[çc] [çc][ıi]k[ıi][sş])/],
  ['breakfast', /(kahvalt|breakfast)/],
  ['wifi', /(wi-?fi|internet|kablosuz)/],
  ['parking', /(otopark|park yeri|araba|parking|car park)/],
  ['transfer', /(transfer|havaliman|airport|shuttle)/],
  ['pets', /(evcil|k[öo]pek|kedi|\bpets?\b|\bdogs?\b|\bcats?\b)/],
  ['cancellation', /(iptal (politika|ko[sş]ul)|[üu]cretsiz iptal|cancell?ation)/]
];
const HANDOFF = /(resepsiyon|yetkili|temsilci|insanla|canl[ıi] destek|operat[öo]r|[şs]ikayet|m[üu]d[üu]r|front ?desk|reception|human|agent|real person|complain|manager)/;
const BOOKING = /(rezervasyon (yap|olu[sş]tur|iste|talep)|rezerve et|ay[ıi]rt|yer ay[ıi]r|talep olu[sş]tur|\bbook\b|booking request|make a reservation|reserve)/;
const AVAILABILITY = /(m[üu]sait|bo[sş] oda|yer var|oda var m|fiyat|[üu]cret|ka[çc] para|ne kadar|gecelik|availab|vacan|\bprice|\brates?\b|how much|\bcost)/;
const GREETING = /^(merhaba|selam|iyi g[üu]nler|g[üu]nayd[ıi]n|iyi ak[sş]amlar|hello|hi\b|hey\b|good (morning|afternoon|evening))/;
const AFFIRMATIVE = /^(evet|olur|tamam|isterim|l[üu]tfen|yes|yeah|sure|ok(ay)?|please)\b/;
const TR_HINT = /[çğıöşüÇĞİÖŞÜ]|\b(ve|bir|için|mi|mı|var|oda|kişi|gece|merhaba|lütfen|tarih|istiyorum|rezervasyon)\b/i;
const EN_HINT = /\b(the|is|are|for|room|night|nights|people|guests|please|available|price|book|hello|hi|want)\b/i;

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
function valid(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** day/month without a year → this year, or next year if that date has passed */
function withYear(d: number, m: number, y: number | undefined, today: string): string | undefined {
  const ty = Number(today.slice(0, 4));
  if (y !== undefined) {
    const yy = y < 100 ? 2000 + y : y;
    return valid(yy, m, d) ? iso(yy, m, d) : undefined;
  }
  if (!valid(ty, m, d)) return valid(ty + 1, m, d) ? iso(ty + 1, m, d) : undefined;
  const candidate = iso(ty, m, d);
  return candidate < today ? (valid(ty + 1, m, d) ? iso(ty + 1, m, d) : undefined) : candidate;
}

export function extractDates(text: string, today: string): { check_in?: string; check_out?: string; nights?: number } {
  const t = text.toLocaleLowerCase('tr-TR');
  const out: { check_in?: string; check_out?: string; nights?: number } = {};
  const nightsM = /(\d{1,2})\s*(gece|gecelik|night|nights)/.exec(t) ?? /(bir|iki|üç|uc|dört|dort|beş|bes|one|two|three|four|five)\s*(gece|night)/.exec(t);
  if (nightsM) out.nights = Number(nightsM[1]) || NUMBER_WORDS[nightsM[1]!];

  const found: string[] = [];
  const monthNames = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  // "12-15 kasım", "12 - 15 aralık 2026", "12 ile 15 kasım"
  const rangeSameMonth = new RegExp(`(\\d{1,2})\\s*(?:-|–|ile|to|and|ve)\\s*(\\d{1,2})\\s*(${monthNames})\\b(?:\\s*(\\d{4}))?`).exec(t);
  if (rangeSameMonth) {
    const m = MONTHS[rangeSameMonth[3]!]!;
    const y = rangeSameMonth[4] ? Number(rangeSameMonth[4]) : undefined;
    const a = withYear(Number(rangeSameMonth[1]), m, y, today);
    const b = withYear(Number(rangeSameMonth[2]), m, y ?? (a ? Number(a.slice(0, 4)) : undefined), today);
    if (a && b) found.push(a, b);
  }
  if (found.length < 2) {
    // "12 kasım", "december 3", "3rd of december"
    const re = new RegExp(`(?:(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${monthNames})\\b|(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b)(?:\\s*,?\\s*(\\d{4}))?`, 'g');
    for (const m of t.matchAll(re)) {
      const day = Number(m[1] ?? m[4]);
      const month = MONTHS[(m[2] ?? m[3])!]!;
      const d = withYear(day, month, m[5] ? Number(m[5]) : undefined, today);
      if (d) found.push(d);
    }
  }
  if (found.length < 2) {
    // ISO and numeric dates: 2026-12-12, 12.12, 12/12/2026
    for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/g)) {
      const d = m[1] ? (valid(+m[1], +m[2]!, +m[3]!) ? iso(+m[1], +m[2]!, +m[3]!) : undefined) : withYear(+m[4]!, +m[5]!, m[6] ? +m[6] : undefined, today);
      if (d && !found.includes(d)) found.push(d);
    }
  }
  if (!found.length) {
    if (/\b(bug[üu]n|today|tonight|bu gece)\b/.test(t)) found.push(today);
    else if (/\b(yar[ıi]n|tomorrow)\b/.test(t)) found.push(addDays(today, 1));
    else if (/(hafta ?sonu|weekend)/.test(t)) {
      const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
      const friday = addDays(today, (5 - dow + 7) % 7);
      found.push(friday, addDays(friday, 2));
    }
  }
  found.sort();
  if (found[0]) out.check_in = found[0];
  if (found[1] && found[1] > found[0]!) out.check_out = found[1];
  else if (out.check_in && out.nights) out.check_out = addDays(out.check_in, out.nights);
  return out;
}

function extractAdults(t: string): number | undefined {
  const m = /(\d{1,2})\s*(ki[sş]i|yeti[sş]kin|adults?|people|persons|guests|pax)\b/.exec(t);
  if (m) return Number(m[1]);
  const w = /(bir|iki|üç|uc|dört|dort|beş|bes|alt[ıi]|one|two|three|four|five|six)\s*(ki[sş]i|yeti[sş]kin|adults?|people|persons|guests)\b/.exec(t);
  if (w) return NUMBER_WORDS[w[1]!.replace('ı', 'ı')] ?? NUMBER_WORDS[w[1]!];
  if (/\b(e[sş]imle|iki ki[sş]ilik|for two|couple)\b/.test(t)) return 2;
  return undefined;
}

const ROOM_SYNONYMS: [RegExp, string][] = [
  [/s[üu]it|suite|suit\b/, 'suite'],
  [/deluxe|delux|l[üu]ks/, 'deluxe'],
  [/klasik|classic|standart|standard/, 'classic'],
  [/junior/, 'junior']
];
function extractRoomType(t: string, roomTypes: RoomTypeHint[]): string | undefined {
  for (const rt of roomTypes) if (new RegExp(`\\b${rt.code.toLowerCase()}\\b`).test(t)) return rt.code;
  const words = ROOM_SYNONYMS.filter(([re]) => re.test(t)).map(([, w]) => w);
  if (!words.length) return undefined;
  const hit = roomTypes.find((rt) => words.some((w) => rt.name.toLowerCase().includes(w)));
  return hit?.code;
}

export function parseGuestMessage(text: string, today: string, opts: { roomTypes?: RoomTypeHint[]; lastAssistantType?: string | null } = {}): Parsed {
  const raw = text.trim().slice(0, 2000);
  const t = raw.toLocaleLowerCase('tr-TR');
  const lang: 'tr' | 'en' = TR_HINT.test(raw) ? 'tr' : EN_HINT.test(raw) ? 'en' : 'tr';
  const slots: Slots = { ...extractDates(raw, today) };
  const adults = extractAdults(t);
  if (adults && adults >= 1 && adults <= 10) slots.adults = adults;
  const roomType = extractRoomType(t, opts.roomTypes ?? []);
  if (roomType) slots.room_type = roomType;
  const email = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/.exec(raw)?.[0];
  if (email) slots.email = email.replace(/[.,;]+$/, '');
  const phone = /(\+?\d[\d\s()-]{8,}\d)/.exec(raw.replace(email ?? '', ''))?.[1];
  if (phone && phone.replace(/\D/g, '').length >= 10) slots.phone = phone.trim();
  const name = /(?:[Aa]d[ıi]m|[İIi]smim|[Bb]enim ad[ıi]m|[Mm]y name is|I am|I'm)\s+([A-ZÇĞİÖŞÜ][\p{L}'-]+(?:\s+[A-ZÇĞİÖŞÜ][\p{L}'-]+){0,2})/u.exec(raw)?.[1];
  if (name) slots.name = name;

  const last = opts.lastAssistantType ?? null;
  const hasDates = Boolean(slots.check_in);
  const contactGiven = Boolean(slots.name || slots.email || slots.phone);
  let intent: Intent;
  if (HANDOFF.test(t)) intent = 'HANDOFF';
  else if (BOOKING.test(t)) intent = 'BOOKING';
  else if ((last === 'ask_room_type' || last === 'ask_contact' || last === 'booking_request') && (roomType || contactGiven || AFFIRMATIVE.test(t) || hasDates)) intent = 'BOOKING';
  else if (last === 'availability' && (AFFIRMATIVE.test(t) || (roomType && !hasDates))) intent = 'BOOKING';
  else if (AVAILABILITY.test(t) || hasDates) intent = 'AVAILABILITY';
  else {
    const topic = FAQ_TOPICS.find(([, re]) => re.test(t))?.[0];
    if (topic) {
      intent = 'FAQ';
      slots.topic = topic;
    } else if (GREETING.test(t)) intent = 'GREETING';
    else if (last === 'ask_dates' && adults) intent = 'AVAILABILITY';
    else intent = 'UNKNOWN';
  }
  // a FAQ question inside a longer message still gets its topic
  if (intent !== 'FAQ' && !hasDates && intent === 'UNKNOWN') {
    const topic = FAQ_TOPICS.find(([, re]) => re.test(t))?.[0];
    if (topic) {
      intent = 'FAQ';
      slots.topic = topic;
    }
  }
  return { lang, intent, slots };
}
