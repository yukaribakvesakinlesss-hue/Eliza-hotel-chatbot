/** Demo housekeeping data (demo mode only; actions are disabled there). */
import type { HkStaff, HkTask, HkTaskNote, RoomWithType } from '@/types/database';
import { demoProperty } from './data';

export const DEMO_STAFF: HkStaff[] = [
  { user_id: '00000000-0000-4000-d000-000000000001', display_name: 'Ayten', role: 'housekeeping' },
  { user_id: '00000000-0000-4000-d000-000000000002', display_name: 'Murat', role: 'housekeeping' },
  { user_id: '00000000-0000-4000-d000-000000000003', display_name: 'Derya', role: 'hk_supervisor' }
];

export function demoHkTasks(rooms: RoomWithType[], today: string, arrivals: Set<string>): { tasks: HkTask[]; notes: HkTaskNote[] } {
  const now = Date.parse(`${today}T10:30:00+03:00`);
  const iso = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();
  const tasks: HkTask[] = [];
  const notes: HkTaskNote[] = [];
  rooms.forEach((r, i) => {
    if (r.housekeeping_status === 'CLEAN' && i % 5 !== 0) return;
    const status = r.housekeeping_status === 'CLEAN' ? 'CLEAN' : r.housekeeping_status;
    const assignee = i % 3 === 0 ? null : DEMO_STAFF[i % 2]!.user_id;
    const started = status !== 'DIRTY' ? iso(25 + (i % 4) * 7) : null;
    const finished = status === 'INSPECTION_REQUIRED' || status === 'CLEAN' ? iso(5 + (i % 3) * 4) : null;
    const id = `00000000-0000-4000-e000-${String(i + 1).padStart(12, '0')}`;
    tasks.push({
      id, organization_id: demoProperty.organization_id, property_id: demoProperty.id, room_id: r.id,
      task_type: i % 4 === 0 ? 'STAYOVER' : 'CHECKOUT', status, priority: arrivals.has(r.id) ? 1 : 2, business_date: today,
      assigned_to: status === 'DIRTY' ? assignee : assignee ?? DEMO_STAFF[0]!.user_id, assigned_at: assignee ? iso(60) : null,
      started_at: started, started_by: started ? assignee : null, finished_at: finished, finished_by: finished ? assignee : null,
      inspected_at: status === 'CLEAN' ? iso(2) : null, inspected_by: status === 'CLEAN' ? DEMO_STAFF[2]!.user_id : null,
      completed_at: status === 'CLEAN' ? iso(2) : null, rework_count: 0, created_by: null, created_at: iso(120), updated_at: iso(2)
    });
    if (i % 4 === 1) notes.push({ id: i + 1, organization_id: demoProperty.organization_id, property_id: demoProperty.id, task_id: id, author_id: DEMO_STAFF[1]!.user_id, body: 'Havlu eksik, çamaşırhaneden istendi.', created_at: iso(15) });
  });
  return { tasks, notes };
}
