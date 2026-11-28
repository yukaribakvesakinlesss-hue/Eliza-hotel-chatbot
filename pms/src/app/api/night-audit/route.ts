import { NextResponse, type NextRequest } from 'next/server';
import { isIsoDate } from '@/lib/reservations/dates';
import { mapDbError } from '@/lib/reservations/api';
import { errorResponse, readJson, withReservationApi } from '@/lib/reservations/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/night-audit { propertyId, businessDate? } → posts that night for every in-house guest. */
export async function POST(req: NextRequest) {
  return withReservationApi(req, async (supabase) => {
    const body = (await readJson(req)) as { propertyId?: unknown; businessDate?: unknown } | null;
    if (typeof body?.propertyId !== 'string' || !UUID.test(body.propertyId)) {
      return errorResponse({ status: 400, code: 'VALIDATION', message: 'Tesis seçilmeli.' });
    }
    if (body.businessDate !== undefined && !isIsoDate(body.businessDate)) {
      return errorResponse({ status: 400, code: 'VALIDATION', message: 'Tarih geçersiz.' });
    }
    const { data, error } = await supabase.rpc('run_night_audit', {
      p_property_id: body.propertyId,
      p_business_date: (body.businessDate as string | undefined) ?? null
    });
    if (error) return errorResponse(mapDbError(error));
    return NextResponse.json({ posted: data ?? 0 }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
