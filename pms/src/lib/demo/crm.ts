/**
 * Demo data for the sales demo (no database): guests, inbox, channel manager, audit log.
 * Everything is derived from the same deterministic demo hotel as the room board and reports,
 * so numbers agree across screens. The demo assistant computes availability and prices from
 * the demo rooms and stays (never invented), mirroring the database's inbox_assistant_turn.
 */
import type {
  AuditEntry, AvailabilityOption, BookingRequest, Conversation, Guest, GuestNote, Message, OtaConnection, OtaInboundEvent,
  OtaRoomMapping, Quote, ReservationWithGuest
} from '@/types/database';
import type { ProfileData } from '@/components/guests/GuestProfile';
import { addDays, formatDate, nightsBetween } from '@/lib/reservations/dates';
import { parseGuestMessage, type Parsed } from '@/lib/inbox/nlu';
import { demoProperty, demoRoomTypes, demoRooms } from './data';
import { demoFinance } from './reservations';

const ORG = demoProperty.organization_id;
const PROP = demoProperty.id;
const id = (prefix: string, n: number) => `00000000-0000-4000-${prefix}-${String(n).padStart(12, '0')}`;
const iso = (today: string, dayOffset: number, hour = 10) => `${addDays(today, dayOffset)}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------
// Availability and prices (same rules as the database)
// ---------------------------------------------------------------------
export function demoQuote(roomTypeId: string, checkIn: string, checkOut: string, rates: Record<string, number | null> = {}): Quote {
  const rt = demoRoomTypes.find((r) => r.id === roomTypeId)!;
  const rate = roomTypeId in rates ? rates[roomTypeId]! : rt.base_rate;
  const nights: Quote['nights'] = [];
  let net = 0; let vat = 0; let lodging = 0;
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
    nights.push({ date: d, rate });
    if (rate !== null) {
      net += rate; vat += round2(rate * demoProperty.vat_rate_rooms); lodging += round2(rate * demoProperty.lodging_tax_rate);
    }
  }
  const complete = rate !== null;
  return { complete, currency: demoProperty.currency, nights, net: complete ? round2(net) : null, vat: complete ? round2(vat) : null, lodging: complete ? round2(lodging) : null, gross: complete ? round2(net + vat + lodging) : null };
}

export function demoAvailability(today: string, checkIn: string, checkOut: string, adults: number, extra: ReservationWithGuest[] = [], rates: Record<string, number | null> = {}): AvailabilityOption[] {
  const stays = [...demoFinance(today).reservations, ...extra].filter((r) => r.status !== 'CANCELLED' && r.status !== 'NO_SHOW');
  const rooms = demoRooms();
  return demoRoomTypes.filter((t) => t.max_occupancy >= adults).map((t) => ({
    room_type_id: t.id, code: t.code, name: t.name, max_occupancy: t.max_occupancy,
    available: rooms.filter((r) => r.room_type_id === t.id && r.maintenance_status === 'OPERATIONAL'
      && !stays.some((s) => s.room_id === r.id && s.check_in < checkOut && s.check_out > checkIn)).length,
    quote: demoQuote(t.id, checkIn, checkOut, rates)
  }));
}

/** first free operational room of a type (demo stays plus the ones created in this browser) */
export function demoFreeRoom(today: string, roomTypeId: string, checkIn: string, checkOut: string, extra: ReservationWithGuest[] = []): string | null {
  const stays = [...demoFinance(today).reservations, ...extra].filter((r) => r.status !== 'CANCELLED' && r.status !== 'NO_SHOW');
  return demoRooms().find((r) => r.room_type_id === roomTypeId && r.maintenance_status === 'OPERATIONAL'
    && !stays.some((s) => s.room_id === r.id && s.check_in < checkOut && s.check_out > checkIn))?.id ?? null;
}

// same format as app_private.fmt_money: decimal comma in Turkish, decimal point in English
const money = (v: number | null, en = false) => {
  if (v === null) return '—';
  const [int, dec] = v.toFixed(2).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, en ? ',' : '.');
  return `€${grouped}${en ? '.' : ','}${dec}`;
};
export const DEMO_FAQ: Record<string, { tr: string; en: string }> = {
  checkin_time: { tr: "Giriş saatimiz 14:00, çıkış saatimiz 12:00'dir. Erken giriş ve geç çıkış müsaitliğe bağlıdır.", en: 'Check-in is from 14:00 and check-out until 12:00. Early check-in and late check-out depend on availability.' },
  breakfast: { tr: 'Kahvaltı 07:30–10:30 arasında açık büfe olarak servis edilir.', en: 'Breakfast is a buffet served from 07:30 to 10:30.' },
  wifi: { tr: 'Tüm otelde ücretsiz Wi-Fi vardır; şifre odanızdaki kartta yazar.', en: 'Free Wi-Fi throughout the hotel; the password is on the card in your room.' },
  parking: { tr: 'Otelimizin kendi otoparkı yoktur; 200 m mesafede ücretli otopark bulunur.', en: 'We have no private parking; there is a paid car park 200 m away.' }
};

// ---------------------------------------------------------------------
// Demo assistant (browser) — port of inbox_assistant_turn for the sales demo
// ---------------------------------------------------------------------
export type DemoContext = { check_in?: string; check_out?: string; adults?: number; room_type?: string; name?: string; contact?: string };
export type DemoTurn = { text: string; payload: Record<string, unknown>; context: DemoContext; handoff?: boolean; request?: BookingRequest };

export function demoAssistantTurn(today: string, conv: Conversation, text: string, ctx: DemoContext, lastType: string | null, rates: Record<string, number | null> = {}): DemoTurn {
  const p = parseGuestMessage(text, today, { roomTypes: demoRoomTypes.map((r) => ({ code: r.code, name: r.name })), lastAssistantType: lastType });
  return demoAssistantTurnParsed(today, conv, p, ctx, rates);
}

/**
 * The turn itself, from already-parsed intent and slots. Must behave exactly like the database's
 * inbox_assistant_turn; tests/assistant-parity.test.ts compares both on the same scenarios.
 */
export function demoAssistantTurnParsed(today: string, conv: Conversation, p: Parsed, ctx: DemoContext, rates: Record<string, number | null> = {}): DemoTurn {
  const s = p.slots as Record<string, unknown>;
  const en = p.lang === 'en';
  const c: DemoContext = { ...ctx };
  if (typeof s.check_in === 'string') c.check_in = s.check_in;
  if (typeof s.check_out === 'string') c.check_out = s.check_out;
  if (c.check_in && !c.check_out && typeof s.nights === 'number') c.check_out = addDays(c.check_in, s.nights);
  if (typeof s.adults === 'number') c.adults = s.adults;
  if (typeof s.room_type === 'string') c.room_type = s.room_type.toUpperCase();
  if (typeof s.name === 'string') c.name = s.name;
  if (typeof s.phone === 'string' || typeof s.email === 'string') c.contact = String(s.phone ?? s.email);
  const adults = Math.min(Math.max(c.adults ?? 2, 1), 10);

  if (p.intent === 'HANDOFF') {
    return { text: en ? 'I am passing you to our front desk; a colleague will reply here shortly.' : 'Sizi resepsiyonumuza aktarıyorum; bir arkadaşımız birazdan buradan yanıt verecek.', payload: { type: 'handoff' }, context: c, handoff: true };
  }
  if (p.intent === 'GREETING') {
    return { text: en ? `Hello, welcome to ${demoProperty.name}! I can check availability and prices for your dates or pass you to the front desk. When would you like to stay?`
      : `Merhaba, ${demoProperty.name}'e hoş geldiniz! Tarihlerinizi yazarsanız müsaitlik ve fiyatı kontrol edebilir ya da sizi resepsiyona bağlayabilirim. Hangi tarihlerde konaklamak istersiniz?`, payload: {}, context: c };
  }
  if (p.intent === 'FAQ') {
    const f = DEMO_FAQ[String(s.topic)];
    return { text: f ? (en ? f.en : f.tr) : en ? 'I do not have verified information on that. Shall I pass you to the front desk? Just write "front desk".' : 'Bu konuda doğrulanmış bir bilgim yok. Sizi resepsiyona aktarmamı ister misiniz? "Resepsiyon" yazmanız yeterli.', payload: { type: 'faq', topic: s.topic, verified: Boolean(f) }, context: c };
  }
  if (p.intent === 'AVAILABILITY' || p.intent === 'BOOKING') {
    if (!c.check_in || !c.check_out) {
      return { text: en ? 'Which dates would you like? Please write your arrival and departure dates (e.g. 12.12 – 15.12) and the number of guests.' : 'Hangi tarihler için bakayım? Giriş ve çıkış tarihlerinizi (örn. 12.12 – 15.12) ve kişi sayısını yazar mısınız?', payload: { type: 'ask_dates' }, context: c };
    }
    if (c.check_in < today || c.check_out <= c.check_in || nightsBetween(c.check_in, c.check_out) > 30) {
      return { text: en ? 'Those dates do not look right (past date, or departure before arrival, or more than 30 nights). Could you write them again?' : 'Bu tarihler geçerli görünmüyor (geçmiş tarih, çıkışın girişten önce olması ya da 30 geceden uzun konaklama). Tekrar yazar mısınız?', payload: { type: 'ask_dates', invalid: true }, context: { ...c, check_in: undefined, check_out: undefined } };
    }
    const nights = nightsBetween(c.check_in, c.check_out);
    const opts = demoAvailability(today, c.check_in, c.check_out, adults, [], rates);
    const lines = opts.map((o) => `\n• ${o.name}: ` + (o.available === 0 ? (en ? 'not available' : 'müsait değil')
      : o.quote.complete ? (en ? `${o.available} room(s) available, ${nights} nights total ${money(o.quote.gross, true)} incl. taxes` : `${o.available} oda müsait, ${nights} gece toplam ${money(o.quote.gross)} (vergiler dahil)`)
        : en ? `${o.available} room(s) available; the price is not in our system yet, the front desk will send it` : `${o.available} oda müsait; fiyat sistemde tanımlı değil, resepsiyon iletecek`)).join('');
    const base = { type: 'availability', check_in: c.check_in, check_out: c.check_out, adults, options: opts, checked_at: new Date().toISOString() };
    const range = `${formatDate(c.check_in)} – ${formatDate(c.check_out)}`;
    if (!opts.some((o) => o.available > 0)) {
      return { text: en ? `Sorry, we have no room for ${adults} guest(s) between ${formatDate(c.check_in)} and ${formatDate(c.check_out)}. I can pass you to the front desk for alternatives.` : `Üzgünüm, ${range} tarihleri arasında ${adults} kişilik müsait odamız yok. Alternatifler için sizi resepsiyona aktarabilirim.`, payload: base, context: c };
    }
    if (p.intent === 'AVAILABILITY') {
      return { text: (en ? `Live availability for ${range}, ${adults} guest(s):` : `${range}, ${adults} kişi için güncel müsaitlik:`) + lines + (en ? '\nWould you like me to create a booking request?' : '\nRezervasyon talebi oluşturmamı ister misiniz?'), payload: base, context: c };
    }
    const free = opts.filter((o) => o.available > 0);
    const choice = c.room_type ? free.find((o) => o.code === c.room_type) : free.length === 1 ? free[0] : undefined;
    if (!choice) return { text: (en ? 'Which room type would you like?' : 'Hangi oda tipini istersiniz?') + lines, payload: { ...base, type: 'ask_room_type' }, context: c };
    const name = c.name ?? conv.contact_name ?? undefined;
    const contact = c.contact ?? (conv.channel !== 'WEBCHAT' ? conv.contact_handle ?? undefined : undefined);
    if (!name || name.length < 2 || !contact) {
      return { text: en ? 'To create the request I need your full name and a phone number or e-mail.' : 'Talebi oluşturmak için adınızı soyadınızı ve bir telefon ya da e-posta adresinizi yazar mısınız?', payload: { ...base, type: 'ask_contact', room_type: choice.code }, context: { ...c, room_type: choice.code } };
    }
    const now = new Date().toISOString();
    const request: BookingRequest = {
      id: crypto.randomUUID(), organization_id: ORG, property_id: PROP, conversation_id: conv.id, guest_id: conv.guest_id, room_type_id: choice.room_type_id,
      check_in: c.check_in, check_out: c.check_out, adults, contact_name: name, contact_email: contact.includes('@') ? contact : null,
      contact_phone: contact.includes('@') ? null : contact, quote: choice.quote, status: 'NEW', reservation_id: null, handled_by: null, handled_at: null, decline_reason: null, created_at: now
    };
    return { text: en ? `Thank you ${name}, your booking request for a ${choice.name}, ${range} is recorded (request ${request.id.slice(0, 8)}). Our front desk will re-check availability and confirm; it is not a confirmed reservation until then.`
      : `Teşekkürler ${name}, ${choice.name} için ${range} rezervasyon talebiniz alındı (talep no ${request.id.slice(0, 8)}). Resepsiyonumuz müsaitliği tekrar kontrol edip onaylayacak; onaylanana kadar rezervasyon kesinleşmiş değildir.`,
    payload: { ...base, type: 'booking_request', booking_request_id: request.id }, context: c, request };
  }
  return { text: en ? 'I could not fully understand. Write your dates for availability and prices, or "front desk" to talk to a colleague.' : 'Mesajınızı tam anlayamadım. Müsaitlik ve fiyat için tarihlerinizi yazabilir ya da bir görevliyle konuşmak için "resepsiyon" yazabilirsiniz.', payload: { type: 'fallback' }, context: c };
}

