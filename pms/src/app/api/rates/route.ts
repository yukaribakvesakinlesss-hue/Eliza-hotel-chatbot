import { NextResponse, type NextRequest } from 'next/server';
import { mapDbError } from '@/lib/reservations/api';
import { errorResponse, readJson, withReservationApi } from '@/lib/reservations/server';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/rates { roomTypeId, baseRate | null } · owners and managers (checked in the database). */
export async function POST(req: NextRequest) {
  return withReservationApi(req, async (supabase) => {
    const b = (await readJson(req)) as { roomTypeId?: unknown; baseRate?: unknown } | null;
    const rate = b?.baseRate;
    if (typeof b?.roomTypeId !== 'string' || !UUID.test(b.roomTypeId) || (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1_000_000))) {
      return errorResponse({ status: 400, code: 'VALIDATION', message: 'Fiyat geçersiz.' });
    }
    const { data, error } = await supabase.rpc('set_room_type_rate', { p_room_type_id: b.roomTypeId, p_base_rate: rate === null ? null : Math.round((rate as number) * 100) / 100 });
    if (error || !data) return errorResponse(mapDbError(error));
    return NextResponse.json({ roomType: data }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
