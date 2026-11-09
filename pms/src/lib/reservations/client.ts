'use client';
/** Browser-side calls to the reservation API. Success is reported only when the server returned the saved row. */
import type { Reservation, ReservationStatus } from '@/types/database';
import type { CreateReservationInput, UpdateReservationInput } from './api';

export type ApiResult = { ok: true; reservation: Reservation } | { ok: false; code: string; message: string; network?: boolean };

const NETWORK_MESSAGE =
  'Sunucuya ulaşılamadı; işlemin kaydedilip kaydedilmediği doğrulanamadı. Tekrar gönderebilirsiniz: aynı işlem anahtarı kullanıldığı için çift kayıt oluşmaz.';

async function call(url: string, init: RequestInit): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }, cache: 'no-store' });
  } catch {
    return { ok: false, code: 'NETWORK', message: NETWORK_MESSAGE, network: true };
  }
  const body = (await res.json().catch(() => null)) as { reservation?: Reservation; error?: { code?: string; message?: string } } | null;
  if (res.ok && body?.reservation?.id) return { ok: true, reservation: body.reservation };
  if (res.ok) return { ok: false, code: 'BAD_RESPONSE', message: NETWORK_MESSAGE, network: true };
  return {
    ok: false,
    code: body?.error?.code ?? `HTTP_${res.status}`,
    message: body?.error?.message ?? 'İşlem tamamlanamadı. Lütfen tekrar deneyin.'
  };
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export const reservationsApi = {
  create: (input: CreateReservationInput, idempotencyKey: string) =>
    call('/api/reservations', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(input) }),
  update: (id: string, input: UpdateReservationInput) =>
    call(`/api/reservations/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  cancel: (id: string, reason: string | null) =>
    call(`/api/reservations/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  setStatus: (id: string, status: ReservationStatus) =>
    call(`/api/reservations/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) })
};
