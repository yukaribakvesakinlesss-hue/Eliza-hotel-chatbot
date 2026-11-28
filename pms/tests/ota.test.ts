import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { BookingComAdapter, ExpediaAdapter, classifyHttp, parseOtaEvent, verifyOtaSignature } from '@/lib/ota/adapters';
import { handleOtaWebhook } from '@/lib/ota/webhook';
import { runChannelSync } from '@/lib/ota/sync';
import { handleWebhook } from '@/lib/inbox/webhook';
import { isPublicPath } from '@/lib/public-paths';
import { redact } from '@/lib/log';
import type { AriItem } from '@/types/database';

const item = (o: Partial<AriItem> = {}): AriItem => ({
  id: 1, channel: 'BOOKING', mode: 'LIVE', hotel_id: '123', room_id: 'BDC-CDBL', rate_plan_id: 'BAR', date: '2026-12-12',
  available: 3, rate: 90, currency: 'EUR', closed: false, attempts: 0, ...o
});
const BKG_ENV = { BOOKING_XML_USERNAME: 'u<&>', BOOKING_XML_PASSWORD: 'p' };
const EXP_ENV = { EXPEDIA_EQC_USERNAME: 'eu', EXPEDIA_EQC_PASSWORD: 'ep' };
const respond = (status: number, body: string) => vi.fn().mockResolvedValue(new Response(body, { status }));

describe('OTA adapters', () => {
  it('HTTP status → retry policy', () => {
    expect(classifyHttp(200)).toBe('SENT');
    expect([429, 500, 503, 408].map(classifyHttp)).toEqual(['RETRY', 'RETRY', 'RETRY', 'RETRY']);
    expect([400, 401, 403, 404, 422].map(classifyHttp)).toEqual(['REJECTED', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED']);
  });

  it('Booking.com XML: escaped credentials, closed nights carry no price and 0 rooms', () => {
    const x = new BookingComAdapter(BKG_ENV).buildAvailabilityXml('123', [item(), item({ id: 2, date: '2026-12-13', rate: null, closed: true })]);
    expect(x).toContain('<username>u&lt;&amp;&gt;</username>');
    expect(x).toContain('<room id="BDC-CDBL"><date value="2026-12-12"><rate id="BAR"/><roomstosell>3</roomstosell><price>90.00</price><closed>0</closed></date>');
    expect(x).toContain('<date value="2026-12-13"><rate id="BAR"/><roomstosell>0</roomstosell><closed>1</closed></date>');
    expect(x).not.toMatch(/<price>[^<]*<\/price><closed>1/);
  });

  it('Expedia XML: inventory, rate plan and currency', () => {
    const x = new ExpediaAdapter(EXP_ENV).buildAvailRateXml('987', [item({ channel: 'EXPEDIA', room_id: 'EXP-DDBL', rate_plan_id: 'RACK', rate: 120.5 })]);
    expect(x).toContain('<Hotel id="987"/>');
    expect(x).toContain('<RoomType id="EXP-DDBL" closed="false"><Inventory totalInventoryAvailable="3"/><RatePlan id="RACK" closed="false"><Rate currency="EUR"><PerDay rate="120.50"/>');
  });

  it('DEMO: without credentials nothing is sent', async () => {
    const f = vi.fn();
    const r = await new BookingComAdapter({}, f as unknown as typeof fetch).pushAri('123', [item()]);
    expect(r[0]).toMatchObject({ result: 'DEMO' });
    expect(f).not.toHaveBeenCalled();
    expect(new ExpediaAdapter({}).live).toBe(false);
  });

  it('LIVE: results per channel answer', async () => {
    const ok = await new BookingComAdapter(BKG_ENV, respond(200, '<ok></ok>') as unknown as typeof fetch).pushAri('123', [item(), item({ id: 2 })]);
    expect(ok.map((r) => r.result)).toEqual(['SENT', 'SENT']);
    const err200 = await new BookingComAdapter(BKG_ENV, respond(200, '<error>Room 99 unknown</error>') as unknown as typeof fetch).pushAri('123', [item()]);
    expect(err200[0]).toMatchObject({ result: 'REJECTED', error: 'Room 99 unknown' });
    const busy = await new ExpediaAdapter(EXP_ENV, respond(503, 'down') as unknown as typeof fetch).pushAri('9', [item()]);
    expect(busy[0]).toMatchObject({ result: 'RETRY', error: 'HTTP 503' });
    const net = await new ExpediaAdapter(EXP_ENV, vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch).pushAri('9', [item()]);
    expect(net[0]!.result).toBe('RETRY');
    const okExp = await new ExpediaAdapter(EXP_ENV, respond(200, '<AvailRateUpdateRS><Success/></AvailRateUpdateRS>') as unknown as typeof fetch).pushAri('9', [item()]);
    expect(okExp[0]!.result).toBe('SENT');
    const noHotel = await new ExpediaAdapter(EXP_ENV, respond(200, '') as unknown as typeof fetch).pushAri(null, [item()]);
    expect(noHotel[0]!.result).toBe('REJECTED');
  });
});

describe('OTA events', () => {
  const ev = { event_id: 'E1', kind: 'NEW', reservation_id: 'BK1', room_id: 'BDC-CDBL', check_in: '2026-12-12', check_out: '2026-12-15', total_amount: 300, adults: 2, currency: 'eur', guest: { name: 'Hans', email: 'bad' } };
  it('valid event is normalised; invalid e-mail dropped', () => {
    const r = parseOtaEvent(ev);
    expect(r.ok && r.event).toMatchObject({ kind: 'NEW', currency: 'EUR', total_amount: 300, guest: { name: 'Hans', email: undefined } });
  });
  it('rejects bad ids, reversed dates, negative amount, unknown kind', () => {
    expect(parseOtaEvent({ ...ev, event_id: 'a b' }).ok).toBe(false);
    expect(parseOtaEvent({ ...ev, check_out: '2026-12-11' }).ok).toBe(false);
    expect(parseOtaEvent({ ...ev, total_amount: -1 }).ok).toBe(false);
    expect(parseOtaEvent({ ...ev, kind: 'DELETE' }).ok).toBe(false);
    expect(parseOtaEvent({ ...ev, adults: 0 }).ok).toBe(false);
    expect(parseOtaEvent([ev]).ok).toBe(false);
  });
  it('cancellation needs only ids', () => {
    expect(parseOtaEvent({ event_id: 'C1', kind: 'cancel', reservation_id: 'BK1' })).toEqual({ ok: true, event: { event_id: 'C1', kind: 'CANCEL', reservation_id: 'BK1' } });
  });
});

const SECRET = 'webhook-secret-0123456789abcdef';
const OTA_ENV = { OTA_PROPERTY: 'axon-demo/AUR', OTA_SYNC_SECRET: 'sync-secret-0123456789abcdefgh', OTA_WEBHOOK_SECRET: SECRET };
const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
const otaReq = (raw: string, sig: string | null) => new NextRequest('http://pms.test/api/ota/webhook/booking', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-axon-signature': sig } : {}) }, body: raw
});
function fakeDb(handler: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return handler(fn, args); });
  return { client: { rpc } as never, calls };
}

