'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { HkStaff, HkTask, HkTaskNote, HkTaskType, HousekeepingStatus, MemberRole, OccupancyStatus } from '@/types/database';
import { getBrowserClient } from '@/lib/supabase/client';
import { loadHkTasks } from '@/lib/housekeeping/load';
import { canAssign, canCancel, canCreate, canFinish, canInspect, canStart, finishLeadsTo, isSupervisor, minutesBetween } from '@/lib/housekeeping/permissions';
import { LABELS, ROLE_LABELS, type Lang } from '@/lib/i18n/labels';
import { AppNav } from '@/components/AppNav';
import { PreferenceToggles, usePreferences } from '@/components/Preferences';
import { Modal } from '@/components/reservations/Modal';

export type HkRoom = { id: string; number: string; floor: number | null; type: string; occupancy: OccupancyStatus; housekeeping: HousekeepingStatus; outOfOrder: boolean };
type Tab = 'mine' | 'unassigned' | 'inspect' | 'open' | 'done';

const T = {
  tr: {
    title: 'Housekeeping', tabs: { mine: 'Görevlerim', unassigned: 'Atanmamış', inspect: 'Kontrol bekleyen', open: 'Açık görevler', done: 'Bugün biten' } as Record<Tab, string>,
    status: { DIRTY: 'Kirli', IN_PROGRESS: 'Temizleniyor', INSPECTION_REQUIRED: 'Kontrol bekliyor', CLEAN: 'Temiz', CANCELLED: 'İptal' } as Record<string, string>,
    type: { CHECKOUT: 'Çıkış temizliği', STAYOVER: 'Konaklama temizliği', DEEP: 'Detaylı temizlik', TOUCH_UP: 'Kontrol / rötuş' } as Record<HkTaskType, string>,
    arrival: 'Bugün misafir geliyor', occupied: 'Misafir odada', start: 'Temizliğe başla', finish: 'Temizlik bitti', finishInspect: 'Bitti · kontrole gönder',
    approve: 'Onayla · Temiz', reject: 'Tekrar temizlensin', rejectNote: 'Eksik olan ne? (zorunlu)', send: 'Gönder', cancel: 'Vazgeç',
    note: 'Not ekle', notePh: 'Örn. lamba arızalı, havlu eksik', addNote: 'Notu kaydet', assignee: 'Görevli', unassigned: 'Atanmadı', assign: 'Ata',
    started: 'Başladı', finished: 'Bitti', inspected: 'Kontrol', minutes: 'dk', rework: 'tekrar', saving: 'Kaydediliyor…',
    newTask: '+ Görev oluştur', create: 'Görevi oluştur', room: 'Oda', taskType: 'Görev türü', priority: 'Öncelik', prio: { 1: 'Acil', 2: 'Normal', 3: 'Düşük' } as Record<number, string>,
    noteOpt: 'Not (isteğe bağlı)', empty: 'Bu listede görev yok.', cancelTask: 'Görevi iptal et',
    setting: 'Kat şefi kontrolü zorunlu', settingOn: 'Açık: temizlik bitince oda "Kontrol bekliyor" olur; kat şefi onaylayınca Temiz olur.', settingOff: 'Kapalı: temizlik bitince oda doğrudan Temiz olur.',
    demo: 'Demo modu: görevler örnek veridir. Gerçek veritabanı bağlantısı olmadan hiçbir görev tamamlandı gösterilmez.',
    done: { start: 'Temizlik başladı', finishInspect: 'Kontrole gönderildi', clean: 'Oda temiz · resepsiyon panosu güncellendi', reject: 'Tekrar temizliğe gönderildi', note: 'Not kaydedildi', assign: 'Görev atandı', cancel: 'Görev iptal edildi', create: 'Görev oluşturuldu', setting: 'Ayar kaydedildi' },
    network: 'Sunucuya ulaşılamadı. İşlem kaydedilmedi; tekrar deneyin.', live: 'Canlı', connecting: 'Bağlanıyor', offline: 'Bağlantı yok',
    summary: { DIRTY: 'Kirli', IN_PROGRESS: 'Temizleniyor', INSPECTION_REQUIRED: 'Kontrol', CLEAN: 'Bugün temiz' } as Record<string, string>
  },
  en: {
    title: 'Housekeeping', tabs: { mine: 'My tasks', unassigned: 'Unassigned', inspect: 'To inspect', open: 'Open tasks', done: 'Done today' } as Record<Tab, string>,
    status: { DIRTY: 'Dirty', IN_PROGRESS: 'In progress', INSPECTION_REQUIRED: 'Inspection', CLEAN: 'Clean', CANCELLED: 'Cancelled' } as Record<string, string>,
    type: { CHECKOUT: 'Departure clean', STAYOVER: 'Stayover clean', DEEP: 'Deep clean', TOUCH_UP: 'Touch-up' } as Record<HkTaskType, string>,
    arrival: 'Guest arriving today', occupied: 'Guest in room', start: 'Start cleaning', finish: 'Cleaning done', finishInspect: 'Done · send to inspection',
    approve: 'Approve · Clean', reject: 'Needs re-cleaning', rejectNote: 'What is missing? (required)', send: 'Send', cancel: 'Cancel',
    note: 'Add note', notePh: 'e.g. lamp broken, towels missing', addNote: 'Save note', assignee: 'Assignee', unassigned: 'Unassigned', assign: 'Assign',
    started: 'Started', finished: 'Finished', inspected: 'Inspected', minutes: 'min', rework: 'rework', saving: 'Saving…',
    newTask: '+ Create task', create: 'Create task', room: 'Room', taskType: 'Task type', priority: 'Priority', prio: { 1: 'Urgent', 2: 'Normal', 3: 'Low' } as Record<number, string>,
    noteOpt: 'Note (optional)', empty: 'No tasks in this list.', cancelTask: 'Cancel task',
    setting: 'Supervisor inspection required', settingOn: 'On: a finished room becomes "Inspection" and turns Clean after supervisor approval.', settingOff: 'Off: a finished room becomes Clean directly.',
    demo: 'Demo mode: sample tasks. Without a real database connection no task is ever shown as completed.',
    done: { start: 'Cleaning started', finishInspect: 'Sent to inspection', clean: 'Room clean · front desk board updated', reject: 'Sent back for re-cleaning', note: 'Note saved', assign: 'Task assigned', cancel: 'Task cancelled', create: 'Task created', setting: 'Setting saved' },
    network: 'Server unreachable. Nothing was saved; please try again.', live: 'Live', connecting: 'Connecting', offline: 'Offline',
    summary: { DIRTY: 'Dirty', IN_PROGRESS: 'In progress', INSPECTION_REQUIRED: 'Inspection', CLEAN: 'Clean today' } as Record<string, string>
  }
};
const TONE: Record<string, string> = { DIRTY: 'tone-amber', IN_PROGRESS: 'tone-blue', INSPECTION_REQUIRED: 'tone-violet', CLEAN: 'tone-green', CANCELLED: 'tone-slate' };
const OPEN = new Set(['DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED']);

