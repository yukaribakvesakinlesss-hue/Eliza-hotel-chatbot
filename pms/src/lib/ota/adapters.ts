/**
 * Channel-manager adapters for Booking.com and Expedia (server-only).
 *
 * What an adapter does:
 *   pushAri(items)  → send availability + rate for single nights; every item gets a result:
 *                     SENT · DEMO (not sent) · RETRY (network, 5xx, 429) · REJECTED (4xx / channel error)
 *   parseWebhook()  → turn a pushed reservation message into normalised events for ota_ingest_event
 *
 * LIVE needs the channel's partner credentials in the server env. Without them the adapter is DEMO:
 * nothing leaves the server and every item is reported as DEMO.
 *
 * Honest scope: the request formats follow the channels' public documentation (Booking.com B.XML
 * availability, Expedia EQC AvailRateUpdate) but have NOT been certified against the real endpoints.
 * Both channels only open their APIs to certified connectivity partners; for a pilot the realistic route
 * is a certified channel manager that posts reservations to /api/ota/webhook/[channel] in the
 * normalised JSON format below.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AriItem, OtaChannel } from '@/types/database';

type Env = Record<string, string | undefined>;
export type PushResult = { id: number; result: 'SENT' | 'DEMO' | 'RETRY' | 'REJECTED'; error?: string; available?: number; rate?: number | null; closed?: boolean };

/** Normalised reservation event (what the database accepts). */
export type OtaEvent = {
  event_id: string;
  kind: 'NEW' | 'MODIFY' | 'CANCEL';
  reservation_id: string;
  room_id?: string;
  rate_plan_id?: string;
  check_in?: string;
  check_out?: string;
  adults?: number;
  children?: number;
  total_amount?: number;
  currency?: string;
  notes?: string;
  guest?: { name?: string; email?: string; phone?: string };
};

export interface OtaAdapter {
  readonly channel: OtaChannel;
  readonly live: boolean;
  pushAri(hotelId: string | null, items: AriItem[]): Promise<PushResult[]>;
}

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const xml = (v: string | number) => String(v).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const money = (n: number) => n.toFixed(2);

/** HTTP status → retry policy shared by both channels. */
export function classifyHttp(status: number): 'SENT' | 'RETRY' | 'REJECTED' {
  if (status >= 200 && status < 300) return 'SENT';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'RETRY';
  return 'REJECTED';
}

async function post(fetcher: typeof fetch, url: string, body: string, headers: Record<string, string>, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { method: 'POST', headers, body, signal: ctrl.signal, cache: 'no-store' });
    return { status: res.status, text: await res.text().catch(() => '') };
  } catch (e) {
    return { status: 0, text: e instanceof Error ? e.message : 'network error' };
  } finally {
    clearTimeout(t);
  }
}

function demo(items: AriItem[]): PushResult[] {
  return items.map((i) => ({ id: i.id, result: 'DEMO', available: i.closed ? 0 : i.available, rate: i.rate, closed: i.closed }));
}

function settle(items: AriItem[], status: number, text: string, isOk: (t: string) => boolean, errorOf: (t: string) => string | null): PushResult[] {
  let result = status === 0 ? 'RETRY' as const : classifyHttp(status);
  let error: string | undefined = status === 0 ? `network: ${text.slice(0, 200)}` : result === 'SENT' ? undefined : `HTTP ${status}`;
  if (result === 'SENT' && !isOk(text)) {
    result = 'REJECTED';
    error = errorOf(text) ?? 'channel did not confirm the update';
  } else if (result !== 'SENT') {
    error = [error, errorOf(text)].filter(Boolean).join(' · ').slice(0, 300);
  }
  return items.map((i) => ({ id: i.id, result, error, available: i.closed ? 0 : i.available, rate: i.rate, closed: i.closed }));
}

// ---------------------------------------------------------------------
// Booking.com (B.XML availability)
// ---------------------------------------------------------------------
export class BookingComAdapter implements OtaAdapter {
  readonly channel = 'BOOKING' as const;
  readonly live: boolean;
  constructor(private env: Env, private fetcher: typeof fetch = fetch) {
    this.live = Boolean(env.BOOKING_XML_USERNAME && env.BOOKING_XML_PASSWORD);
  }