// ---------------------------------------------------------------------
// Guests (from the demo stays) and profiles
// ---------------------------------------------------------------------
const slug = (s: string) => s.toLowerCase().replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');
const NATION: Record<string, [string, string]> = {
  'Lukas Weber': ['DE', 'de'], 'Sophie Martin': ['FR', 'fr'], 'Elena Rossi': ['IT', 'it'], 'John Smith': ['GB', 'en'], 'Al-Farsi Ailesi': ['AE', 'ar'],
  'Anna Kowalska': ['PL', 'pl'], 'Maria Garcia': ['ES', 'es'], 'Kenji Tanaka': ['JP', 'ja'], 'Olivia Brown': ['US', 'en'], 'Pierre Dubois': ['FR', 'fr'],
  'Hans Müller': ['DE', 'de'], 'Yuki Sato': ['JP', 'ja'], 'Laura Bianchi': ['IT', 'it'], 'David Cohen': ['US', 'en'], 'Ivan Petrov': ['BG', 'en'], 'Noah Wilson': ['GB', 'en']
};
const VIP: Record<string, [number, string]> = { 'Al-Farsi Ailesi': [3, 'Aile süiti, havalimanı transferi'], 'Kenji Tanaka': [2, 'Tekrarlayan kurumsal misafir'], 'Elena Rossi': [1, 'Balayı'] };
const NOTES: Record<string, [GuestNote['category'], string][]> = {
  'Al-Farsi Ailesi': [['PREFERENCE', 'Üst kat, sessiz oda'], ['SPECIAL_REQUEST', 'Bebek yatağı']],
  'Kenji Tanaka': [['PREFERENCE', 'Yastık: sert'], ['PREFERENCE', 'Erken kahvaltı 06:45']],
  'Elena Rossi': [['SPECIAL_REQUEST', 'Odada çiçek ve şampanya (sürpriz)']],
  'John Smith': [['ALERT', 'Fıstık alerjisi']],
  'Ayşe Yılmaz': [['PREFERENCE', 'Deniz manzarası değil, şehir tarafı']]
};

