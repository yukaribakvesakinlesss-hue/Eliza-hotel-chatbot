import { describe, expect, it } from 'vitest';
import { extractDates, parseGuestMessage } from '@/lib/inbox/nlu';

const TODAY = '2026-11-08'; // a Sunday
const ROOMS = [{ code: 'CDBL', name: 'Classic Double' }, { code: 'DDBL', name: 'Deluxe Double' }, { code: 'JSTE', name: 'Junior Suite' }];
const p = (text: string, last?: string) => parseGuestMessage(text, TODAY, { roomTypes: ROOMS, lastAssistantType: last });

describe('dates', () => {
  it('Turkish month ranges', () => {
    expect(extractDates('12-15 Aralık', TODAY)).toMatchObject({ check_in: '2026-12-12', check_out: '2026-12-15' });
    expect(extractDates('12 ile 15 kasım arası', TODAY)).toMatchObject({ check_in: '2026-11-12', check_out: '2026-11-15' });
    expect(extractDates('20 Aralık – 3 Ocak', TODAY)).toMatchObject({ check_in: '2026-12-20', check_out: '2027-01-03' });
  });
  it('numeric and ISO dates', () => {
    expect(extractDates('12.12 - 15.12', TODAY)).toMatchObject({ check_in: '2026-12-12', check_out: '2026-12-15' });
    expect(extractDates('2026-12-01 to 2026-12-04', TODAY)).toMatchObject({ check_in: '2026-12-01', check_out: '2026-12-04' });
    expect(extractDates('01/02/2027 - 05/02/2027', TODAY)).toMatchObject({ check_in: '2027-02-01', check_out: '2027-02-05' });
  });
  it('a past day/month means next year; invalid dates are ignored', () => {
    expect(extractDates('3 Kasım', TODAY).check_in).toBe('2027-11-03');
    expect(extractDates('31.02', TODAY).check_in).toBeUndefined();
  });
  it('start date + nights', () => {
    expect(extractDates('20 Aralık 3 gece', TODAY)).toMatchObject({ check_in: '2026-12-20', check_out: '2026-12-23', nights: 3 });
    expect(extractDates('December 5th for two nights', TODAY)).toMatchObject({ check_in: '2026-12-05', check_out: '2026-12-07' });
  });
  it('relative dates', () => {
    expect(extractDates('yarın 1 gece', TODAY)).toMatchObject({ check_in: '2026-11-09', check_out: '2026-11-10' });
    expect(extractDates('this weekend', TODAY)).toMatchObject({ check_in: '2026-11-13', check_out: '2026-11-15' });
  });
});

describe('intents and slots', () => {
  it('availability / price questions', () => {
    expect(p('12-15 Aralık 2 kişi müsait oda var mı?')).toMatchObject({ lang: 'tr', intent: 'AVAILABILITY', slots: { check_in: '2026-12-12', check_out: '2026-12-15', adults: 2 } });
    expect(p('How much is a deluxe room on Dec 3 for 2 nights?')).toMatchObject({ lang: 'en', intent: 'AVAILABILITY', slots: { room_type: 'DDBL', check_out: '2026-12-05' } });
    expect(p('Fiyat nedir?').intent).toBe('AVAILABILITY');
  });
  it('booking requests, including follow-ups', () => {
    expect(p('Rezervasyon yapmak istiyorum, süit oda').slots.room_type).toBe('JSTE');
    expect(p('Rezervasyon yapmak istiyorum').intent).toBe('BOOKING');
    expect(p('evet', 'availability').intent).toBe('BOOKING');
    expect(p('Deluxe olsun', 'ask_room_type')).toMatchObject({ intent: 'BOOKING', slots: { room_type: 'DDBL' } });
    expect(p('Adım Deniz Ak, 0532 111 22 33', 'ask_contact')).toMatchObject({ intent: 'BOOKING', slots: { name: 'Deniz Ak', phone: '0532 111 22 33' } });
    expect(p('my name is John Smith, john@example.com', 'ask_contact')).toMatchObject({ intent: 'BOOKING', slots: { name: 'John Smith', email: 'john@example.com' } });
  });
  it('handoff wins over everything', () => {
    expect(p('Resepsiyonla görüşmek istiyorum').intent).toBe('HANDOFF');
    expect(p('I want to talk to a human about the price').intent).toBe('HANDOFF');
    expect(p('Şikayetim var').intent).toBe('HANDOFF');
  });
  it('FAQ topics', () => {
    expect(p('Kahvaltı dahil mi?')).toMatchObject({ intent: 'FAQ', slots: { topic: 'breakfast' } });
    expect(p('Is there free wifi?')).toMatchObject({ intent: 'FAQ', slots: { topic: 'wifi' } });
    expect(p('Otopark var mı?').slots.topic).toBe('parking');
    expect(p('Giriş saati kaçta?').slots.topic).toBe('checkin_time');
  });
  it('greeting and unknown', () => {
    expect(p('Merhaba').intent).toBe('GREETING');
    expect(p('Hello there').intent).toBe('GREETING');
    expect(p('asdf qwer').intent).toBe('UNKNOWN');
  });
  it('never invents slots from nothing', () => {
    expect(p('Merhaba').slots).toEqual({});
  });
  it('English questions without hint words are still English; "park" is a parking question', () => {
    expect(p('Where can I park my car?')).toMatchObject({ lang: 'en', intent: 'FAQ', slots: { topic: 'parking' } });
    expect(p('Arabamı nereye park edebilirim?')).toMatchObject({ lang: 'tr', intent: 'FAQ', slots: { topic: 'parking' } });
    expect(p('Do you have a room for two?').lang).toBe('en');
  });
});