describe('OTA webhook', () => {
  const raw = JSON.stringify([{ event_id: 'E1', kind: 'NEW', reservation_id: 'BK1', room_id: 'BDC-CDBL', check_in: '2026-12-12', check_out: '2026-12-15', total_amount: 300 }]);
  it('signature check (exact HMAC only, secret of at least 24 characters)', () => {
    expect(verifyOtaSignature(raw, sign(raw), SECRET)).toBe(true);
    expect(verifyOtaSignature(raw + ' ', sign(raw), SECRET)).toBe(false);
    expect(verifyOtaSignature(raw, sign(raw), 'short')).toBe(false);
    expect(verifyOtaSignature(raw, null, SECRET)).toBe(false);
  });
  it('DEMO: 503 and nothing stored', async () => {
    const { client, calls } = fakeDb(() => ({ data: null, error: null }));
    expect((await handleOtaWebhook(otaReq(raw, sign(raw)), 'BOOKING', client, {})).status).toBe(503);
    expect(calls).toEqual([]);
  });
  it('forged signature: 401, nothing stored', async () => {
    const { client, calls } = fakeDb(() => ({ data: null, error: null }));
    expect((await handleOtaWebhook(otaReq(raw, 'sha256=' + '0'.repeat(64)), 'BOOKING', client, OTA_ENV)).status).toBe(401);
    expect(calls).toEqual([]);
  });
  it('stored (even if processing needs staff): 200 so the sender stops retrying', async () => {
    const { client, calls } = fakeDb(() => ({ data: { event_id: 1, inserted: true, status: 'NEEDS_ATTENTION', error: 'OTA_NO_ROOM: x' }, error: null }));
    const res = await handleOtaWebhook(otaReq(raw, sign(raw)), 'BOOKING', client, OTA_ENV);
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ fn: 'ota_ingest_event', args: { p_org_slug: 'axon-demo', p_property_code: 'AUR', p_channel: 'BOOKING', p_secret: OTA_ENV.OTA_SYNC_SECRET } });
  });
  it('database unreachable: 500 so the sender delivers again (idempotent)', async () => {
    const { client } = fakeDb(() => ({ data: null, error: { message: 'fetch failed' } }));
    expect((await handleOtaWebhook(otaReq(raw, sign(raw)), 'BOOKING', client, OTA_ENV)).status).toBe(500);
  });
  it('malformed JSON / invalid events: 400 (retrying cannot help)', async () => {
    const { client, calls } = fakeDb(() => ({ data: null, error: null }));
    expect((await handleOtaWebhook(otaReq('{oops', sign('{oops')), 'BOOKING', client, OTA_ENV)).status).toBe(400);
    const bad = JSON.stringify({ event_id: 'x y', kind: 'NEW', reservation_id: '1' });
    expect((await handleOtaWebhook(otaReq(bad, sign(bad)), 'BOOKING', client, OTA_ENV)).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it('oversized body: 413', async () => {
    const { client } = fakeDb(() => ({ data: null, error: null }));
    const big = 'x'.repeat(300_000);
    expect((await handleOtaWebhook(otaReq(big, sign(big)), 'BOOKING', client, OTA_ENV)).status).toBe(413);
  });
});

describe('channel sync run', () => {
  const db = (items: AriItem[]) => fakeDb((fn) => {
    if (fn === 'ota_retry_due') return { data: { retried: 1, succeeded: 1, purged: 0 }, error: null };
    if (fn === 'ota_claim_outbox') return { data: items, error: null };
    return { data: { updated: 1 }, error: null };
  });
  it('DEMO connection: recorded as DEMO, nothing sent even with credentials present', async () => {
    const f = vi.fn();
    const { client, calls } = db([item({ mode: 'DEMO' })]);
    const s = await runChannelSync(client, 'p', null, BKG_ENV, f as unknown as typeof fetch);
    expect(s).toMatchObject({ claimed: 1, demo: 1, sent: 0, retried: 1 });
    expect(f).not.toHaveBeenCalled();
    expect(calls.at(-1)).toMatchObject({ fn: 'ota_outbox_result', args: { p_results: [{ id: 1, result: 'DEMO' }] } });
  });
  it('LIVE with credentials: pushed and the result stored', async () => {
    const f = respond(200, '<ok/>');
    const { client, calls } = db([item(), item({ id: 2, channel: 'EXPEDIA', room_id: 'EXP-CDBL' })]);
    const s = await runChannelSync(client, 'p', 'secret', { ...BKG_ENV }, f as unknown as typeof fetch);
    expect(s).toMatchObject({ sent: 1, retry: 1 });   // Expedia has no credentials here → retried later, not dropped
    expect(f).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.fn === 'ota_outbox_result')).toHaveLength(2);
  });
  it('a failing database call aborts the run (no silent success)', async () => {
    const { client } = fakeDb(() => ({ data: null, error: { message: 'FORBIDDEN: x' } }));
    await expect(runChannelSync(client, 'p', 'bad', {})).rejects.toThrow('FORBIDDEN');
  });
});

