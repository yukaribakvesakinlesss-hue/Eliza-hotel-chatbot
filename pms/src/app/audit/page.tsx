import { redirect } from 'next/navigation';
import { AuditLog } from '@/components/audit/AuditLog';
import { demoProperty, demoRole } from '@/lib/demo/data';
import { demoAudit } from '@/lib/demo/crm';
import { todayIn } from '@/lib/reservations/dates';
import { getPropertyContext } from '@/lib/supabase/context';
import { getServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const supabase = await getServerClient();
  if (!supabase) return <AuditLog organizationId={demoProperty.organization_id} propertyCode={demoProperty.code} role={demoRole} initial={demoAudit(todayIn(demoProperty.timezone))} demo />;
  const ctx = await getPropertyContext(supabase);
  if (ctx.role !== 'owner' && ctx.role !== 'manager') redirect('/rooms');
  const { data, error } = await supabase.rpc('audit_feed', { p_organization_id: ctx.property.organization_id, p_limit: 100 });
  if (error) throw new Error(`audit_feed: ${error.message}`);
  return <AuditLog organizationId={ctx.property.organization_id} propertyCode={ctx.property.code} role={ctx.role} initial={data ?? []} />;
}
