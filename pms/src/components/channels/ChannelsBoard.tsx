'use client';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { MemberRole, OtaChannel, OtaConnection, OtaInboundEvent, OtaRoomMapping, RoomType } from '@/types/database';
import { getBrowserClient } from '@/lib/supabase/client';
import { addDays, todayIn } from '@/lib/reservations/dates';
import { AppNav } from '@/components/AppNav';
import { PreferenceToggles } from '@/components/Preferences';
import { demoFreeRoom } from '@/lib/demo/crm';
import type { ReservationWithGuest } from '@/types/database';

type Props = {
  property: { id: string; code: string; currency: string };
  role: MemberRole;
  connections: OtaConnection[];
  mappings: OtaRoomMapping[];
  roomTypes: Pick<RoomType, 'id' | 'code' | 'name'>[];
  initialEvents: OtaInboundEvent[];
  openByConnection: Record<string, number>;
  deadByConnection: Record<string, number>;
  /** sales demo: actions run on local state; channel bookings are checked against the demo hotel's rooms */
  demo?: { today: string };
};
const NAME: Record<OtaChannel, string> = { BOOKING: 'Booking.com', EXPEDIA: 'Expedia' };
const STATUS: Record<string, { text: string; tone: string }> = {
  RECEIVED: { text: 'Alındı', tone: 'tone-slate' },
  PROCESSED: { text: 'İşlendi', tone: 'tone-green' },
  IGNORED: { text: 'Tekrar (yok sayıldı)', tone: 'tone-slate' },
  FAILED: { text: 'Tekrar denenecek', tone: 'tone-amber' },
  NEEDS_ATTENTION: { text: 'Müdahale gerekli', tone: 'tone-rose' },
  DEAD: { text: 'Denemeler bitti', tone: 'tone-rose' },
  DISMISSED: { text: 'Elle çözüldü', tone: 'tone-slate' }
};
const OUTCOME: Record<string, string> = {
  CREATED: 'Rezervasyon oluşturuldu', MODIFIED: 'Değişiklik uygulandı', MODIFIED_ROOM_CHANGED: 'Değişiklik uygulandı (oda değişti)',
  CANCELLED: 'Rezervasyon iptal edildi', DUPLICATE: 'Bu rezervasyon zaten vardı', ALREADY_CANCELLED: 'Zaten iptal edilmişti'
};
const outcomeText = (o: string) => OUTCOME[o] ?? o.replace(/^MANUAL: /, 'Elle çözüldü: ');
const KIND: Record<string, string> = { NEW: 'Yeni rezervasyon', MODIFY: 'Değişiklik', CANCEL: 'İptal' };
const when = (v: string | null) => (v ? new Date(v).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

async function post<T>(url: string, body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    return res.ok && json ? { ok: true, data: json } : { ok: false, message: json?.error?.message ?? 'İşlem tamamlanamadı.' };
  } catch {
    return { ok: false, message: 'Sunucuya ulaşılamadı; işlem kaydedilmedi.' };
  }
}

