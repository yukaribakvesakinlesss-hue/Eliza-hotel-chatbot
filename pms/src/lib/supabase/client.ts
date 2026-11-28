'use client';
import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { SUPABASE_ANON_KEY, SUPABASE_URL, isDemoMode } from '@/lib/config';

let client: SupabaseClient<Database> | null = null;

/** Browser client (singleton). Returns null in demo mode. */
export function getBrowserClient(): SupabaseClient<Database> | null {
  if (isDemoMode()) return null;
  client ??= createBrowserClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
  return client;
}
