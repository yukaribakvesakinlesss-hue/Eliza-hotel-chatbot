/** Supabase connection settings. Empty values switch the PMS to demo mode (sample data, no database writes). */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export function isDemoMode(): boolean {
  return !SUPABASE_URL || !SUPABASE_ANON_KEY;
}