export function ChannelsBoard({ property, role, connections: initialConnections, mappings: initialMappings, roomTypes, initialEvents, openByConnection, deadByConnection, demo }: Props) {
  const [connections, setConnections] = useState(initialConnections);
  const [mappings, setMappings] = useState(initialMappings);
  const [events, setEvents] = useState(initialEvents);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const canManage = role === 'owner' || role === 'manager';
  const [open, setOpen] = useState(openByConnection);
  const [demoStays, setDemoStays] = useState<(ReservationWithGuest & { ext: string })[]>([]);
  const alarms = events.filter((e) => e.status === 'NEEDS_ATTENTION' || e.status === 'DEAD');
  const connName = useMemo(() => new Map(connections.map((c) => [c.id, NAME[c.channel_code]])), [connections]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(id);
  }, [flash]);

  const reload = async () => {
    const supabase = getBrowserClient();
    if (!supabase) return;
    const [{ data: e }, { data: c }, { data: m }] = await Promise.all([
      supabase.from('ota_inbound_events').select('*').eq('property_id', property.id).order('id', { ascending: false }).limit(50),
      supabase.from('ota_connections').select('*').eq('property_id', property.id).order('channel_code'),
      supabase.from('ota_room_mappings').select('*').eq('property_id', property.id)
    ]);
    if (e) setEvents(e);
    if (c) setConnections(c);
    if (m) setMappings(m);
  };

  useEffect(() => {
    const supabase = getBrowserClient();
    if (!supabase) return;
    const ch = supabase.channel(`ota-${property.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ota_inbound_events', filter: `property_id=eq.${property.id}` }, () => void reload())
      .subscribe();
    return () => void supabase.removeChannel(ch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property.id]);

  /** sales demo: same flow on local state (overbooking check against the demo hotel's rooms) */
  const demoRun = (url: string, body: Record<string, unknown>): { ok: true; data: Record<string, unknown> } | { ok: false; message: string } => {
    const now = new Date().toISOString();
    const queue = (nights: number) => setOpen((o) => Object.fromEntries(connections.map((c) => [c.id, (o[c.id] ?? 0) + nights * roomTypes.length])));
    if (url === '/api/ota/sync') {
      const claimed = Object.values(open).reduce((a, b) => a + b, 0);
      setOpen(Object.fromEntries(connections.map((c) => [c.id, 0])));
      setConnections((list) => list.map((c) => ({ ...c, last_push_at: now })));
      return { ok: true, data: { ota: { claimed, sent: 0, demo: claimed, retry: 0, rejected: 0, retriedOk: 0 } } };
    }
    switch (body.action) {
      case 'configure':
        return body.mode === 'LIVE' ? { ok: false, message: 'Demo: gerçek moda geçiş için kanalın iş ortağı erişimi ve sunucu anahtarları gerekir.' } : { ok: true, data: {} };
      case 'resync':
        queue(366);
        return { ok: true, data: { queued: 366 * roomTypes.length * connections.length } };
      case 'mapping': {
        const conn = connections.find((c) => c.channel_code === body.channel)!;
        const code = String(body.externalRoomId ?? '').trim();
        if (code && !/^[A-Za-z0-9_.:-]{1,40}$/.test(code)) return { ok: false, message: 'Kodlar yalnızca harf, rakam ve . _ : - içerebilir.' };
        if (code && mappings.some((m) => m.connection_id === conn.id && m.external_room_id === code && m.room_type_id !== body.roomTypeId)) return { ok: false, message: 'Bu kanal oda kodu başka bir oda tipine bağlı.' };
        setMappings((list) => [...list.filter((m) => !(m.connection_id === conn.id && m.room_type_id === body.roomTypeId)),
          ...(code ? [{ id: crypto.randomUUID(), organization_id: conn.organization_id, property_id: conn.property_id, connection_id: conn.id, room_type_id: String(body.roomTypeId), external_room_id: code, external_rate_plan_id: String(body.ratePlanId ?? 'BAR'), created_at: now }] : [])]);
        if (code) setOpen((o) => ({ ...o, [conn.id]: (o[conn.id] ?? 0) + 366 }));
        return { ok: true, data: {} };
      }
      case 'retry':
      case 'dismiss': {
        const ev = events.find((e) => e.id === body.eventId);
        if (!ev) return { ok: false, message: 'Kanal mesajı bulunamadı.' };
        const next: OtaInboundEvent = body.action === 'dismiss'
          ? { ...ev, status: 'DISMISSED', outcome: `MANUAL: ${String(body.note).slice(0, 200)}`, processed_at: now }
          : { ...ev, attempts: ev.attempts + 1, last_error: `${ev.last_error ?? ''} (demo: oda hâlâ dolu; önce bir rezervasyonu taşıyın ya da "Elle çözüldü" deyin)`.trim() };
        setEvents((list) => list.map((e) => (e.id === ev.id ? next : e)));
        return { ok: true, data: { event: next } };
      }
      case 'simulate': {
        const e = body.event as { event_id: string; kind: OtaInboundEvent['kind']; reservation_id: string; room_id?: string; check_in?: string; check_out?: string; total_amount?: number };
        const conn = connections.find((c) => c.channel_code === body.channel)!;
        const ext = `demo-${e.reservation_id}`;
        const base: OtaInboundEvent = { id: Date.now(), organization_id: conn.organization_id, property_id: conn.property_id, connection_id: conn.id, external_event_id: `demo-${e.event_id}`,
          kind: e.kind, external_reservation_id: ext, payload: {}, is_demo: true, status: 'PROCESSED', outcome: null, attempts: 1, next_attempt_at: null, last_error: null,
          reservation_id: null, received_at: now, processed_at: now, handled_by: null };
        const existing = demoStays.find((r) => r.ext === ext && r.status !== 'CANCELLED');
        let ev: OtaInboundEvent;
        if (e.kind === 'CANCEL' || e.kind === 'MODIFY') {
          if (!existing) ev = { ...base, status: 'FAILED', processed_at: null, next_attempt_at: new Date(Date.now() + 120_000).toISOString(), last_error: `OTA_NOT_FOUND: ${NAME[conn.channel_code]} rezervasyonu ${ext} henüz sistemde yok; yeni rezervasyon mesajı gelince otomatik işlenecek.` };
          else if (e.kind === 'CANCEL') {
            setDemoStays((l) => l.map((r) => (r.ext === ext ? { ...r, status: 'CANCELLED' } : r)));
            ev = { ...base, outcome: 'CANCELLED' };
          } else {
            const map = mappings.find((m) => m.connection_id === conn.id && m.external_room_id === e.room_id);
            const others = demoStays.filter((r) => r.ext !== ext);
            const room = map ? demoFreeRoom(demo!.today, map.room_type_id, e.check_in!, e.check_out!, others) : null;
            if (!room) ev = { ...base, status: 'NEEDS_ATTENTION', processed_at: null, last_error: 'OTA_NO_ROOM: Değişiklik için boş oda yok; rezervasyon eski haliyle duruyor.' };
            else {
              setDemoStays((l) => l.map((r) => (r.ext === ext ? { ...r, room_id: room, check_in: e.check_in!, check_out: e.check_out! } : r)));
              ev = { ...base, outcome: room === existing.room_id ? 'MODIFIED' : 'MODIFIED_ROOM_CHANGED' };
            }
          }
        } else if (existing) {
          ev = { ...base, status: 'IGNORED', outcome: 'DUPLICATE' };
        } else {
          const map = mappings.find((m) => m.connection_id === conn.id && m.external_room_id === e.room_id);
          const room = map ? demoFreeRoom(demo!.today, map.room_type_id, e.check_in!, e.check_out!, demoStays) : null;
          if (!map) ev = { ...base, status: 'NEEDS_ATTENTION', processed_at: null, last_error: `OTA_MAPPING: Kanal oda kodu "${e.room_id}" hiçbir oda tipiyle eşleşmiyor.` };
          else if (!room) ev = { ...base, status: 'NEEDS_ATTENTION', processed_at: null, last_error: `OTA_NO_ROOM: ${NAME[conn.channel_code]} için seçilen tarihlerde boş ${roomTypes.find((r) => r.id === map.room_type_id)?.name} odası yok. Kanal oda sattı: aşırı rezervasyon, hemen müdahale edin.` };
          else {
            setDemoStays((l) => [...l, { id: crypto.randomUUID(), room_id: room, check_in: e.check_in!, check_out: e.check_out!, status: 'CONFIRMED', ext } as ReservationWithGuest & { ext: string }]);
            ev = { ...base, outcome: 'CREATED' };
            queue(Math.max(1, Math.round((Date.parse(e.check_out!) - Date.parse(e.check_in!)) / 86_400_000)) / roomTypes.length);
          }
        }
        setEvents((list) => [ev, ...list]);
        return { ok: true, data: { event: ev } };
      }
      default:
        return { ok: false, message: 'Bu işlem demoda kapalı.' };
    }
  };

  const run = async (url: string, body: Record<string, unknown>, success: (d: Record<string, unknown>) => string) => {
    if (demo) {
      const r = demoRun(url, body);
      if (!r.ok) {
        setFlash({ ok: false, text: r.message });
        return false;
      }
      setFlash({ ok: true, text: `${success(r.data)} (demo)` });
      return true;
    }
    setBusy(true);
    const r = await post<Record<string, unknown>>(url, body);
    setBusy(false);
    if (!r.ok) {
      setFlash({ ok: false, text: r.message });
      return false;
    }
    setFlash({ ok: true, text: success(r.data) });
    await reload();
    return true;
  };

  const sync = () => run('/api/ota/sync', { propertyId: property.id }, (d) => {
    const o = d.ota as { claimed: number; sent: number; demo: number; retry: number; rejected: number; retriedOk: number };
    if (!o.claimed) return 'Gönderilecek müsaitlik/fiyat değişikliği yok.';
    return `${o.claimed} gece işlendi: ${o.sent} gönderildi, ${o.demo} DEMO (dışarı gönderilmedi), ${o.retry} tekrar denenecek, ${o.rejected} reddedildi.`;
  });

  return (
    <div className="mx-auto max-w-[1400px] px-3 pb-16 pt-5 sm:px-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">AXON PMS · {property.code}</p>
          <h1 className="mt-1 font-display text-[1.6rem] font-semibold tracking-tight text-ink sm:text-[2rem]">Kanal yöneticisi</h1>
          <p className="mt-0.5 text-[13px] text-mist">Booking.com · Expedia — müsaitlik, fiyat, rezervasyon, değişiklik ve iptal</p>
        </div>
        <PreferenceToggles />
      </header>
      <AppNav role={role} />
      {demo && <p className="tone tone-amber mb-3 rounded-xl px-4 py-2.5 text-[13px]">Demo: Booking.com ve Expedia bağlı değil. Sağdaki simülatörle kanaldan rezervasyon, değişiklik veya iptal gelmiş gibi deneyin; boş oda yoksa sistem rezervasyonu sıkıştırmaz, alarm verir. Değişiklikler bu tarayıcıda kalır.</p>}

      {alarms.length > 0 && (
        <p role="alert" className="tone tone-rose mb-3 rounded-xl px-4 py-3 text-[14px] font-semibold">
          {alarms.length} kanal mesajı müdahale bekliyor (ör. aşırı rezervasyon veya eşleşmeyen oda kodu). Aşağıdaki listeden çözün.
        </p>
      )}

      <section className="grid gap-3 md:grid-cols-2">
        {connections.map((c) => (
          <ConnectionCard key={c.id} c={c} open={open[c.id] ?? 0} dead={deadByConnection[c.id] ?? 0} canManage={canManage} busy={busy}
            onSave={(mode, hotelId) => run('/api/ota', { action: 'configure', propertyId: property.id, channel: c.channel_code, mode, hotelId },
              () => (mode === 'LIVE' ? `${NAME[c.channel_code]} gerçek moda alındı; 365 gecelik tam gönderim kuyruğa eklendi.` : `${NAME[c.channel_code]} DEMO moduna alındı.`))} />
        ))}
      </section>

      <div className="mt-3 flex flex-wrap gap-2">
        {canManage && <button type="button" disabled={busy} onClick={sync} className="btn-gold min-h-[48px]">{busy ? '…' : 'Şimdi senkronize et'}</button>}
        {canManage && (
          <button type="button" disabled={busy} className="btn-line min-h-[48px]"
            onClick={() => run('/api/ota', { action: 'resync', propertyId: property.id }, (d) => `Tam gönderim kuyruğa eklendi (${String(d.queued)} gece).`)}>
            365 geceyi yeniden gönder
          </button>
        )}
        <p className="self-center text-[12.5px] text-mist">Otomatik senkronizasyon sunucu zamanlayıcısıyla çalışır; DEMO kanallarda hiçbir şey dışarı gönderilmez.</p>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="card overflow-hidden">
          <h2 className="border-b border-silver/10 px-4 py-3 text-[15px] font-semibold text-ink">Kanal mesajları</h2>
          <ul className="max-h-[70vh] overflow-y-auto">
            {events.length === 0 && <li className="p-4 text-[13px] text-mist">Henüz kanal mesajı yok. DEMO kanallarda sağdaki simülatörle deneyebilirsiniz.</li>}
            {events.map((e) => (
              <li key={e.id} className="border-b border-silver/[0.06] px-4 py-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{connName.get(e.connection_id)} · {KIND[e.kind]}</span>
                  <span className="text-mist">#{e.external_reservation_id}</span>
                  {e.is_demo && <span className="tone tone-amber rounded px-1.5 text-[11px] font-semibold">DEMO</span>}
                  <span className={`tone ${STATUS[e.status]?.tone ?? 'tone-slate'} rounded px-1.5 text-[11px] font-semibold`}>{STATUS[e.status]?.text ?? e.status}</span>
                  <span className="ml-auto text-[11.5px] text-mist">{when(e.received_at)}</span>
                </div>
                {e.outcome && <p className="mt-1 text-mist">Sonuç: {outcomeText(e.outcome)}{e.attempts > 1 ? ` · ${e.attempts}. denemede` : ''}</p>}
                {e.last_error && <p className="mt-1 break-words text-rose-300">{e.last_error}</p>}
                {e.status === 'FAILED' && e.next_attempt_at && <p className="mt-1 text-mist">Sonraki otomatik deneme: {when(e.next_attempt_at)}</p>}
                {(e.status === 'FAILED' || e.status === 'NEEDS_ATTENTION' || e.status === 'DEAD') && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" disabled={busy} className="btn-line min-h-[40px]"
                      onClick={() => run('/api/ota', { action: 'retry', eventId: e.id }, (d) => ((d.event as OtaInboundEvent).status === 'PROCESSED' ? 'Mesaj işlendi.' : 'Tekrar denendi; hâlâ çözülemedi.'))}>Şimdi tekrar dene</button>
                    {canManage && (
                      <button type="button" disabled={busy} className="btn-line min-h-[40px]" onClick={() => {
                        const note = window.prompt('Ne yapıldı? (ör. misafir başka odaya alındı, kanal bilgilendirildi)');
                        if (note) void run('/api/ota', { action: 'dismiss', eventId: e.id, note }, () => 'Mesaj elle çözüldü olarak kapatıldı.');
                      }}>Elle çözüldü</button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>

        <aside className="flex flex-col gap-3">
          <Mappings connections={connections} mappings={mappings} roomTypes={roomTypes} canManage={canManage} busy={busy}
            onSave={(channel, roomTypeId, externalRoomId, ratePlanId) => run('/api/ota', { action: 'mapping', propertyId: property.id, channel, roomTypeId, externalRoomId, ratePlanId }, () => 'Eşleştirme kaydedildi; bu oda tipi için tam gönderim kuyruğa eklendi.')} />
          <Simulator connections={connections} mappings={mappings} roomTypes={roomTypes} currency={property.currency} busy={busy}
            onSend={(channel, event) => run('/api/ota', { action: 'simulate', propertyId: property.id, channel, event }, (d) => {
              const ev = d.event as OtaInboundEvent;
              return ev.status === 'PROCESSED' ? `Kanal mesajı işlendi: ${outcomeText(ev.outcome ?? '')}` : `Kanal mesajı kaydedildi: ${STATUS[ev.status]?.text ?? ev.status}`;
            })} />
        </aside>
      </div>

      {flash && (
        <div role={flash.ok ? 'status' : 'alert'} className={`tone ${flash.ok ? 'tone-green' : 'tone-rose'} fixed inset-x-3 bottom-4 z-[60] mx-auto max-w-md rounded-2xl px-4 py-3 text-[14px] font-semibold shadow-2xl backdrop-blur`}>
          {flash.ok ? '✓ ' : ''}{flash.text}
        </div>
      )}
    </div>
  );
}

function ConnectionCard({ c, open, dead, canManage, busy, onSave }: {
  c: OtaConnection; open: number; dead: number; canManage: boolean; busy: boolean; onSave: (mode: 'DEMO' | 'LIVE', hotelId: string | null) => Promise<boolean>;
}) {
  const [hotelId, setHotelId] = useState(c.external_hotel_id ?? '');
  return (
    <div className="card p-4 text-[13px]">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[16px] font-semibold text-ink">{NAME[c.channel_code]}</h2>
        <span className={`tone ${c.mode === 'LIVE' ? 'tone-green' : 'tone-amber'} rounded px-2 py-0.5 text-[12px] font-semibold`}>
          {c.mode === 'LIVE' ? 'Gerçek bağlantı' : 'DEMO · gerçek API bağlı değil'}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
        <dt className="text-mist">Otel kimliği</dt><dd className="text-ink">{c.external_hotel_id ?? '—'}</dd>
        <dt className="text-mist">Son gönderim</dt><dd className="text-ink">{when(c.last_push_at)}</dd>
        <dt className="text-mist">Bekleyen gece</dt><dd className="text-ink">{open}</dd>
        <dt className="text-mist">Gönderilemeyen</dt><dd className={dead ? 'font-semibold text-rose-300' : 'text-ink'}>{dead}</dd>
      </dl>
      {c.last_error && <p className="mt-2 break-words text-rose-300">Son hata: {c.last_error}</p>}
      {canManage && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input aria-label={`${NAME[c.channel_code]} otel kimliği`} className="field min-h-[44px] w-[150px]" value={hotelId} placeholder="Otel kimliği" onChange={(e) => setHotelId(e.target.value)} />
          {c.mode === 'DEMO' ? (
            <button type="button" disabled={busy} className="btn-line min-h-[44px]" onClick={() => onSave('LIVE', hotelId.trim() || null)}>Gerçek moda al</button>
          ) : (
            <button type="button" disabled={busy} className="btn-line min-h-[44px]" onClick={() => onSave('DEMO', null)}>DEMO&apos;ya al</button>
          )}
        </div>
      )}
      {c.mode === 'DEMO' && <p className="mt-2 text-[12px] text-mist">Gerçek mod için kanal iş ortağı erişimi ve sunucu anahtarları gerekir (kurulum listesine bakın).</p>}
    </div>
  );
}

function Mappings({ connections, mappings, roomTypes, canManage, busy, onSave }: {
  connections: OtaConnection[]; mappings: OtaRoomMapping[]; roomTypes: Props['roomTypes']; canManage: boolean; busy: boolean;
  onSave: (channel: OtaChannel, roomTypeId: string, externalRoomId: string, ratePlanId: string) => Promise<boolean>;
}) {
  const key = (cid: string, rt: string) => `${cid}:${rt}`;
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(mappings.map((m) => [key(m.connection_id, m.room_type_id), m.external_room_id])));
  return (
    <section className="card p-4 text-[13px]">
      <h2 className="text-[15px] font-semibold text-ink">Oda eşleştirme</h2>
      <p className="mb-2 text-[12px] text-mist">Her oda tipinin kanaldaki oda kodu. Eşleşmeyen oda tipi kanala gönderilmez.</p>
      {connections.map((c) => (
        <div key={c.id} className="mt-2">
          <p className="font-semibold text-ink">{NAME[c.channel_code]}</p>
          <ul className="mt-1 space-y-1.5">
            {roomTypes.map((rt) => {
              const k = key(c.id, rt.id);
              const current = mappings.find((m) => m.connection_id === c.id && m.room_type_id === rt.id);
              return (
                <li key={rt.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-ink">{rt.name}</span>
                  {canManage ? (
                    <>
                      <input aria-label={`${NAME[c.channel_code]} ${rt.name} oda kodu`} className="field w-[120px] py-1.5" value={draft[k] ?? ''} placeholder="—"
                        onChange={(e) => setDraft((s) => ({ ...s, [k]: e.target.value }))} />
                      <button type="button" disabled={busy} className="btn-line px-3 py-1.5" onClick={() => onSave(c.channel_code, rt.id, draft[k] ?? '', current?.external_rate_plan_id ?? 'BAR')}>Kaydet</button>
                    </>
                  ) : (
                    <span className="text-mist">{current?.external_room_id ?? '—'}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

function Simulator({ connections, mappings, roomTypes, currency, busy, onSend }: {
  connections: OtaConnection[]; mappings: OtaRoomMapping[]; roomTypes: Props['roomTypes']; currency: string; busy: boolean;
  onSend: (channel: OtaChannel, event: Record<string, unknown>) => Promise<boolean>;
}) {
  const demo = connections.filter((c) => c.mode === 'DEMO');
  const [channel, setChannel] = useState<OtaChannel>(demo[0]?.channel_code ?? 'BOOKING');
  const [kind, setKind] = useState<'NEW' | 'MODIFY' | 'CANCEL'>('NEW');
  const conn = connections.find((c) => c.channel_code === channel);
  const rooms = mappings.filter((m) => m.connection_id === conn?.id);
  const today = todayIn('Europe/Istanbul');
  if (demo.length === 0) return null;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const event: Record<string, unknown> = { event_id: crypto.randomUUID().slice(0, 18), kind, reservation_id: String(f.get('res')).trim() };
    if (kind !== 'CANCEL') {
      Object.assign(event, {
        room_id: String(f.get('room')), check_in: String(f.get('in')), check_out: String(f.get('out')), adults: Number(f.get('adults')),
        total_amount: Number(String(f.get('total')).replace(',', '.')), currency, guest: { name: String(f.get('name')) }
      });
    }
    await onSend(channel, event);
  };
  return (
    <form onSubmit={submit} className="card flex flex-col gap-2 p-4 text-[13px]">
      <h2 className="text-[15px] font-semibold text-ink">Kanal simülatörü</h2>
      <p className="tone tone-amber rounded-lg px-2 py-1.5 text-[12px]">DEMO: kanaldan gelmiş gibi bir mesaj oluşturur ve gerçek işleme yolundan geçirir (oda ataması, çakışma koruması, folyo). Oluşan rezervasyon PMS&apos;te gerçek kayıttır ve “DEMO kanal simülasyonu” notu taşır; deneme bitince iptal edin.</p>
      <div className="grid grid-cols-2 gap-2">
        <select aria-label="Kanal" className="field min-h-[44px]" value={channel} onChange={(e) => setChannel(e.target.value as OtaChannel)}>
          {demo.map((c) => <option key={c.id} value={c.channel_code}>{NAME[c.channel_code]}</option>)}
        </select>
        <select aria-label="Mesaj türü" className="field min-h-[44px]" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="NEW">Yeni rezervasyon</option>
          <option value="MODIFY">Değişiklik</option>
          <option value="CANCEL">İptal</option>
        </select>
      </div>
      <input name="res" required pattern="[A-Za-z0-9_.:\-]{1,50}" aria-label="Kanal rezervasyon numarası" className="field min-h-[44px]" defaultValue={`T${Date.now().toString().slice(-6)}`} />
      {kind !== 'CANCEL' && (
        <>
          <select name="room" aria-label="Kanal oda kodu" className="field min-h-[44px]" required>
            {rooms.map((m) => <option key={m.id} value={m.external_room_id}>{m.external_room_id} · {roomTypes.find((r) => r.id === m.room_type_id)?.name}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-mist">Giriş<input name="in" type="date" required className="field min-h-[44px]" defaultValue={addDays(today, 30)} /></label>
            <label className="flex flex-col gap-1 text-mist">Çıkış<input name="out" type="date" required className="field min-h-[44px]" defaultValue={addDays(today, 32)} /></label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-mist">Kişi<input name="adults" type="number" min={1} max={6} defaultValue={2} className="field min-h-[44px]" /></label>
            <label className="flex flex-col gap-1 text-mist">Toplam ({currency})<input name="total" inputMode="decimal" required defaultValue="240" className="field min-h-[44px]" /></label>
          </div>
          <input name="name" aria-label="Misafir adı" className="field min-h-[44px]" defaultValue="Hans Müller" />
        </>
      )}
      <button type="submit" disabled={busy || (kind !== 'CANCEL' && rooms.length === 0)} className="btn-gold min-h-[48px]">Kanal mesajını simüle et</button>
    </form>
  );
}
