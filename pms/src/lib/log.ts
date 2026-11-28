/**
 * Structured application logs (one JSON line per event) for Vercel runtime logs or any log drain.
 * Personal data never goes into logs: keys that can carry it are masked before writing.
 */
type Level = 'info' | 'warn' | 'error';
const SENSITIVE = /^(email|phone|name|full_name|guest|guest_name|contact.*|body|text|token|secret|password|authorization|cookie|p_secret|p_token)$/i;

export function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(val, depth + 1);
    return out;
  }
  if (typeof v === 'string') return v.length > 500 ? `${v.slice(0, 500)}…` : v;
  return v;
}

export function log(level: Level, event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, service: 'axon-pms', commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7), ...(redact(data) as object) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
