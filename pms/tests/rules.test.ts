import { describe, expect, it } from 'vitest';
import { applyStatusChange, canChange, isReady, ruleFromError } from '@/lib/rooms/rules';
import type { Room } from '@/types/database';

const base: Room = {
  id: 'r1', organization_id: 'o1', property_id: 'p1', room_type_id: 't1', number: '101', floor: 1,
  occupancy_status: 'VACANT', housekeeping_status: 'CLEAN', maintenance_status: 'OPERATIONAL', maintenance_note: null,
  status_updated_at: '2026-01-01T00:00:00.000Z', status_updated_by: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z'
};
const room = (patch: Partial<Room>): Room => ({ ...base, ...patch });
const NOW = '2026-11-08T10:00:00.000Z';

describe('canChange (mirrors the room_status_guard role rules)', () => {
  it('lets owner, manager and front desk change every dimension', () => {
    for (const role of ['owner', 'manager', 'front_desk'] as const)
      for (const d of ['occupancy', 'housekeeping', 'maintenance'] as const) expect(canChange(role, d)).toBe(true);
  });
  it('limits housekeeping staff to the housekeeping dimension', () => {
    expect(canChange('housekeeping', 'housekeeping')).toBe(true);
    expect(canChange('housekeeping', 'occupancy')).toBe(false);
    expect(canChange('housekeeping', 'maintenance')).toBe(false);
  });
  it('denies everything without a role', () => {
    expect(canChange(null, 'housekeeping')).toBe(false);
  });
});

describe('applyStatusChange', () => {
  it('check-out (OCCUPIED → VACANT) marks the room DIRTY', () => {
    const res = applyStatusChange(room({ occupancy_status: 'OCCUPIED' }), 'occupancy', 'VACANT', 'front_desk', null, NOW, 'u1');
    expect(res).toEqual({ ok: true, room: expect.objectContaining({ occupancy_status: 'VACANT', housekeeping_status: 'DIRTY', status_updated_at: NOW, status_updated_by: 'u1' }) });
  });
  it('RESERVED → VACANT does not dirty the room', () => {
    const res = applyStatusChange(room({ occupancy_status: 'RESERVED' }), 'occupancy', 'VACANT', 'owner');
    expect(res.ok && res.room.housekeeping_status).toBe('CLEAN');
  });
  it('blocks check-in to an out-of-order room', () => {
    expect(applyStatusChange(room({ maintenance_status: 'OUT_OF_ORDER' }), 'occupancy', 'OCCUPIED', 'owner')).toEqual({ ok: false, error: 'RULE_OUT_OF_ORDER' });
  });
  it('allows reserving an out-of-order room (only check-in is blocked)', () => {
    expect(applyStatusChange(room({ maintenance_status: 'OUT_OF_ORDER' }), 'occupancy', 'RESERVED', 'owner').ok).toBe(true);
  });
  it('blocks setting an occupied room out of order', () => {
    expect(applyStatusChange(room({ occupancy_status: 'OCCUPIED' }), 'maintenance', 'OUT_OF_ORDER', 'manager', 'leak')).toEqual({ ok: false, error: 'RULE_OCCUPIED' });
  });
  it('stores the trimmed note when a room goes out of order and clears it when repaired', () => {
    const broken = applyStatusChange(base, 'maintenance', 'OUT_OF_ORDER', 'owner', '  AC repair  ');
    expect(broken.ok && broken.room.maintenance_note).toBe('AC repair');
    if (!broken.ok) return;
    const fixed = applyStatusChange(broken.room, 'maintenance', 'OPERATIONAL', 'owner');
    expect(fixed.ok && fixed.room.maintenance_note).toBeNull();
  });
  it('rejects role violations with FORBIDDEN', () => {
    expect(applyStatusChange(base, 'occupancy', 'OCCUPIED', 'housekeeping')).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(applyStatusChange(base, 'housekeeping', 'DIRTY', 'housekeeping').ok).toBe(true);
  });
  it('does not mutate the input room', () => {
    const r = room({ occupancy_status: 'OCCUPIED' });
    applyStatusChange(r, 'occupancy', 'VACANT', 'owner');
    expect(r.occupancy_status).toBe('OCCUPIED');
    expect(r.housekeeping_status).toBe('CLEAN');
  });
});

describe('ruleFromError / isReady', () => {
  it('maps database error messages to rule codes', () => {
    expect(ruleFromError('RULE_OUT_OF_ORDER: room 304 is out of order')).toBe('RULE_OUT_OF_ORDER');
    expect(ruleFromError('FORBIDDEN: housekeeping can only change housekeeping_status')).toBe('FORBIDDEN');
    expect(ruleFromError('network down')).toBeNull();
    expect(ruleFromError(undefined)).toBeNull();
  });
  it('a room is ready only when vacant, clean and operational', () => {
    expect(isReady(base)).toBe(true);
    expect(isReady(room({ housekeeping_status: 'INSPECTION_REQUIRED' }))).toBe(false);
    expect(isReady(room({ occupancy_status: 'RESERVED' }))).toBe(false);
    expect(isReady(room({ maintenance_status: 'OUT_OF_ORDER' }))).toBe(false);
  });
});
