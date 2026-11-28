'use client';
import { memo, useState } from 'react';
import {
  HOUSEKEEPING_STATUSES,
  MAINTENANCE_STATUSES,
  OCCUPANCY_STATUSES,
  type MemberRole,
  type RoomWithType,
  type StatusDimension
} from '@/types/database';
import { applyStatusChange, canChange, isReady } from '@/lib/rooms/rules';
import { LABELS, type Lang } from '@/lib/i18n/labels';
import { StatusControl, type OptionState } from './StatusControl';

const VALUES: Record<StatusDimension, readonly string[]> = {
  occupancy: OCCUPANCY_STATUSES,
  housekeeping: HOUSEKEEPING_STATUSES,
  maintenance: MAINTENANCE_STATUSES
};
const DIMENSIONS: StatusDimension[] = ['occupancy', 'housekeeping', 'maintenance'];

export type ChangeHandler = (room: RoomWithType, dimension: StatusDimension, value: string, note?: string | null) => void;

function optionsFor(room: RoomWithType, dimension: StatusDimension, role: MemberRole | null, lang: Lang): OptionState[] {
  return VALUES[dimension].map((value) => {
    if (value === room[`${dimension}_status` as const]) return { value, blockedBy: null };
    const res = applyStatusChange(room, dimension, value, role);
    return { value, blockedBy: res.ok ? null : LABELS[lang].errors[res.error] };
  });
}

function RoomCardImpl({
  room,
  role,
  lang,
  busy,
  onChange
}: {
  room: RoomWithType;
  role: MemberRole | null;
  lang: Lang;
  busy: boolean;
  onChange: ChangeHandler;
}) {
  const t = LABELS[lang].ui;
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const ready = isReady(room);
  const ooo = room.maintenance_status === 'OUT_OF_ORDER';

  const select = (dimension: StatusDimension, value: string) => {
    if (dimension === 'maintenance' && value === 'OUT_OF_ORDER') {
      setNote(room.maintenance_note ?? '');
      setNoteOpen(true);
      return;
    }
    onChange(room, dimension, value);
  };

  return (
    <article
      className={`card relative flex flex-col gap-3 p-4 transition ${ooo ? 'border-rose-400/40' : ready ? 'border-emerald-400/30' : ''} ${busy ? 'opacity-80' : ''}`}
      aria-label={`${room.number} ${room.room_type?.name ?? ''}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <p className="font-display text-[22px] font-semibold leading-none text-ink">{room.number}</p>
          <p className="mt-1 text-[12px] text-mist">
            {room.room_type?.name ?? '—'}
            {room.floor !== null ? ` · ${t.floor} ${room.floor}` : ''}
          </p>
        </div>
        {ready && <span className="tone tone-green rounded-full px-2 py-0.5 text-[10.5px] font-semibold">{t.ready}</span>}
        {busy && <span className="text-[10.5px] text-mist">{t.saving}…</span>}
      </header>

      <div className="flex flex-col gap-1.5">
        {DIMENSIONS.map((d) => (
          <StatusControl
            key={d}
            roomNumber={room.number}
            dimension={d}
            value={room[`${d}_status` as const]}
            options={optionsFor(room, d, role, lang)}
            editable={canChange(role, d)}
            busy={busy}
            lang={lang}
            onSelect={(v) => select(d, v)}
          />
        ))}
      </div>

      {ooo && room.maintenance_note && !noteOpen && (
        <p className="tone tone-rose rounded-lg px-2.5 py-1.5 text-[12px]">⚠ {room.maintenance_note}</p>
      )}

      {noteOpen && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setNoteOpen(false);
            onChange(room, 'maintenance', 'OUT_OF_ORDER', note);
          }}
        >
          <label className="text-[11px] font-medium uppercase tracking-wider text-mist" htmlFor={`note-${room.id}`}>
            {t.noteTitle}
          </label>
          <input
            id={`note-${room.id}`}
            className="field py-2 text-[13px]"
            value={note}
            maxLength={500}
            placeholder={t.notePlaceholder}
            autoFocus
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <button type="submit" className="btn-gold px-4 py-1.5 text-[12.5px]">{t.save}</button>
            <button type="button" className="btn-line px-3 py-1.5 text-[12.5px]" onClick={() => setNoteOpen(false)}>{t.cancel}</button>
          </div>
        </form>
      )}

      <p className="text-[10.5px] text-mist/70">
        {t.updated}: {new Date(room.status_updated_at).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}
      </p>
    </article>
  );
}

export const RoomCard = memo(RoomCardImpl);