export function demoGuests(today: string): { guests: Guest[]; byName: Map<string, string> } {
  const stays = demoFinance(today).reservations;
  const names = [...new Set(stays.map((r) => r.guest_name).filter((n): n is string => Boolean(n)))].sort();
  const byName = new Map<string, string>();
  const guests = names.map((name, i) => {
    const gid = id('c000', i + 1);
    byName.set(name, gid);
    const mine = stays.filter((r) => r.guest_name === name);
    const last = mine.map((r) => r.check_out).sort().at(-1) ?? today;
    const [nat, lang] = NATION[name] ?? ['TR', 'tr'];
    const [vip, vipNote] = VIP[name] ?? [0, null];
    return {
      id: gid, organization_id: ORG, full_name: name, email: `${slug(name)}@example.com`, phone: `+90 555 010 ${String(10 + i).padStart(2, '0')} ${String(30 + i)}`,
      phone_normalized: `9055501${10 + i}${30 + i}`, nationality: nat, language: lang, vip_level: vip, vip_note: vipNote, marketing_consent: i % 3 === 0,
      marketing_consent_at: i % 3 === 0 ? iso(today, -60) : null, marketing_consent_source: i % 3 === 0 ? 'web' : null, kvkk_notice_at: iso(today, -60),
      anonymized_at: null, last_activity_at: `${last}T12:00:00.000Z`, created_at: iso(today, -200), updated_at: iso(today, -1)
    } satisfies Guest;
  });
  return { guests: guests.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at)), byName };
}

