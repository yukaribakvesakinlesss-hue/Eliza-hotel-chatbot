import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { Database } from '@/types/database';
import { SUPABASE_ANON_KEY, SUPABASE_URL, isDemoMode } from '@/lib/config';

/** Server client bound to the request cookies (the user's session). Returns null in demo mode. */
export async function getServerClient(): Promise<SupabaseClient<Database> | null> {
  if (isDemoMode()) return null;
  const store = await cookies();
  return createServerClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // called from a Server Component: the middleware refreshes the session instead
        }
      }
    }
  });
}
