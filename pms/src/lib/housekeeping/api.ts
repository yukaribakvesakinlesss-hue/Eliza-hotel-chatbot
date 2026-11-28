/** Housekeeping API contract: request validation (pure, unit-tested). The database re-checks everything. */
import { HK_TASK_TYPES, type HkTaskType } from '@/types/database';
import type { ApiError } from '@/lib/reservations/api';

type Parsed<T> = { ok: true; value: T } | { ok: false; error: ApiError };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message: string, code = 'VALIDATION'): { ok: false; error: ApiError } => ({ ok: false, error: { status: 400, code, message } });
const note = (v: unknown): string | null | 'invalid' => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return 'invalid';
  const t = v.trim();
  if (!t) return null;
  return t.length > 1000 ? 'invalid' : t;
};

export type CreateTaskInput = { roomId: string; taskType: HkTaskType; priority: 1 | 2 | 3; assignedTo: string | null; note: string | null };

export function parseCreateTask(body: unknown): Parsed<CreateTaskInput> {
  if (!body || typeof body !== 'object') return bad('Geçersiz istek gövdesi.');
  const b = body as Record<string, unknown>;
  if (typeof b.roomId !== 'string' || !UUID.test(b.roomId)) return bad('Oda seçilmeli.');
  const taskType = b.taskType ?? 'STAYOVER';
  if (!HK_TASK_TYPES.includes(taskType as HkTaskType)) return bad('Görev türü geçersiz.', 'HK_INVALID');
  const priority = b.priority ?? 2;
  if (priority !== 1 && priority !== 2 && priority !== 3) return bad('Öncelik 1, 2 veya 3 olmalı.', 'HK_INVALID');
  if (b.assignedTo !== undefined && b.assignedTo !== null && (typeof b.assignedTo !== 'string' || !UUID.test(b.assignedTo))) return bad('Personel geçersiz.');
  const n = note(b.note);
  if (n === 'invalid') return bad('Not en fazla 1000 karakter olmalı.', 'HK_INVALID');
  return { ok: true, value: { roomId: b.roomId, taskType: taskType as HkTaskType, priority, assignedTo: (b.assignedTo as string | null | undefined) ?? null, note: n } };
}

export type TaskAction =
  | { action: 'start' }
  | { action: 'finish'; note: string | null }
  | { action: 'inspect'; passed: boolean; note: string | null }
  | { action: 'assign'; userId: string | null }
  | { action: 'note'; note: string }
  | { action: 'cancel' };

export function parseTaskAction(body: unknown): Parsed<TaskAction> {
  if (!body || typeof body !== 'object') return bad('Geçersiz istek gövdesi.');
  const b = body as Record<string, unknown>;
  const n = note(b.note);
  if (n === 'invalid') return bad('Not en fazla 1000 karakter olmalı.', 'HK_INVALID');
  switch (b.action) {
    case 'start':
    case 'cancel':
      return { ok: true, value: { action: b.action } };
    case 'finish':
      return { ok: true, value: { action: 'finish', note: n } };
    case 'inspect':
      if (typeof b.passed !== 'boolean') return bad('Kontrol sonucu seçilmeli.');
      if (!b.passed && !n) return bad('Tekrar temizlik istenirken neyin eksik olduğunu yazın.', 'HK_NOTE_REQUIRED');
      return { ok: true, value: { action: 'inspect', passed: b.passed, note: n } };
    case 'assign':
      if (b.userId !== null && (typeof b.userId !== 'string' || !UUID.test(b.userId))) return bad('Personel geçersiz.');
      return { ok: true, value: { action: 'assign', userId: b.userId as string | null } };
    case 'note':
      if (!n) return bad('Not boş olamaz.', 'HK_INVALID');
      return { ok: true, value: { action: 'note', note: n } };
    default:
      return bad('Bilinmeyen görev işlemi.');
  }
}

export function parseTaskId(id: string): Parsed<string> {
  return UUID.test(id) ? { ok: true, value: id } : { ok: false, error: { status: 404, code: 'HK_NOT_FOUND', message: 'Görev bulunamadı.' } };
}
