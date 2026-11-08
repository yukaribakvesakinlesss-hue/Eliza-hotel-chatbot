'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MemberRole, Reservation, ReservationWithGuest, RoomWithType } from '@/types/database';
import { addDays, nightsBetween } from '@/lib/reservations/dates';
import { getBrowserClient } from '@/lib/supabase/client';
import { demoReservations } from '@/lib/demo/reservations';
import { RES_STATUS_LABELS, RES_STATUS_TONES, RES_TEXT } from '@/lib/i18n/reservations';
import { LABELS } from '@/lib/i18n/labels';
import { AppNav } from '@/components/AppNav';
import { PreferenceToggles, usePreferences } from '@/components/Preferences';
import { QuickBookingModal, type QuickBookingDefaults } from './QuickBookingModal';
import { ReservationPanel } from './ReservationPanel';

const DAYS = 14;
const COLS = `repeat(${DAYS}, minmax(52px, 1fr))`;
const HIDDEN = new Set(['CANCELLED', 'NO_SHOW']);

export type TapeProperty = { id: string; name: string; code: string };

export function TapeChart({
  demo,
  property,
  role,
  rooms,
  today,
  initialReservations
}: {
  demo: boolean;
  property: TapeProperty;
  role: MemberRole | null;
  rooms: RoomWithType[];
  today: string;
  initialReservations: ReservationWithGuest[];
}) {
  const { lang } = usePreferences();
  const t = RES_TEXT[lang];
  const canEdit = role === 'owner' || role === 'manager' || role === 'front_desk';
  const [from, setFrom] = useState(addDays(today, -1));
  const [list, setList] = useState<ReservationWithGuest[]>(initialReservations);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [booking, setBooking] = useState<QuickBookingDefaults | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const to = addDays(from, DAYS);
  const reqId = useRef(0);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  // ---------- load the visible window from the database ----------
  const load = useCallback(async () => {
    const my = ++reqId.current;
    if (demo) {
      setList(demoReservations(today).filter((r) => r.check_in < to && r.check_out > from));
      return;
    }
    const supabase = getBrowserClient();
    if (!supabase) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('reservations')
      .select('*')
      .eq('property_id', property.id)
      .lt('check_in', to)
      .gt('check_out', from)
      .not('status', 'in', '("CANCELLED","NO_SHOW")');
    let names = new Map<string, string>();
    if (!error && data && data.length) {
      // RLS returns guest names only to roles allowed to see them (not housekeeping)
      const { data: guests } = await supabase
        .from('reservation_guests')
        .select('reservation_id, full_name')
        .in('reservation_id', data.map((r) => r.id))
        .eq('is_primary', true);
      names = new Map((guests ?? []).map((g) => [g.reservation_id, g.full_name]));
    }
    if (my !== reqId.current) return; // a newer load started (user moved the window)
    setLoading(false);
    if (error) {
      setLoadError(lang === 'tr' ? 'Rezervasyonlar yüklenemedi.' : 'Could not load reservations.');
      return;
    }
    setLoadError(null);
    setList((data ?? []).map((r) => ({ ...r, guest_name: names.get(r.id) ?? null })));
  }, [demo, from, to, today, property.id, lang]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---------- realtime: any device's booking change reloads the window ----------
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (demo) return;
    const supabase = getBrowserClient();
    if (!supabase) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel(`reservations:${property.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations', filter: `property_id=eq.${property.id}` }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => void loadRef.current(), 250);
      })
      .subscribe();
    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [demo, property.id]);

  const visible = useMemo(() => list.filter((r) => !HIDDEN.has(r.status) && r.check_in < to && r.check_out > from), [list, from, to]);
  const byRoom = useMemo(() => {
    const m = new Map<string, ReservationWithGuest[]>();
    for (const r of visible) m.set(r.room_id, [...(m.get(r.room_id) ?? []), r]);
    return m;
  }, [visible]);
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(from, i)), [from]);
  const soldNights = visible.reduce((n, r) => n + Math.max(0, nightsBetween(r.check_in < from ? from : r.check_in, r.check_out > to ? to : r.check_out)), 0);
  const selectedRes = list.find((r) => r.id === selected) ?? null;

  const upsert = (res: Reservation, guestName?: string | null) =>
    setList((l) => {
      const prev = l.find((x) => x.id === res.id);
      const next: ReservationWithGuest = { ...res, guest_name: guestName ?? prev?.guest_name ?? null };
      return prev ? l.map((x) => (x.id === res.id ? next : x)) : [...l, next];
    });

  const dayLabel = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return {
      wd: d.toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-GB', { weekday: 'short', timeZone: 'UTC' }),
      dm: d.toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-GB', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }),
      weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6
    };
  };

  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-16 pt-6 sm:px-6">
      {demo && (
        <div role="status" className="tone tone-amber mb-5 rounded-xl px-4 py-2.5 text-[13px] font-medium">
          {LABELS[lang].ui.demo}
        </div>
      )}
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">AXON PMS · {property.code}</p>
          <h1 className="mt-1 font-display text-[1.7rem] font-semibold tracking-tight text-ink sm:text-[2.1rem]">{property.name}</h1>
          <p className="mt-1 text-[13px] text-mist">
            {t.title} · {t.sold}: {soldNights}/{rooms.length * DAYS}
            {loading && ' · …'}
          </p>
        </div>
        <PreferenceToggles />
      </header>
      <AppNav />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-line px-3 py-1.5" onClick={() => setFrom((f) => addDays(f, -7))}>{t.prev}</button>
        <button type="button" className="btn-line px-3 py-1.5" onClick={() => setFrom(addDays(today, -1))}>{t.today}</button>
        <button type="button" className="btn-line px-3 py-1.5" onClick={() => setFrom((f) => addDays(f, 7))}>{t.next}</button>
        {canEdit && rooms[0] && (
          <button type="button" className="btn-gold ml-auto" onClick={() => setBooking({ roomId: rooms[0]!.id, checkIn: today })}>
            + {t.newBooking}
          </button>
        )}
      </div>
      <p className="mb-3 text-[12px] text-mist">{t.legend}</p>
      {loadError && <p role="alert" className="tone tone-rose mb-3 rounded-xl px-3 py-2 text-[13px]">{loadError}</p>}

      <div className="card overflow-x-auto">
        <div className="min-w-[860px]" role="grid" aria-label={t.title}>
          {/* header */}
          <div className="sticky top-0 z-20 grid border-b border-silver/10 bg-navy-900" style={{ gridTemplateColumns: `96px minmax(0, 1fr)` }} role="row">
            <div className="sticky left-0 z-30 bg-navy-900 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-mist" role="columnheader">{t.room}</div>
            <div className="grid" style={{ gridTemplateColumns: COLS }}>
              {days.map((d) => {
                const l = dayLabel(d);
                return (
                  <div key={d} role="columnheader" className={`border-l border-silver/10 px-1 py-1.5 text-center text-[11px] leading-tight ${d === today ? 'bg-gold/15 font-semibold text-gold' : l.weekend ? 'text-ink' : 'text-mist'}`}>
                    <div className="capitalize">{l.wd}</div>
                    <div>{l.dm}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {rooms.map((room) => (
            <div key={room.id} className="grid border-b border-silver/[0.06]" style={{ gridTemplateColumns: `96px minmax(0, 1fr)` }} role="row">
              <div className="sticky left-0 z-10 flex flex-col justify-center bg-navy-800 px-3 py-1.5" role="rowheader">
                <span className="font-display text-[14px] font-semibold text-ink">
                  {room.number}
                  {room.maintenance_status === 'OUT_OF_ORDER' && <span title={room.maintenance_note ?? ''} className="ml-1 text-rose-400">⚠</span>}
                </span>
                <span className="truncate text-[10.5px] text-mist">{room.room_type?.code}</span>
              </div>
              <div className="grid h-11" style={{ gridTemplateColumns: COLS }}>
                {days.map((d, i) => {
                  const past = d < today;
                  return (
                    <button
                      key={d}
                      type="button"
                      role="gridcell"
                      style={{ gridColumn: `${i + 1} / ${i + 2}`, gridRow: 1 }}
                      disabled={past || !canEdit}
                      aria-label={`${t.room} ${room.number}, ${d}: ${t.newBooking}`}
                      onClick={() => setBooking({ roomId: room.id, checkIn: d })}
                      className={`border-l border-silver/[0.06] transition ${d === today ? 'bg-gold/[0.06]' : ''} ${past ? 'bg-silver/[0.03]' : 'hover:bg-gold/10'} disabled:cursor-default`}
                    />
                  );
                })}
                {(byRoom.get(room.id) ?? []).map((r) => {
                  const start = Math.max(0, nightsBetween(from, r.check_in));
                  const end = Math.min(DAYS, nightsBetween(from, r.check_out));
                  if (end <= start) return null;
                  const clippedLeft = r.check_in < from;
                  const clippedRight = r.check_out > to;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelected(r.id)}
                      style={{ gridColumn: `${start + 1} / ${end + 1}`, gridRow: 1 }}
                      title={`${r.code} · ${r.guest_name ?? t.guest} · ${RES_STATUS_LABELS[lang][r.status]}`}
                      className={`tone ${RES_STATUS_TONES[r.status]} relative z-[5] mx-[2px] my-1.5 flex min-w-0 items-center gap-1 overflow-hidden px-2 text-left text-[11.5px] font-semibold shadow-sm transition hover:brightness-110 ${clippedLeft ? 'rounded-l-none' : 'rounded-l-lg'} ${clippedRight ? 'rounded-r-none' : 'rounded-r-lg'}`}
                    >
                      <span className="truncate">{r.guest_name ?? t.guest}</span>
                      <span className="shrink-0 opacity-70">· {nightsBetween(r.check_in, r.check_out)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      {visible.length === 0 && !loading && <p className="mt-3 text-[13px] text-mist">{t.empty}</p>}

      <div className="mt-4 flex flex-wrap gap-2 text-[11.5px]">
        {(['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] as const).map((s) => (
          <span key={s} className={`tone ${RES_STATUS_TONES[s]} rounded-full px-2.5 py-0.5 font-semibold`}>{RES_STATUS_LABELS[lang][s]}</span>
        ))}
      </div>

      {booking && (
        <QuickBookingModal
          lang={lang}
          demo={demo}
          propertyId={property.id}
          rooms={rooms}
          existing={list}
          today={today}
          defaults={booking}
          onClose={() => setBooking(null)}
          onCreated={(res, guestName) => {
            setBooking(null);
            upsert(res, guestName);
            setToast(t.saved(res.code));
          }}
        />
      )}
      {selectedRes && (
        <ReservationPanel
          key={`${selectedRes.id}:${selectedRes.version}`}
          lang={lang}
          demo={demo}
          canEdit={canEdit}
          reservation={selectedRes}
          rooms={rooms}
          today={today}
          onClose={() => setSelected(null)}
          onChanged={(res, message) => {
            upsert(res);
            if (HIDDEN.has(res.status)) setSelected(null);
            setToast(message);
          }}
        />
      )}

      {toast && (
        <div role="status" className="tone tone-green fixed bottom-5 left-1/2 z-[60] w-[min(92vw,480px)] -translate-x-1/2 rounded-xl px-4 py-3 text-[13.5px] font-medium shadow-2xl backdrop-blur">
          ✓ {toast}
        </div>
      )}
    </div>
  );
}
