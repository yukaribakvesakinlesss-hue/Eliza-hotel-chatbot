/**
 * Reservation API contract: request validation and database-error mapping.
 * Pure functions (no I/O) so they are unit-tested and shared by every route handler.
 * The database re-validates everything; this layer only rejects obviously bad input early
 * and turns database errors into HTTP status codes with a Turkish message.
 */
import { RESERVATION_SOURCES, RESERVATION_STATUSES, type ReservationSource, type ReservationStatus } from '@/types/database';
import { isIsoDate, nightsBetween } from './dates';

export type ApiError = { status: number; code: string; message: string };
type Parsed<T> = { ok: true; value: T } | { ok: false; error: ApiError };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

const bad = (message: string, code = 'VALIDATION'): { ok: false; error: ApiError } => ({ ok: false, error: { status: 400, code, message } });

export type CreateReservationInput = {
  propertyId: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  guestName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  notes: string | null;
  source: ReservationSource;
  status: 'PENDING' | 'CONFIRMED';
};

const str = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

function checkDates(checkIn: unknown, checkOut: unknown): ApiError | null {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) return { status: 400, code: 'RES_INVALID_DATES', message: 'Giriş ve çıkış tarihleri geçerli olmalı (YYYY-AA-GG).' };
  const n = nightsBetween(checkIn, checkOut);
  if (n < 1) return { status: 400, code: 'RES_INVALID_DATES', message: 'Çıkış tarihi giriş tarihinden sonra olmalı.' };
  if (n > 365) return { status: 400, code: 'RES_INVALID_DATES', message: 'Bir rezervasyon en fazla 365 gece olabilir.' };
  return null;
}

export function parseIdempotencyKey(header: string | null): Parsed<string> {
  if (!header) return bad('Idempotency-Key başlığı gerekli.', 'IDEMPOTENCY_KEY_REQUIRED');
  if (!IDEMPOTENCY_KEY.test(header)) return bad('Idempotency-Key 8–100 karakter olmalı (harf, rakam, - veya _).', 'IDEMPOTENCY_KEY_INVALID');
  return { ok: true, value: header };
}

export function parseCreate(body: unknown): Parsed<CreateReservationInput> {
  if (!body || typeof body !== 'object') return bad('Geçersiz istek gövdesi.');
  const b = body as Record<string, unknown>;
  if (typeof b.propertyId !== 'string' || !UUID.test(b.propertyId)) return bad('Tesis seçilmeli.');
  if (typeof b.roomId !== 'string' || !UUID.test(b.roomId)) return bad('Oda seçilmeli.');
  const dateErr = checkDates(b.checkIn, b.checkOut);
  if (dateErr) return { ok: false, error: dateErr };
  const adults = int(b.adults);
  const children = b.children === undefined ? 0 : int(b.children);
  if (adults === null || adults < 1 || adults > 20) return bad('Yetişkin sayısı 1 ile 20 arasında olmalı.');
  if (children === null || children < 0 || children > 20) return bad('Çocuk sayısı 0 ile 20 arasında olmalı.');
  const guestName = str(b.guestName, 120);
  if (!guestName || guestName.length < 2) return bad('Misafir adı en az 2 karakter olmalı.', 'RES_GUEST_REQUIRED');
  const guestEmail = str(b.guestEmail, 160);
  if (guestEmail && !EMAIL.test(guestEmail)) return bad('E-posta adresi geçersiz.');
  const source = b.source === undefined ? 'direct' : b.source;
  if (!RESERVATION_SOURCES.includes(source as ReservationSource)) return bad('Geçersiz rezervasyon kaynağı.');
  const status = b.status === undefined ? 'CONFIRMED' : b.status;
  if (status !== 'PENDING' && status !== 'CONFIRMED') return bad('Yeni rezervasyon yalnızca Beklemede veya Onaylı olabilir.');
  return {
    ok: true,
    value: {
      propertyId: b.propertyId,
      roomId: b.roomId,
      checkIn: b.checkIn as string,
      checkOut: b.checkOut as string,
      adults,
      children,
      guestName,
      guestEmail,
      guestPhone: str(b.guestPhone, 30),
      notes: str(b.notes, 1000),
      source: source as ReservationSource,
      status
    }
  };
}

export type UpdateReservationInput = {
  roomId?: string;
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  children?: number;
  notes?: string;
  expectedVersion?: number;
};

