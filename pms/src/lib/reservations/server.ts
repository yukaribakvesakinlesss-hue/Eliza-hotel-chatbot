/** Shared plumbing for the reservation route handlers: demo guard, CSRF guard, auth, JSON. */
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { isDemoMode } from '@/lib/config';
import { getServerClient } from '@/lib/supabase/server';
import { mapDbError, type ApiError } from './api';
import { log } from '@/lib/log';

export const errorResponse = (e: ApiError) => NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status, headers: { 'Cache-Control': 'no-store' } });

export const DEMO_ERROR: ApiError = {
  status: 503,
  code: 'DEMO_MODE',
  message: 'Demo modunda rezervasyon kaydedilemez. Gerçek kayıt için Supabase bağlantısı gerekli.'
};

/** Cookie-authenticated API: only accept requests sent by our own pages (blocks cross-site form posts). */
export function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return req.headers.get('sec-fetch-site') !== 'cross-site';
  try {
    return new URL(origin).host === (req.headers.get('x-forwarded-host') ?? req.headers.get('host'));
  } catch {
    return false;
  }
}

export async function readJson(req: NextRequest): Promise<unknown> {
  const text = await req.text();
  if (text.length > 20_000) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type Handler = (supabase: SupabaseClient<Database>) => Promise<NextResponse>;

export async function withReservationApi(req: NextRequest, handler: Handler): Promise<NextResponse> {
  if (isDemoMode()) return errorResponse(DEMO_ERROR);
  if (!isSameOrigin(req)) return errorResponse({ status: 403, code: 'FORBIDDEN', message: 'İstek reddedildi.' });
  const supabase = await getServerClient();
  if (!supabase) return errorResponse(DEMO_ERROR);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return errorResponse({ status: 401, code: 'AUTH_REQUIRED', message: 'Oturum açmanız gerekiyor.' });
  try {
    return await handler(supabase);
  } catch (e) {
    log('error', 'api_unhandled', { path: req.nextUrl.pathname, message: e instanceof Error ? e.message.slice(0, 300) : String(e) });
    return errorResponse(mapDbError(null));
  }
}

/** Successful responses only after the database returned the saved row. */
export function rpcResult<T extends { id: string }>(data: T | null, error: { message: string; code?: string } | null, status = 200) {
  if (error) return errorResponse(mapDbError(error));
  if (!data?.id) return errorResponse(mapDbError(null));
  return NextResponse.json({ reservation: data }, { status, headers: { 'Cache-Control': 'no-store' } });
}
