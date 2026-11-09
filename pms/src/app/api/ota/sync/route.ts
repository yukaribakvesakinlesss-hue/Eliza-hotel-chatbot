import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getAnonClient } from '@/lib/supabase/anon';
import { otaWebhookTarget } from '@/lib/ota/adapters';
import { redeliverInbox, runChannelSync } from '@/lib/ota/sync';
import { errorResponse, readJson, withReservationApi } from '@/lib/reservations/server';
import { mapDbError } from '@/lib/reservations/api';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function cronAuthorized(req: NextRequest, secret: string | undefined): boolean {
  if (!secret || secret.length < 24) return false;
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** GET: scheduled worker (Vercel Cron sends Authorization: Bearer CRON_SECRET). */
export async function GET(req: NextRequest) {
  const env = process.env;
  const supabase = getAnonClient();
  const target = otaWebhookTarget(env);
  if (!supabase || !target || !env.OTA_SYNC_SECRET || !env.CRON_SECRET) {
    return json({ error: { code: 'CHANNEL_DEMO', message: 'Kanal senkronizasyonu yapılandırılmadı (DEMO).' } }, 503);
  }
  if (!cronAuthorized(req, env.CRON_SECRET)) return json({ error: { code: 'FORBIDDEN' } }, 401);
  const started = Date.now();
  try {
    const ctx = await supabase.rpc('ota_worker_context', { p_org_slug: target.orgSlug, p_property_code: target.propertyCode, p_secret: env.OTA_SYNC_SECRET });
    if (ctx.error || !ctx.data) throw new Error(ctx.error?.message ?? 'no context');
    const ota = await runChannelSync(supabase, ctx.data.property_id, env.OTA_SYNC_SECRET);
    const inbox = await redeliverInbox(supabase);
    log('info', 'sync_run', { trigger: 'cron', ms: Date.now() - started, ...ota, inbox });
    return json({ ok: true, ota, inbox });
  } catch (e) {
    log('error', 'sync_run_failed', { trigger: 'cron', message: e instanceof Error ? e.message : String(e) });
    return json({ error: { code: 'SYNC_FAILED' } }, 500);
  }
}

/** POST { propertyId }: "Senkronize et" button (owners and managers, checked in the database). */
export async function POST(req: NextRequest) {
  return withReservationApi(req, async (supabase) => {
    const b = (await readJson(req)) as { propertyId?: unknown } | null;
    if (typeof b?.propertyId !== 'string' || !UUID.test(b.propertyId)) return errorResponse({ status: 400, code: 'VALIDATION', message: 'Tesis seçilmeli.' });
    try {
      const ota = await runChannelSync(supabase, b.propertyId, null);
      log('info', 'sync_run', { trigger: 'manual', ...ota });
      return json({ ok: true, ota });
    } catch (e) {
      return errorResponse(mapDbError({ message: e instanceof Error ? e.message : '' }));
    }
  });
}
