/**
 * Parity: the browser copy of the assistant (sales demo, lib/demo/crm.ts) must answer exactly like the
 * database's inbox_assistant_turn. The fixture comes from supabase/tests/55_assistant_parity.sql and
 * is produced by `npm run db:test` (PMS_ASSISTANT_PARITY_FILE); without a database the test is skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demoAssistantTurnParsed, type DemoContext } from '@/lib/demo/crm';
import { addDays } from '@/lib/reservations/dates';
import type { Parsed } from '@/lib/inbox/nlu';
import type { Conversation } from '@/types/database';

const file = process.env.PMS_ASSISTANT_PARITY_FILE;
const run = file && existsSync(file) ? describe : describe.skip;
type Turn = { lang: 'tr' | 'en'; intent: Parsed['intent']; slots: Record<string, string | number> };
const scenarios = JSON.parse(readFileSync(join(__dirname, '..', 'supabase', 'tests', 'assistant_scenarios.json'), 'utf8')) as { name: string; turns: Turn[] }[];

run('assistant: browser copy vs database (same scenarios, same replies)', () => {
  const doc = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { today: string; results: Record<string, { replied: boolean; type: string | null; text: string }[]> }) : null;
  for (const sc of scenarios) {
    it(sc.name, () => {
      const today = doc!.today;
      const conv = { id: 'p', channel: 'WEBCHAT', contact_name: null, contact_handle: null, guest_id: null, status: 'AI' } as unknown as Conversation;
      let ctx: DemoContext = {};
      let handedOff = false;
      const got = sc.turns.map((t) => {
        if (handedOff) return { replied: false, type: null, text: '' };
        const s = t.slots;
        const slots: Parsed['slots'] = {
          ...(s.in !== undefined ? { check_in: addDays(today, Number(s.in)) } : {}), ...(s.out !== undefined ? { check_out: addDays(today, Number(s.out)) } : {}),
          ...(s.nights !== undefined ? { nights: Number(s.nights) } : {}), ...(s.adults !== undefined ? { adults: Number(s.adults) } : {}),
          ...(s.room_type ? { room_type: String(s.room_type) } : {}), ...(s.name ? { name: String(s.name) } : {}), ...(s.email ? { email: String(s.email) } : {}),
          ...(s.phone ? { phone: String(s.phone) } : {}), ...(s.topic ? { topic: String(s.topic) } : {})
        };
        const r = demoAssistantTurnParsed(today, conv, { lang: t.lang, intent: t.intent, slots }, ctx);
        ctx = r.context;
        if (r.handoff) handedOff = true;
        return { replied: true, type: (r.payload.type as string | undefined) ?? null, text: r.text.replace(/\(talep no [0-9a-f]{8}\)|\(request [0-9a-f]{8}\)/, '(…)') };
      });
      const want = doc!.results[sc.name]!.map((x) => ({ replied: x.replied, type: x.replied ? x.type : null, text: x.replied ? x.text : '' }));
      expect(got).toEqual(want);
    });
  }
});
