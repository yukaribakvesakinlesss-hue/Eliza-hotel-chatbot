import type { NextRequest } from 'next/server';
import { parseUuid } from '@/lib/reservations/api';
import { errorResponse, readJson, rpcResult, withReservationApi } from '@/lib/reservations/server';

export const dynamic = 'force-dynamic';

/** POST /api/reservations/:id/cancel · body { reason? }. Repeating it is harmless. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withReservationApi(req, async (supabase) => {
    const id = parseUuid((await params).id);
    if (!id.ok) return errorResponse(id.error);
    const body = (await readJson(req)) as { reason?: unknown } | null;
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : null;
    const { data, error } = await supabase.rpc('cancel_reservation', { p_reservation_id: id.value, p_reason: reason });
    return rpcResult(data, error);
  });
}