export function parseUpdate(body: unknown): Parsed<UpdateReservationInput> {
  if (!body || typeof body !== 'object') return bad('Geçersiz istek gövdesi.');
  const b = body as Record<string, unknown>;
  const out: UpdateReservationInput = {};
  if (b.roomId !== undefined) {
    if (typeof b.roomId !== 'string' || !UUID.test(b.roomId)) return bad('Oda geçersiz.');
    out.roomId = b.roomId;
  }
  if (b.checkIn !== undefined || b.checkOut !== undefined) {
    if (b.checkIn !== undefined && !isIsoDate(b.checkIn)) return bad('Giriş tarihi geçersiz.', 'RES_INVALID_DATES');
    if (b.checkOut !== undefined && !isIsoDate(b.checkOut)) return bad('Çıkış tarihi geçersiz.', 'RES_INVALID_DATES');
    if (b.checkIn !== undefined && b.checkOut !== undefined) {
      const err = checkDates(b.checkIn, b.checkOut);
      if (err) return { ok: false, error: err };
    }
    if (b.checkIn !== undefined) out.checkIn = b.checkIn as string;
    if (b.checkOut !== undefined) out.checkOut = b.checkOut as string;
  }
  if (b.adults !== undefined) {
    const a = int(b.adults);
    if (a === null || a < 1 || a > 20) return bad('Yetişkin sayısı 1 ile 20 arasında olmalı.');
    out.adults = a;
  }
  if (b.children !== undefined) {
    const c = int(b.children);
    if (c === null || c < 0 || c > 20) return bad('Çocuk sayısı 0 ile 20 arasında olmalı.');
    out.children = c;
  }
  if (b.notes !== undefined) {
    if (typeof b.notes !== 'string') return bad('Not metin olmalı.');
    out.notes = b.notes.slice(0, 1000);
  }
  if (b.expectedVersion !== undefined) {
    const v = int(b.expectedVersion);
    if (v === null || v < 1) return bad('Sürüm numarası geçersiz.');
    out.expectedVersion = v;
  }
  if (Object.keys(out).filter((k) => k !== 'expectedVersion').length === 0) return bad('Değiştirilecek bir alan gönderilmedi.');
  return { ok: true, value: out };
}

const TRANSITIONS: ReservationStatus[] = ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW'];
export function parseStatus(body: unknown): Parsed<ReservationStatus> {
  const s = body && typeof body === 'object' ? (body as Record<string, unknown>).status : undefined;
  if (typeof s !== 'string' || !RESERVATION_STATUSES.includes(s as ReservationStatus)) return bad('Geçersiz durum.');
  if (!TRANSITIONS.includes(s as ReservationStatus)) return bad('Bu durum buradan ayarlanamaz. İptal için iptal işlemini kullanın.', 'RES_BAD_TRANSITION');
  return { ok: true, value: s as ReservationStatus };
}

export function parseUuid(id: string): Parsed<string> {
  return UUID.test(id) ? { ok: true, value: id } : { ok: false, error: { status: 404, code: 'RES_NOT_FOUND', message: 'Rezervasyon bulunamadı.' } };
}

const STATUS_BY_CODE: Record<string, number> = {
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  RES_NOT_FOUND: 404,
  RES_ROOM_NOT_FOUND: 404,
  RES_CONFLICT: 409,
  RES_STALE: 409,
  IDEMPOTENCY_MISMATCH: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  RES_ROOM_OCCUPIED: 409
};

/**
 * Maps a database error ('CODE: Türkçe mesaj') to an HTTP error. Unknown errors become a
 * generic 500 so internal details (SQL, constraint names) never reach the browser.
 */
export function mapDbError(err: { message?: string | null; code?: string | null } | null | undefined): ApiError {
  const msg = err?.message ?? '';
  const m = /^([A-Z_]+):\s*(.+)$/s.exec(msg);
  if (m && m[1] && m[2] && (m[1].startsWith('RES_') || m[1].startsWith('IDEMPOTENCY_') || m[1] === 'FORBIDDEN' || m[1] === 'AUTH_REQUIRED')) {
    return { status: STATUS_BY_CODE[m[1]] ?? 422, code: m[1], message: m[2].trim() };
  }
  // the EXCLUDE constraint fired without the friendly pre-check (should not happen, but never show raw SQL)
  if (err?.code === '23P01' || msg.includes('reservations_no_overlap')) {
    return { status: 409, code: 'RES_CONFLICT', message: 'Oda seçilen tarihlerde başka bir rezervasyonla çakışıyor.' };
  }
  return { status: 500, code: 'INTERNAL', message: 'Rezervasyon kaydedilemedi. Lütfen tekrar deneyin; sorun sürerse yöneticinize bildirin.' };
}
