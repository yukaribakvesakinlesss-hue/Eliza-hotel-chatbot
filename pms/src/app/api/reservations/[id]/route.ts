import type { NextRequest } from 'next/server';
import { parseUpdate, parseUuid } from '@/lib/reservations/api';
import { errorResponse, readJson, rpcResult, withReservationApi } from '@/lib/reservations/server';

export const dynamic = 'force-dynamic';

/** PATCH /api/reservations/:id · change dates (extend/shorten), room, guests or notes. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withReservationApi(req, async (supabase) => {
    const id = parseUuid((await params).id);
    if (!id.ok) return errorResponse(id.error);
    const input = parseUpdate(await readJson(req));
    if (!input.ok) return errorResponse(input.error);
    const v = input.value;
    const { data, error } = await supabase.rpc('update_reservation', {
      p_reservation_id: id.value,
      p_room_id: v.roomId ?? null,
      p_check_in: v.checkIn ?? null,
      p_check_out: v.checkOut ?? null,
      p_adults: v.adults ?? null,
      p_children: v.children ?? null,
      p_notes: v.notes ?? null,
      p_expected_version: v.expectedVersion ?? null
    });
    return rpcResult(data, error);
  });
}