export function demoGuestProfile(today: string, guestId: string): ProfileData | null {
  const { guests } = demoGuests(today);
  const g = guests.find((x) => x.id === guestId);
  if (!g) return null;
  const { reservations, transactions } = demoFinance(today);
  const mine = reservations.filter((r) => r.guest_name === g.full_name).sort((a, b) => b.check_in.localeCompare(a.check_in));
  const spendOf = (rid: string) => round2(transactions.filter((t) => t.reservation_id === rid && ['ROOM_CHARGE', 'TAX', 'DISCOUNT', 'EXTRA'].includes(t.txn_type)).reduce((s, t) => s + Number(t.amount), 0));
  const roomNo = new Map(demoRooms().map((r) => [r.id, r.number]));
  const stayed = mine.filter((r) => r.status === 'CHECKED_IN' || r.status === 'CHECKED_OUT');
  return {
    guest: g,
    stats: {
      stays: mine.filter((r) => r.status === 'CHECKED_OUT').length, upcoming: mine.filter((r) => r.status === 'PENDING' || r.status === 'CONFIRMED').length,
      in_house: mine.filter((r) => r.status === 'CHECKED_IN').length, cancellations: mine.filter((r) => r.status === 'CANCELLED').length,
      no_shows: mine.filter((r) => r.status === 'NO_SHOW').length, nights: stayed.reduce((s, r) => s + nightsBetween(r.check_in, r.check_out), 0),
      first_stay: stayed.map((r) => r.check_in).sort()[0] ?? null, last_stay: stayed.map((r) => r.check_in).sort().at(-1) ?? null,
      total_spend: round2(mine.reduce((s, r) => s + spendOf(r.id), 0)), currency: demoProperty.currency
    },
    stays: mine.map((r) => ({ id: r.id, code: r.code, status: r.status, check_in: r.check_in, check_out: r.check_out, room: roomNo.get(r.room_id) ?? '—', property: demoProperty.name, channel: r.channel_code, spend: spendOf(r.id) })),
    notes: (NOTES[g.full_name] ?? []).map(([category, body], i) => ({ id: i + 1, organization_id: ORG, guest_id: g.id, category, body, created_by: null, created_at: iso(today, -30 + i), archived_at: null })),
    conversations: [], requests: []
  };
}

