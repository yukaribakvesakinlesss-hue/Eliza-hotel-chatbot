import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { InstagramAdapter, WhatsAppAdapter, verifyMetaSignature } from '@/lib/inbox/adapters';
import { handleVerify, handleWebhook } from '@/lib/inbox/webhook';
import { maskEmail, maskPhone, parseGuestChanges } from '@/lib/crm/api';

const SECRET = 'app-secret';
const LIVE_ENV = {
  WHATSAPP_TOKEN: 'wa-token', WHATSAPP_PHONE_NUMBER_ID: '1234', META_APP_SECRET: SECRET, META_VERIFY_TOKEN: 'verify-me',
  INSTAGRAM_PAGE_TOKEN: 'ig-token', INBOX_PROPERTY: 'axon-demo/AUR', INBOX_INGEST_SECRET: 'ingest-secret-xxxxxxxxxxxxxxxx'
};
const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
const WA_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '905551112233', profile: { name: 'Ali Veli' } }],
    messages: [
      { id: 'wamid.A', from: '905551112233', timestamp: '1731000000', type: 'text', text: { body: '12-15 Aralık 2 kişi müsait mi?' } },
      { id: 'wamid.B', from: '905551112233', timestamp: '1731000001', type: 'image' }
    ]
  } }] }]
};

describe('Meta signature', () => {
  it('accepts the exact HMAC and rejects anything else', () => {
    const raw = JSON.stringify(WA_PAYLOAD);
    expect(verifyMetaSignature(raw, sign(raw), SECRET)).toBe(true);
    expect(verifyMetaSignature(raw + ' ', sign(raw), SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, 'sha256=deadbeef', SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, null, SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, sign(raw), undefined)).toBe(false);
  });
});

describe('adapters', () => {
  it('WhatsApp: parses text and media messages with the contact name', () => {
    const msgs = new WhatsAppAdapter({}).parse(WA_PAYLOAD);
    expect(msgs).toEqual([
      { externalId: 'wamid.A', threadId: '905551112233', contactName: 'Ali Veli', text: '12-15 Aralık 2 kişi müsait mi?', timestamp: 1731000000 },
      { externalId: 'wamid.B', threadId: '905551112233', contactName: 'Ali Veli', text: '[image]', timestamp: 1731000001 }
    ]);
    expect(new WhatsAppAdapter({}).parse({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{}] } }] }] })).toEqual([]);
  });
  it('Instagram: parses messages and skips echoes of our own replies', () => {
    const msgs = new InstagramAdapter({}).parse({ object: 'instagram', entry: [{ messaging: [
      { sender: { id: 'u1' }, timestamp: 5, message: { mid: 'm1', text: 'Kahvaltı dahil mi?' } },
      { sender: { id: 'page' }, timestamp: 6, message: { mid: 'm2', text: 'echo', is_echo: true } }
    ] }] });
    expect(msgs).toEqual([{ externalId: 'm1', threadId: 'u1', contactName: null, text: 'Kahvaltı dahil mi?', timestamp: 5 }]);
  });
  it('DEMO: without credentials nothing is sent to Meta', async () => {
    const fetcher = vi.fn();
    const r = await new WhatsAppAdapter({}, fetcher as unknown as typeof fetch).send('905551112233', 'hi');
    expect(r.status).toBe('DEMO_NOT_SENT');
    expect(fetcher).not.toHaveBeenCalled();
    expect(new InstagramAdapter({}).live).toBe(false);
  });
  it('LIVE: WhatsApp Cloud API request shape and result', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }] }), { status: 200 }));
    const r = await new WhatsAppAdapter(LIVE_ENV, fetcher as unknown as typeof fetch).send('905551112233', 'Merhaba');
    expect(r).toEqual({ status: 'SENT', externalId: 'wamid.OUT' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v21.0/1234/messages');
    expect(JSON.parse(init.body)).toMatchObject({ messaging_product: 'whatsapp', to: '905551112233', text: { body: 'Merhaba' } });
    const failed = await new WhatsAppAdapter(LIVE_ENV, vi.fn().mockResolvedValue(new Response('{"error":{"message":"bad"}}', { status: 400 })) as unknown as typeof fetch).send('1', 'x');
    expect(failed).toEqual({ status: 'FAILED', error: 'bad' });
  });
});

