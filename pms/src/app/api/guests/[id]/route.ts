import { NextResponse, type NextRequest } from 'next/server';
import { mapDbError } from '@/lib/reservations/api';
import { errorResponse, readJson, withReservationApi } from '@/lib/reservations/server';
import { parseGuestChanges } from '@/lib/crm/api';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = (body: unknown, headers: Record<string, string> = {}) => NextResponse.json(body, { headers: { 'Cache-Control': 'no-store', ...headers } });
const bad = (message: string) => errorResponse({ status: 400, code: 'VALIDATION', message });
/** POST /api/guests/:id { action: update | note | archive_note | export | anonymize } · access and KVKK rules live in the database. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withReservationApi(req, async (supabase) => {
    const id = (await params).id;
    if (!UUID.test(id)) return errorResponse({ status: 404, code: 'GUEST_NOT_FOUND', message: 'Misafir bulunamadı.' });
    const b = (await readJson(req)) as Record<string, unknown> | null;
    const err = (e: { message: string } | null) => errorResponse(mapDbError(e));
    switch (b?.action) {
      case 'update': {
        const c = parseGuestChanges(b.changes);
        if (!c.ok) return bad(c.message);
        const { data, error } = await supabase.rpc('guest_update', { p_guest_id: id, p_changes: c.value });
        return error || !data ? err(error) : ok({ guest: data });
      }
      case 'note': {
        if (!['PREFERENCE', 'SPECIAL_REQUEST', 'ALERT'].includes(b.category as string) || typeof b.body !== 'string' || !b.body.trim() || b.body.length > 500) return bad('Not türü veya metni geçersiz.');
        const { data, error } = await supabase.rpc('guest_add_note', { p_guest_id: id, p_category: b.category as 'PREFERENCE', p_body: b.body });
        return error || !data ? err(error) : ok({ note: data });
      }
      case 'archive_note': {
        if (typeof b.noteId !== 'number') return bad('Not seçilmeli.');
        const { data, error } = await supabase.rpc('guest_archive_note', { p_note_id: b.noteId });
        return error || !data ? err(error) : ok({ note: data });
      }
      case 'export': {
        const { data, error } = await supabase.rpc('kvkk_export_guest', { p_guest_id: id });
        if (error || !data) return err(error);
        return ok(data, { 'Content-Disposition': `attachment; filename="kvkk-${id}.json"` });
      }
      case 'anonymize': {
        if (b.confirm !== 'ANONİMLEŞTİR' && b.confirm !== 'ANONYMIZE') return bad('Onay metni gerekli.');
        const { data, error } = await supabase.rpc('kvkk_anonymize_guest', { p_guest_id: id });
        return error || !data ? err(error) : ok({ guest: data });
      }
      default:
        return bad('Bilinmeyen işlem.');
    }
  });
}
