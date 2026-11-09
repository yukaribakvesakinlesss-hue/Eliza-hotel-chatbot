import { redirect } from 'next/navigation';
import { ChannelsBoard } from '@/components/channels/ChannelsBoard';
import { demoProperty, demoRole, demoRoomTypes } from '@/lib/demo/data';
import { demoChannels } from '@/lib/demo/crm';
import { todayIn } from '@/lib/reservations/dates';
import { isHousekeepingRole } from '@/lib/rooms/rules';
import { getPropertyContext } from '@/lib/supabase/context';
import { getServerClient } from '@/lib/supabase/server';
import type { OtaOutboxStatus } from '@/types/database';

export const dynamic = 'force-dynamic';

export default async function ChannelsPage() {
  const supabase = await getServerClient();
  if (!supabase) {
    const today = todayIn(demoProperty.timezone);
    const d = demoChannels(today);
    return (
      <ChannelsBoard property={{ id: demoProperty.id, code: demoProperty.code, currency: demoProperty.currency }} role={demoRole} connections={d.connections}
        mappings={d.mappings} roomTypes={demoRoomTypes} initialEvents={d.events} openByConnection={d.open} deadByConnection={d.dead} demo={{ today }} />
    );
  }
  const ctx = await getPropertyContext(supabase);
  if (isHousekeepingRole(ctx.role)) redirect('/housekeeping');
  const pid = ctx.property.id;
  const { data: connections } = await supabase.from('ota_connections').select('*').eq('property_id', pid).order('channel_code');
  const count = async (cid: string, status: OtaOutboxStatus[]) =>
    (await supabase.from('ota_outbox').select('id', { count: 'exact', head: true }).eq('connection_id', cid).in('status', status)).count ?? 0;
  const tallies = await Promise.all((connections ?? []).map(async (c) => [c.id, await count(c.id, ['PENDING', 'FAILED']), await count(c.id, ['DEAD'])] as const));

  const [{ data: mappings }, { data: roomTypes }, { data: events }] = await Promise.all([
    supabase.from('ota_room_mappings').select('*').eq('property_id', pid),
    supabase.from('room_types').select('id, code, name').eq('property_id', pid).order('code'),
    supabase.from('ota_inbound_events').select('*').eq('property_id', pid).order('id', { ascending: false }).limit(50)
  ]);

  return (
    <ChannelsBoard
      property={{ id: pid, code: ctx.property.code, currency: ctx.property.currency }}
      role={ctx.role}
      connections={connections ?? []}
      mappings={mappings ?? []}
      roomTypes={roomTypes ?? []}
      initialEvents={events ?? []}
      openByConnection={Object.fromEntries(tallies.map(([id, open]) => [id, open]))}
      deadByConnection={Object.fromEntries(tallies.map(([id, , dead]) => [id, dead]))}
    />
  );
}