// ---------------------------------------------------------------------
// Inbox: conversations already handled by the assistant (built through the demo assistant itself)
// ---------------------------------------------------------------------
export type DemoInbox = { conversations: Conversation[]; threads: Record<string, Message[]>; requests: BookingRequest[]; contexts: Record<string, DemoContext> };

export function demoInbox(today: string): DemoInbox {
  const d = (n: number) => formatDate(addDays(today, n)).slice(0, 5);
  const scripts: { channel: Conversation['channel']; name: string; handle: string; status?: Conversation['status']; unread: number; lines: string[]; staff?: string }[] = [
    { channel: 'WHATSAPP', name: 'Ayşe Yılmaz', handle: '+90 555 010 10 30', unread: 1, lines: [`Merhaba, ${d(20)}-${d(23)} arası 2 kişi müsait oda var mı?`, 'Deluxe Double rezervasyon yapmak istiyorum, adım Ayşe Yılmaz'] },
    { channel: 'INSTAGRAM', name: 'Lukas Weber', handle: '@lukas.travels', unread: 0, lines: ['Hi! Is breakfast included?', 'Where can I park my car?'] },
    { channel: 'WEBCHAT', name: 'Elena', handle: 'Web', unread: 2, status: 'HUMAN', lines: ['Hello, can I bring my small dog?', 'front desk please'] },
    { channel: 'WHATSAPP', name: 'Kenji Tanaka', handle: '+90 555 010 19 39', unread: 0, lines: [`${d(45)} için 3 gece, 1 kişi, fiyat nedir?`], staff: 'Kenji Bey, kurumsal anlaşmanız geçerli; size özel fiyatı e-posta ile ilettik.' }
  ];
  const conversations: Conversation[] = [];
  const threads: Record<string, Message[]> = {};
  const requests: BookingRequest[] = [];
  const contexts: Record<string, DemoContext> = {};
  let mid = 1;
  scripts.forEach((s, i) => {
    const cid = id('d000', i + 1);
    const conv: Conversation = {
      id: cid, organization_id: ORG, property_id: PROP, channel: s.channel, external_thread_id: s.handle, guest_id: null, contact_name: s.name,
      contact_handle: s.handle, status: 'AI', is_demo: true, context: {}, unread_count: s.unread, last_message_at: iso(today, 0, 9 - i),
      last_message_preview: null, created_at: iso(today, -1), updated_at: iso(today, 0)
    };
    const msgs: Message[] = [];
    let ctx: DemoContext = {};
    let last: string | null = null;
    const add = (sender: Message['sender'], body: string, payload: Record<string, unknown> | null = null) => {
      msgs.push({ id: mid++, organization_id: ORG, property_id: PROP, conversation_id: cid, channel: s.channel, direction: sender === 'GUEST' ? 'IN' : 'OUT', sender, body, payload,
        external_id: null, delivery_status: sender === 'GUEST' ? 'RECEIVED' : s.channel === 'WEBCHAT' ? 'DELIVERED' : 'DEMO_NOT_SENT', author_id: null, created_at: iso(today, 0, 8 + msgs.length % 10) });
    };
    for (const line of s.lines) {
      add('GUEST', line);
      const t = demoAssistantTurn(today, conv, line, ctx, last);
      ctx = t.context;
      last = (t.payload.type as string | undefined) ?? null;
      add('AI', t.text, { ...t.payload, intent: 'demo' });
      if (t.request) requests.push(t.request);
      if (t.handoff) conv.status = 'HUMAN';
    }
    if (s.staff) {
      add('STAFF', s.staff);
      conv.status = 'HUMAN';
    }
    conv.last_message_preview = msgs.at(-1)!.body.slice(0, 140);
    conversations.push(conv);
    threads[cid] = msgs;
    contexts[cid] = ctx;
  });
  return { conversations, threads, requests, contexts };
}

