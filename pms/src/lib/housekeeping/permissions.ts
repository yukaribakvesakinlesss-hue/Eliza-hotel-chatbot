/**
 * What a role may do with a task · client mirror of the hk_* functions (the database decides).
 * Used to show only the buttons that will work.
 */
import type { HkTask, MemberRole } from '@/types/database';

const SUPERVISORS: readonly MemberRole[] = ['owner', 'manager', 'hk_supervisor'];
export const isSupervisor = (role: MemberRole | null) => role !== null && SUPERVISORS.includes(role);
const open = (t: Pick<HkTask, 'status'>) => t.status === 'DIRTY' || t.status === 'IN_PROGRESS' || t.status === 'INSPECTION_REQUIRED';

export function canStart(t: Pick<HkTask, 'status' | 'assigned_to'>, role: MemberRole | null, userId: string | null): boolean {
  if (t.status !== 'DIRTY') return false;
  if (isSupervisor(role)) return true;
  return role === 'housekeeping' && (t.assigned_to === null || t.assigned_to === userId);
}

export function canFinish(t: Pick<HkTask, 'status' | 'assigned_to'>, role: MemberRole | null, userId: string | null): boolean {
  if (t.status !== 'IN_PROGRESS') return false;
  if (isSupervisor(role)) return true;
  return role === 'housekeeping' && t.assigned_to !== null && t.assigned_to === userId;
}

export const canInspect = (t: Pick<HkTask, 'status'>, role: MemberRole | null) => t.status === 'INSPECTION_REQUIRED' && isSupervisor(role);
export const canAssign = (t: Pick<HkTask, 'status'>, role: MemberRole | null) => open(t) && isSupervisor(role);
export const canCancel = canAssign;
export const canCreate = (role: MemberRole | null) => role !== null && role !== 'housekeeping';

/** After "finish": inspection only when the setting is on and a housekeeper (not a supervisor) cleaned. */
export function finishLeadsTo(role: MemberRole | null, requireInspection: boolean): 'INSPECTION_REQUIRED' | 'CLEAN' {
  return requireInspection && role === 'housekeeping' ? 'INSPECTION_REQUIRED' : 'CLEAN';
}

export function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
}
