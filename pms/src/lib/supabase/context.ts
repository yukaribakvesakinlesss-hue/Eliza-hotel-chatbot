/** Resolves the signed-in user's current property and role (server components). */
import { redirect } from 'next/navigation';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, MemberRole, Property } from '@/types/database';

export type PropertyContext = { userId: string; property: Property; role: MemberRole };

export async function getPropertyContext(supabase: SupabaseClient<Database>): Promise<PropertyContext> {
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: memberships, error: mErr } = await supabase.from('memberships').select('*').eq('user_id', user.id).order('created_at');
  if (mErr) throw new Error(`memberships: ${mErr.message}`);
  const membership = memberships?.[0];
  if (!membership) redirect('/onboarding');

  const q = supabase.from('properties').select('*').eq('organization_id', membership.organization_id);
  const { data: property, error: pErr } = await (membership.property_id ? q.eq('id', membership.property_id) : q.order('created_at')).limit(1).maybeSingle();
  if (pErr) throw new Error(`properties: ${pErr.message}`);
  if (!property) redirect('/onboarding');

  const role: MemberRole =
    memberships.find((m) => m.organization_id === membership.organization_id && m.property_id === property.id)?.role ??
    memberships.find((m) => m.organization_id === membership.organization_id && m.property_id === null)?.role ??
    membership.role;
  return { userId: user.id, property, role };
}
