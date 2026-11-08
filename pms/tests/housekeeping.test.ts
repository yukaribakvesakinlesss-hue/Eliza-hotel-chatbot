import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { canAssign, canCancel, canCreate, canFinish, canInspect, canStart, finishLeadsTo, minutesBetween } from '@/lib/housekeeping/permissions';
import { parseCreateTask, parseTaskAction } from '@/lib/housekeeping/api';
import { applyStatusChange, canChange, isHousekeepingRole } from '@/lib/rooms/rules';
import { navItemsFor } from '@/components/AppNav';
import type { Room } from '@/types/database';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const task = (status: 'DIRTY' | 'IN_PROGRESS' | 'INSPECTION_REQUIRED' | 'CLEAN', assigned_to: string | null = null) => ({ status, assigned_to });

describe('task permissions (mirror of hk_* functions)', () => {
  it('a housekeeper starts unassigned tasks and their own, never someone else’s', () => {
    expect(canStart(task('DIRTY'), 'housekeeping', ME)).toBe(true);
    expect(canStart(task('DIRTY', ME), 'housekeeping', ME)).toBe(true);
    expect(canStart(task('DIRTY', OTHER), 'housekeeping', ME)).toBe(false);
    expect(canStart(task('IN_PROGRESS', ME), 'housekeeping', ME)).toBe(false);
    expect(canStart(task('DIRTY', OTHER), 'hk_supervisor', ME)).toBe(true);
    expect(canStart(task('DIRTY'), 'front_desk', ME)).toBe(false);
  });
  it('only the assignee (or a supervisor) finishes', () => {
    expect(canFinish(task('IN_PROGRESS', ME), 'housekeeping', ME)).toBe(true);
    expect(canFinish(task('IN_PROGRESS', OTHER), 'housekeeping', ME)).toBe(false);
    expect(canFinish(task('IN_PROGRESS', OTHER), 'manager', ME)).toBe(true);
  });
  it('inspection, assignment and cancel are for supervisors, managers and owners', () => {
    for (const r of ['hk_supervisor', 'manager', 'owner'] as const) {
      expect(canInspect(task('INSPECTION_REQUIRED'), r)).toBe(true);
      expect(canAssign(task('DIRTY'), r)).toBe(true);
    }
    for (const r of ['housekeeping', 'front_desk'] as const) {
      expect(canInspect(task('INSPECTION_REQUIRED'), r)).toBe(false);
      expect(canCancel(task('DIRTY'), r)).toBe(false);
    }
    expect(canAssign(task('CLEAN'), 'manager')).toBe(false);
  });
  it('front desk and supervisors create tasks; housekeepers do not', () => {
    expect(canCreate('front_desk')).toBe(true);
    expect(canCreate('hk_supervisor')).toBe(true);
    expect(canCreate('housekeeping')).toBe(false);
  });
  it('finish goes to inspection only for housekeepers when the setting is on', () => {
    expect(finishLeadsTo('housekeeping', true)).toBe('INSPECTION_REQUIRED');
    expect(finishLeadsTo('housekeeping', false)).toBe('CLEAN');
    expect(finishLeadsTo('hk_supervisor', true)).toBe('CLEAN');
  });
  it('cleaning time in minutes', () => {
    expect(minutesBetween('2026-11-08T10:00:00Z', '2026-11-08T10:27:30Z')).toBe(28);
    expect(minutesBetween(null, '2026-11-08T10:00:00Z')).toBeNull();
  });
});

describe('screens per role', () => {
  const hrefs = (r: Parameters<typeof navItemsFor>[0]) => navItemsFor(r).map((i) => i.href);
  it('housekeeping staff only see the housekeeping screen', () => {
    expect(hrefs('housekeeping')).toEqual(['/housekeeping']);
    expect(hrefs('hk_supervisor')).toEqual(['/housekeeping']);
    expect(isHousekeepingRole('hk_supervisor')).toBe(true);
  });
  it('front desk sees rooms, reservations and housekeeping; managers also reports', () => {
    expect(hrefs('front_desk')).toEqual(['/rooms', '/reservations', '/housekeeping']);
    expect(hrefs('manager')).toEqual(['/rooms', '/reservations', '/housekeeping', '/reports']);
  });
});