// ---------------------------------------------------------------------
// Channel manager
// ---------------------------------------------------------------------
export function demoChannels(today: string) {
  const conns: OtaConnection[] = (['BOOKING', 'EXPEDIA'] as const).map((ch, i) => ({
    id: id('e000', i + 1), organization_id: ORG, property_id: PROP, channel_code: ch, mode: 'DEMO', enabled: true, external_hotel_id: null,
    last_push_at: iso(today, 0, 7), last_pull_at: null, last_error: null, created_at: iso(today, -30), updated_at: iso(today, 0)
  }));
  const mappings: OtaRoomMapping[] = conns.flatMap((c) => demoRoomTypes.map((rt, j) => ({
    id: id('e100', (c.channel_code === 'BOOKING' ? 0 : 10) + j), organization_id: ORG, property_id: PROP, connection_id: c.id, room_type_id: rt.id,
    external_room_id: (c.channel_code === 'BOOKING' ? 'BDC-' : 'EXP-') + rt.code, external_rate_plan_id: c.channel_code === 'BOOKING' ? 'BAR' : 'RACK', created_at: iso(today, -30)
  })));
  const ota = demoFinance(today).reservations.filter((r) => r.channel_code !== 'DIRECT' && r.check_in >= addDays(today, -10)).slice(0, 6);
  const events: OtaInboundEvent[] = ota.map((r, i) => ({
    id: 200 - i, organization_id: ORG, property_id: PROP, connection_id: r.channel_code === 'BOOKING' ? conns[0]!.id : conns[1]!.id, external_event_id: `demo-E${i}`,
    kind: i === 2 ? 'MODIFY' : 'NEW', external_reservation_id: `${r.channel_code === 'BOOKING' ? 'BK' : 'EX'}-${4810 + i}`, payload: {}, is_demo: true,
    status: 'PROCESSED', outcome: i === 2 ? 'MODIFIED' : 'CREATED', attempts: 1, next_attempt_at: null, last_error: null, reservation_id: r.id,
    received_at: iso(today, -i, 9), processed_at: iso(today, -i, 9), handled_by: null
  }));
  events.splice(1, 0, {
    id: 201, organization_id: ORG, property_id: PROP, connection_id: conns[0]!.id, external_event_id: 'demo-E99', kind: 'NEW', external_reservation_id: 'BK-4899',
    payload: {}, is_demo: true, status: 'NEEDS_ATTENTION', outcome: null, attempts: 1, next_attempt_at: null,
    last_error: `OTA_NO_ROOM: BOOKING için ${formatDate(addDays(today, 3))} – ${formatDate(addDays(today, 5))} arasında boş Junior Suite odası yok. Kanal oda sattı: aşırı rezervasyon, hemen müdahale edin.`,
    reservation_id: null, received_at: iso(today, 0, 8), processed_at: null, handled_by: null
  });
  return { connections: conns, mappings, events, open: Object.fromEntries(conns.map((c) => [c.id, 0])), dead: Object.fromEntries(conns.map((c) => [c.id, 0])) };
}

