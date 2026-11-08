'use client';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { RESERVATION_SOURCES, type Reservation, type ReservationSource, type RoomWithType } from '@/types/database';
import { addDays, nightsBetween, staysOverlap } from '@/lib/reservations/dates';
import { newIdempotencyKey, reservationsApi } from '@/lib/reservations/client';
import { RES_TEXT, SOURCE_LABELS } from '@/lib/i18n/reservations';
import type { Lang } from '@/lib/i18n/labels';
import { Modal } from './Modal';

export type QuickBookingDefaults = { roomId: string; checkIn: string };
export type ChannelOption = { code: string; name: string; commission_rate: number };

export function QuickBookingModal({
  lang,
  demo,
  propertyId,
  rooms,
  existing,
  today,
  defaults,
  channels,
  onClose,
  onCreated
}: {
  lang: Lang;
  demo: boolean;
  propertyId: string;
  rooms: RoomWithType[];
  existing: Pick<Reservation, 'id' | 'room_id' | 'check_in' | 'check_out' | 'status'>[];
  today: string;
  defaults: QuickBookingDefaults;
  channels: ChannelOption[];
  onClose: () => void;
  onCreated: (reservation: Reservation, guestName: string) => void;
}) {
  const t = RES_TEXT[lang];
  const [roomId, setRoomId] = useState(defaults.roomId);
  const [checkIn, setCheckIn] = useState(defaults.checkIn);
  const [checkOut, setCheckOut] = useState(addDays(defaults.checkIn, 1));
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [status, setStatus] = useState<'CONFIRMED' | 'PENDING'>('CONFIRMED');
  const [source, setSource] = useState<ReservationSource>('phone');
  const [rate, setRate] = useState('');
  const [channelCode, setChannelCode] = useState(channels[0]?.code ?? 'DIRECT');
  const [comp, setComp] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // one key per opened form: retries after a lost response replay the same booking instead of creating a second one
  const key = useRef(newIdempotencyKey());

  const room = rooms.find((r) => r.id === roomId);
  const max = room?.room_type?.max_occupancy ?? 2;
  const nights = nightsBetween(checkIn, checkOut);
  const localConflict = useMemo(
    () => existing.some((r) => r.room_id === roomId && r.status !== 'CANCELLED' && r.status !== 'NO_SHOW' && staysOverlap(r.check_in, r.check_out, checkIn, checkOut)),
    [existing, roomId, checkIn, checkOut]
  );

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    if (demo) {
      setError(t.demoNote);
      return;
    }
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const guestName = String(f.get('guestName') ?? '').trim();
    const nightlyRate = comp ? 0 : Number(rate.replace(',', '.') || '0');
    if (!Number.isFinite(nightlyRate) || nightlyRate < 0) {
      setPending(false);
      setError(lang === 'tr' ? 'Gecelik fiyat geçersiz.' : 'Invalid nightly rate.');
      return;
    }
    const res = await reservationsApi.create(
      {
        propertyId,
        roomId,
        checkIn,
        checkOut,
        adults,
        children,
        guestName,
        guestEmail: String(f.get('guestEmail') ?? '').trim() || null,
        guestPhone: String(f.get('guestPhone') ?? '').trim() || null,
        notes: String(f.get('notes') ?? '').trim() || null,
        source,
        status,
        nightlyRate: Math.round(nightlyRate * 100) / 100,
        channelCode,
        isComplimentary: comp
      },
      key.current
    );
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onCreated(res.reservation, guestName);
  };

  const label = 'block text-[12px] font-medium text-mist';
  return (
    <Modal title={t.quickBooking} onClose={onClose}>
      {demo && <p className="tone tone-amber mb-4 rounded-xl px-3 py-2 text-[12.5px]">{t.demoNote}</p>}
      <form className="grid grid-cols-2 gap-3" onSubmit={submit} noValidate>
        <label className={`${label} col-span-2`}>
          {t.guestName} *
          <input className="field mt-1" name="guestName" required minLength={2} maxLength={120} autoComplete="off" />
        </label>
        <label className={label}>
          {t.phone}
          <input className="field mt-1" name="guestPhone" type="tel" maxLength={30} />
        </label>
        <label className={label}>
          {t.email}
          <input className="field mt-1" name="guestEmail" type="email" maxLength={160} />
        </label>
        <label className={`${label} col-span-2`}>
          {t.room}
          <select className="field mt-1" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.number} · {r.room_type?.name ?? ''}{r.maintenance_status === 'OUT_OF_ORDER' ? ' ⚠' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {t.checkIn}
          <input
            className="field mt-1"
            type="date"
            min={today}
            value={checkIn}
            onChange={(e) => {
              const v = e.target.value;
              setCheckIn(v);
              if (v && checkOut <= v) setCheckOut(addDays(v, 1));
            }}
            required
          />
        </label>
        <label className={label}>
          {t.checkOut}
          <input className="field mt-1" type="date" min={checkIn ? addDays(checkIn, 1) : today} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} required />
        </label>
        <label className={label}>
          {t.adults}
          <input className="field mt-1" type="number" min={1} max={max} value={adults} onChange={(e) => setAdults(Number(e.target.value))} />
        </label>
        <label className={label}>
          {t.children}
          <input className="field mt-1" type="number" min={0} max={max} value={children} onChange={(e) => setChildren(Number(e.target.value))} />
        </label>
        <p className="col-span-2 -mt-1 text-[12px] text-mist">
          {nights > 0 ? `${nights} ${t.nights}` : '—'} · {t.capacity(max)}
        </p>
        <label className={label}>
          {t.status}
          <select className="field mt-1" value={status} onChange={(e) => setStatus(e.target.value as 'CONFIRMED' | 'PENDING')}>
            <option value="CONFIRMED">{lang === 'tr' ? 'Onaylı' : 'Confirmed'}</option>
            <option value="PENDING">{lang === 'tr' ? 'Beklemede' : 'Pending'}</option>
          </select>
        </label>
        <label className={label}>
          {t.source}
          <select className="field mt-1" value={source} onChange={(e) => setSource(e.target.value as ReservationSource)}>
            {RESERVATION_SOURCES.map((s) => (
              <option key={s} value={s}>{SOURCE_LABELS[lang][s]}</option>
            ))}
          </select>
        </label>
        <label className={label}>
          {lang === 'tr' ? 'Gecelik fiyat (vergi hariç)' : 'Nightly rate (excl. tax)'}
          <input className="field mt-1" inputMode="decimal" value={comp ? '0' : rate} disabled={comp} placeholder="0,00" onChange={(e) => setRate(e.target.value)} />
        </label>
        <label className={label}>
          {lang === 'tr' ? 'Satış kanalı' : 'Channel'}
          <select className="field mt-1" value={channelCode} onChange={(e) => setChannelCode(e.target.value)}>
            {channels.map((c) => (
              <option key={c.code} value={c.code}>{c.name} · %{Math.round(c.commission_rate * 1000) / 10}</option>
            ))}
          </select>
        </label>
        <label className="col-span-2 flex items-center gap-2 text-[12.5px] text-mist">
          <input type="checkbox" checked={comp} onChange={(e) => setComp(e.target.checked)} />
          {lang === 'tr' ? 'Complimentary (ücretsiz konaklama; gelire ve ADR\'ye girmez, ayrı raporlanır)' : 'Complimentary (free stay; excluded from revenue and ADR, reported separately)'}
        </label>
        {nights > 0 && !comp && Number(rate.replace(',', '.')) > 0 && (
          <p className="col-span-2 -mt-1 text-[12px] text-mist">
            {lang === 'tr' ? 'Toplam (vergi hariç)' : 'Total (excl. tax)'}: {(Number(rate.replace(',', '.')) * nights).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        )}
        <label className={`${label} col-span-2`}>
          {t.notes}
          <textarea className="field mt-1 min-h-[64px]" name="notes" maxLength={1000} />
        </label>

        {localConflict && <p className="tone tone-amber col-span-2 rounded-xl px-3 py-2 text-[12.5px]">{t.conflictHint}</p>}
        {error && (
          <p role="alert" className="tone tone-rose col-span-2 rounded-xl px-3 py-2 text-[13px] font-medium">
            {error}
          </p>
        )}
        <div className="col-span-2 mt-1 flex justify-end gap-2">
          <button type="button" className="btn-line" onClick={onClose}>{t.cancel}</button>
          <button type="submit" className="btn-gold" disabled={pending || nights < 1}>{pending ? t.saving : t.save}</button>
        </div>
      </form>
    </Modal>
  );
}
