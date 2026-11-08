// POST /api/contact: validates a demo request and emails it to the AXON team via Resend.
// Delivery:
//   default   FormSubmit (formsubmit.co), no key; the inbox owner clicks a one-time activation link
//   optional  Resend, when RESEND_API_KEY is set (CONTACT_FROM_EMAIL = verified sender)
//   CONTACT_TO_EMAIL overrides the receiving inbox (default below).
// Storage: every valid inquiry is saved to the AXON CRM (Vercel Blob, see _crm.js) when connected.
// Success is returned only after the provider accepts the message; otherwise the page offers email/WhatsApp.

const { rateLimited, clientIp, sameOrigin, readBody, send, escapeHtml } = require('./_lib');
const crm = require('./_crm');

const CHALLENGES = ['Missed Guest Inquiries', 'Slow Response Times', 'Manual Reservation Management', 'Multilingual Communication', 'High Staff Workload', 'Other'];
const ROOMS = ['1-20', '21-50', '51-100', '101-200', '200+'];
const PACKAGES = ['', 'Start', 'Pro', 'Enterprise', 'Personal'];
const DEFAULT_TO = 'gulcanyesilbudak@icloud.com';
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

function validate(b) {
  const errors = {};
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const d = {
    name: s(b.name), email: s(b.email), hotel: s(b.hotel), rooms: s(b.rooms),
    challenge: s(b.challenge), whatsapp: s(b.whatsapp), message: s(b.message), package: s(b.package), lang: s(b.lang).slice(0, 5)
  };
  if (d.name.length < 2 || d.name.length > 100) errors.name = 'name';
  if (!EMAIL_RE.test(d.email) || d.email.length > 200) errors.email = 'email';
  if (d.hotel.length < 2 || d.hotel.length > 150) errors.hotel = 'hotel';
  if (!ROOMS.includes(d.rooms)) errors.rooms = 'rooms';
  if (!CHALLENGES.includes(d.challenge)) errors.challenge = 'challenge';
  if (d.whatsapp && !/^\+?[0-9 ()-]{7,20}$/.test(d.whatsapp)) errors.whatsapp = 'whatsapp';
  if (d.message.length > 2000) errors.message = 'message';
  if (!PACKAGES.includes(d.package)) d.package = '';
  return { d, errors };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { error: 'method_not_allowed' }); }
  if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
  if (rateLimited('contact:' + clientIp(req), 5, 10 * 60 * 1000)) return send(res, 429, { error: 'rate_limited' });

  const b = readBody(req);
  if (!b) return send(res, 400, { error: 'invalid_body' });

  // spam protection: hidden honeypot field and a minimum fill time
  if (b.website) return send(res, 200, { ok: true });
  const elapsed = Date.now() - Number(b.ts || 0);
  if (!Number.isFinite(elapsed) || elapsed < 3000) return send(res, 400, { error: 'too_fast' });

  const { d, errors } = validate(b);
  if (Object.keys(errors).length) return send(res, 400, { error: 'validation', fields: errors });

  // 1) Save the inquiry in the AXON CRM (if the store is connected)
  let saved = null;
  if (crm.configured()) {
    try { saved = await crm.createInquiry({ ...d, source: 'website form' }); }
    catch (e) { console.error('crm_save_failed', e && e.message); }
  }

  // 2) Notify the team by email
  const site = 'https://' + (req.headers.host || 'axon-systems-three.vercel.app');
  const sent = await notify(d, saved, site);
  if (saved) {
    try { await crm.updateInquiry(saved.id, { notify: sent.ok ? 'sent' : 'failed', notifyText: sent.ok ? 'Team notified by email' : 'Email notification failed (' + sent.reason + ')' }, 'system'); }
    catch (e) { console.error('crm_update_failed', e && e.message); }
  }

  // Success when the inquiry is safely stored or the team was emailed; never a fake success.
  if (saved || sent.ok) return send(res, 200, { ok: true, id: saved ? saved.id : undefined });
  if (sent.reason === 'activation_pending') return send(res, 503, { error: 'activation_pending' });
  return send(res, 502, { error: 'delivery_failed' });
};

async function notify(d, saved, site) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO_EMAIL || DEFAULT_TO;
  const rows = [['Name', d.name], ['Business email', d.email], ['Hotel', d.hotel], ['Rooms', d.rooms], ['Main challenge', d.challenge],
    ['WhatsApp', d.whatsapp || '-'], ['Package of interest', d.package || '-'], ['Page language', d.lang || '-'], ['Message', d.message || '-']];
  if (saved) rows.push(['CRM', site + '/panel#' + saved.id]);

  if (!key) {
    // No Resend key: FormSubmit (no account; the inbox owner confirms once via an activation email)
    try {
      const payload = { _subject: 'AXON demo request: ' + d.hotel, _template: 'table', _captcha: 'false', _replyto: d.email };
      rows.forEach(([k, v]) => { payload[k] = v; });
      const r = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(to.split(',')[0].trim()), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: site, Referer: site + '/' }, body: JSON.stringify(payload)
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && String(j.success) === 'true') return { ok: true };
      console.error('formsubmit_failed', r.status, JSON.stringify(j).slice(0, 300));
      return { ok: false, reason: /activat/i.test(j.message || '') ? 'activation_pending' : 'formsubmit_' + r.status };
    } catch (e) { console.error('formsubmit_error', e && e.message); return { ok: false, reason: 'network' }; }
  }

  const html = '<h2 style="font-family:sans-serif">New AXON demo request</h2><table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">' +
    rows.map(([k, v]) => '<tr><td style="padding:6px 12px 6px 0;color:#555;vertical-align:top">' + k + '</td><td style="padding:6px 0;white-space:pre-wrap">' +
      (k === 'CRM' ? '<a href="' + escapeHtml(v) + '">Open in AXON CRM</a>' : escapeHtml(v)) + '</td></tr>').join('') + '</table>';
  const text = rows.map(([k, v]) => k + ': ' + v).join('\n');
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.CONTACT_FROM_EMAIL || 'AXON Systems <onboarding@resend.dev>',
        to: to.split(',').map((x) => x.trim()).filter(Boolean),
        ...(/^[\x21-\x7e]+$/.test(d.email) ? { reply_to: d.email } : {}),
        subject: 'AXON demo request: ' + d.hotel,
        html, text
      })
    });
    if (!r.ok) { console.error('resend_failed', r.status, (await r.text()).slice(0, 300)); return { ok: false, reason: 'resend_' + r.status }; }
    return { ok: true };
  } catch (e) { console.error('resend_error', e && e.message); return { ok: false, reason: 'network' }; }
}
