/**
 * Channel sync run (server-only): retry due inbound events, push due availability / rates,
 * record every result so failed pushes are retried with backoff by the database queue.
 * Used by the cron worker (anon key + property secret) and by managers ("Senkronize et").
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AriItem, Database, OtaChannel } from '@/types/database';
import { otaAdapterFor, type PushResult } from './adapters';
import { adapterFor, webhookTarget } from '@/lib/inbox/adapters';
import { log } from '@/lib/log';

type Client = SupabaseClient<Database>;
type Env = Record<string, string | undefined>;
const BATCH = 100;

export type SyncSummary = {
  retried: number; retriedOk: number; claimed: number;
  sent: number; demo: number; retry: number; rejected: number; errors: string[];
};

export async function runChannelSync(supabase: Client, propertyId: string, secret: string | null, env: Env = process.env,
  fetcher: typeof fetch = fetch): Promise<SyncSummary> {
  const s: SyncSummary = { retried: 0, retriedOk: 0, claimed: 0, sent: 0, demo: 0, retry: 0, rejected: 0, errors: [] };

  const retry = await supabase.rpc('ota_retry_due', { p_property_id: propertyId, p_secret: secret });
  if (retry.error) throw new Error(retry.error.message);
  s.retried = retry.data?.retried ?? 0;
  s.retriedOk = retry.data?.succeeded ?? 0;

  const claim = await supabase.rpc('ota_claim_outbox', { p_property_id: propertyId, p_secret: secret, p_limit: 1000 });
  if (claim.error) throw new Error(claim.error.message);
  const items = (claim.data ?? []) as AriItem[];
  s.claimed = items.length;

  const byChannel = new Map<OtaChannel, AriItem[]>();
  for (const i of items) byChannel.set(i.channel, [...(byChannel.get(i.channel) ?? []), i]);

  for (const [channel, list] of byChannel) {
    const adapter = otaAdapterFor(channel, env, fetcher);
    for (let k = 0; k < list.length; k += BATCH) {
      const batch = list.slice(k, k + BATCH);
      let results: PushResult[];
      if (batch[0]!.mode !== 'LIVE') {
        // the database decides: a DEMO connection is never sent, even if credentials exist
        results = batch.map((i) => ({ id: i.id, result: 'DEMO', available: i.closed ? 0 : i.available, rate: i.rate, closed: i.closed }));
      } else if (!adapter.live) {
        results = batch.map((i) => ({ id: i.id, result: 'RETRY', error: `${channel} LIVE but server credentials are missing` }));
      } else {
        results = await adapter.pushAri(batch[0]!.hotel_id, batch);
      }
      for (const r of results) {
        if (r.result === 'SENT') s.sent++;
        else if (r.result === 'DEMO') s.demo++;
        else if (r.result === 'RETRY') s.retry++;
        else s.rejected++;
        if (r.error && s.errors.length < 5 && !s.errors.includes(r.error)) s.errors.push(r.error);
      }
      const saved = await supabase.rpc('ota_outbox_result', { p_property_id: propertyId, p_secret: secret, p_results: results as unknown as Record<string, unknown>[] });
      if (saved.error) throw new Error(saved.error.message);
    }
  }
  if (s.retry || s.rejected) log('warn', 'ota_push_problems', { propertyId, retry: s.retry, rejected: s.rejected, errors: s.errors });
  return s;
}

/** Re-sends failed WhatsApp / Instagram replies (LIVE channels only). */
export async function redeliverInbox(supabase: Client, env: Env = process.env, fetcher: typeof fetch = fetch) {
  const target = webhookTarget(env);
  const secret = env.INBOX_INGEST_SECRET;
  const out = { attempted: 0, sent: 0, failed: 0 };
  if (!target || !secret) return out;
  for (const channel of ['WHATSAPP', 'INSTAGRAM'] as const) {
    const adapter = adapterFor(channel, env, fetcher);
    if (!adapter.live) continue;
    const due = await supabase.rpc('inbox_due_deliveries', { p_org_slug: target.orgSlug, p_property_code: target.propertyCode, p_channel: channel, p_secret: secret });
    if (due.error) {
      if (!due.error.message.startsWith('FORBIDDEN')) log('warn', 'inbox_due_failed', { channel, message: due.error.message });
      continue;
    }
    for (const m of due.data ?? []) {
      out.attempted++;
      const r = await adapter.send(m.thread_id, m.body);
      await supabase.rpc('inbox_set_delivery', { p_message_id: m.id, p_status: r.status, p_token: secret });
      if (r.status === 'SENT') out.sent++;
      else out.failed++;
    }
  }
  return out;
}
