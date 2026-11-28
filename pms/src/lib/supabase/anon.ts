/** Anonymous server-side client for public entry points (web chat, verified webhooks). No user session. */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { SUPABASE_ANON_KEY, SUPABASE_URL, isDemoMode } from '@/lib/config';

export function getAnonClient(): SupabaseClient<Database> | null {
  if (isDemoMode()) return null;
  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
