import { redirect } from 'next/navigation';
import { InboxBoard } from '@/components/inbox/InboxBoard';
import { demoOrganization, demoProperty, demoRole, demoRoomTypes } from '@/lib/demo/data';
import { demoInbox } from '@/lib/demo/crm';
import { todayIn } from '@/lib/reservations/dates';
import { isHousekeepingRole } from '@/lib/rooms/rules';
import { getPropertyContext } from '@/lib/supabase/context';
import { getServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const supabase = await getServerClient();
  if (!supabase) {
    const today = todayIn(demoProperty.timezone);
    const demo = demoInbox(today);
    return (
      <InboxBoard
        property={{ id: demoProperty.id, name: demoProperty.name, code: demoProperty.code, currency: demoProperty.currency, orgSlug: demoOrganization.slug }}
        role={demoRole}
        initialConversations={demo.conversations}
        initialRequests={demo.requests}
        channels={(['WHATSAPP', 'INSTAGRAM', 'WEBCHAT'] as const).map((c) => ({ id: c, organization_id: demoProperty.organization_id, property_id: demoProperty.id, channel: c, mode: c === 'WEBCHAT' ? 'LIVE' : 'DEMO', external_account_id: null, display_name: null, created_at: today, updated_at: today }))}
        roomTypes={demoRoomTypes}
        demo={{ today, threads: demo.threads, contexts: demo.contexts }}
      />
    );
  }
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
