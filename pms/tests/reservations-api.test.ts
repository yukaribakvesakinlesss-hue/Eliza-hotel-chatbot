import { describe, expect, it } from 'vitest';
import { mapDbError, parseCreate, parseIdempotencyKey, parseStatus, parseUpdate } from '@/lib/reservations/api';
import { addDays, isIsoDate, nightsBetween, staysOverlap, todayIn } from '@/lib/reservations/dates';
import { demoReservations } from '@/lib/demo/reservations';

const valid = {
  propertyId: '00000000-0000-4000-a000-000000000101',
  roomId: '00000000-0000-4000-b000-000000000101',
  checkIn: '2026-12-01',
  checkOut: '2026-12-03',
  adults: 2,
  guestName: 'Ayşe Yılmaz'
};

describe('dates', () => {
  it('half-open overlap: same-day turnover does not overlap', () => {
    expect(staysOverlap('2026-12-01', '2026-12-03', '2026-12-03', '2026-12-05')).toBe(false);
    expect(staysOverlap('2026-12-03', '2026-12-05', '2026-12-01', '2026-12-03')).toBe(false);
    expect(staysOverlap('2026-12-01', '2026-12-04', '2026-12-03', '2026-12-05')).toBe(true);
    expect(staysOverlap('2026-12-01', '2026-12-10', '2026-12-03', '2026-12-04')).toBe(true);
  });
  it('validates real calendar dates and counts nights across month ends', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(nightsBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30'); // DST weekend in Europe
  });
  it('computes "today" in the hotel timezone, not UTC', () => {
    const lateUtc = new Date('2026-11-08T22:30:00Z'); // 01:30 on the 9th in Istanbul
    expect(todayIn('Europe/Istanbul', lateUtc)).toBe('2026-11-09');
    expect(todayIn('UTC', lateUtc)).toBe('2026-11-08');
  });
});

describe('parseCreate', () => {
  it('accepts a valid request and fills defaults', () => {
    const r = parseCreate(valid);
    expect(r.ok && r.value).toMatchObject({ children: 0, source: 'direct', status: 'CONFIRMED', guestEmail: null });
  });
  it('rejects check-out on or before check-in', () => {
    const r = parseCreate({ ...valid, checkOut: '2026-12-01' });
    expect(!r.ok && r.error).toMatchObject({ status: 400, code: 'RES_INVALID_DATES', message: 'Çıkış tarihi giriş tarihinden sonra olmalı.' });
  });
  it('rejects bad input with Turkish messages', () => {
    expect(parseCreate({ ...valid, guestName: ' ' }).ok).toBe(false);
    expect(parseCreate({ ...valid, adults: 0 }).ok).toBe(false);
    expect(parseCreate({ ...valid, adults: 1.5 }).ok).toBe(false);
    expect(parseCreate({ ...valid, guestEmail: 'not-an-email' }).ok).toBe(false);
    expect(parseCreate({ ...valid, roomId: 'x' }).ok).toBe(false);
    expect(parseCreate({ ...valid, status: 'CHECKED_IN' }).ok).toBe(false);
    expect(parseCreate({ ...valid, checkIn: '2026-02-30' }).ok).toBe(false);
    expect(parseCreate(null).ok).toBe(false);
  });
});

describe('parseUpdate / parseStatus / idempotency key', () => {
  it('extension: only check-out is enough', () => {
    expect(parseUpdate({ checkOut: '2026-12-05', expectedVersion: 2 })).toEqual({ ok: true, value: { checkOut: '2026-12-05', expectedVersion: 2 } });
  });
  it('rejects an empty change and reversed dates', () => {
    expect(parseUpdate({ expectedVersion: 1 }).ok).toBe(false);
    expect(parseUpdate({ checkIn: '2026-12-05', checkOut: '2026-12-04' }).ok).toBe(false);
  });
  it('status endpoint never cancels (cancel has its own endpoint)', () => {
    expect(parseStatus({ status: 'CHECKED_IN' }).ok).toBe(true);
    expect(parseStatus({ status: 'CANCELLED' }).ok).toBe(false);
    expect(parseStatus({ status: 'BOGUS' }).ok).toBe(false);
  });
  it('requires a well-formed Idempotency-Key', () => {
    expect(parseIdempotencyKey(null).ok).toBe(false);
    expect(parseIdempotencyKey('short').ok).toBe(false);
    expect(parseIdempotencyKey('5b1c7e0e-1f2a-4d39-9c35-0d5e6f7a8b9c').ok).toBe(true);
  });
});

describe('mapDbError', () => {
  it('maps a conflict to 409 with the database Turkish message', () => {
    const e = mapDbError({ message: 'RES_CONFLICT: Oda 101 seçilen tarihlerde dolu. 08.12.2026 – 11.12.2026 tarihlerindeki R000001 numaralı rezervasyonla çakışıyor.' });
    expect(e).toEqual({ status: 409, code: 'RES_CONFLICT', message: 'Oda 101 seçilen tarihlerde dolu. 08.12.2026 – 11.12.2026 tarihlerindeki R000001 numaralı rezervasyonla çakışıyor.' });
  });
  it('maps permissions, stale versions and idempotency', () => {
    expect(mapDbError({ message: 'FORBIDDEN: Rezervasyon işlemleri için yetkiniz yok.' }).status).toBe(403);
    expect(mapDbError({ message: 'RES_STALE: x' }).status).toBe(409);
    expect(mapDbError({ message: 'IDEMPOTENCY_MISMATCH: x' }).status).toBe(409);
    expect(mapDbError({ message: 'RES_CAPACITY: Oda 101 en fazla 2 kişi alır.' })).toMatchObject({ status: 422, code: 'RES_CAPACITY' });
  });
  it('never leaks raw SQL: a bare constraint violation becomes a friendly conflict', () => {
    const e = mapDbError({ code: '23P01', message: 'conflicting key value violates exclusion constraint "reservations_no_overlap"' });
    expect(e.status).toBe(409);
    expect(e.message).not.toContain('constraint');
  });
  it('unknown errors become a generic 500', () => {
    expect(mapDbError({ message: 'relation "x" does not exist' })).toMatchObject({ status: 500, code: 'INTERNAL' });
    expect(mapDbError(null).status).toBe(500);
  });
});

describe('demo reservations', () => {
  it('never overlap in the same room (same rule as the database constraint)', () => {
    const list = demoReservations('2026-11-08');
    for (const a of list)
      for (const b of list)
        if (a.id !== b.id && a.room_id === b.room_id) expect(staysOverlap(a.check_in, a.check_out, b.check_in, b.check_out)).toBe(false);
  });
});
