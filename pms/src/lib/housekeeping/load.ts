/** Loads open tasks + everything finished today, with notes (RLS applies). Used by the page and the realtime refresh. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, HkTask, HkTaskNote } from '@/types/database';

export async function loadHkTasks(supabase: SupabaseClient<Database>, propertyId: string, today: string): Promise<{ tasks: HkTask[]; notes: HkTaskNote[] }> {
  const { data: tasks, error } = await supabase
    .from('hk_tasks')
    .select('*')
    .eq('property_id', propertyId)
    .or(`status.in.(DIRTY,IN_PROGRESS,INSPECTION_REQUIRED),business_date.eq.${today},completed_at.gte.${today}T00:00:00`)
    .order('priority')
    .order('created_at')
    .limit(500);
  if (error) throw new Error(`hk_tasks: ${error.message}`);
  const ids = (tasks ?? []).map((t) => t.id);
  if (!ids.length) return { tasks: [], notes: [] };
  const { data: notes, error: nErr } = await supabase.from('hk_task_notes').select('*').in('task_id', ids).order('id');
  if (nErr) throw new Error(`hk_task_notes: ${nErr.message}`);
  return { tasks: tasks ?? [], notes: notes ?? [] };
}
