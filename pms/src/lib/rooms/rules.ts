/**
 * Room status engine · client-side mirror of app_private.room_status_guard().
 * The database is the authority; these rules only decide what the UI offers and
 * apply the same automatic effects optimistically (and in demo mode).
 */
import type { MemberRole, Room, StatusDimension } from '@/types/database';

export type RuleError = 'FORBIDDEN' | 'RULE_OUT_OF_ORDER' | 'RULE_OCCUPIED' | 'RULE_INSPECTION';

/** Housekeeping roles see only the housekeeping screens. */
export function isHousekeepingRole(role: MemberRole | null): boolean {
  return role === 'housekeeping' || role === 'hk_supervisor';
}

/** Which status dimensions a role may change. */
export function canChange(role: MemberRole | null, dimension: StatusDimension): boolean {
  if (!role) return false;
  if (role === 'owner' || role === 'manager' || role === 'front_desk') return true;
  return dimension === 'housekeeping';
}

/**
 * Validates a single status change and returns the resulting room (including automatic
 * effects) or the rule that blocks it.
 */
export function applyStatusChange(
  room: Room,
  dimension: StatusDimension,
  value: string,
  role: MemberRole | null,
  note?: string | null,
  now: string = new Date().toISOString(),
  userId: string | null = null,
  requireInspection = false
): { ok: true; room: Room } | { ok: false; error: RuleError } {
  if (!canChange(role, dimension)) return { ok: false, error: 'FORBIDDEN' };
  // mirrors RULE_INSPECTION in the database: housekeeping staff never mark a room CLEAN when inspection is required
  if (dimension === 'housekeeping' && value === 'CLEAN' && room.housekeeping_status !== 'CLEAN' && role === 'housekeeping' && requireInspection)
    return { ok: false, error: 'RULE_INSPECTION' };
  const next: Room = { ...room };

  if (dimension === 'occupancy') {
    next.occupancy_status = value as Room['occupancy_status'];
    if (next.occupancy_status === 'OCCUPIED' && room.occupancy_status !== 'OCCUPIED' && room.maintenance_status === 'OUT_OF_ORDER') {
      return { ok: false, error: 'RULE_OUT_OF_ORDER' };
    }
    // check-out: the room needs cleaning
    if (room.occupancy_status === 'OCCUPIED' && next.occupancy_status === 'VACANT') next.housekeeping_status = 'DIRTY';
  } else if (dimension === 'housekeeping') {
    next.housekeeping_status = value as Room['housekeeping_status'];
  } else {
    next.maintenance_status = value as Room['maintenance_status'];
    if (next.maintenance_status === 'OUT_OF_ORDER' && room.maintenance_status !== 'OUT_OF_ORDER' && room.occupancy_status === 'OCCUPIED') {
      return { ok: false, error: 'RULE_OCCUPIED' };
    }
    if (next.maintenance_status === 'OUT_OF_ORDER') next.maintenance_note = note?.trim() ? note.trim() : room.maintenance_note;
    if (next.maintenance_status === 'OPERATIONAL' && room.maintenance_status === 'OUT_OF_ORDER') next.maintenance_note = null;
  }

  next.status_updated_at = now;
  next.status_updated_by = userId;
  return { ok: true, room: next };
}

/** Maps a Postgres/PostgREST error message to a rule code (or null). */
export function ruleFromError(message: string | undefined | null): RuleError | 'NOT_FOUND' | null {
  if (!message) return null;
  for (const code of ['RULE_OUT_OF_ORDER', 'RULE_OCCUPIED', 'RULE_INSPECTION', 'FORBIDDEN', 'NOT_FOUND'] as const) {
    if (message.includes(code)) return code;
  }
  return null;
}

/** A room is ready to sell tonight when it is vacant, clean and operational. */
export function isReady(room: Pick<Room, 'occupancy_status' | 'housekeeping_status' | 'maintenance_status'>): boolean {
  return room.occupancy_status === 'VACANT' && room.housekeeping_status === 'CLEAN' && room.maintenance_status === 'OPERATIONAL';
}