type Result<T> = { ok: true; data: T } | { ok: false; message: string };
async function post<T>(url: string, body: unknown, lang: Lang): Promise<Result<T>> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    if (res.ok && json) return { ok: true, data: json };
    return { ok: false, message: json?.error?.message ?? T[lang].network };
  } catch {
    return { ok: false, message: T[lang].network };
  }
}

export function HousekeepingBoard({
  demo, property, role, userId, today, rooms, arrivals, staff, initialTasks, initialNotes
}: {
  demo: boolean;
  property: { id: string; name: string; code: string; requireInspection: boolean };
  role: MemberRole;
  userId: string | null;
  today: string;
  rooms: HkRoom[];
  arrivals: string[];
  staff: HkStaff[];
  initialTasks: HkTask[];
  initialNotes: HkTaskNote[];
}) {
  const { lang } = usePreferences();
  const t = T[lang];
  const [tasks, setTasks] = useState(initialTasks);
  const [notes, setNotes] = useState(initialNotes);
  const [requireInspection, setRequireInspection] = useState(property.requireInspection);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [live, setLive] = useState<'demo' | 'connecting' | 'live' | 'offline'>(demo ? 'demo' : 'connecting');
  const [creating, setCreating] = useState(false);
  const supervisor = isSupervisor(role);
  const [tab, setTab] = useState<Tab>(() => {
    if (role === 'housekeeping') return initialTasks.some((x) => x.assigned_to === userId && OPEN.has(x.status)) ? 'mine' : 'unassigned';
    return supervisor && initialTasks.some((x) => x.status === 'INSPECTION_REQUIRED') ? 'inspect' : 'open';
  });

  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);
  const arrivalSet = useMemo(() => new Set(arrivals), [arrivals]);
  const staffName = useMemo(() => new Map(staff.map((s) => [s.user_id, s.display_name])), [staff]);
  const notesByTask = useMemo(() => {
    const m = new Map<string, HkTaskNote[]>();
    for (const n of notes) m.set(n.task_id, [...(m.get(n.task_id) ?? []), n]);
    return m;
  }, [notes]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 4500);
    return () => clearTimeout(id);
  }, [flash]);

  // ---------- realtime: any device's change reloads the list ----------
  const reload = useCallback(async () => {
    const supabase = getBrowserClient();
    if (!supabase) return;
    try {
      const fresh = await loadHkTasks(supabase, property.id, today);
      setTasks(fresh.tasks);
      setNotes(fresh.notes);
    } catch {
      setLive('offline');
    }
  }, [property.id, today]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (demo) return;
    const supabase = getBrowserClient();
    if (!supabase) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void reloadRef.current(), 200);
    };
    const channel = supabase
      .channel(`hk:${property.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hk_tasks', filter: `property_id=eq.${property.id}` }, kick)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'hk_task_notes', filter: `property_id=eq.${property.id}` }, kick)
      .subscribe((s) => setLive(s === 'SUBSCRIBED' ? 'live' : s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED' ? 'offline' : 'connecting'));
    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [demo, property.id]);

  // ---------- actions: shown as done only with the row the database returned ----------
  const act = async (task: HkTask, body: Record<string, unknown>, done: string) => {
    if (demo) {
      setFlash({ kind: 'err', text: t.demo });
      return false;
    }
    setBusy(task.id);
    const r = await post<{ task?: HkTask; note?: HkTaskNote }>(`/api/housekeeping/tasks/${task.id}`, body, lang);
    setBusy(null);
    if (!r.ok) {
      setFlash({ kind: 'err', text: r.message });
      return false;
    }
    if (r.data.task) setTasks((list) => list.map((x) => (x.id === r.data.task!.id ? r.data.task! : x)));
    if (r.data.note) setNotes((list) => [...list, r.data.note!]);
    const roomNo = roomById.get(task.room_id)?.number ?? '';
    setFlash({ kind: 'ok', text: `${roomNo} · ${done}` });
    return true;
  };

  const visible = useMemo(() => {
    const byTab: Record<Tab, (x: HkTask) => boolean> = {
      mine: (x) => OPEN.has(x.status) && x.assigned_to === userId,
      unassigned: (x) => OPEN.has(x.status) && x.assigned_to === null,
      inspect: (x) => x.status === 'INSPECTION_REQUIRED',
      open: (x) => OPEN.has(x.status),
      done: (x) => (x.status === 'CLEAN' || x.status === 'CANCELLED') && (x.completed_at ?? '') >= today
    };
    const order: Record<string, number> = { INSPECTION_REQUIRED: 0, IN_PROGRESS: 1, DIRTY: 2, CLEAN: 3, CANCELLED: 4 };
    return tasks.filter(byTab[tab]).sort((a, b) =>
      a.priority - b.priority || (order[a.status] ?? 9) - (order[b.status] ?? 9) ||
      (roomById.get(a.room_id)?.number ?? '').localeCompare(roomById.get(b.room_id)?.number ?? '', undefined, { numeric: true }));
  }, [tasks, tab, userId, today, roomById]);

  const tabs: Tab[] = role === 'housekeeping' ? ['mine', 'unassigned', 'done'] : supervisor ? ['inspect', 'open', 'done'] : ['open', 'inspect', 'done'];
  const counts = {
    DIRTY: tasks.filter((x) => x.status === 'DIRTY').length,
    IN_PROGRESS: tasks.filter((x) => x.status === 'IN_PROGRESS').length,
    INSPECTION_REQUIRED: tasks.filter((x) => x.status === 'INSPECTION_REQUIRED').length,
    CLEAN: tasks.filter((x) => x.status === 'CLEAN' && (x.completed_at ?? '') >= today).length
  };

  const saveSetting = async (value: boolean) => {
    if (demo) return setFlash({ kind: 'err', text: t.demo });
    setBusy('setting');
    const r = await post<{ requireInspection: boolean }>('/api/housekeeping/settings', { propertyId: property.id, requireInspection: value }, lang);
    setBusy(null);
    if (!r.ok) return setFlash({ kind: 'err', text: r.message });
    setRequireInspection(r.data.requireInspection);
    setFlash({ kind: 'ok', text: t.done.setting });
  };

  return (
    <div className="mx-auto max-w-6xl px-3 pb-24 pt-5 sm:px-6">
      {demo && <div role="status" className="tone tone-amber mb-4 rounded-xl px-4 py-2.5 text-[13px] font-medium">{t.demo}</div>}
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">AXON PMS · {property.code}</p>
          <h1 className="mt-1 font-display text-[1.6rem] font-semibold tracking-tight text-ink sm:text-[2rem]">{t.title}</h1>
          <p className="mt-0.5 flex items-center gap-2 text-[13px] text-mist">
            {property.name} · {ROLE_LABELS[lang][role]}
            {live !== 'demo' && (
              <span className="inline-flex items-center gap-1.5">· <span className={`h-2 w-2 rounded-full ${live === 'live' ? 'bg-emerald-400' : live === 'connecting' ? 'bg-amber-400' : 'bg-rose-400'}`} />{t[live]}</span>
            )}
          </p>
        </div>
        <PreferenceToggles />
      </header>
      <AppNav role={role} />

      <div className="mb-4 grid grid-cols-4 gap-2">
        {(['DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED', 'CLEAN'] as const).map((k) => (
          <div key={k} className={`tone ${TONE[k]} rounded-xl px-2 py-2 text-center`}>
            <p className="font-display text-[22px] font-semibold leading-none">{counts[k]}</p>
            <p className="mt-1 text-[10.5px] font-medium leading-tight sm:text-[11.5px]">{t.summary[k]}</p>
          </div>
        ))}
      </div>

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-2xl border border-silver/15 bg-navy-800/60 p-1">
        {tabs.map((k) => (
          <button key={k} type="button" onClick={() => setTab(k)} aria-pressed={tab === k}
            className={`min-h-[44px] flex-1 whitespace-nowrap rounded-xl px-3 text-[14px] font-semibold transition ${tab === k ? 'bg-gold/15 text-gold' : 'text-mist'}`}>
            {t.tabs[k]}
          </button>
        ))}
      </div>

      {canCreate(role) && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {canCreate(role) && <button type="button" className="btn-line min-h-[44px]" onClick={() => setCreating(true)}>{t.newTask}</button>}
          {(role === 'owner' || role === 'manager') && (
            <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-[13px] text-ink">
              <input type="checkbox" className="h-5 w-5" checked={requireInspection} disabled={busy === 'setting'} onChange={(e) => void saveSetting(e.target.checked)} />
              <span><b>{t.setting}</b><span className="block text-[11.5px] text-mist">{requireInspection ? t.settingOn : t.settingOff}</span></span>
            </label>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="card p-6 text-center text-[14px] text-mist">{t.empty}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((task) => (
            <TaskCard key={task.id} task={task} room={roomById.get(task.room_id)} arrival={arrivalSet.has(task.room_id)} lang={lang} role={role} userId={userId}
              requireInspection={requireInspection} staff={staff} staffName={staffName} notes={notesByTask.get(task.id) ?? []} busy={busy === task.id} act={act} />
          ))}
        </div>
      )}

      {creating && (
        <CreateTask lang={lang} rooms={rooms.filter((r) => !r.outOfOrder && !tasks.some((x) => x.room_id === r.id && OPEN.has(x.status)))} staff={staff}
          canAssignStaff={supervisor} onClose={() => setCreating(false)}
          onSubmit={async (body) => {
            if (demo) {
              setFlash({ kind: 'err', text: t.demo });
              return false;
            }
            const r = await post<{ task: HkTask }>('/api/housekeeping/tasks', body, lang);
            if (!r.ok) {
              setFlash({ kind: 'err', text: r.message });
              return false;
            }
            setTasks((list) => [...list, r.data.task]);
            setFlash({ kind: 'ok', text: `${roomById.get(r.data.task.room_id)?.number ?? ''} · ${t.done.create}` });
            setCreating(false);
            void reload();
            return true;
          }} />
      )}

      {flash && (
        <div role={flash.kind === 'ok' ? 'status' : 'alert'}
          className={`tone ${flash.kind === 'ok' ? 'tone-green' : 'tone-rose'} fixed inset-x-3 bottom-4 z-[60] mx-auto max-w-md rounded-2xl px-4 py-3.5 text-[15px] font-semibold shadow-2xl backdrop-blur`}>
          {flash.kind === 'ok' ? '✓ ' : ''}{flash.text}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, room, arrival, lang, role, userId, requireInspection, staff, staffName, notes, busy, act }: {
  task: HkTask; room: HkRoom | undefined; arrival: boolean; lang: Lang; role: MemberRole; userId: string | null; requireInspection: boolean;
  staff: HkStaff[]; staffName: Map<string, string>; notes: HkTaskNote[]; busy: boolean;
  act: (task: HkTask, body: Record<string, unknown>, done: string) => Promise<boolean>;
}) {
  const t = T[lang];
  const [mode, setMode] = useState<'none' | 'note' | 'reject'>('none');
  const [text, setText] = useState('');
  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(lang === 'tr' ? 'tr-TR' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : '—');
  const cleanMin = minutesBetween(task.started_at, task.finished_at);
  const next = finishLeadsTo(role, requireInspection);
  const big = 'flex min-h-[56px] w-full items-center justify-center rounded-2xl px-4 text-[17px] font-semibold transition active:scale-[0.99] disabled:opacity-60';

  const submitText = async (e: FormEvent) => {
    e.preventDefault();
    const ok = mode === 'note'
      ? await act(task, { action: 'note', note: text }, t.done.note)
      : await act(task, { action: 'inspect', passed: false, note: text }, t.done.reject);
    if (ok) {
      setText('');
      setMode('none');
    }
  };

  return (
    <article className={`card flex flex-col gap-3 p-4 ${task.priority === 1 && OPEN.has(task.status) ? 'border-rose-400/50' : ''}`} aria-label={`${t.room} ${room?.number ?? ''}`}>
      <header className="flex items-start justify-between gap-2">
        <div>
          <p className="font-display text-[34px] font-semibold leading-none text-ink">{room?.number ?? '—'}</p>
          <p className="mt-1 text-[13px] text-mist">{t.type[task.task_type]}{room?.floor !== null && room?.floor !== undefined ? ` · ${LABELS[lang].ui.floor} ${room.floor}` : ''}{room?.type ? ` · ${room.type}` : ''}</p>
        </div>
        <span className={`tone ${TONE[task.status]} rounded-full px-3 py-1 text-[13px] font-semibold`}>{t.status[task.status]}</span>
      </header>
      <div className="flex flex-wrap gap-1.5 text-[12px] font-semibold">
        {arrival && OPEN.has(task.status) && <span className="tone tone-rose rounded-full px-2.5 py-1">⚑ {t.arrival}</span>}
        {room?.occupancy === 'OCCUPIED' && <span className="tone tone-slate rounded-full px-2.5 py-1">{t.occupied}</span>}
        {task.rework_count > 0 && <span className="tone tone-amber rounded-full px-2.5 py-1">↺ {task.rework_count} {t.rework}</span>}
      </div>

      <dl className="grid grid-cols-3 gap-2 text-[12px]">
        <div><dt className="text-mist">{t.assignee}</dt><dd className="font-semibold text-ink">{task.assigned_to ? staffName.get(task.assigned_to) ?? '•' : t.unassigned}</dd></div>
        <div><dt className="text-mist">{t.started}</dt><dd className="font-semibold text-ink">{time(task.started_at)}</dd></div>
        <div><dt className="text-mist">{t.finished}</dt><dd className="font-semibold text-ink">{time(task.finished_at)}{cleanMin !== null ? ` · ${cleanMin} ${t.minutes}` : ''}</dd></div>
      </dl>

      {notes.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-silver/[0.06] px-3 py-2 text-[13px] text-ink">
          {notes.slice(-3).map((n) => (
            <li key={n.id}><span className="text-mist">{time(n.created_at)} · {n.author_id ? staffName.get(n.author_id) ?? '' : ''}</span> {n.body}</li>
          ))}
        </ul>
      )}

      <div className="mt-auto flex flex-col gap-2">
        {canStart(task, role, userId) && (
          <button type="button" disabled={busy} className={`${big} btn-gold`} onClick={() => act(task, { action: 'start' }, t.done.start)}>
            {busy ? t.saving : `▶ ${t.start}`}
          </button>
        )}
        {canFinish(task, role, userId) && (
          <button type="button" disabled={busy} className={`${big} tone ${next === 'CLEAN' ? 'tone-green' : 'tone-violet'}`}
            onClick={() => act(task, { action: 'finish' }, next === 'CLEAN' ? t.done.clean : t.done.finishInspect)}>
            {busy ? t.saving : `✓ ${next === 'CLEAN' ? t.finish : t.finishInspect}`}
          </button>
        )}
        {canInspect(task, role) && mode !== 'reject' && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button type="button" disabled={busy} className={`${big} tone tone-green`} onClick={() => act(task, { action: 'inspect', passed: true }, t.done.clean)}>
              {busy ? t.saving : `✓ ${t.approve}`}
            </button>
            <button type="button" disabled={busy} className={`${big} tone tone-amber`} onClick={() => setMode('reject')}>↺ {t.reject}</button>
          </div>
        )}
        {mode !== 'none' && (
          <form onSubmit={submitText} className="flex flex-col gap-2">
            <textarea className="field min-h-[84px] text-[15px]" value={text} required maxLength={1000} autoFocus
              placeholder={mode === 'reject' ? t.rejectNote : t.notePh} onChange={(e) => setText(e.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className={`${big} btn-line`} onClick={() => { setMode('none'); setText(''); }}>{t.cancel}</button>
              <button type="submit" disabled={busy || !text.trim()} className={`${big} btn-gold`}>{busy ? t.saving : mode === 'reject' ? t.send : t.addNote}</button>
            </div>
          </form>
        )}
        {mode === 'none' && OPEN.has(task.status) && (
          <button type="button" className="min-h-[44px] rounded-xl text-[14px] font-semibold text-gold" onClick={() => setMode('note')}>✎ {t.note}</button>
        )}
        {canAssign(task, role) && (
          <label className="flex items-center gap-2 text-[13px] text-mist">
            {t.assign}
            <select className="field min-h-[44px] flex-1 py-2 text-[14px]" value={task.assigned_to ?? ''} disabled={busy}
              onChange={(e) => act(task, { action: 'assign', userId: e.target.value || null }, t.done.assign)}>
              <option value="">{t.unassigned}</option>
              {staff.map((s) => <option key={s.user_id} value={s.user_id}>{s.display_name}{s.role === 'hk_supervisor' ? ` (${ROLE_LABELS[lang].hk_supervisor})` : ''}</option>)}
            </select>
          </label>
        )}
        {canCancel(task, role) && (
          <button type="button" disabled={busy} className="min-h-[40px] text-[12.5px] text-rose-400" onClick={() => act(task, { action: 'cancel' }, t.done.cancel)}>{t.cancelTask}</button>
        )}
      </div>
    </article>
  );
}

function CreateTask({ lang, rooms, staff, canAssignStaff, onClose, onSubmit }: {
  lang: Lang; rooms: HkRoom[]; staff: HkStaff[]; canAssignStaff: boolean; onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const t = T[lang];
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    await onSubmit({
      roomId: String(f.get('roomId')),
      taskType: String(f.get('taskType')),
      priority: Number(f.get('priority')),
      assignedTo: String(f.get('assignedTo') ?? '') || null,
      note: String(f.get('note') ?? '').trim() || null
    });
    setPending(false);
  };
  const label = 'block text-[13px] font-medium text-mist';
  return (
    <Modal title={t.create} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className={label}>{t.room}
          <select name="roomId" required className="field mt-1 min-h-[48px] text-[16px]">
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.number}{r.type ? ` · ${r.type}` : ''}</option>)}
          </select>
        </label>
        <label className={label}>{t.taskType}
          <select name="taskType" defaultValue="STAYOVER" className="field mt-1 min-h-[48px] text-[16px]">
            {(Object.keys(t.type) as HkTaskType[]).map((k) => <option key={k} value={k}>{t.type[k]}</option>)}
          </select>
        </label>
        <label className={label}>{t.priority}
          <select name="priority" defaultValue="2" className="field mt-1 min-h-[48px] text-[16px]">
            {[1, 2, 3].map((p) => <option key={p} value={p}>{t.prio[p]}</option>)}
          </select>
        </label>
        {canAssignStaff && (
          <label className={label}>{t.assignee}
            <select name="assignedTo" defaultValue="" className="field mt-1 min-h-[48px] text-[16px]">
              <option value="">{t.unassigned}</option>
              {staff.map((s) => <option key={s.user_id} value={s.user_id}>{s.display_name}</option>)}
            </select>
          </label>
        )}
        <label className={label}>{t.noteOpt}
          <textarea name="note" maxLength={1000} className="field mt-1 min-h-[72px] text-[15px]" />
        </label>
        <button type="submit" disabled={pending || rooms.length === 0} className="btn-gold min-h-[56px] text-[17px]">{pending ? t.saving : t.create}</button>
      </form>
    </Modal>
  );
}
