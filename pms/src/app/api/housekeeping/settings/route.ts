import { NextResponse, type NextRequest } from 'next/server';
import { mapDbError } from '@/lib/reservations/api';
import { errorResponse, readJson, withReservationApi } from '@/lib/reservations/server';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/housekeeping/settings { propertyId, requireInspection } · owners and managers only (checked in the database). */
export async function POST(req: NextRequest) {
  return withReservationApi(req, async (supabase) => {
    const b = (await readJson(req)) as { propertyId?: unknown; requireInspection?: unknown } | null;
    if (typeof b?.propertyId !== 'string' || !UUID.test(b.propertyId) || typeof b.requireInspection !== 'boolean') {
      return errorResponse({ status: 400, code: 'VALIDATION', message: 'Ayar geçersiz.' });
    }
    const { data, error } = await supabase.rpc('hk_set_require_inspection', { p_property_id: b.propertyId, p_required: b.requireInspection });
    if (error) return errorResponse(mapDbError(error));
    if (typeof data !== 'boolean') return errorResponse(mapDbError(null));
    return NextResponse.json({ requireInspection: data }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
