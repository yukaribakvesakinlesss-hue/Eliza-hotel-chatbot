import { redirect } from 'next/navigation';
import { InboxBoard } from '@/components/inbox/InboxBoard';
import { DemoNotice } from '@/components/DemoNotice';
import { isHousekeepingRole } from '@/lib/rooms/rules';
import { getPropertyContext } from '@/lib/supabase/context';
import { getServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const supabase = await getServerClient();
  if (!supabase) return <DemoNotice title="Inbox" />;
  const ctx = await getPropertyContext(supabase);
  if (isHousekeepingRole(ctx.role)) redirect('/housekeeping');

  const [{ data: org }, { data: conversations }, { data: requests }, { data: channels }, { data: roomTypes }] = await Promise.all([
    supabase.from('organizations').select('slug').eq('id', ctx.property.organization_id).single(),
    supabase.from('conversations').select('*').eq('property_id', ctx.property.id).order('last_message_at', { ascending: false }).limit(100),
    supabase.from('booking_requests').select('*').eq('property_id', ctx.property.id).order('created_at', { ascending: false }).limit(50),
    supabase.from('channel_connections').select('*').eq('property_id', ctx.property.id),
    supabase.from('room_types').select('id, code, name, max_occupancy, base_rate').eq('property_id', ctx.property.id).order('code')
  ]);

  return (
    <InboxBoard
      property={{ id: ctx.property.id, name: ctx.property.name, code: ctx.property.code, currency: ctx.property.currency, orgSlug: org?.slug ?? '' }}
      role={ctx.role}
      initialConversations={conversations ?? []}
      initialRequests={requests ?? []}
      channels={channels ?? []}
      roomTypes={roomTypes ?? []}
    />
  );
}
