import { NextResponse, type NextRequest } from 'next/server';
import { handleOtaWebhook } from '@/lib/ota/webhook';
import { getAnonClient } from '@/lib/supabase/anon';

export const dynamic = 'force-dynamic';

/** POST /api/ota/webhook/booking | expedia — signed, normalised reservation events from the channel manager. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ channel: string }> }) {
  const { channel } = await ctx.params;
  const code = channel.toUpperCase();
  if (code !== 'BOOKING' && code !== 'EXPEDIA') return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  return handleOtaWebhook(req, code, getAnonClient());
}