  buildAvailabilityXml(hotelId: string, items: AriItem[]): string {
    const rooms = new Map<string, AriItem[]>();
    for (const i of items) rooms.set(i.room_id, [...(rooms.get(i.room_id) ?? []), i]);
    const body = [...rooms].map(([room, list]) =>
      `<room id="${xml(room)}">` + list.map((i) =>
        `<date value="${xml(i.date)}"><rate id="${xml(i.rate_plan_id)}"/>` +
        `<roomstosell>${i.closed ? 0 : i.available}</roomstosell>` +
        (i.rate !== null && !i.closed ? `<price>${money(i.rate)}</price>` : '') +
        `<closed>${i.closed ? 1 : 0}</closed></date>`).join('') + '</room>').join('');
    return `<?xml version="1.0" encoding="UTF-8"?><request><username>${xml(this.env.BOOKING_XML_USERNAME ?? '')}</username>` +
      `<password>${xml(this.env.BOOKING_XML_PASSWORD ?? '')}</password><hotel_id>${xml(hotelId)}</hotel_id><version>1.0</version>${body}</request>`;
  }

  async pushAri(hotelId: string | null, items: AriItem[]): Promise<PushResult[]> {
    if (!this.live) return demo(items);
    if (!hotelId) return items.map((i) => ({ id: i.id, result: 'REJECTED', error: 'Booking.com hotel id missing' }));
    const url = this.env.BOOKING_XML_URL ?? 'https://supply-xml.booking.com/hotels/xml/availability';
    const { status, text } = await post(this.fetcher, url, this.buildAvailabilityXml(hotelId, items), { 'Content-Type': 'text/xml; charset=utf-8' });
    return settle(items, status, text, (t) => /<ok\b|<ok>/i.test(t) && !/<error/i.test(t), (t) => /<error[^>]*>([\s\S]*?)<\/error>/i.exec(t)?.[1]?.trim().slice(0, 200) ?? null);
  }
}

// ---------------------------------------------------------------------
// Expedia (EQC AvailRateUpdate)
// ---------------------------------------------------------------------
export class ExpediaAdapter implements OtaAdapter {
  readonly channel = 'EXPEDIA' as const;
  readonly live: boolean;
  constructor(private env: Env, private fetcher: typeof fetch = fetch) {
    this.live = Boolean(env.EXPEDIA_EQC_USERNAME && env.EXPEDIA_EQC_PASSWORD);
  }

