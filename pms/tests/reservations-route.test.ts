/**
 * Route handler behaviour with a mocked Supabase client: the handler must report success only
 * when the database returned a saved row, and must pass errors through as clear Turkish messages.
 * (Real database behaviour, including concurrency, is covered by supabase/tests.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  demo: false,
  user: { id: '22222222-2222-4222-8222-222222222222' } as { id: string } | null,
  rpc: vi.fn()
}));

vi.mock('@/lib/config', () => ({ isDemoMode: () => state.demo, SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'x' }));
vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () =>
    state.demo ? null : { auth: { getUser: async () => ({ data: { user: state.user }, error: null }) }, rpc: state.rpc }
}));

const { POST: create } = await import('@/app/api/reservations/route');
const { PATCH: update } = await import('@/app/api/reservations/[id]/route');
const { POST: cancel } = await import('@/app/api/reservations/[id]/cancel/route');

const body = {
  propertyId: '00000000-0000-4000-a000-000000000101',
  roomId: '00000000-0000-4000-b000-000000000101',
  checkIn: '2026-12-01',
  checkOut: '2026-12-03',
  adults: 2,
  guestName: 'Ayşe Yılmaz'
};
const RES_ID = '6f1c2b6e-3c1a-4f7e-9b1d-2a3b4c5d6e7f';
const saved = { id: RES_ID, code: 'R000001', status: 'CONFIRMED', version: 1 };

function req(url: string, method: string, json: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://pms.test${url}`, {
    method,
    headers: { host: 'pms.test', origin: 'http://pms.test', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(json)
  });
}
const params = { params: Promise.resolve({ id: RES_ID }) };

beforeEach(() => {
  state.demo = false;
  state.user = { id: '22222222-2222-4222-8222-222222222222' };
  state.rpc.mockReset();
});

describe('POST /api/reservations', () => {
  it('201 with the saved reservation; passes the idempotency key to the database', async () => {
    state.rpc.mockResolvedValue({ data: saved, error: null });
    const res = await create(req('/api/reservations', 'POST', body, { 'idempotency-key': 'key-12345678' }));
    expect(res.status).toBe(201);
    expect((await res.json()).reservation.code).toBe('R000001');
    expect(state.rpc).toHaveBeenCalledWith('create_reservation', expect.objectContaining({ p_idempotency_key: 'key-12345678', p_room_id: body.roomId, p_check_in: '2026-12-01' }));
  });
  it('409 with the Turkish conflict message', async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: 'RES_CONFLICT: Oda 101 seçilen tarihlerde dolu.', code: 'P0001' } });
    const res = await create(req('/api/reservations', 'POST', body, { 'idempotency-key': 'key-12345678' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'RES_CONFLICT', message: 'Oda 101 seçilen tarihlerde dolu.' } });
  });
  it('never reports success when the database returned no row', async () => {
    state.rpc.mockResolvedValue({ data: null, error: null });
    const res = await create(req('/api/reservations', 'POST', body, { 'idempotency-key': 'key-12345678' }));
    expect(res.status).toBe(500);
    expect((await res.json()).reservation).toBeUndefined();
  });
  it('400 without an Idempotency-Key, and the database is not called', async () => {
    const res = await create(req('/api/reservations', 'POST', body));
    expect(res.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('400 on invalid dates before touching the database', async () => {
    const res = await create(req('/api/reservations', 'POST', { ...body, checkOut: '2026-11-30' }, { 'idempotency-key': 'key-12345678' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Çıkış tarihi giriş tarihinden sonra olmalı.');
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('403 for a cross-site request', async () => {
    const res = await create(req('/api/reservations', 'POST', body, { origin: 'https://evil.example', 'idempotency-key': 'key-12345678' }));
    expect(res.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('401 when signed out', async () => {
    state.user = null;
    const res = await create(req('/api/reservations', 'POST', body, { 'idempotency-key': 'key-12345678' }));
    expect(res.status).toBe(401);
  });
  it('503 in demo mode: no fake success without a real database', async () => {
    state.demo = true;
    const res = await create(req('/api/reservations', 'POST', body, { 'idempotency-key': 'key-12345678' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('DEMO_MODE');
  });
  it('two simultaneous requests: each gets the database answer (one 201, one 409)', async () => {
    state.rpc
      .mockResolvedValueOnce({ data: saved, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'RES_CONFLICT: Oda 101 seçilen tarihlerde dolu.' } });
    const [a, b] = await Promise.all([
      create(req('/api/reservations', 'POST', body, { 'idempotency-key': 'key-aaaaaaaa' })),
      create(req('/api/reservations', 'POST', body, { 'idempotency-key': 'key-bbbbbbbb' }))
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });
});

describe('PATCH / cancel', () => {
  it('extension forwards the expected version (optimistic locking)', async () => {
    state.rpc.mockResolvedValue({ data: { ...saved, version: 2 }, error: null });
    const res = await update(req(`/api/reservations/${RES_ID}`, 'PATCH', { checkOut: '2026-12-04', expectedVersion: 1 }), params);
    expect(res.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith('update_reservation', expect.objectContaining({ p_reservation_id: RES_ID, p_check_out: '2026-12-04', p_expected_version: 1, p_check_in: null }));
  });
  it('a stale version becomes 409', async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: 'RES_STALE: Rezervasyon bu arada başka biri tarafından değiştirildi.' } });
    const res = await update(req(`/api/reservations/${RES_ID}`, 'PATCH', { checkOut: '2026-12-04', expectedVersion: 1 }), params);
    expect(res.status).toBe(409);
  });
  it('cancel calls cancel_reservation with the reason', async () => {
    state.rpc.mockResolvedValue({ data: { ...saved, status: 'CANCELLED' }, error: null });
    const res = await cancel(req(`/api/reservations/${RES_ID}/cancel`, 'POST', { reason: 'Misafir vazgeçti' }), params);
    expect(res.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith('cancel_reservation', { p_reservation_id: RES_ID, p_reason: 'Misafir vazgeçti' });
  });
  it('an invalid id is a 404 without a database call', async () => {
    const res = await cancel(req('/api/reservations/abc/cancel', 'POST', {}), { params: Promise.resolve({ id: 'abc' }) });
    expect(res.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
