/**
 * Inbound channel webhook (normalised JSON, see adapters.ts). Semantics for the sender's retries:
 *   200 → every event is stored (processed, or queued for retry / staff attention in the database)
 *   500 → at least one event could NOT be stored: send again (stored events are idempotent)
 *   400 / 401 / 413 → do not retry, the request itself is wrong
 *   503 → channel is DEMO on this server
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, OtaChannel } from '@/types/database';
import { otaWebhookTarget, parseOtaEvent, verifyOtaSignature } from './adapters';
import { log } from '@/lib/log';

type Env = Record<string, string | undefined>;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function handleOtaWebhook(req: NextRequest, channel: OtaChannel, supabase: SupabaseClient<Database> | null, env: Env = process.env) {
  const target = otaWebhookTarget(env);
  if (!supabase || !target || !env.OTA_SYNC_SECRET || !env.OTA_WEBHOOK_SECRET) {
    return json({ error: { code: 'CHANNEL_DEMO', message: `${channel} bağlı değil (DEMO); mesaj işlenmedi.` } }, 503);
  }
  const raw = await req.text();
  if (raw.length > 256_000) return json({ error: { code: 'TOO_LARGE' } }, 413);
  if (!verifyOtaSignature(raw, req.headers.get('x-axon-signature'), env.OTA_WEBHOOK_SECRET)) {
    log('warn', 'ota_webhook_bad_signature', { channel });
    return json({ error: { code: 'BAD_SIGNATURE' } }, 401);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: { code: 'BAD_JSON' } }, 400);
  }
  const list = Array.isArray(body) ? body : (body as { events?: unknown })?.events ?? [body];
  if (!Array.isArray(list) || list.length === 0 || list.length > 100) return json({ error: { code: 'VALIDATION', message: '1–100 events per request' } }, 400);

  const results: { event_id: string; stored: boolean; status?: string; error?: string }[] = [];
  let storeFailed = false;
  for (const item of list) {
    const parsed = parseOtaEvent(item);
    const id = (item as { event_id?: unknown })?.event_id;
    if (!parsed.ok) {
      results.push({ event_id: typeof id === 'string' ? id.slice(0, 80) : '?', stored: false, error: parsed.error });
      continue;
    }
    const { data, error } = await supabase.rpc('ota_ingest_event', {
      p_org_slug: target.orgSlug, p_property_code: target.propertyCode, p_channel: channel, p_secret: env.OTA_SYNC_SECRET,
      p_event: parsed.event as unknown as Record<string, unknown>
    });
    if (error || !data) {
      // FORBIDDEN (channel in DEMO, wrong secret) is a configuration problem, not worth a retry storm, but still unstored
      storeFailed = storeFailed || !error?.message.startsWith('FORBIDDEN');
      results.push({ event_id: parsed.event.event_id, stored: false, error: error?.message.split(':')[0] ?? 'INTERNAL' });
      log('error', 'ota_ingest_failed', { channel, eventId: parsed.event.event_id, code: error?.message.split(':')[0] });
      continue;
    }
    results.push({ event_id: parsed.event.event_id, stored: true, status: data.status });
    if (data.status === 'NEEDS_ATTENTION') log('warn', 'ota_event_needs_attention', { channel, eventId: parsed.event.event_id, error: data.error?.split(':')[0] });
  }
  const invalid = results.some((r) => !r.stored && !storeFailed && r.error && !r.error.startsWith('FORBIDDEN'));
  if (storeFailed) return json({ ok: false, results }, 500);
  if (results.every((r) => !r.stored)) return json({ ok: false, results }, invalid ? 400 : 403);
  return json({ ok: true, results });
}
