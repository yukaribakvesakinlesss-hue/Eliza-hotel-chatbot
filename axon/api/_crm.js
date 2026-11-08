// AXON CRM storage: one private JSON document per inquiry in Vercel Blob (store "axon-crm").
// BLOB_READ_WRITE_TOKEN is added to the project automatically when the store is connected.
// For local development, CRM_LOCAL_DIR stores the same documents on disk instead.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'crm/inquiries/';
const STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'];

function configured() { return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.CRM_LOCAL_DIR); }

function newId() {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 10).replace(/-/g, '');
  return stamp + '-' + crypto.randomBytes(5).toString('hex');
}

// ---- storage backends ----
const local = {
  dir() { const p = path.join(process.env.CRM_LOCAL_DIR, PREFIX); fs.mkdirSync(p, { recursive: true }); return p; },
  async put(id, doc) { fs.writeFileSync(path.join(this.dir(), id + '.json'), JSON.stringify(doc)); },
  async get(id) { try { return JSON.parse(fs.readFileSync(path.join(this.dir(), id + '.json'), 'utf8')); } catch (e) { return null; } },
  async list() { return fs.readdirSync(this.dir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); }
};
const blob = {
  sdk() { return require('@vercel/blob'); },
  async put(id, doc) {
    await this.sdk().put(PREFIX + id + '.json', JSON.stringify(doc), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
  },
  async get(id) {
    const r = await this.sdk().get(PREFIX + id + '.json', { access: 'private', useCache: false });
    if (!r || !r.stream) return null;
    const text = await new Response(r.stream).text();
    return JSON.parse(text);
  },
  async list() {
    const ids = []; let cursor;
    do {
      const r = await this.sdk().list({ prefix: PREFIX, cursor, limit: 1000 });
      r.blobs.forEach((b) => { const m = b.pathname.match(/([^/]+)\.json$/); if (m) ids.push(m[1]); });
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return ids;
  }
};
const store = () => (process.env.CRM_LOCAL_DIR ? local : blob);

// ---- public API ----
async function createInquiry(data) {
  const now = new Date().toISOString();
  const doc = {
    id: newId(), createdAt: now, updatedAt: now, status: 'new', source: data.source || 'website',
    contact: { name: data.name, email: data.email, whatsapp: data.whatsapp || '' },
    hotel: data.hotel, rooms: data.rooms, challenge: data.challenge, package: data.package || '', message: data.message || '', lang: data.lang || '',
    notify: 'pending',
    history: [{ at: now, type: 'created', text: 'Inquiry received from the website form' }]
  };
  await store().put(doc.id, doc);
  return doc;
}

async function getInquiry(id) {
  if (!/^[0-9]{8}-[0-9a-f]{10}$/.test(id)) return null;
  return store().get(id);
}

async function listInquiries() {
  const ids = await store().list();
  const docs = await Promise.all(ids.map((id) => store().get(id).catch(() => null)));
  return docs.filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function updateInquiry(id, patch, actor) {
  const doc = await getInquiry(id);
  if (!doc) return null;
  const now = new Date().toISOString();
  if (patch.status && STATUSES.includes(patch.status) && patch.status !== doc.status) {
    doc.history.push({ at: now, type: 'status', text: doc.status + ' → ' + patch.status, by: actor || 'panel' });
    doc.status = patch.status;
  }
  if (typeof patch.note === 'string' && patch.note.trim()) {
    doc.history.push({ at: now, type: 'note', text: patch.note.trim().slice(0, 2000), by: actor || 'panel' });
  }
  if (patch.notify) { doc.notify = patch.notify; if (patch.notifyText) doc.history.push({ at: now, type: 'notify', text: patch.notifyText }); }
  doc.updatedAt = now;
  await store().put(id, doc);
  return doc;
}

module.exports = { configured, createInquiry, getInquiry, listInquiries, updateInquiry, STATUSES };
