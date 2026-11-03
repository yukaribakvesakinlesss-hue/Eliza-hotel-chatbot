// POST /api/chat: optional live AI mode for the demo assistant on the AXON homepage.
// Environment variable (server-side only):
//   OPENAI_API_KEY   enables live AI replies (same provider and model as the Hotel Eliza project)
// Without it the endpoint answers 503 { error: "not_configured" } and the page runs its
// clearly labelled simulation instead. The demo hotel is fictional and is never connected
// to a real reservation system.

const { rateLimited, clientIp, sameOrigin, readBody, send } = require('./_lib');

const SYSTEM = `You are the guest assistant of "Aurelia Boutique Hotel", a FICTIONAL demo hotel used on the AXON Systems website to show hotel owners how an AI guest assistant works.
Rules:
- Reply in the language the guest writes in. Keep replies short (1 to 3 sentences), warm and professional.
- Facts you may use: 24 rooms. Room types: Classic Double (22 m2, up to 2 guests), Deluxe Double (28 m2, city view, up to 2 guests), Junior Suite (38 m2, up to 3 guests). Check-in from 14:00, check-out until 12:00. Breakfast served 07:00 to 10:30, included in flexible rates. Limited on-site parking on request. Airport transfer can be arranged on request. Front desk open 24/7.
- You cannot see live availability or prices. Never confirm availability, never quote a price and never say a booking is confirmed. Offer to submit a reservation inquiry that the reservations team will confirm.
- For a reservation inquiry collect: dates, number of guests, room type, guest name and email. Ask for one or two missing items at a time.
- If the guest asks for a person, or asks something you cannot answer from these facts, say you will hand the conversation to the team.
- If asked, say plainly that this is a demo assistant for a fictional hotel.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { error: 'method_not_allowed' }); }
  if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return send(res, 503, { error: 'not_configured' });
  if (rateLimited('chat:' + clientIp(req), 20, 60 * 1000)) return send(res, 429, { error: 'rate_limited' });

  const b = readBody(req);
  const message = b && typeof b.message === 'string' ? b.message.trim().slice(0, 600) : '';
  if (!message) return send(res, 400, { error: 'empty' });
  const history = Array.isArray(b.history) ? b.history.slice(-10).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 600) })) : [];

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.3, max_tokens: 220, messages: [{ role: 'system', content: SYSTEM }, ...history, { role: 'user', content: message }] })
    });
    if (!r.ok) { console.error('openai_failed', r.status); return send(res, 502, { error: 'ai_failed' }); }
    const j = await r.json();
    const reply = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!reply) return send(res, 502, { error: 'ai_failed' });
    return send(res, 200, { reply: reply.trim() });
  } catch (e) {
    console.error('openai_error', e && e.message);
    return send(res, 502, { error: 'ai_failed' });
  }
};
