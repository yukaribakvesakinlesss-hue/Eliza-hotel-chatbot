import { NextResponse, type NextRequest } from 'next/server';
import { mapDbError } from '@/lib/reservations/api';
import { errorResponse, readJson, withReservationApi } from '@/lib/reservations/server';
import { parseOtaEvent } from '@/lib/ota/adapters';
import type { OtaChannel } from '@/types/database';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9_.:-]{1,40}$/;
const ok = (body: unknown) => NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string) => errorResponse({ status: 400, code: 'VALIDATION', message });
const channelOf = (v: unknown): OtaChannel | null => (v === 'BOOKING' || v === 'EXPEDIA' ? v : null);

/**
 * Staff channel-manager actions (every rule is re-checked in the database):
 *   simulate (front desk+, DEMO only) · retry (front desk+) · dismiss · configure · mapping · resync (owner / manager)
 */
export async function POST(req: NextRequest) {
  return withReservationApi(req, async (supabase) => {
    const b = (await readJson(req)) as Record<string, unknown> | null;
    if (!b || typeof b.action !== 'string') return bad('Geçersiz istek.');
    const err = (e: { message: string } | null) => errorResponse(mapDbError(e));
    const propertyOk = typeof b.propertyId === 'string' && UUID.test(b.propertyId);
    const eventId = typeof b.eventId === 'number' && Number.isInteger(b.eventId) && b.eventId > 0 ? b.eventId : null;

    switch (b.action) {
      case 'simulate': {
        const channel = channelOf(b.channel);
        const parsed = parseOtaEvent(b.event);
        if (!propertyOk || !channel) return bad('Kanal seçilmeli.');
        if (!parsed.ok) return bad(`Kanal mesajı geçersiz: ${parsed.error}`);
        const { data, error } = await supabase.rpc('ota_simulate_event', { p_property_id: b.propertyId as string, p_channel: channel, p_event: parsed.event as unknown as Record<string, unknown> });
        return error || !data ? err(error) : ok({ event: data });
      }
      case 'retry': {
        if (!eventId) return bad('Mesaj seçilmeli.');
        const { data, error } = await supabase.rpc('ota_retry_event', { p_event_id: eventId });
        return error || !data ? err(error) : ok({ event: data });
      }
      case 'dismiss': {
        const note = typeof b.note === 'string' ? b.note.trim().slice(0, 200) : '';
        if (!eventId) return bad('Mesaj seçilmeli.');
        const { data, error } = await supabase.rpc('ota_dismiss_event', { p_event_id: eventId, p_note: note });
        return error || !data ? err(error) : ok({ event: data });
      }
      case 'configure': {
        const channel = channelOf(b.channel);
        const mode = b.mode === 'LIVE' || b.mode === 'DEMO' ? b.mode : null;
        const hotelId = typeof b.hotelId === 'string' && b.hotelId.trim() ? b.hotelId.trim() : null;
        if (!propertyOk || !channel || !mode) return bad('Kanal ve mod seçilmeli.');
        if (hotelId && !/^[A-Za-z0-9_-]{1,40}$/.test(hotelId)) return bad('Otel kimliği yalnızca harf, rakam, - ve _ içerebilir.');
        // the worker secret is never typed in the browser: the server registers its own OTA_SYNC_SECRET (hash only)
        const secret = mode === 'LIVE' ? process.env.OTA_SYNC_SECRET ?? null : null;
        if (mode === 'LIVE' && !secret) return errorResponse({ status: 409, code: 'OTA_INVALID', message: 'Sunucuda OTA_SYNC_SECRET tanımlı değil; kanal gerçek moda alınamaz.' });
        const { data, error } = await supabase.rpc('ota_configure', { p_property_id: b.propertyId as string, p_channel: channel, p_mode: mode, p_hotel_id: hotelId, p_secret: secret });
        return error || !data ? err(error) : ok({ connection: data });
      }
      case 'mapping': {
        const channel = channelOf(b.channel);
        const room = typeof b.externalRoomId === 'string' ? b.externalRoomId.trim() : '';
        const plan = typeof b.ratePlanId === 'string' && b.ratePlanId.trim() ? b.ratePlanId.trim() : 'BAR';
        if (!propertyOk || !channel || typeof b.roomTypeId !== 'string' || !UUID.test(b.roomTypeId)) return bad('Kanal ve oda tipi seçilmeli.');
        if ((room && !CODE.test(room)) || !CODE.test(plan)) return bad('Kodlar yalnızca harf, rakam ve . _ : - içerebilir.');
        const { data, error } = await supabase.rpc('ota_set_mapping', { p_property_id: b.propertyId as string, p_channel: channel, p_room_type_id: b.roomTypeId, p_external_room_id: room || null, p_rate_plan_id: plan });
        return error ? err(error) : ok({ mapping: data });
      }
      case 'resync': {
        if (!propertyOk) return bad('Tesis seçilmeli.');
        const { data, error } = await supabase.rpc('ota_full_resync', { p_property_id: b.propertyId as string });
        return error || !data ? err(error) : ok(data);
      }
      default:
        return bad('Bilinmeyen işlem.');
    }
  });
}