function fakeSupabase(ingest: { inserted: boolean; status?: string }) {
  const calls: string[] = [];
  const rpc = vi.fn(async (fn: string) => {
    calls.push(fn);
    if (fn === 'inbox_public_property') return { data: { property_id: 'p', name: 'Aurelia', timezone: 'Europe/Istanbul', currency: 'EUR', room_types: [] }, error: null };
    if (fn === 'inbox_ingest') return { data: { conversation_id: 'c1', inserted: ingest.inserted, message_id: 1, status: ingest.status ?? 'AI', last_assistant_type: null }, error: null };
    if (fn === 'inbox_assistant_turn') return { data: { replied: true, message: { id: 9, body: 'Müsaitlik…', delivery_status: 'PENDING' } }, error: null };
    return { data: {}, error: null };
  });
  return { client: { rpc } as never, calls };
}
const webhookReq = (raw: string, signature: string | null) => new NextRequest('http://pms.test/api/webhooks/whatsapp', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) }, body: raw
});

describe('webhook handling', () => {
  afterEach(() => vi.unstubAllGlobals());
  const raw = JSON.stringify({ ...WA_PAYLOAD, entry: [{ changes: [{ value: { ...WA_PAYLOAD.entry[0]!.changes[0]!.value, messages: [WA_PAYLOAD.entry[0]!.changes[0]!.value.messages[0]] } }] }] });

  it('DEMO: 503 and nothing stored when credentials are missing', async () => {
    const { client, calls } = fakeSupabase({ inserted: true });
    const res = await handleWebhook(webhookReq(raw, sign(raw)), 'WHATSAPP', client, {});
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('CHANNEL_DEMO');
    expect(calls).toEqual([]);
  });
  it('rejects a forged signature', async () => {
    const { client, calls } = fakeSupabase({ inserted: true });
    const res = await handleWebhook(webhookReq(raw, 'sha256=' + '0'.repeat(64)), 'WHATSAPP', client, LIVE_ENV);
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
  it('new message: stored, answered by the database, delivered through the adapter', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const { client, calls } = fakeSupabase({ inserted: true });
    const res = await handleWebhook(webhookReq(raw, sign(raw)), 'WHATSAPP', client, LIVE_ENV);
    expect(res.status).toBe(200);
    expect(calls).toEqual(['inbox_public_property', 'inbox_ingest', 'inbox_assistant_turn', 'inbox_set_delivery']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await res.json()).results[0]).toMatchObject({ inserted: true, replied: true, delivery: 'SENT' });
  });
  it('retried webhook (same message id): acknowledged, not answered or sent again', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { client, calls } = fakeSupabase({ inserted: false });
    const res = await handleWebhook(webhookReq(raw, sign(raw)), 'WHATSAPP', client, LIVE_ENV);
    expect(res.status).toBe(200);
    expect(calls).toEqual(['inbox_public_property', 'inbox_ingest']);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('a conversation taken over by staff gets no AI reply', async () => {
    const { client, calls } = fakeSupabase({ inserted: true, status: 'HUMAN' });
    await handleWebhook(webhookReq(raw, sign(raw)), 'WHATSAPP', client, LIVE_ENV);
    expect(calls).not.toContain('inbox_assistant_turn');
  });
  it('verification handshake', () => {
    const ok = handleVerify(new NextRequest('http://pms.test/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42'), 'WHATSAPP', LIVE_ENV);
    expect(ok.status).toBe(200);
    expect(handleVerify(new NextRequest('http://pms.test/x?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42'), 'WHATSAPP', LIVE_ENV).status).toBe(403);
    expect(handleVerify(new NextRequest('http://pms.test/x'), 'WHATSAPP', {}).status).toBe(503);
  });
});

describe('guest CRM helpers', () => {
  it('only known profile fields; VIP 0–3', () => {
    expect(parseGuestChanges({ vip_level: 2 }).ok).toBe(true);
    expect(parseGuestChanges({ vip_level: 5 }).ok).toBe(false);
    expect(parseGuestChanges({ is_admin: true }).ok).toBe(false);
    expect(parseGuestChanges({ email: 'not-mail' }).ok).toBe(false);
    expect(parseGuestChanges({}).ok).toBe(false);
  });
  it('lists mask contact data', () => {
    expect(maskEmail('elif.kaya@example.com')).toBe('e••••@example.com');
    expect(maskPhone('+90 532 111 22 33')).toBe('•••• 2233');
    expect(maskEmail(null)).toBe('');
  });
});