// ---------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------
export function demoAudit(today: string): AuditEntry[] {
  const stays = demoFinance(today).reservations.filter((r) => r.check_in >= today).slice(0, 8);
  const rows: Omit<AuditEntry, 'id'>[] = [];
  const at = (h: number, m: number) => `${today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  stays.forEach((r, i) => {
    rows.push({ at: at(9 - Math.floor(i / 2), 50 - i * 5), actor_kind: r.channel_code === 'DIRECT' ? 'USER' : 'SYSTEM', actor_name: r.channel_code === 'DIRECT' ? 'Selin Arslan (Resepsiyon)' : 'AXON Kanal Yöneticisi',
      action: 'INSERT', table_name: 'reservations', row_id: r.id, property_id: PROP,
      changes: { code: r.code, status: r.status, check_in: r.check_in, check_out: r.check_out, channel_code: r.channel_code, nightly_rate: r.nightly_rate, notes: '•••' } });
  });
  rows.splice(2, 0, { at: at(9, 12), actor_kind: 'USER', actor_name: 'Emre Koç (Müdür)', action: 'UPDATE', table_name: 'rate_calendar', row_id: '41', property_id: PROP, changes: { rate: { old: '120.00', new: '135.00' } } });
  rows.splice(4, 0, { at: at(8, 40), actor_kind: 'USER', actor_name: 'Emre Koç (Müdür)', action: 'UPDATE', table_name: 'guests', row_id: id('c000', 1), property_id: null, changes: { vip_level: { old: 0, new: 2 }, email: { changed: true } } });
  rows.splice(6, 0, { at: at(8, 5), actor_kind: 'USER', actor_name: 'Emre Koç (Müdür)', action: 'UPDATE', table_name: 'distribution_channels', row_id: 'BOOKING', property_id: null, changes: { commission_rate: { old: 0.17, new: 0.18 } } });
  rows.push({ at: at(7, 30), actor_kind: 'USER', actor_name: 'Emre Koç (Müdür)', action: 'INSERT', table_name: 'memberships', row_id: id('f000', 4), property_id: PROP, changes: { role: 'housekeeping' } });
  rows.push({ at: at(7, 10), actor_kind: 'USER', actor_name: 'Emre Koç (Müdür)', action: 'UPDATE', table_name: 'ota_room_mappings', row_id: id('e100', 2), property_id: PROP, changes: { external_room_id: { old: 'BDC-SUITE', new: 'BDC-JSTE' } } });
  return rows.map((r, i) => ({ ...r, id: 1000 - i }));
}
