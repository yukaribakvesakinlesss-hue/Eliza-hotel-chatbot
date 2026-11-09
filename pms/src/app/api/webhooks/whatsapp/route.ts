import type { NextRequest } from 'next/server';
import { handleVerify, handleWebhook } from '@/lib/inbox/webhook';
import { getAnonClient } from '@/lib/supabase/anon';

export const dynamic = 'force-dynamic';

/** Meta webhook verification (hub.challenge). */
export function GET(req: NextRequest) {
  return handleVerify(req, 'WHATSAPP');
}

/** Incoming WHATSAPP messages (signature-checked, idempotent). DEMO (503) until credentials are configured. */
export function POST(req: NextRequest) {
  return handleWebhook(req, 'WHATSAPP', getAnonClient());
}
