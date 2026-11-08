import { NextResponse, type NextRequest } from 'next/server';
import { parseCreateTask } from '@/lib/housekeeping/api';
import { mapDbError } from '@/lib/reservations/api';
import { errorResponse, readJson, withReservationApi } from '@/lib/reservations/server';

export const dynamic = 'force-dynamic';

/** POST /api/housekeeping/tasks · create a cleaning task for a room. */
export async function POST(req: NextRequest) {
  return withReservationApi(req, async (supabase) => {
    const input = parseCreateTask(await readJson(req));
    if (!input.ok) return errorResponse(input.error);
    const v = input.value;
    const { data, error } = await supabase.rpc('hk_create_task', {
      p_room_id: v.roomId,
      p_task_type: v.taskType,
      p_priority: v.priority,
      p_assigned_to: v.assignedTo,
      p_note: v.note
    });
    if (error) return errorResponse(mapDbError(error));
    if (!data?.id) return errorResponse(mapDbError(null));
    return NextResponse.json({ task: data }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  });
}
