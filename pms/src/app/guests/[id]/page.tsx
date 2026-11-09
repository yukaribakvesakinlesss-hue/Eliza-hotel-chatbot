import { notFound, redirect } from 'next/navigation';
import { demoProperty, demoRole } from '@/lib/demo/data';
import { demoGuestProfile } from '@/lib/demo/crm';
import { todayIn } from '@/lib/reservations/dates';
import { GuestProfile, type ProfileData } from '@/components/guests/GuestProfile';
import { isHousekeepingRole } from '@/lib/rooms/rules';
import { getPropertyContext } from '@/lib/supabase/context';
import { getServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function GuestPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await getServerClient();
  const { id } = await params;
  if (!supabase) {
    const demo = demoGuestProfile(todayIn(demoProperty.timezone), id);
    if (!demo) notFound();
    return <GuestProfile role={demoRole} propertyCode={demoProperty.code} data={demo} demo />;
  }
  const ctx = await getPropertyContext(supabase);
  if (isHousekeepingRole(ctx.role)) redirect('/housekeeping');
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  // guest_profile checks access and writes a VIEW entry to the KVKK access log
  const { data, error } = await supabase.rpc('guest_profile', { p_guest_id: id });
  if (error?.message.startsWith('GUEST_NOT_FOUND') || error?.message.startsWith('FORBIDDEN')) notFound();
  if (error || !data) throw new Error(error?.message ?? 'profile');
  return <GuestProfile role={ctx.role} propertyCode={ctx.property.code} data={data as ProfileData} />;
}
