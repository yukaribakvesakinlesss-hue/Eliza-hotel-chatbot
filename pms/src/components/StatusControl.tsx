'use client';
import type { StatusDimension } from '@/types/database';
import { statusLabel, LABELS, type Lang } from '@/lib/i18n/labels';
import { toneFor } from '@/lib/rooms/tones';

export type OptionState = { value: string; blockedBy: string | null };

/** One status dimension of a room: a labelled, colour-coded select. */
export function StatusControl({
  roomNumber,
  dimension,
  value,
  options,
  editable,
  busy,
  lang,
  onSelect
}: {
  roomNumber: string;
  dimension: StatusDimension;
  value: string;
  options: OptionState[];
  editable: boolean;
  busy: boolean;
  lang: Lang;
  onSelect: (value: string) => void;
}) {
  const id = `st-${roomNumber}-${dimension}`;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-[84px] shrink-0 text-[11px] font-medium uppercase tracking-wider text-mist">
        {LABELS[lang].dimension[dimension]}
      </label>
      <div className="relative min-w-0 flex-1">
        <select
          id={id}
          className={`status-select tone ${toneFor(dimension, value)} pr-7`}
          value={value}
          disabled={!editable}
          aria-busy={busy}
          onChange={(e) => onSelect(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.blockedBy !== null} title={o.blockedBy ?? undefined}>
              {statusLabel(lang, dimension, o.value)}
              {o.blockedBy ? ' ⛔' : ''}
            </option>
          ))}
        </select>
        <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] opacity-70">
          {editable ? '▾' : '🔒'}
        </span>
      </div>
    </div>
  );
}
