// /api/panel: AXON CRM panel API (login, list, update).
// Needs PANEL_PASSWORD (Vercel > Settings > Environment Variables, type Sensitive).
// Login returns a signed session token (HMAC of the password) valid for 12 hours.
const crypto = require('crypto');
const { rateLimited, clientIp, sameOrigin, readBody, send } = require('./_lib');
const crm = require('./_crm');

const TTL_MS = 12 * 60 * 60 * 1000;

function secret() { return process.env.PANEL_PASSWORD || ''; }
function sign(payload) { return crypto.createHmac('sha256', 'axon-panel:' + secret()).update(payload).digest('base64url'); }
function makeToken() { const exp = String(Date.now() + TTL_MS); return exp + '.' + sign(exp); }
function validToken(t) {
  if (!t || typeof t !== 'string') return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeEqual(x, y) {
  const a = crypto.createHash('sha256').update(String(x)).digest(), b = crypto.createHash('sha256').update(String(y)).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex');
  if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
  if (!secret()) return send(res, 503, { error: 'panel_not_configured' });
  if (!crm.configured()) return send(res, 503, { error: 'crm_not_configured' });

  if (req.method === 'POST') {
    const b = readBody(req) || {};
    if (b.action === 'login') {
      if (rateLimited('login:' + clientIp(req), 8, 15 * 60 * 1000)) return send(res, 429, { error: 'rate_limited' });
      if (typeof b.password !== 'string' || !safeEqual(b.password, secret())) return send(res, 401, { error: 'wrong_password' });
      return send(res, 200, { token: makeToken() });
    }
  }

  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!validToken(auth)) return send(res, 401, { error: 'unauthorized' });

  try {
    if (req.method === 'GET') {
      const items = await crm.listInquiries();
      return send(res, 200, { items, statuses: crm.STATUSES, transitions: crm.TRANSITIONS });
    }
    if (req.method === 'POST') {
      const b = readBody(req) || {};
      if (b.action === 'update') {
        const doc = await crm.updateInquiry(String(b.id || ''), { status: b.status, note: b.note }, 'panel');
        if (!doc) return send(res, 404, { error: 'not_found' });
        return send(res, 200, { item: doc });
      }
      return send(res, 400, { error: 'unknown_action' });
    }
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'method_not_allowed' });
  } catch (e) {
    if (e && e.code === 'bad_transition') return send(res, 409, { error: 'bad_transition' });
    console.error('panel_error', e && e.message);
    return send(res, 500, { error: 'storage_error' });
  }
};