  buildAvailRateXml(hotelId: string, items: AriItem[]): string {
    const body = items.map((i) =>
      `<AvailRateUpdate><DateRange from="${xml(i.date)}" to="${xml(i.date)}"/><RoomType id="${xml(i.room_id)}" closed="${i.closed}">` +
      `<Inventory totalInventoryAvailable="${i.closed ? 0 : i.available}"/>` +
      `<RatePlan id="${xml(i.rate_plan_id)}" closed="${i.closed}">` +
      (i.rate !== null && !i.closed ? `<Rate currency="${xml(i.currency)}"><PerDay rate="${money(i.rate)}"/></Rate>` : '') +
      `</RatePlan></RoomType></AvailRateUpdate>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><AvailRateUpdateRQ xmlns="http://www.expediaconnect.com/EQC/AR/2011/06">` +
      `<Authentication username="${xml(this.env.EXPEDIA_EQC_USERNAME ?? '')}" password="${xml(this.env.EXPEDIA_EQC_PASSWORD ?? '')}"/>` +
      `<Hotel id="${xml(hotelId)}"/>${body}</AvailRateUpdateRQ>`;
  }

  async pushAri(hotelId: string | null, items: AriItem[]): Promise<PushResult[]> {
    if (!this.live) return demo(items);
    if (!hotelId) return items.map((i) => ({ id: i.id, result: 'REJECTED', error: 'Expedia hotel id missing' }));
    const url = this.env.EXPEDIA_EQC_URL ?? 'https://services.expediapartnercentral.com/eqc/ar';
    const { status, text } = await post(this.fetcher, url, this.buildAvailRateXml(hotelId, items), { 'Content-Type': 'text/xml; charset=utf-8' });
    return settle(items, status, text, (t) => /<Success\s*\/?>/i.test(t) && !/<Error\b/i.test(t),
      (t) => /<Error[^>]*>([\s\S]*?)<\/Error>/i.exec(t)?.[1]?.trim().slice(0, 200) ?? null);
  }
}

export function otaAdapterFor(channel: OtaChannel, env: Env = process.env, fetcher: typeof fetch = fetch): OtaAdapter {
  return channel === 'BOOKING' ? new BookingComAdapter(env, fetcher) : new ExpediaAdapter(env, fetcher);
}

// ---------------------------------------------------------------------
// Inbound webhook (normalised JSON from a channel manager)
// ---------------------------------------------------------------------
/** Signature: X-AXON-Signature: sha256=<hex HMAC-SHA256 of the raw body with OTA_WEBHOOK_SECRET>. */
export function verifyOtaSignature(raw: string, header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 24 || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const given = Buffer.from(header.slice(7));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Validates and normalises one event; returns an error text instead of throwing. */
export function parseOtaEvent(v: unknown): { ok: true; event: OtaEvent } | { ok: false; error: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'event must be an object' };
  const e = v as Record<string, unknown>;
  const kind = typeof e.kind === 'string' ? e.kind.toUpperCase() : '';
  if (typeof e.event_id !== 'string' || !ID.test(e.event_id) || e.event_id.length > 70) return { ok: false, error: 'event_id invalid' };
  if (kind !== 'NEW' && kind !== 'MODIFY' && kind !== 'CANCEL') return { ok: false, error: 'kind must be NEW, MODIFY or CANCEL' };
  if (typeof e.reservation_id !== 'string' || !ID.test(e.reservation_id) || e.reservation_id.length > 50) return { ok: false, error: 'reservation_id invalid' };
  const out: OtaEvent = { event_id: e.event_id, kind, reservation_id: e.reservation_id };
  if (kind !== 'CANCEL') {
    if (typeof e.room_id !== 'string' || !ID.test(e.room_id)) return { ok: false, error: 'room_id invalid' };
    if (typeof e.check_in !== 'string' || !DATE.test(e.check_in) || typeof e.check_out !== 'string' || !DATE.test(e.check_out) || e.check_out <= e.check_in) {
      return { ok: false, error: 'check_in / check_out must be YYYY-MM-DD, check_out after check_in' };
    }
    if (typeof e.total_amount !== 'number' || !Number.isFinite(e.total_amount) || e.total_amount < 0 || e.total_amount > 10_000_000) return { ok: false, error: 'total_amount invalid' };
    const adults = e.adults === undefined ? 2 : e.adults;
    const children = e.children === undefined ? 0 : e.children;
    if (!Number.isInteger(adults) || (adults as number) < 1 || (adults as number) > 20 || !Number.isInteger(children) || (children as number) < 0 || (children as number) > 20) {
      return { ok: false, error: 'adults / children invalid' };
    }
    Object.assign(out, { room_id: e.room_id, check_in: e.check_in, check_out: e.check_out, total_amount: e.total_amount, adults, children });
    if (typeof e.rate_plan_id === 'string' && ID.test(e.rate_plan_id)) out.rate_plan_id = e.rate_plan_id;
    if (typeof e.currency === 'string' && /^[A-Za-z]{3}$/.test(e.currency)) out.currency = e.currency.toUpperCase();
    else if (e.currency !== undefined) return { ok: false, error: 'currency invalid' };
    if (typeof e.notes === 'string') out.notes = e.notes.slice(0, 300);
    const g = e.guest as Record<string, unknown> | undefined;
    if (g && typeof g === 'object') {
      out.guest = {
        name: typeof g.name === 'string' ? g.name.slice(0, 120) : undefined,
        email: typeof g.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(g.email) ? g.email.slice(0, 160) : undefined,
        phone: typeof g.phone === 'string' ? g.phone.slice(0, 30) : undefined
      };
    }
  }
  return { ok: true, event: out };
}

export function otaWebhookTarget(env: Env): { orgSlug: string; propertyCode: string } | null {
  const m = /^([a-z0-9][a-z0-9-]{1,62})\/([A-Za-z0-9]{2,12})$/.exec(env.OTA_PROPERTY ?? '');
  return m ? { orgSlug: m[1]!, propertyCode: m[2]!.toUpperCase() } : null;
}