describe('Meta webhook retries', () => {
  it('a message that could not be stored returns 500 so Meta sends it again', async () => {
    const env = { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', META_APP_SECRET: 'app-secret', META_VERIFY_TOKEN: 'v', INBOX_PROPERTY: 'axon-demo/AUR', INBOX_INGEST_SECRET: 'ingest-secret-xxxxxxxxxxxxxxxx' };
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: [], messages: [{ id: 'wamid.X', from: '905551112233', timestamp: '1', type: 'text', text: { body: 'hi' } }] } }] }] });
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
    const { client } = fakeDb((fn) => fn === 'inbox_public_property'
      ? { data: { property_id: 'p', name: 'A', timezone: 'Europe/Istanbul', currency: 'EUR', room_types: [] }, error: null }
      : { data: null, error: { message: 'connection refused' } });
    const req = new NextRequest('http://pms.test/api/webhooks/whatsapp', { method: 'POST', headers: { 'x-hub-signature-256': sig }, body: raw });
    expect((await handleWebhook(req, 'WHATSAPP', client, env)).status).toBe(500);
  });
});

describe('API surface', () => {
  it('only the intended paths skip the staff session', () => {
    expect(isPublicPath('/api/health')).toBe(true);
    expect(isPublicPath('/api/ota/webhook/booking', 'POST')).toBe(true);
    expect(isPublicPath('/api/ota/sync', 'GET')).toBe(true);
    expect(isPublicPath('/api/ota/sync', 'POST')).toBe(false);
    expect(isPublicPath('/api/ota', 'POST')).toBe(false);
    expect(isPublicPath('/api/reservations', 'POST')).toBe(false);
    expect(isPublicPath('/audit')).toBe(false);
  });

  it('every API route handler is either a known public entry point or wrapped in the authenticated, same-origin guard', () => {
    const root = join(__dirname, '..', 'src', 'app', 'api');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f === 'route.ts') files.push(p); } };
    walk(root);
    const PUBLIC = ['webchat/route.ts', 'webhooks/whatsapp/route.ts', 'webhooks/instagram/route.ts', 'ota/webhook/[channel]/route.ts', 'health/route.ts'];
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(root.length + 1).replaceAll('\\', '/');
      const src = readFileSync(f, 'utf8');
      const handlers = (src.match(/export (async )?function (GET|POST|PUT|PATCH|DELETE)\b/g) ?? []).length;
      const guarded = (src.match(/withReservationApi\(/g) ?? []).length;
      if (PUBLIC.includes(rel)) continue;
      if (rel === 'ota/sync/route.ts') {
        // GET = cron with a bearer secret compared in constant time; POST = staff button behind the guard
        if (!src.includes('cronAuthorized(req') || guarded < 1) offenders.push(rel);
        continue;
      }
      if (guarded < handlers) offenders.push(rel);
    }
    expect(files.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it('logs never carry personal data or secrets', () => {
    expect(redact({ email: 'a@b.c', guest: { name: 'X' }, nested: { phone: '1', token: 't', ok: 1 } })).toEqual({ email: '[redacted]', guest: '[redacted]', nested: { phone: '[redacted]', token: '[redacted]', ok: 1 } });
  });
});
