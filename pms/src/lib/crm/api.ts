/** Guest CRM request validation (pure). */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ALLOWED = ['full_name', 'email', 'phone', 'nationality', 'language', 'vip_level', 'vip_note', 'marketing_consent', 'kvkk_notice'] as const;

/** Validates a profile change set (only known fields; VIP level 0–3). Exported for tests. */
export function parseGuestChanges(input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') return { ok: false, message: 'Değişiklik yok.' };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(ALLOWED as readonly string[]).includes(k)) return { ok: false, message: `Bilinmeyen alan: ${k}` };
    if (k === 'vip_level' && (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 3)) return { ok: false, message: 'VIP seviyesi 0–3 olmalı.' };
    if ((k === 'marketing_consent' || k === 'kvkk_notice') && typeof v !== 'boolean') return { ok: false, message: 'Onay alanı evet/hayır olmalı.' };
    if (k === 'email' && v !== '' && (typeof v !== 'string' || !EMAIL.test(v))) return { ok: false, message: 'E-posta geçersiz.' };
    if (['full_name', 'phone', 'nationality', 'language', 'vip_note'].includes(k) && (typeof v !== 'string' || v.length > 300)) return { ok: false, message: 'Alan değeri geçersiz.' };
    if (k === 'full_name' && typeof v === 'string' && v.trim().length < 2) return { ok: false, message: 'Ad en az 2 karakter olmalı.' };
    out[k] = v;
  }
  return Object.keys(out).length ? { ok: true, value: out } : { ok: false, message: 'Değişiklik yok.' };
}


/** Shows enough to recognise a guest in a list without exposing full contact data (full data only in the logged profile view). */
export function maskEmail(email: string | null): string {
  if (!email) return '';
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(4, user.length - 1)))}@${domain}`;
}
export function maskPhone(phone: string | null): string {
  if (!phone) return '';
  const d = phone.replace(/\D/g, '');
  return d.length < 4 ? '•••' : `•••• ${d.slice(-4)}`;
}
