// node --test tools/axon-site/tests  ·  CRM status transitions (axon/api/_crm.js) with the local disk store
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

process.env.CRM_LOCAL_DIR = mkdtempSync(join(tmpdir(), 'axon-crm-'));
const require = createRequire(import.meta.url);
const crm = require('../../../axon/api/_crm.js');

test('every status has a transition entry and no status moves to itself', () => {
  for (const s of crm.STATUSES) {
    assert.ok(Array.isArray(crm.TRANSITIONS[s]), s);
    assert.ok(!crm.TRANSITIONS[s].includes(s), s);
    for (const t of crm.TRANSITIONS[s]) assert.ok(crm.STATUSES.includes(t), `${s} → ${t}`);
  }
});

test('won and lost are final (won can only become lost, lost can only be reopened)', () => {
  assert.deepEqual(crm.TRANSITIONS.won, ['lost']);
  assert.deepEqual(crm.TRANSITIONS.lost, ['contacted']);
  assert.equal(crm.canMove('won', 'new'), false);
  assert.equal(crm.canMove('lost', 'won'), false);
});

test('updateInquiry follows the rules and logs each move', async () => {
  const doc = await crm.createInquiry({ hotel: 'Test Hotel', contact: { name: 'A', email: 'a@example.com' }, rooms: '10', challenge: 'Other' });
  await crm.updateInquiry(doc.id, { status: 'contacted' }, 'test');
  await crm.updateInquiry(doc.id, { status: 'won' }, 'test');
  await assert.rejects(crm.updateInquiry(doc.id, { status: 'new' }, 'test'), (e) => e.code === 'bad_transition');
  await assert.rejects(crm.updateInquiry(doc.id, { status: 'bogus' }, 'test'), (e) => e.code === 'bad_transition');
  const after = await crm.updateInquiry(doc.id, { note: 'still won' }, 'test');
  assert.equal(after.status, 'won');
  assert.deepEqual(after.history.filter((h) => h.type === 'status').map((h) => h.text), ['new → contacted', 'contacted → won']);
});
