import type { NextRequest } from 'next/server';
import { parseStatus, parseUuid } from '@/lib/reservations/api';
import { errorResponse, readJson, rpcResult, withReservationApi } from '@/lib/reservations/server';

export const dynamic = 'force-dynamic';

/** POST /api/reservations/:id/status · body { status: CONFIRMED | CHECKED_IN | CHECKED_OUT | NO_SHOW }. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withReservationApi(req, async (supabase) => {
    const id = parseUuid((await params).id);
    if (!id.ok) return errorResponse(id.error);
    const status = parseStatus(await readJson(req));
    if (!status.ok) return errorResponse(status.error);
    const { data, error } = await supabase.rpc('set_reservation_status', { p_reservation_id: id.value, p_status: status.value });
    return rpcResult(data, error);
  });
}
