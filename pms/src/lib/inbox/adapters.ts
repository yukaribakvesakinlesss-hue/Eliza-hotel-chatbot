/**
 * Channel adapters · one interface for WhatsApp Cloud API, Instagram Messaging and web chat.
 * Without credentials an adapter is in DEMO mode: it never calls an external API and reports DEMO_NOT_SENT.
 * Server-only (reads secrets from the environment).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type ChannelCode = 'WHATSAPP' | 'INSTAGRAM' | 'WEBCHAT';
export type InboundMessage = { externalId: string; threadId: string; contactName: string | null; text: string; timestamp: number };
export type SendResult = { status: 'SENT' | 'FAILED' | 'DEMO_NOT_SENT' | 'DELIVERED'; externalId?: string; error?: string };
type Fetch = typeof fetch;

export interface ChannelAdapter {
  readonly channel: ChannelCode;
  /** true when real credentials are configured; false = DEMO */
  readonly live: boolean;
  /** Meta's GET verification handshake; returns the challenge to echo or null */
  verifyChallenge(params: URLSearchParams): string | null;
  /** validates X-Hub-Signature-256 against the raw body */
  verifySignature(rawBody: string, signatureHeader: string | null): boolean;
  parse(body: unknown): InboundMessage[];
  send(threadId: string, text: string): Promise<SendResult>;
}

const GRAPH = 'https://graph.facebook.com/v21.0';

export function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string | undefined): boolean {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const given = header.slice(7);
  if (given.length !== expected.length || !/^[0-9a-f]+$/i.test(given)) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

function challenge(params: URLSearchParams, verifyToken: string | undefined): string | null {
  if (!verifyToken) return null;
  return params.get('hub.mode') === 'subscribe' && params.get('hub.verify_token') === verifyToken ? params.get('hub.challenge') : null;
}

type Env = Record<string, string | undefined>;

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'WHATSAPP' as const;
  readonly live: boolean;
  constructor(private env: Env = process.env, private fetcher: Fetch = fetch) {
    this.live = Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.META_APP_SECRET && env.META_VERIFY_TOKEN);
  }
  verifyChallenge(params: URLSearchParams) {
    return challenge(params, this.env.META_VERIFY_TOKEN);
  }
  verifySignature(raw: string, header: string | null) {
    return verifyMetaSignature(raw, header, this.env.META_APP_SECRET);
  }
  parse(body: unknown): InboundMessage[] {
    const out: InboundMessage[] = [];
    const b = body as { object?: string; entry?: { changes?: { value?: { contacts?: { wa_id?: string; profile?: { name?: string } }[]; messages?: { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } } }[] } }[] }[] };
    if (b?.object !== 'whatsapp_business_account') return out;
    for (const entry of b.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value;
        for (const m of v?.messages ?? []) {
          if (!m.id || !m.from) continue;
          const name = v?.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
          const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? `[${m.type ?? 'medya'}]`;
          out.push({ externalId: m.id, threadId: m.from, contactName: name, text, timestamp: Number(m.timestamp ?? 0) });
        }
      }
    }
    return out;
  }
  async send(to: string, text: string): Promise<SendResult> {
    if (!this.live) return { status: 'DEMO_NOT_SENT' };
    try {
      const res = await this.fetcher(`${GRAPH}/${this.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body: text.slice(0, 4096) } })
      });
      const json = (await res.json().catch(() => null)) as { messages?: { id?: string }[]; error?: { message?: string } } | null;
      return res.ok ? { status: 'SENT', externalId: json?.messages?.[0]?.id } : { status: 'FAILED', error: json?.error?.message ?? `HTTP ${res.status}` };
    } catch (e) {
      return { status: 'FAILED', error: e instanceof Error ? e.message : 'network' };
    }
  }
}

export class InstagramAdapter implements ChannelAdapter {
  readonly channel = 'INSTAGRAM' as const;
  readonly live: boolean;
  constructor(private env: Env = process.env, private fetcher: Fetch = fetch) {
    this.live = Boolean(env.INSTAGRAM_PAGE_TOKEN && env.META_APP_SECRET && env.META_VERIFY_TOKEN);
  }
  verifyChallenge(params: URLSearchParams) {
    return challenge(params, this.env.META_VERIFY_TOKEN);
  }
  verifySignature(raw: string, header: string | null) {
    return verifyMetaSignature(raw, header, this.env.META_APP_SECRET);
  }
  parse(body: unknown): InboundMessage[] {
    const out: InboundMessage[] = [];
    const b = body as { object?: string; entry?: { id?: string; messaging?: { sender?: { id?: string }; timestamp?: number; message?: { mid?: string; text?: string; is_echo?: boolean } }[] }[] };
    if (b?.object !== 'instagram') return out;
    for (const entry of b.entry ?? []) {
      for (const ev of entry.messaging ?? []) {
        const m = ev.message;
        if (!m?.mid || !ev.sender?.id || m.is_echo) continue; // echoes are our own messages
        out.push({ externalId: m.mid, threadId: ev.sender.id, contactName: null, text: m.text ?? '[medya]', timestamp: Number(ev.timestamp ?? 0) });
      }
    }
    return out;
  }
  async send(recipientId: string, text: string): Promise<SendResult> {
    if (!this.live) return { status: 'DEMO_NOT_SENT' };
    try {
      const res = await this.fetcher(`${GRAPH}/me/messages?access_token=${encodeURIComponent(this.env.INSTAGRAM_PAGE_TOKEN!)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text: text.slice(0, 1000) } })
      });
      const json = (await res.json().catch(() => null)) as { message_id?: string; error?: { message?: string } } | null;
      return res.ok ? { status: 'SENT', externalId: json?.message_id } : { status: 'FAILED', error: json?.error?.message ?? `HTTP ${res.status}` };
    } catch (e) {
      return { status: 'FAILED', error: e instanceof Error ? e.message : 'network' };
    }
  }
}

/** Web chat: the guest's browser polls the conversation, so "sending" is storing. */
export class WebChatAdapter implements ChannelAdapter {
  readonly channel = 'WEBCHAT' as const;
  readonly live = true;
  verifyChallenge() {
    return null;
  }
  verifySignature() {
    return true;
  }
  parse(): InboundMessage[] {
    return [];
  }
  async send(): Promise<SendResult> {
    return { status: 'DELIVERED' };
  }
}

export function adapterFor(channel: ChannelCode, env: Env = process.env, fetcher: Fetch = fetch): ChannelAdapter {
  if (channel === 'WHATSAPP') return new WhatsAppAdapter(env, fetcher);
  if (channel === 'INSTAGRAM') return new InstagramAdapter(env, fetcher);
  return new WebChatAdapter();
}

/** Which property a webhook belongs to (one hotel per deployment for now): INBOX_PROPERTY = "org-slug/CODE". */
export function webhookTarget(env: Env = process.env): { orgSlug: string; propertyCode: string } | null {
  const [orgSlug, propertyCode] = (env.INBOX_PROPERTY ?? '').split('/');
  return orgSlug && propertyCode ? { orgSlug, propertyCode } : null;
}
