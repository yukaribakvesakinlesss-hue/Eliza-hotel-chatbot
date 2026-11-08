import { NextResponse, type NextRequest } from 'next/server';
import { getAnonClient } from '@/lib/supabase/anon';
import { assistantReply, lastAssistantType, publicProperty } from '@/lib/inbox/service';
import { mapDbError } from '@/lib/reservations/api';
import { todayIn } from '@/lib/reservations/dates';
import { readJson } from '@/lib/reservations/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CODE = /^[A-Za-z0-9]{2,12}$/;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

// per-IP limiter for the public endpoint (the database also limits per conversation)
const hits = new Map<string, { n: number; reset: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) {
    if (hits.size > 5000) hits.clear();
    hits.set(ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  h.n++;
  return h.n > 40;
}

/**
 * Public web chat for guests.
 *   { action: 'start', org, code, name? }                               → conversation + token
 *   { action: 'send', org, code, conversationId, token, body, clientMessageId } → stores, then the database answers
 *   { action: 'poll', conversationId, token, afterId }                  → new messages
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  if (limited(ip)) return fail(429, 'RATE_LIMIT', 'Çok fazla istek. Lütfen biraz bekleyin.');
  const supabase = getAnonClient();
  if (!supabase) return fail(503, 'DEMO_MODE', 'Demo modu: sohbet veritabanına bağlı değil; müsaitlik ve fiyat doğrulanamaz.');
  const b = (await readJson(req)) as Record<string, unknown> | null;
  if (!b) return fail(400, 'VALIDATION', 'Geçersiz istek.');

  if (b.action === 'start') {
    if (typeof b.org !== 'string' || !SLUG.test(b.org) || typeof b.code !== 'string' || !CODE.test(b.code)) return fail(400, 'VALIDATION', 'Otel bilgisi geçersiz.');
    const { data, error } = await supabase.rpc('webchat_start', { p_org_slug: b.org, p_property_code: b.code, p_name: typeof b.name === 'string' ? b.name.slice(0, 120) : null });
    if (error || !data) return fail(mapDbError(error).status, mapDbError(error).code, mapDbError(error).message);
    return json(data);
  }

  if (typeof b.conversationId !== 'string' || !UUID.test(b.conversationId) || typeof b.token !== 'string' || !/^[0-9a-f]{48}$/.test(b.token)) {
    return fail(403, 'FORBIDDEN', 'Sohbet oturumu geçersiz.');
  }

  if (b.action === 'poll') {
    const after = typeof b.afterId === 'number' && Number.isInteger(b.afterId) ? b.afterId : 0;
    const { data, error } = await supabase.rpc('webchat_messages', { p_conversation_id: b.conversationId, p_token: b.token, p_after_id: after });
    if (error) return fail(mapDbError(error).status, mapDbError(error).code, mapDbError(error).message);
    return json({ messages: data ?? [] });
  }

  if (b.action === 'send') {
    if (typeof b.body !== 'string' || !b.body.trim() || b.body.length > 2000) return fail(400, 'VALIDATION', 'Mesaj 1–2000 karakter olmalı.');
    if (typeof b.clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(b.clientMessageId)) return fail(400, 'VALIDATION', 'Mesaj kimliği eksik.');
    if (typeof b.org !== 'string' || typeof b.code !== 'string') return fail(400, 'VALIDATION', 'Otel bilgisi geçersiz.');
    const sent = await supabase.rpc('webchat_send', { p_conversation_id: b.conversationId, p_token: b.token, p_body: b.body, p_client_message_id: b.clientMessageId });
    if (sent.error) return fail(mapDbError(sent.error).status, mapDbError(sent.error).code, mapDbError(sent.error).message);
    // a retried send (same client id) is not answered twice
    if (sent.data?.inserted) {
      const property = await publicProperty(supabase, b.org, b.code);
      if (property) {
        try {
          await assistantReply(supabase, {
            conversationId: b.conversationId, token: b.token, text: b.body, today: todayIn(property.timezone), roomTypes: property.room_types,
            lastAssistantType: await lastAssistantType(supabase, b.conversationId, b.token)
          });
        } catch (e) {
          console.error('assistant', e);
        }
      }
    }
    return json({ ok: true, inserted: Boolean(sent.data?.inserted) });
  }
  return fail(400, 'VALIDATION', 'Bilinmeyen işlem.');
}
