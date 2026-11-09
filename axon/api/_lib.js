// Shared helpers for AXON serverless functions (Vercel Node runtime).
// Secrets are read from environment variables only; nothing here is sent to the browser.

const buckets = new Map();

// In-memory rate limit, per function instance. Vercel may run several instances and recycle
// them, so this slows abuse down rather than guaranteeing a global limit (that needs a shared
// store such as Upstash Redis). The contact form also has a honeypot and a minimum fill time.
const MAX_KEYS = 5000;
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > windowMs) b = { n: 0, t: now, w: windowMs };
  b.n += 1;
  buckets.delete(key); buckets.set(key, b); // keep insertion order = most recently used last
  if (buckets.size > MAX_KEYS) {
    // drop expired windows first, then the least recently used, never everyone at once
    for (const [k, v] of buckets) { if (now - v.t > v.w) buckets.delete(k); }
    while (buckets.size > MAX_KEYS) buckets.delete(buckets.keys().next().value);
  }
  return b.n > max;
}

function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Only accept browser calls from this site (or local development).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin).host;
    return o === req.headers.host || /^localhost(:\d+)?$/.test(o) || /^127\.0\.0\.1(:\d+)?$/.test(o);
  } catch (e) { return false; }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
  return null;
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { rateLimited, clientIp, sameOrigin, readBody, send, escapeHtml };
