import { HousekeepingBoard, type HkRoom } from '@/components/housekeeping/HousekeepingBoard';
import { demoProperty } from '@/lib/demo/data';
import { DEMO_STAFF, demoHkTasks } from '@/lib/demo/housekeeping';
import { demoReservations, demoRoomsForToday } from '@/lib/demo/reservations';
import { loadHkTasks } from '@/lib/housekeeping/load';
import { todayIn } from '@/lib/reservations/dates';
import { getPropertyContext } from '@/lib/supabase/context';
import { getServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function HousekeepingPage() {
  const supabase = await getServerClient();

  if (!supabase) {
    const today = todayIn(demoProperty.timezone);
    const rooms = demoRoomsForToday(today);
    const arrivals = new Set(demoReservations(today).filter((r) => r.check_in === today && (r.status === 'CONFIRMED' || r.status === 'PENDING')).map((r) => r.room_id));
    const { tasks, notes } = demoHkTasks(rooms, today, arrivals);
    const hkRooms: HkRoom[] = rooms.map((r) => ({ id: r.id, number: r.number, floor: r.floor, type: r.room_type?.code ?? '', occupancy: r.occupancy_status, housekeeping: r.housekeeping_status, outOfOrder: r.maintenance_status === 'OUT_OF_ORDER' }));
    return (
      <HousekeepingBoard demo property={{ id: demoProperty.id, name: demoProperty.name, code: demoProperty.code, requireInspection: true }} role="owner" userId={null}
        today={today} rooms={hkRooms} arrivals={[...arrivals]} staff={DEMO_STAFF} initialTasks={tasks} initialNotes={notes} />
    );
  }

  const ctx = await getPropertyContext(supabase);
  const today = todayIn(ctx.property.timezone);
  const [{ data: rooms, error: rErr }, { data: types }, { data: arrivals }, { data: staff }, loaded] = await Promise.all([
    supabase.from('rooms').select('id, number, floor, room_type_id, occupancy_status, housekeeping_status, maintenance_status').eq('property_id', ctx.property.id),
    supabase.from('room_types').select('id, code').eq('property_id', ctx.property.id),
    supabase.from('reservations').select('room_id').eq('property_id', ctx.property.id).eq('check_in', today).in('status', ['CONFIRMED', 'PENDING']),
    supabase.rpc('hk_list_staff', { p_property_id: ctx.property.id }),
    loadHkTasks(supabase, ctx.property.id, today)
  ]);
  if (rErr) throw new Error(`rooms: ${rErr.message}`);
  const typeCode = new Map((types ?? []).map((t) => [t.id, t.code]));
  const hkRooms: HkRoom[] = (rooms ?? [])
    .map((r) => ({ id: r.id, number: r.number, floor: r.floor, type: typeCode.get(r.room_type_id) ?? '', occupancy: r.occupancy_status, housekeeping: r.housekeeping_status, outOfOrder: r.maintenance_status === 'OUT_OF_ORDER' }))
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));

  return (
    <HousekeepingBoard
      demo={false}
      property={{ id: ctx.property.id, name: ctx.property.name, code: ctx.property.code, requireInspection: ctx.property.require_inspection }}
      role={ctx.role}
      userId={ctx.userId}
      today={today}
      rooms={hkRooms}
      arrivals={(arrivals ?? []).map((a) => a.room_id)}
      staff={staff ?? []}
      initialTasks={loaded.tasks}
      initialNotes={loaded.notes}
    />
  );
}
