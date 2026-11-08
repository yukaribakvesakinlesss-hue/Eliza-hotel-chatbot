'use client';
import { useState } from 'react';
import type { Reservation, ReservationStatus, ReservationWithGuest, RoomWithType } from '@/types/database';
import { addDays, formatDate, nightsBetween } from '@/lib/reservations/dates';
import { reservationsApi, type ApiResult } from '@/lib/reservations/client';
import { RES_STATUS_LABELS, RES_STATUS_TONES, RES_TEXT, SOURCE_LABELS } from '@/lib/i18n/reservations';
import type { Lang } from '@/lib/i18n/labels';
import { Modal } from './Modal';

/** Reservation details + every backend action (extend, change, confirm, check-in/out, no-show, cancel). */
export function ReservationPanel({
  lang,
  demo,
  canEdit,
  reservation,
  rooms,
  today,
  onClose,
  onChanged
}: {
  lang: Lang;
  demo: boolean;
  canEdit: boolean;
  reservation: ReservationWithGuest;
  rooms: RoomWithType[];
  today: string;
  onClose: () => void;
  onChanged: (reservation: Reservation, message: string) => void;
}) {
  const t = RES_TEXT[lang];
  const r = reservation;
  const room = rooms.find((x) => x.id === r.room_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [checkIn, setCheckIn] = useState(r.check_in);
  const [checkOut, setCheckOut] = useState(r.check_out);
  const [roomId, setRoomId] = useState(r.room_id);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');

  const active = r.status === 'PENDING' || r.status === 'CONFIRMED' || r.status === 'CHECKED_IN';
  const writable = canEdit && !demo && active;

  const run = async (fn: () => Promise<ApiResult>, message: (code: string) => string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onChanged(res.reservation, message(res.reservation.code));
  };

  const setStatus = (s: ReservationStatus) => run(() => reservationsApi.setStatus(r.id, s), t.updated);

  return (
    <Modal title={`${r.code} · ${r.guest_name ?? t.guest}`} onClose={onClose} wide>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13.5px] sm:grid-cols-3">
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-mist">{t.status}</dt>
          <dd className="mt-0.5"><span className={`tone ${RES_STATUS_TONES[r.status]} rounded-full px-2 py-0.5 text-[12px] font-semibold`}>{RES_STATUS_LABELS[lang][r.status]}</span></dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-mist">{t.room}</dt>
          <dd className="mt-0.5 text-ink">{room ? `${room.number} · ${room.room_type?.name ?? ''}` : '—'}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-mist">{t.dates}</dt>
          <dd className="mt-0.5 text-ink">
            {formatDate(r.check_in, lang)} → {formatDate(r.check_out, lang)} · {nightsBetween(r.check_in, r.check_out)} {t.nights}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-mist">{t.adults} / {t.children}</dt>
          <dd className="mt-0.5 text-ink">{r.adults} / {r.children}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-mist">{t.source}</dt>
          <dd className="mt-0.5 text-ink">{SOURCE_LABELS[lang][r.source]}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-mist">{t.version}</dt>
          <dd className="mt-0.5 text-ink">{r.version}</dd>
        </div>
        {r.notes && (
          <div className="col-span-full">
            <dt className="text-[11px] uppercase tracking-wider text-mist">{t.notes}</dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-ink">{r.notes}</dd>
          </div>
        )}
      </dl>

      {demo && <p className="tone tone-amber mt-4 rounded-xl px-3 py-2 text-[12.5px]">{t.demoNote}</p>}
      {!demo && !canEdit && <p className="tone tone-slate mt-4 rounded-xl px-3 py-2 text-[12.5px]">{t.readOnly}</p>}

      {writable && (
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className="btn-line" disabled={busy} onClick={() => run(() => reservationsApi.update(r.id, { checkOut: addDays(r.check_out, 1), expectedVersion: r.version }), t.updated)}>
            {t.extend}
          </button>
          {r.status !== 'CHECKED_IN' && (
            <button type="button" className="btn-line" disabled={busy} onClick={() => setEditing((v) => !v)}>{t.changeDates}</button>
          )}
          {r.status === 'PENDING' && <button type="button" className="btn-line" disabled={busy} onClick={() => setStatus('CONFIRMED')}>{t.confirm}</button>}
          {(r.status === 'PENDING' || r.status === 'CONFIRMED') && r.check_in <= today && (
            <>
              <button type="button" className="btn-gold" disabled={busy} onClick={() => setStatus('CHECKED_IN')}>{t.checkInBtn}</button>
              <button type="button" className="btn-line" disabled={busy} onClick={() => setStatus('NO_SHOW')}>{t.noShow}</button>
            </>
          )}
          {r.status === 'CHECKED_IN' && <button type="button" className="btn-gold" disabled={busy} onClick={() => setStatus('CHECKED_OUT')}>{t.checkOutBtn}</button>}
          {(r.status === 'PENDING' || r.status === 'CONFIRMED') && (
            <button type="button" className="btn-line border-rose-400/40 text-rose-400" disabled={busy} onClick={() => setCancelling((v) => !v)}>{t.cancelRes}</button>
          )}
        </div>
      )}

      {writable && editing && (
        <form
          className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => reservationsApi.update(r.id, { roomId, checkIn, checkOut, expectedVersion: r.version }), t.updated);
          }}
        >
          <label className="block text-[12px] font-medium text-mist">
            {t.checkIn}
            <input className="field mt-1" type="date" min={today} value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
          </label>
          <label className="block text-[12px] font-medium text-mist">
            {t.checkOut}
            <input className="field mt-1" type="date" min={addDays(checkIn, 1)} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
          </label>
          <label className="col-span-2 block text-[12px] font-medium text-mist sm:col-span-1">
            {t.room}
            <select className="field mt-1" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {rooms.map((x) => (
                <option key={x.id} value={x.id}>{x.number} · {x.room_type?.name ?? ''}</option>
              ))}
            </select>
          </label>
          <div className="col-span-full flex justify-end">
            <button type="submit" className="btn-gold" disabled={busy}>{busy ? t.saving : t.applyChange}</button>
          </div>
        </form>
      )}

      {writable && cancelling && (
        <form
          className="mt-4 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => reservationsApi.cancel(r.id, reason.trim() || null), t.cancelled);
          }}
        >
          <label className="block text-[12px] font-medium text-mist">
            {t.cancelReason}
            <input className="field mt-1" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="flex justify-end">
            <button type="submit" className="btn-line border-rose-400/50 text-rose-400" disabled={busy}>{t.cancelConfirm}</button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="tone tone-rose mt-4 rounded-xl px-3 py-2 text-[13px] font-medium">
          {error}
        </p>
      )}
    </Modal>
  );
}
