import { redirect } from 'next/navigation';
import { TapeChart } from '@/components/reservations/TapeChart';
import { demoProperty, demoRole, demoRooms } from '@/lib/demo/data';
import { DEMO_CHANNELS, demoReservations } from '@/lib/demo/reservations';
import { todayIn } from '@/lib/reservations/dates';
import { getServerClient } from '@/lib/supabase/server';
import { isHousekeepingRole } from '@/lib/rooms/rules';
import type { MemberRole, RoomWithType } from '@/types/database';

export const dynamic = 'force-dynamic';

const byNumber = (a: { number: string }, b: { number: string }) => a.number.localeCompare(b.number, undefined, { numeric: true });

export default async function ReservationsPage() {
  const supabase = await getServerClient();

  if (!supabase) {
    const today = todayIn(demoProperty.timezone);
    return <TapeChart demo property={demoProperty} role={demoRole} rooms={demoRooms().sort(byNumber)} today={today} channels={DEMO_CHANNELS} initialReservations={demoReservations(today)} />;
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: memberships, error: mErr } = await supabase.from('memberships').select('*').eq('user_id', user.id).order('created_at');
  if (mErr) throw new Error(`memberships: ${mErr.message}`);
  const membership = memberships?.[0];
  if (!membership) redirect('/onboarding');

  const propertyQuery = supabase.from('properties').select('id, name, code, timezone').eq('organization_id', membership.organization_id);
  const { data: property, error: pErr } = await (membership.property_id ? propertyQuery.eq('id', membership.property_id) : propertyQuery.order('created_at'))
    .limit(1)
    .maybeSingle();
  if (pErr) throw new Error(`properties: ${pErr.message}`);
  if (!property) redirect('/onboarding');

  const role: MemberRole =
    memberships.find((m) => m.organization_id === membership.organization_id && m.property_id === property.id)?.role ??
    memberships.find((m) => m.organization_id === membership.organization_id && m.property_id === null)?.role ??
    membership.role;
  if (isHousekeepingRole(role)) redirect('/housekeeping'); // housekeeping staff only see their operational screen

  const [{ data: roomTypes, error: tErr }, { data: rooms, error: rErr }, { data: channels }] = await Promise.all([
    supabase.from('room_types').select('id, code, name, max_occupancy').eq('property_id', property.id),
    supabase.from('rooms').select('*').eq('property_id', property.id),
    supabase.from('distribution_channels').select('code, name, commission_rate').eq('organization_id', membership.organization_id).eq('is_active', true).order('commission_rate')
  ]);
  if (tErr) throw new Error(`room_types: ${tErr.message}`);
  if (rErr) throw new Error(`rooms: ${rErr.message}`);
  const types = new Map((roomTypes ?? []).map((t) => [t.id, t]));
  const withTypes: RoomWithType[] = (rooms ?? []).map((r) => ({ ...r, room_type: types.get(r.room_type_id) ?? null })).sort(byNumber);

  // reservations are loaded by the client for the visible window (and kept fresh via realtime)
  return <TapeChart demo={false} property={property} role={role} rooms={withTypes} today={todayIn(property.timezone)} channels={(channels ?? []).map((c) => ({ ...c, commission_rate: Number(c.commission_rate) }))} initialReservations={[]} />;
}
