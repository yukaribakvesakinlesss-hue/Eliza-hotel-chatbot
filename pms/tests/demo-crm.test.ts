import { describe, expect, it } from 'vitest';
import { demoAssistantTurn, demoAudit, demoAvailability, demoChannels, demoGuestProfile, demoGuests, demoInbox, demoQuote } from '@/lib/demo/crm';
import { demoRoomTypes } from '@/lib/demo/data';
import { demoFinance } from '@/lib/demo/reservations';
import { addDays } from '@/lib/reservations/dates';
import type { Conversation } from '@/types/database';

const today = '2026-11-09';
const conv = { id: 'c', channel: 'WEBCHAT', contact_name: null, contact_handle: null, guest_id: null } as unknown as Conversation;

describe('sales demo data', () => {
  it('quote uses the demo rate and the hotel taxes (per night rounding, like the database)', () => {
    const q = demoQuote(demoRoomTypes[1]!.id, '2026-12-12', '2026-12-15');
    expect(q).toMatchObject({ complete: true, net: 360, vat: 36, lodging: 7.2, gross: 403.2 });
  });

  it('availability counts only free operational rooms (agrees with the demo stays)', () => {
    const [ci, co] = [addDays(today, 1), addDays(today, 3)];
    const stays = demoFinance(today).reservations.filter((r) => r.status !== 'CANCELLED' && r.status !== 'NO_SHOW' && r.check_in < co && r.check_out > ci);
    const opts = demoAvailability(today, ci, co, 2);
    const total = opts.reduce((s, o) => s + o.available, 0);
    expect(total).toBe(23 - new Set(stays.map((s) => s.room_id)).size);   // 24 rooms, 1 out of order
  });

  it('assistant: prices come from the demo data; a type without a rate gets no invented number', () => {
    const t = demoAssistantTurn(today, conv, '12-15 Aralık 2 kişi müsait mi?', {}, null);
    expect(t.text).toContain('€403,20');
    const noRate = demoAssistantTurn(today, conv, '12-15 Aralık 2 kişi müsait mi?', {}, null, { [demoRoomTypes[1]!.id]: null });
    expect(noRate.text).toMatch(/Deluxe Double: \d+ oda müsait; fiyat sistemde tanımlı değil/);
    expect(noRate.text).not.toContain('€403,20');
  });

  it('assistant: booking request needs a room type and contact; it is never a confirmed booking', () => {
    const a = demoAssistantTurn(today, conv, '12-15 Aralık 2 kişi rezervasyon yapmak istiyorum', {}, null);
    expect(a.payload.type).toBe('ask_room_type');
    const b = demoAssistantTurn(today, conv, 'Deluxe olsun', a.context, 'ask_room_type');
    expect(b.payload.type).toBe('ask_contact');
    const c = demoAssistantTurn(today, conv, 'Adım Test Misafir, telefon 0532 000 00 00', b.context, 'ask_contact');
    expect(c.request?.status).toBe('NEW');
    expect(c.text).toContain('rezervasyon kesinleşmiş değildir');
  });

  it('guests, profiles, inbox, channels and audit build without gaps', () => {
    const { guests } = demoGuests(today);
    expect(guests.length).toBeGreaterThan(10);
    const p = demoGuestProfile(today, guests[0]!.id)!;
    expect(p.stays.length).toBeGreaterThan(0);
    const inbox = demoInbox(today);
    expect(inbox.conversations).toHaveLength(4);
    expect(inbox.requests.length).toBe(1);
    expect(Object.values(inbox.threads).every((t) => t.length >= 2)).toBe(true);
    expect(demoChannels(today).events.some((e) => e.status === 'NEEDS_ATTENTION')).toBe(true);
    expect(JSON.stringify(demoAudit(today))).not.toMatch(/@/);
  });
});
