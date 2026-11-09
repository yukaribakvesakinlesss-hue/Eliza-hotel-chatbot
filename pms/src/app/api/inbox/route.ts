import { NextResponse, type NextRequest } from 'next/server';
import { mapDbError } from '@/lib/reservations/api';
import { errorResponse, readJson, withReservationApi } from '@/lib/reservations/server';
import { isIsoDate, todayIn } from '@/lib/reservations/dates';
import { assistantReply, deliver, lastAssistantType } from '@/lib/inbox/service';
import type { InboxChannel } from '@/types/database';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = (body: unknown) => NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string) => errorResponse({ status: 400, code: 'VALIDATION', message });
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

/**
 * Staff inbox actions (front desk and up; every rule is re-checked in the database).
 *   simulate · reply · status · read · link_guest · confirm_request · decline_request · availability · channel
 */
export async function POST(req: NextRequest) {
  return withReservationApi(req, async (supabase) => {
    const b = (await readJson(req)) as Record<string, unknown> | null;
    if (!b || typeof b.action !== 'string') return bad('Geçersiz istek.');
    const err = (e: { message: string } | null) => errorResponse(mapDbError(e));

    switch (b.action) {
      case 'simulate': {
        // DEMO channels only: inject a guest message as if it came from WhatsApp / Instagram, then let the assistant answer
        const channel = b.channel === 'WHATSAPP' || b.channel === 'INSTAGRAM' ? (b.channel as InboxChannel) : null;
        const body = str(b.body, 2000);
        const thread = str(b.threadId, 80);
        if (typeof b.propertyId !== 'string' || !UUID.test(b.propertyId) || !channel || !body || !thread) return bad('Simülasyon bilgileri eksik.');
        const extId = str(b.clientMessageId, 80) ?? crypto.randomUUID();
        const { data, error } = await supabase.rpc('inbox_simulate_inbound', {
          p_property_id: b.propertyId, p_channel: channel, p_thread_id: thread, p_contact_name: str(b.name, 120), p_body: body, p_external_message_id: extId
        });
        if (error || !data) return err(error);
        let reply = null;
        if (data.inserted && data.status === 'AI') {
          const [{ data: prop }, { data: rts }] = await Promise.all([
            supabase.from('properties').select('timezone').eq('id', b.propertyId).single(),
            supabase.from('room_types').select('code, name').eq('property_id', b.propertyId)
          ]);
          reply = await assistantReply(supabase, {
            conversationId: data.conversation_id, token: null, text: body, today: todayIn(prop?.timezone ?? 'Europe/Istanbul'),
            roomTypes: rts ?? [], lastAssistantType: await lastAssistantType(supabase, data.conversation_id, null)
          });
        }
        return ok({ conversationId: data.conversation_id, inserted: data.inserted, reply });
      }
      case 'reply': {
        const body = str(b.body, 4000);
        if (typeof b.conversationId !== 'string' || !UUID.test(b.conversationId) || !body) return bad('Mesaj boş olamaz.');
        const { data, error } = await supabase.rpc('inbox_send_staff_message', {
          p_conversation_id: b.conversationId, p_body: body, p_client_message_id: str(b.clientMessageId, 80)
        });
        if (error || !data?.id) return err(error);
        const { data: conv } = await supabase.from('conversations').select('channel, external_thread_id').eq('id', b.conversationId).single();
        const delivery = conv ? await deliver(supabase, data, conv.channel, conv.external_thread_id, null) : data.delivery_status;
        return ok({ message: { ...data, delivery_status: delivery } });
      }
      case 'status':
      case 'read':
      case 'link_guest': {
        if (typeof b.conversationId !== 'string' || !UUID.test(b.conversationId)) return bad('Konuşma seçilmeli.');
        const res = b.action === 'status'
          ? await supabase.rpc('inbox_set_status', { p_conversation_id: b.conversationId, p_status: b.status === 'HUMAN' || b.status === 'CLOSED' ? b.status : 'AI' })
          : b.action === 'read'
            ? await supabase.rpc('inbox_mark_read', { p_conversation_id: b.conversationId })
            : await supabase.rpc('inbox_link_guest', { p_conversation_id: b.conversationId, p_guest_id: typeof b.guestId === 'string' && UUID.test(b.guestId) ? b.guestId : null });
        if (res.error || !res.data) return err(res.error);
        return ok({ conversation: res.data });
      }
      case 'confirm_request':
      case 'decline_request': {
        if (typeof b.requestId !== 'string' || !UUID.test(b.requestId)) return bad('Talep seçilmeli.');
        const res = b.action === 'confirm_request'
          ? await supabase.rpc('booking_request_confirm', { p_request_id: b.requestId })
          : await supabase.rpc('booking_request_decline', { p_request_id: b.requestId, p_reason: str(b.reason, 300) });
        if (res.error || !res.data?.id) return err(res.error);
        // the confirmation message to the guest goes out through the channel adapter
        if (b.action === 'confirm_request' && res.data.conversation_id) {
          const [{ data: conv }, { data: msg }] = await Promise.all([
            supabase.from('conversations').select('channel, external_thread_id').eq('id', res.data.conversation_id).single(),
            supabase.from('messages').select('*').eq('external_id', `confirm-${res.data.id}`).maybeSingle()
          ]);
          if (conv && msg) await deliver(supabase, msg, conv.channel, conv.external_thread_id, null);
        }
        return ok({ request: res.data });
      }
      case 'availability': {
        if (typeof b.propertyId !== 'string' || !UUID.test(b.propertyId) || !isIsoDate(b.checkIn) || !isIsoDate(b.checkOut)) return bad('Tarihler geçersiz.');
        const adults = typeof b.adults === 'number' && b.adults >= 1 && b.adults <= 10 ? b.adults : 2;
        const { data, error } = await supabase.rpc('check_availability', { p_property_id: b.propertyId, p_check_in: b.checkIn, p_check_out: b.checkOut, p_adults: adults });
        if (error) return err(error);
        return ok({ options: data });
      }
      default:
        return bad('Bilinmeyen işlem.');
    }
  });
}
