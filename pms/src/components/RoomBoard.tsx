'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MemberRole, Room, RoomType, RoomWithType, StatusDimension } from '@/types/database';
import { applyStatusChange, isReady, ruleFromError } from '@/lib/rooms/rules';
import { LABELS, ROLE_LABELS } from '@/lib/i18n/labels';
import { getBrowserClient } from '@/lib/supabase/client';
import { PreferenceToggles, usePreferences } from './Preferences';
import { RoomCard, type ChangeHandler } from './RoomCard';

type Filter = 'all' | 'ready' | 'occupied' | 'dirty' | 'ooo';
type Live = 'demo' | 'connecting' | 'live' | 'offline';

export type BoardProperty = { id: string; name: string; code: string };
export type BoardRoomType = Pick<RoomType, 'id' | 'code' | 'name' | 'max_occupancy'>;

const MATCH: Record<Filter, (r: Room) => boolean> = {
  all: () => true,
  ready: isReady,
  occupied: (r) => r.occupancy_status === 'OCCUPIED',
  dirty: (r) => r.housekeeping_status === 'DIRTY' || r.housekeeping_status === 'INSPECTION_REQUIRED',
  ooo: (r) => r.maintenance_status === 'OUT_OF_ORDER'
};

const byNumber = (a: Room, b: Room) => a.number.localeCompare(b.number, undefined, { numeric: true });