describe('room rules with inspection', () => {
  const room: Room = {
    id: 'r', organization_id: 'o', property_id: 'p', room_type_id: 't', number: '101', floor: 1, occupancy_status: 'VACANT',
    housekeeping_status: 'IN_PROGRESS', maintenance_status: 'OPERATIONAL', maintenance_note: null, status_updated_at: '', status_updated_by: null, created_at: '', updated_at: ''
  };
  it('a housekeeper cannot mark CLEAN when inspection is required (RULE_INSPECTION)', () => {
    expect(applyStatusChange(room, 'housekeeping', 'CLEAN', 'housekeeping', null, undefined, null, true)).toEqual({ ok: false, error: 'RULE_INSPECTION' });
    expect(applyStatusChange(room, 'housekeeping', 'CLEAN', 'housekeeping', null, undefined, null, false).ok).toBe(true);
    expect(applyStatusChange(room, 'housekeeping', 'CLEAN', 'hk_supervisor', null, undefined, null, true).ok).toBe(true);
  });
  it('supervisors are housekeeping staff for the other dimensions', () => {
    expect(canChange('hk_supervisor', 'occupancy')).toBe(false);
    expect(canChange('hk_supervisor', 'housekeeping')).toBe(true);
  });
});

describe('request validation', () => {
  it('reject during inspection needs a note', () => {
    expect(parseTaskAction({ action: 'inspect', passed: false }).ok).toBe(false);
    expect(parseTaskAction({ action: 'inspect', passed: false, note: 'Ayna lekeli' }).ok).toBe(true);
    expect(parseTaskAction({ action: 'inspect', passed: true }).ok).toBe(true);
  });
  it('unknown actions, empty notes and bad ids are rejected', () => {
    expect(parseTaskAction({ action: 'complete' }).ok).toBe(false);
    expect(parseTaskAction({ action: 'note', note: '   ' }).ok).toBe(false);
    expect(parseTaskAction({ action: 'assign', userId: 'x' }).ok).toBe(false);
    expect(parseTaskAction({ action: 'assign', userId: null }).ok).toBe(true);
  });
  it('create task: defaults and validation', () => {
    expect(parseCreateTask({ roomId: ME })).toEqual({ ok: true, value: { roomId: ME, taskType: 'STAYOVER', priority: 2, assignedTo: null, note: null } });
    expect(parseCreateTask({ roomId: ME, taskType: 'SPA' }).ok).toBe(false);
    expect(parseCreateTask({ roomId: ME, priority: 0 }).ok).toBe(false);
  });
});

// ---------- route: success only with a database row ----------
const state = vi.hoisted(() => ({ demo: false, rpc: vi.fn() }));
vi.mock('@/lib/config', () => ({ isDemoMode: () => state.demo, SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'x' }));
vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => (state.demo ? null : { auth: { getUser: async () => ({ data: { user: { id: ME } }, error: null }) }, rpc: state.rpc })
}));
const { POST: taskAction } = await import('@/app/api/housekeeping/tasks/[id]/route');
const TASK = '6f1c2b6e-3c1a-4f7e-9b1d-2a3b4c5d6e7f';
const req = (body: unknown) => new NextRequest(`http://pms.test/api/housekeeping/tasks/${TASK}`, {
  method: 'POST', headers: { host: 'pms.test', origin: 'http://pms.test', 'content-type': 'application/json' }, body: JSON.stringify(body)
});
const params = { params: Promise.resolve({ id: TASK }) };

describe('POST /api/housekeeping/tasks/:id', () => {
  beforeEach(() => {
    state.demo = false;
    state.rpc.mockReset();
  });
  it('returns the saved task row', async () => {
    state.rpc.mockResolvedValue({ data: { id: TASK, status: 'CLEAN' }, error: null });
    const res = await taskAction(req({ action: 'inspect', passed: true }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).task.status).toBe('CLEAN');
    expect(state.rpc).toHaveBeenCalledWith('hk_inspect_task', { p_task_id: TASK, p_passed: true, p_note: null });
  });
  it('never reports completion without a database row', async () => {
    state.rpc.mockResolvedValue({ data: null, error: null });
    const res = await taskAction(req({ action: 'finish' }), params);
    expect(res.status).toBe(500);
    expect((await res.json()).task).toBeUndefined();
  });
  it('passes database rules through as clear Turkish errors', async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: 'HK_NOT_YOURS: Bu görev başka bir personele atanmış.' } });
    const res = await taskAction(req({ action: 'start' }), params);
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('Bu görev başka bir personele atanmış.');
  });
  it('demo mode: 503, nothing completed', async () => {
    state.demo = true;
    const res = await taskAction(req({ action: 'finish' }), params);
    expect(res.status).toBe(503);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
