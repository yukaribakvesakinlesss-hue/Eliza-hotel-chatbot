import { redirect } from 'next/navigation';
import { RoomBoard } from '@/components/RoomBoard';
import { demoProperty, demoRole, demoRoomTypes, demoRooms } from '@/lib/demo/data';
import { demoRoomsForToday } from '@/lib/demo/reservations';
import { todayIn } from '@/lib/reservations/dates';
import { getServerClient } from '@/lib/supabase/server';
import { isHousekeepingRole } from '@/lib/rooms/rules';
import type { MemberRole, RoomWithType } from '@/types/database';

export const dynamic = 'force-dynamic';

export default async function RoomsPage() {
  const supabase = await getServerClient();

  if (!supabase) {
    const rooms = demoRoomsForToday(todayIn(demoProperty.timezone));
    return <RoomBoard demo property={demoProperty} role={demoRole} userId={null} roomTypes={demoRoomTypes} initialRooms={rooms} />;
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // RLS returns only this user's memberships (or all of the org's for owners/managers)
  const { data: memberships, error: mErr } = await supabase.from('memberships').select('*').eq('user_id', user.id).order('created_at');
  if (mErr) throw new Error(`memberships: ${mErr.message}`);
  const membership = memberships?.[0];
  if (!membership) redirect('/onboarding');

  const propertyQuery = supabase.from('properties').select('id, name, code').eq('organization_id', membership.organization_id);
  const { data: property, error: pErr } = await (membership.property_id
    ? propertyQuery.eq('id', membership.property_id)
    : propertyQuery.order('created_at')
  )
    .limit(1)
    .maybeSingle();
  if (pErr) throw new Error(`properties: ${pErr.message}`);
  if (!property) redirect('/onboarding');

  // a property-scoped membership overrides the org-wide one for that property
  const role: MemberRole =
    memberships.find((m) => m.organization_id === membership.organization_id && m.property_id === property.id)?.role ??
    memberships.find((m) => m.organization_id === membership.organization_id && m.property_id === null)?.role ??
    membership.role;
  if (isHousekeepingRole(role)) redirect('/housekeeping'); // housekeeping staff only see their operational screen

  const [{ data: roomTypes, error: tErr }, { data: rooms, error: rErr }] = await Promise.all([
    supabase.from('room_types').select('id, code, name, max_occupancy').eq('property_id', property.id),
    supabase.from('rooms').select('*').eq('property_id', property.id)
  ]);
  if (tErr) throw new Error(`room_types: ${tErr.message}`);
  if (rErr) throw new Error(`rooms: ${rErr.message}`);

  const types = new Map((roomTypes ?? []).map((t) => [t.id, t]));
  const withTypes: RoomWithType[] = (rooms ?? []).map((r) => ({ ...r, room_type: types.get(r.room_type_id) ?? null }));

  return <RoomBoard demo={false} property={property} role={role} userId={user.id} roomTypes={roomTypes ?? []} initialRooms={withTypes} />;
}
