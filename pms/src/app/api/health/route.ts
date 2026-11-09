import { NextResponse } from 'next/server';
import { getAnonClient } from '@/lib/supabase/anon';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

/** GET /api/health — for uptime monitors. 200 when the database answers, 503 otherwise. No data, no secrets. */
export async function GET() {
  const headers = { 'Cache-Control': 'no-store' };
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
  const supabase = getAnonClient();
  if (!supabase) return NextResponse.json({ ok: true, mode: 'DEMO', database: 'not configured', commit }, { headers });
  const t = Date.now();
  const { data, error } = await supabase.rpc('health_check');
  const dbMs = Date.now() - t;
  if (error || !data?.ok) {
    log('error', 'health_db_down', { message: error?.message?.slice(0, 200) });
    return NextResponse.json({ ok: false, database: 'unreachable', commit }, { status: 503, headers });
  }
  return NextResponse.json({ ok: true, database: 'ok', db_ms: dbMs, schema: data.schema, commit }, { headers });
}
