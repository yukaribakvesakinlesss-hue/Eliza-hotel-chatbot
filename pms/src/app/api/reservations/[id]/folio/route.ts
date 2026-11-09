import { NextResponse, type NextRequest } from 'next/server';
import { mapDbError, parseFolioAction, parseUuid } from '@/lib/reservations/api';
import { errorResponse, readJson, withReservationApi } from '@/lib/reservations/server';

export const dynamic = 'force-dynamic';

const ok = (body: Record<string, unknown>) => NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });

/**
 * POST /api/reservations/:id/folio
 *   { action: 'post_charges' }                         → posts room nights up to tonight
 *   { action: 'post', type, amount, …, idempotencyKey } → extra / discount / payment / refund
 *   { action: 'reverse', transactionId, reason? }       → correction by reversal (ledger is append-only)
 *   { action: 'close' }                                 → closes a settled folio
 * Success is reported only with the id/row the database returned.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withReservationApi(req, async (supabase) => {
    const id = parseUuid((await params).id);
    if (!id.ok) return errorResponse(id.error);
    const input = parseFolioAction(await readJson(req));
    if (!input.ok) return errorResponse(input.error);
    const a = input.value;

    if (a.action === 'post_charges') {
      const { data, error } = await supabase.rpc('post_room_charges', { p_reservation_id: id.value });
      if (error) return errorResponse(mapDbError(error));
      return ok({ posted: data ?? 0 });
    }
    if (a.action === 'post') {
      const { data, error } = await supabase.rpc('post_folio_transaction', {
        p_reservation_id: id.value,
        p_type: a.type,
        p_amount: a.amount,
        p_description: a.description,
        p_account_code: a.accountCode,
        p_tax_rate: a.taxRate,
        p_payment_method: a.paymentMethod as 'CASH' | 'CARD' | 'TRANSFER' | 'OTA' | null,
        p_idempotency_key: a.idempotencyKey
      });
      if (error) return errorResponse(mapDbError(error));
      if (typeof data !== 'number') return errorResponse(mapDbError(null));
      return ok({ transactionId: data });
    }
    if (a.action === 'reverse') {
      const { data, error } = await supabase.rpc('reverse_folio_transaction', { p_transaction_id: a.transactionId, p_reason: a.reason });
      if (error) return errorResponse(mapDbError(error));
      if (typeof data !== 'number') return errorResponse(mapDbError(null));
      return ok({ transactionId: data });
    }
    const { data, error } = await supabase.rpc('close_folio', { p_reservation_id: id.value });
    if (error) return errorResponse(mapDbError(error));
    if (!data?.id) return errorResponse(mapDbError(null));
    return ok({ folio: data });
  });
}
