// Shared helpers for AXON serverless functions (Vercel Node runtime).
// Secrets are read from environment variables only; nothing here is sent to the browser.

const buckets = new Map();

// Best-effort in-memory rate limit. It resets when the function instance is recycled,
// so it slows down abuse but is not a hard guarantee.
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, t: now };
  if (now - b.t > windowMs) { b.n = 0; b.t = now; }
  b.n += 1;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.clear();
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
