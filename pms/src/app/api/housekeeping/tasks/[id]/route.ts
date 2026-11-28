import { NextResponse, type NextRequest } from 'next/server';
import { parseTaskAction, parseTaskId } from '@/lib/housekeeping/api';
import { mapDbError } from '@/lib/reservations/api';
import { errorResponse, readJson, withReservationApi } from '@/lib/reservations/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/housekeeping/tasks/:id { action: start | finish | inspect | assign | note | cancel, … }
 * The response carries the task row the database saved; the UI shows a step as done only then.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withReservationApi(req, async (supabase) => {
    const id = parseTaskId((await params).id);
    if (!id.ok) return errorResponse(id.error);
    const input = parseTaskAction(await readJson(req));
    if (!input.ok) return errorResponse(input.error);
    const a = input.value;
    const taskId = id.value;

    if (a.action === 'note') {
      const { data, error } = await supabase.rpc('hk_add_note', { p_task_id: taskId, p_body: a.note });
      if (error) return errorResponse(mapDbError(error));
      if (!data?.id) return errorResponse(mapDbError(null));
      return NextResponse.json({ note: data }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const call =
      a.action === 'start' ? supabase.rpc('hk_start_task', { p_task_id: taskId })
      : a.action === 'finish' ? supabase.rpc('hk_finish_task', { p_task_id: taskId, p_note: a.note })
      : a.action === 'inspect' ? supabase.rpc('hk_inspect_task', { p_task_id: taskId, p_passed: a.passed, p_note: a.note })
      : a.action === 'assign' ? supabase.rpc('hk_assign_task', { p_task_id: taskId, p_user_id: a.userId })
      : supabase.rpc('hk_cancel_task', { p_task_id: taskId });
    const { data, error } = await call;
    if (error) return errorResponse(mapDbError(error));
    if (!data?.id) return errorResponse(mapDbError(null));
    return NextResponse.json({ task: data }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