export function RoomBoard({
  demo,
  property,
  role,
  userId,
  roomTypes,
  initialRooms
}: {
  demo: boolean;
  property: BoardProperty;
  role: MemberRole | null;
  userId: string | null;
  roomTypes: BoardRoomType[];
  initialRooms: RoomWithType[];
}) {
  const { lang } = usePreferences();
  const t = LABELS[lang].ui;
  const router = useRouter();
  const [rooms, setRooms] = useState<RoomWithType[]>(() => [...initialRooms].sort(byNumber));
  const [filter, setFilter] = useState<Filter>('all');
  const [floor, setFloor] = useState<number | 'all'>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [live, setLive] = useState<Live>(demo ? 'demo' : 'connecting');

  // the latest change per room; an older request finishing late must not overwrite a newer one
  const latest = useRef(new Map<string, number>());
  const seq = useRef(0);
  const types = useMemo(() => new Map(roomTypes.map((rt) => [rt.id, rt])), [roomTypes]);
  const withType = useCallback((r: Room): RoomWithType => ({ ...r, room_type: types.get(r.room_type_id) ?? null }), [types]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(id);
  }, [toast]);

  // ---------- realtime: every change by any device on this property ----------
  useEffect(() => {
    if (demo) return;
    const supabase = getBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel(`rooms:${property.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `property_id=eq.${property.id}` }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as Partial<Room>).id;
          if (id) setRooms((list) => list.filter((r) => r.id !== id));
          return;
        }
        const row = withType(payload.new as Room);
        setRooms((list) => {
          const i = list.findIndex((r) => r.id === row.id);
          if (i === -1) return [...list, row].sort(byNumber);
          const next = list.slice();
          next[i] = row;
          return next;
        });
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setLive('live');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setLive('offline');
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [demo, property.id, withType]);

  const setBusyFor = (id: string, on: boolean) =>
    setBusy((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // ---------- status change: validate → optimistic update → RPC → confirm or roll back ----------
  const change: ChangeHandler = useCallback(
    async (room, dimension: StatusDimension, value, note) => {
      const res = applyStatusChange(room, dimension, value, role, note, new Date().toISOString(), userId);
      if (!res.ok) {
        setToast(LABELS[lang].errors[res.error]);
        return;
      }
      const mySeq = ++seq.current;
      latest.current.set(room.id, mySeq);
      setRooms((list) => list.map((r) => (r.id === room.id ? { ...r, ...res.room } : r)));
      if (demo) return;

      const supabase = getBrowserClient();
      if (!supabase) return;
      setBusyFor(room.id, true);
      const { data, error } = await supabase.rpc('set_room_status', {
        p_room_id: room.id,
        p_dimension: dimension,
        p_value: value,
        p_note: note ?? null
      });
      if (latest.current.get(room.id) !== mySeq) return; // a newer change for this room is in flight
      setBusyFor(room.id, false);

      if (error) {
        const code = ruleFromError(error.message);
        setToast(LABELS[lang].errors[code ?? 'UNKNOWN']);
        // roll back to what the database really holds (falls back to the pre-change snapshot)
        const { data: fresh } = await supabase.from('rooms').select('*').eq('id', room.id).maybeSingle();
        if (latest.current.get(room.id) !== mySeq) return;
        setRooms((list) => list.map((r) => (r.id === room.id ? (fresh ? withType(fresh) : room) : r)));
        return;
      }
      if (data) setRooms((list) => list.map((r) => (r.id === room.id ? withType(data) : r)));
    },
    [demo, lang, role, userId, withType]
  );

  const floors = useMemo(() => [...new Set(rooms.map((r) => r.floor).filter((f): f is number => f !== null))].sort((a, b) => a - b), [rooms]);
  const counts = useMemo(
    () => ({
      all: rooms.length,
      ready: rooms.filter(MATCH.ready).length,
      occupied: rooms.filter(MATCH.occupied).length,
      dirty: rooms.filter(MATCH.dirty).length,
      ooo: rooms.filter(MATCH.ooo).length
    }),
    [rooms]
  );
  const visible = rooms.filter(
    (r) => MATCH[filter](r) && (floor === 'all' || r.floor === floor) && (!query.trim() || r.number.includes(query.trim()))
  );

  const signOut = async () => {
    await getBrowserClient()?.auth.signOut();
    router.replace('/login');
    router.refresh();
  };

  const liveLabel = live === 'demo' ? null : live === 'live' ? t.live : live === 'connecting' ? t.connecting : t.offline;
  const stats: { key: Filter; label: string; tone: string }[] = [
    { key: 'all', label: t.all, tone: 'tone-slate' },
    { key: 'ready', label: t.ready, tone: 'tone-green' },
    { key: 'occupied', label: t.occupied, tone: 'tone-violet' },
    { key: 'dirty', label: t.dirty, tone: 'tone-amber' },
    { key: 'ooo', label: t.ooo, tone: 'tone-rose' }
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6">
      {demo && (
        <div role="status" className="tone tone-amber mb-5 rounded-xl px-4 py-2.5 text-[13px] font-medium">
          {t.demo}
        </div>
      )}

      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">AXON PMS · {property.code}</p>
          <h1 className="mt-1 font-display text-[1.7rem] font-semibold tracking-tight text-ink sm:text-[2.1rem]">{property.name}</h1>
          <p className="mt-1 flex items-center gap-2 text-[13px] text-mist">
            <span>{t.rooms}</span>
            {role && <span>· {t.role}: {ROLE_LABELS[lang][role]}</span>}
            {liveLabel && (
              <span className="inline-flex items-center gap-1.5">
                · <span className={`h-2 w-2 rounded-full ${live === 'live' ? 'bg-emerald-400' : live === 'connecting' ? 'bg-amber-400' : 'bg-rose-400'}`} />
                {liveLabel}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PreferenceToggles />
          {!demo && (
            <button type="button" className="btn-line" onClick={signOut}>
              {t.signOut}
            </button>
          )}
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {stats.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={filter === s.key}
            onClick={() => setFilter(s.key)}
            className={`tone ${s.tone} rounded-xl px-3 py-2.5 text-left transition ${filter === s.key ? 'ring-2 ring-gold/50' : 'opacity-85 hover:opacity-100'}`}
          >
            <span className="block font-display text-[22px] font-semibold leading-none">{counts[s.key]}</span>
            <span className="mt-1 block text-[11.5px] font-medium">{s.label}</span>
          </button>
        ))}
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <button type="button" className={`btn-line px-3 py-1.5 ${floor === 'all' ? 'border-gold/60 text-gold' : ''}`} onClick={() => setFloor('all')}>
          {t.all}
        </button>
        {floors.map((f) => (
          <button key={f} type="button" className={`btn-line px-3 py-1.5 ${floor === f ? 'border-gold/60 text-gold' : ''}`} onClick={() => setFloor(f)}>
            {t.floor} {f}
          </button>
        ))}
        <input
          className="field ml-auto w-full max-w-[200px] py-1.5 text-[13px]"
          inputMode="numeric"
          placeholder={t.search}
          aria-label={t.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {visible.length === 0 ? (
        <p className="card p-8 text-center text-mist">{t.empty}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((r) => (
            <RoomCard key={r.id} room={r} role={role} lang={lang} busy={busy.has(r.id)} onChange={change} />
          ))}
        </div>
      )}

      {toast && (
        <div role="alert" className="tone tone-rose fixed bottom-5 left-1/2 z-50 w-[min(92vw,460px)] -translate-x-1/2 rounded-xl px-4 py-3 text-[13.5px] font-medium shadow-2xl backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  );
}
