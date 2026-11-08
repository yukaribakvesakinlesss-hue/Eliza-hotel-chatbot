import type { NextRequest } from 'next/server';
import { parseCreate, parseIdempotencyKey } from '@/lib/reservations/api';
import { errorResponse, readJson, rpcResult, withReservationApi } from '@/lib/reservations/server';

export const dynamic = 'force-dynamic';

/** POST /api/reservations · create (requires an Idempotency-Key header). */
export async function POST(req: NextRequest) {
  return withReservationApi(req, async (supabase) => {
    const key = parseIdempotencyKey(req.headers.get('idempotency-key'));
    if (!key.ok) return errorResponse(key.error);
    const input = parseCreate(await readJson(req));
    if (!input.ok) return errorResponse(input.error);
    const v = input.value;
    const { data, error } = await supabase.rpc('create_reservation', {
      p_property_id: v.propertyId,
      p_room_id: v.roomId,
      p_check_in: v.checkIn,
      p_check_out: v.checkOut,
      p_adults: v.adults,
      p_children: v.children,
      p_guest_name: v.guestName,
      p_guest_email: v.guestEmail,
      p_guest_phone: v.guestPhone,
      p_notes: v.notes,
      p_source: v.source,
      p_status: v.status,
      p_idempotency_key: key.value
    });
    return rpcResult(data, error, 201);
  });
}
