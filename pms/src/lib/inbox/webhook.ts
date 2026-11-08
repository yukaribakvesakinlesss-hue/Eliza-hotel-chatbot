/** Shared webhook handling for Meta channels (WhatsApp Cloud API, Instagram Messaging). */
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { adapterFor, webhookTarget, type ChannelCode } from './adapters';
import { assistantReply, deliver, publicProperty } from './service';
import { todayIn } from '@/lib/reservations/dates';

type Env = Record<string, string | undefined>;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export function handleVerify(req: NextRequest, channel: ChannelCode, env: Env = process.env) {
  const adapter = adapterFor(channel, env);
  if (!adapter.live) return json({ error: { code: 'CHANNEL_DEMO', message: `${channel} bağlı değil (DEMO).` } }, 503);
  const c = adapter.verifyChallenge(req.nextUrl.searchParams);
  return c ? new NextResponse(c, { status: 200, headers: { 'Content-Type': 'text/plain' } }) : json({ error: { code: 'FORBIDDEN' } }, 403);
}

/**
 * POST: verify the Meta signature on the raw body, store each message once (idempotent on the
 * channel message id), let the database answer new messages, deliver the answer.
 * A retried webhook (same message id) is acknowledged but neither stored nor answered again.
 */
export async function handleWebhook(req: NextRequest, channel: ChannelCode, supabase: SupabaseClient<Database> | null, env: Env = process.env) {
  const adapter = adapterFor(channel, env);
  const target = webhookTarget(env);
  if (!adapter.live || !supabase || !target || !env.INBOX_INGEST_SECRET) {
    return json({ error: { code: 'CHANNEL_DEMO', message: `${channel} bağlı değil (DEMO); mesaj işlenmedi.` } }, 503);
  }
  const raw = await req.text();
  if (raw.length > 512_000) return json({ error: { code: 'TOO_LARGE' } }, 413);
  if (!adapter.verifySignature(raw, req.headers.get('x-hub-signature-256'))) return json({ error: { code: 'BAD_SIGNATURE' } }, 401);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: { code: 'BAD_JSON' } }, 400);
  }
  const property = await publicProperty(supabase, target.orgSlug, target.propertyCode);
  if (!property) return json({ error: { code: 'NOT_FOUND' } }, 404);

  const results: { id: string; inserted: boolean; replied: boolean; delivery?: string }[] = [];
  for (const m of adapter.parse(body)) {
    const { data, error } = await supabase.rpc('inbox_ingest', {
      p_org_slug: target.orgSlug, p_property_code: target.propertyCode, p_channel: channel, p_secret: env.INBOX_INGEST_SECRET,
      p_external_message_id: m.externalId, p_thread_id: m.threadId, p_contact_name: m.contactName, p_body: m.text
    });
    if (error || !data) {
      results.push({ id: m.externalId, inserted: false, replied: false });
      continue;
    }
    if (!data.inserted || data.status !== 'AI') {
      results.push({ id: m.externalId, inserted: data.inserted, replied: false });
      continue;
    }
    const reply = await assistantReply(supabase, {
      conversationId: data.conversation_id, token: env.INBOX_INGEST_SECRET, text: m.text, today: todayIn(property.timezone),
      roomTypes: property.room_types, lastAssistantType: data.last_assistant_type
    }).catch(() => null);
    const delivery = reply ? await deliver(supabase, reply, channel, m.threadId, env.INBOX_INGEST_SECRET, env) : undefined;
    results.push({ id: m.externalId, inserted: true, replied: Boolean(reply), delivery });
  }
  // Meta retries on non-2xx; duplicates are already harmless, so always acknowledge a verified delivery
  return json({ ok: true, results });
}
