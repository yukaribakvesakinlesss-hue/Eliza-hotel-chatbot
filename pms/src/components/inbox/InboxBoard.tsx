'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { AvailabilityOption, BookingRequest, ChannelConnection, Conversation, InboxChannel, MemberRole, Message, RoomType } from '@/types/database';
import { getBrowserClient } from '@/lib/supabase/client';
import { formatDate } from '@/lib/reservations/dates';
import { formatMoney, toCents } from '@/lib/finance/metrics';
import { AppNav } from '@/components/AppNav';
import { PreferenceToggles, usePreferences } from '@/components/Preferences';
import { demoAssistantTurn, type DemoContext } from '@/lib/demo/crm';

type Props = {
  property: { id: string; name: string; code: string; currency: string; orgSlug: string };
  role: MemberRole;
  initialConversations: Conversation[];
  initialRequests: BookingRequest[];
  channels: ChannelConnection[];
  roomTypes: Pick<RoomType, 'id' | 'code' | 'name' | 'max_occupancy' | 'base_rate'>[];
  /** sales demo: no database; the demo assistant answers from the demo hotel's rooms and stays */
  demo?: { today: string; threads: Record<string, Message[]>; contexts: Record<string, DemoContext> };
};
type Side = 'requests' | 'simulate' | 'channels';

const ICON: Record<InboxChannel, string> = { WHATSAPP: '🟢 WhatsApp', INSTAGRAM: '🟣 Instagram', WEBCHAT: '🌐 Web' };
const DELIVERY: Record<string, string> = { DEMO_NOT_SENT: 'DEMO · gönderilmedi', PENDING: 'gönderiliyor…', SENT: 'gönderildi', DELIVERED: 'iletildi', FAILED: 'GÖNDERİLEMEDİ', RECEIVED: '' };

async function api<T>(body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch('/api/inbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    return res.ok && json ? { ok: true, data: json } : { ok: false, message: json?.error?.message ?? 'İşlem tamamlanamadı.' };
  } catch {
    return { ok: false, message: 'Sunucuya ulaşılamadı; işlem kaydedilmedi.' };
  }
}

export function InboxBoard({ property, role, initialConversations, initialRequests, channels, roomTypes, demo }: Props) {
  const { lang } = usePreferences();
  const [convs, setConvs] = useState(initialConversations);
  const [requests, setRequests] = useState(initialRequests);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [side, setSide] = useState<Side>('requests');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'HUMAN' | 'unread'>('all');
  const conv = convs.find((c) => c.id === selected) ?? null;
  const rtName = useMemo(() => new Map(roomTypes.map((r) => [r.id, r.name])), [roomTypes]);
  const money = (v: number | string | null | undefined) => (v === null || v === undefined ? '—' : formatMoney(toCents(v), property.currency, lang));
  const canManage = role === 'owner' || role === 'manager';
  const replyKey = useRef(crypto.randomUUID());
  const threadsRef = useRef<Record<string, Message[]>>(demo?.threads ?? {});
  const contextsRef = useRef<Record<string, DemoContext>>(demo?.contexts ?? {});
  const [demoRates, setDemoRates] = useState<Record<string, number | null>>({});

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 5000);
    return () => clearTimeout(id);
  }, [flash]);

  const reloadList = useCallback(async () => {
    const supabase = getBrowserClient();
    if (!supabase) return;
    const [{ data: c }, { data: r }] = await Promise.all([
      supabase.from('conversations').select('*').eq('property_id', property.id).order('last_message_at', { ascending: false }).limit(100),
      supabase.from('booking_requests').select('*').eq('property_id', property.id).order('created_at', { ascending: false }).limit(50)
    ]);
    if (c) setConvs(c);
    if (r) setRequests(r);
  }, [property.id]);
  const loadThread = useCallback(async (id: string) => {
    if (demo) {
      setMessages([...(threadsRef.current[id] ?? [])]);
      return;
    }
    const supabase = getBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from('messages').select('*').eq('conversation_id', id).order('id').limit(500);
    setMessages(data ?? []);
  }, [demo]);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    const supabase = getBrowserClient();
    if (!supabase) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        void reloadList();
        if (selectedRef.current) void loadThread(selectedRef.current);
      }, 200);
    };
    const ch = supabase
      .channel(`inbox:${property.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `property_id=eq.${property.id}` }, kick)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: `property_id=eq.${property.id}` }, kick)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_requests', filter: `property_id=eq.${property.id}` }, kick)
      .subscribe();
    return () => {
      clearTimeout(t);
      void supabase.removeChannel(ch);
    };
  }, [property.id, reloadList, loadThread]);

  const open = async (id: string) => {
    setSelected(id);
    await loadThread(id);
    const c = convs.find((x) => x.id === id);
    if (c && c.unread_count > 0) {
      setConvs((list) => list.map((x) => (x.id === id ? { ...x, unread_count: 0 } : x)));
      void api({ action: 'read', conversationId: id });
    }
  };

  /** sales demo: the same actions on local state only */
  const demoRun = (body: Record<string, unknown>): { ok: true; selectId?: string } | { ok: false; message: string } => {
    if (!demo) return { ok: false, message: 'demo' };
    const now = new Date().toISOString();
    let nextId = Math.max(0, ...Object.values(threadsRef.current).flat().map((m) => m.id)) + 1;
    const push = (c: Conversation, sender: Message['sender'], text: string, payload: Record<string, unknown> | null = null) => {
      const m: Message = { id: nextId++, organization_id: c.organization_id, property_id: c.property_id, conversation_id: c.id, channel: c.channel,
        direction: sender === 'GUEST' ? 'IN' : 'OUT', sender, body: text, payload, external_id: null,
        delivery_status: sender === 'GUEST' ? 'RECEIVED' : c.channel === 'WEBCHAT' ? 'DELIVERED' : 'DEMO_NOT_SENT', author_id: null, created_at: now };
      threadsRef.current = { ...threadsRef.current, [c.id]: [...(threadsRef.current[c.id] ?? []), m] };
      return m;
    };
    const patch = (cid: string, change: Partial<Conversation>) => setConvs((list) => list.map((x) => (x.id === cid ? { ...x, ...change } : x)));
    const find = (cid: unknown) => convs.find((c) => c.id === cid);
    switch (body.action) {
      case 'read': {
        patch(String(body.conversationId), { unread_count: 0 });
        return { ok: true };
      }
      case 'reply': {
        const c = find(body.conversationId);
        if (!c) return { ok: false, message: 'Konuşma bulunamadı.' };
        const m = push(c, 'STAFF', String(body.body));
        patch(c.id, { status: 'HUMAN', last_message_at: now, last_message_preview: m.body.slice(0, 140) });
        return { ok: true };
      }
      case 'status': {
        patch(String(body.conversationId), { status: body.status as Conversation['status'] });
        return { ok: true };
      }
      case 'link_guest':
        return { ok: false, message: 'Demo: misafir profillerini Misafirler ekranında inceleyebilirsiniz.' };
      case 'confirm_request':
      case 'decline_request': {
        const r = requests.find((x) => x.id === body.requestId);
        if (!r) return { ok: false, message: 'Talep bulunamadı.' };
        const confirmed = body.action === 'confirm_request';
        setRequests((list) => list.map((x) => (x.id === r.id ? { ...x, status: confirmed ? 'CONFIRMED' : 'DECLINED', handled_at: now } : x)));
        const c = find(r.conversation_id);
        if (c && confirmed) {
          const code = `R${String(900000 + Math.floor(Math.random() * 99999))}`;
          const m = push(c, 'SYSTEM', `Rezervasyonunuz onaylandı: ${code}, ${formatDate(r.check_in)} – ${formatDate(r.check_out)}. / Your reservation is confirmed: ${code}.`, { type: 'reservation_confirmed', code });
          patch(c.id, { last_message_at: now, last_message_preview: m.body.slice(0, 140) });
        }
        return { ok: true };
      }
      case 'simulate': {
        const channel = body.channel as InboxChannel;
        const thread = String(body.threadId);
        let c = convs.find((x) => x.channel === channel && x.external_thread_id === thread);
        if (!c) {
          c = { id: crypto.randomUUID(), organization_id: property.id, property_id: property.id, channel, external_thread_id: thread, guest_id: null,
            contact_name: String(body.name ?? '') || null, contact_handle: channel === 'WHATSAPP' ? `+${thread.replace(/\D/g, '')}` : `@${thread}`, status: 'AI',
            is_demo: true, context: {}, unread_count: 0, last_message_at: now, last_message_preview: null, created_at: now, updated_at: now };
          const fresh = c;
          setConvs((list) => [fresh, ...list]);
        }
        push(c, 'GUEST', String(body.body));
        let status = c.status;
        if (status === 'AI') {
          const prev = [...(threadsRef.current[c.id] ?? [])].reverse().find((m) => m.sender === 'AI');
          const t = demoAssistantTurn(demo.today, c, String(body.body), contextsRef.current[c.id] ?? {}, ((prev?.payload as { type?: string } | null)?.type) ?? null, demoRates);
          contextsRef.current = { ...contextsRef.current, [c.id]: t.context };
          push(c, 'AI', t.text, { ...t.payload, intent: 'demo' });
          if (t.request) setRequests((list) => [t.request!, ...list]);
          if (t.handoff) status = 'HUMAN';
        }
        const last = threadsRef.current[c.id]!.at(-1)!;
        const cid = c.id;
        setConvs((list) => list.map((x) => (x.id === cid ? { ...x, status, unread_count: x.unread_count + 1, last_message_at: now, last_message_preview: last.body.slice(0, 140) } : x)));
        return { ok: true, selectId: cid };
      }
      default:
        return { ok: false, message: 'Bu işlem demoda kapalı.' };
    }
  };

  const run = async (body: Record<string, unknown>, done: string) => {
    if (demo) {
      const r = demoRun(body);
      if (!r.ok) {
        setFlash({ ok: false, text: r.message });
        return false;
      }
      setFlash({ ok: true, text: `${done} (demo)` });
      const target = r.selectId ?? selected;
      if (r.selectId) setSelected(r.selectId);
      if (target) setMessages([...(threadsRef.current[target] ?? [])]);
      return true;
    }
    setBusy(true);
    const r = await api<Record<string, unknown>>(body);
    setBusy(false);
    if (!r.ok) {
      setFlash({ ok: false, text: r.message });
      return false;
    }
    setFlash({ ok: true, text: done });
    await reloadList();
    if (selected) await loadThread(selected);
    return true;
  };

  const sendReply = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!conv) return;
    const form = e.currentTarget;
    const body = String(new FormData(form).get('body') ?? '').trim();
    if (!body) return;
    const ok = await run({ action: 'reply', conversationId: conv.id, body, clientMessageId: replyKey.current }, 'Yanıt kaydedildi');
    if (ok) {
      replyKey.current = crypto.randomUUID();
      form.reset();
    }
  };

  const shown = convs.filter((c) => filter === 'all' || (filter === 'HUMAN' ? c.status === 'HUMAN' : c.unread_count > 0));
  const openRequests = requests.filter((r) => r.status === 'NEW');
  const requestFor = (id: string | undefined) => requests.find((r) => r.id === id);

  return (
    <div className="mx-auto max-w-[1400px] px-3 pb-16 pt-5 sm:px-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">AXON PMS · {property.code}</p>
          <h1 className="mt-1 font-display text-[1.6rem] font-semibold tracking-tight text-ink sm:text-[2rem]">Inbox</h1>
          <p className="mt-0.5 text-[13px] text-mist">WhatsApp · Instagram · Web chat — tek panel</p>
        </div>
        <PreferenceToggles />
      </header>
      <AppNav role={role} />
      {demo && <p className="tone tone-amber mb-3 rounded-xl px-4 py-2.5 text-[13px]">Demo: kurgusal konuşmalar. Sağdaki Simülatör&apos;den misafir gibi yazın; AI asistan müsaitlik ve fiyatı örnek otelin oda ve rezervasyon verisinden hesaplar. Dışarıya mesaj gönderilmez, değişiklikler bu tarayıcıda kalır.</p>}

      <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)_340px]">
        {/* conversation list */}
        <section className={`card flex max-h-[78vh] flex-col overflow-hidden ${selected ? 'hidden lg:flex' : 'flex'}`}>
          <div className="flex gap-1 border-b border-silver/10 p-2 text-[12.5px]">
            {(['all', 'unread', 'HUMAN'] as const).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
                className={`min-h-[36px] flex-1 rounded-lg px-2 font-semibold ${filter === f ? 'bg-gold/15 text-gold' : 'text-mist'}`}>
                {f === 'all' ? 'Tümü' : f === 'unread' ? 'Okunmamış' : 'Resepsiyonda'}
              </button>
            ))}
          </div>
          <ul className="flex-1 overflow-y-auto">
            {shown.length === 0 && <li className="p-4 text-[13px] text-mist">Henüz konuşma yok. Simülatörden ya da web sohbetinden bir mesaj gönderin.</li>}
            {shown.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => open(c.id)}
                  className={`flex w-full flex-col gap-0.5 border-b border-silver/[0.06] px-3 py-2.5 text-left transition hover:bg-silver/[0.05] ${selected === c.id ? 'bg-gold/10' : ''}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[14px] font-semibold text-ink">{c.contact_name ?? c.contact_handle ?? 'Misafir'}</span>
                    {c.unread_count > 0 && <span className="rounded-full bg-gold px-2 text-[11px] font-bold text-navy-950">{c.unread_count}</span>}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-mist">
                    {ICON[c.channel]}
                    {c.is_demo && <span className="tone tone-amber rounded px-1.5 font-semibold">DEMO</span>}
                    <span className={`tone ${c.status === 'AI' ? 'tone-blue' : c.status === 'HUMAN' ? 'tone-violet' : 'tone-slate'} rounded px-1.5 font-semibold`}>{c.status === 'AI' ? 'AI' : c.status === 'HUMAN' ? 'Resepsiyon' : 'Kapalı'}</span>
                  </span>
                  <span className="truncate text-[12.5px] text-mist">{c.last_message_preview}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* thread */}
        <section className={`card flex max-h-[78vh] min-h-[60vh] flex-col overflow-hidden ${selected ? 'flex' : 'hidden lg:flex'}`}>
          {!conv ? (
            <p className="m-auto p-6 text-center text-[14px] text-mist">Soldan bir konuşma seçin.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-silver/10 p-3">
                <button type="button" className="btn-line px-3 py-1 lg:hidden" onClick={() => setSelected(null)}>←</button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-ink">{conv.contact_name ?? 'Misafir'}</p>
                  <p className="text-[11.5px] text-mist">{ICON[conv.channel]} {conv.contact_handle ?? ''} {conv.is_demo ? '· DEMO (simülasyon; dışarıya gönderilmez)' : ''}</p>
                </div>
                {conv.status === 'AI' ? (
                  <button type="button" disabled={busy} className="btn-line min-h-[40px]" onClick={() => run({ action: 'status', conversationId: conv.id, status: 'HUMAN' }, 'Konuşma resepsiyona alındı')}>Devral</button>
                ) : (
                  <button type="button" disabled={busy} className="btn-line min-h-[40px]" onClick={() => run({ action: 'status', conversationId: conv.id, status: 'AI' }, 'Konuşma AI asistana verildi')}>AI&apos;ya ver</button>
                )}
                {conv.guest_id ? (
                  <Link href={`/guests/${conv.guest_id}`} className="btn-line min-h-[40px]">Misafir profili</Link>
                ) : (
                  <button type="button" disabled={busy} className="btn-line min-h-[40px]" onClick={() => run({ action: 'link_guest', conversationId: conv.id, guestId: null }, 'Misafir profili oluşturuldu')}>Profil oluştur</button>
                )}
              </div>
              <ol className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
                {messages.map((m) => {
                  const payload = (m.payload ?? {}) as { type?: string; options?: AvailabilityOption[]; booking_request_id?: string; check_in?: string; check_out?: string };
                  const req = requestFor(payload.booking_request_id);
                  const mine = m.direction === 'OUT';
                  return (
                    <li key={m.id} className={`flex flex-col ${m.sender === 'SYSTEM' ? 'items-center' : mine ? 'items-end' : 'items-start'}`}>
                      <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[14px] ${
                        m.sender === 'GUEST' ? 'bg-silver/10 text-ink' : m.sender === 'AI' ? 'tone tone-blue' : m.sender === 'STAFF' ? 'tone tone-violet' : 'tone tone-green text-center text-[12.5px]'}`}>
                        {m.body}
                      </div>
                      <span className="mt-0.5 text-[10.5px] text-mist">
                        {m.sender === 'AI' ? 'AI asistan' : m.sender === 'STAFF' ? 'Resepsiyon' : m.sender === 'SYSTEM' ? 'Sistem' : 'Misafir'} ·{' '}
                        {new Date(m.created_at).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}
                        {payload.type === 'availability' ? ' · ✓ veritabanından doğrulandı' : ''}
                        {DELIVERY[m.delivery_status] ? ` · ${DELIVERY[m.delivery_status]}` : ''}
                      </span>
                      {req && req.status === 'NEW' && (
                        <div className="mt-1 w-full max-w-[85%] rounded-xl border border-gold/30 p-3 text-[13px]">
                          <p className="font-semibold text-ink">Rezervasyon talebi · {rtName.get(req.room_type_id)} · {formatDate(req.check_in)} – {formatDate(req.check_out)}</p>
                          <p className="text-mist">{req.contact_name} · {req.adults} kişi · teklif: {req.quote.complete ? money(req.quote.gross) : 'fiyat yok'}</p>
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <button type="button" disabled={busy} className="btn-gold min-h-[44px]" onClick={() => run({ action: 'confirm_request', requestId: req.id }, 'Rezervasyon oluşturuldu ve misafire bildirildi')}>Tek tıkla rezervasyon</button>
                            <button type="button" disabled={busy} className="btn-line min-h-[44px]" onClick={() => run({ action: 'decline_request', requestId: req.id }, 'Talep reddedildi')}>Reddet</button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
              <form onSubmit={sendReply} className="flex gap-2 border-t border-silver/10 p-2">
                <textarea name="body" required maxLength={4000} rows={2} className="field flex-1 resize-none text-[14px]"
                  placeholder={conv.status === 'AI' ? 'Yanıt yazarsanız konuşmayı devralırsınız…' : 'Yanıtınız…'} />
                <button type="submit" disabled={busy} className="btn-gold min-w-[88px]">{busy ? '…' : 'Gönder'}</button>
              </form>
            </>
          )}
        </section>

        {/* side panel */}
        <aside className="card flex max-h-[78vh] flex-col overflow-hidden">
          <div className="flex gap-1 border-b border-silver/10 p-2 text-[12.5px]">
            {(['requests', 'simulate', 'channels'] as Side[]).map((s) => (
              <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)}
                className={`min-h-[36px] flex-1 rounded-lg px-2 font-semibold ${side === s ? 'bg-gold/15 text-gold' : 'text-mist'}`}>
                {s === 'requests' ? `Talepler (${openRequests.length})` : s === 'simulate' ? 'Simülatör' : 'Kanallar'}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-3 text-[13px]">
            {side === 'requests' && (
              <ul className="space-y-2">
                {requests.length === 0 && <li className="text-mist">Rezervasyon talebi yok.</li>}
                {requests.map((r) => (
                  <li key={r.id} className="rounded-xl border border-silver/10 p-3">
                    <p className="font-semibold text-ink">{r.contact_name} · {rtName.get(r.room_type_id)}</p>
                    <p className="text-mist">{formatDate(r.check_in)} – {formatDate(r.check_out)} · {r.adults} kişi · {r.quote.complete ? money(r.quote.gross) : 'fiyat yok'}</p>
                    <p className="mt-1"><span className={`tone ${r.status === 'NEW' ? 'tone-amber' : r.status === 'CONFIRMED' ? 'tone-green' : 'tone-slate'} rounded px-1.5 text-[11px] font-semibold`}>{r.status === 'NEW' ? 'Bekliyor' : r.status === 'CONFIRMED' ? 'Rezervasyon oluşturuldu' : 'Reddedildi'}</span></p>
                    {r.status === 'NEW' && (
                      <button type="button" disabled={busy} className="btn-gold mt-2 min-h-[44px] w-full" onClick={() => run({ action: 'confirm_request', requestId: r.id }, 'Rezervasyon oluşturuldu ve misafire bildirildi')}>Tek tıkla rezervasyon</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {side === 'simulate' && <Simulator propertyId={property.id} channels={channels} busy={busy} onSend={(body) => run(body, 'Mesaj simüle edildi; AI asistan veritabanından yanıtladı')} />}
            {side === 'channels' && <Channels property={property} channels={channels} roomTypes={roomTypes} canManage={canManage} money={money} onSaved={(t) => setFlash({ ok: true, text: t })} onError={(t) => setFlash({ ok: false, text: t })}
              onDemoRate={demo ? (id, rate) => setDemoRates((r) => ({ ...r, [id]: rate })) : undefined} />}
          </div>
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

function Simulator({ propertyId, channels, busy, onSend }: { propertyId: string; channels: ChannelConnection[]; busy: boolean; onSend: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [channel, setChannel] = useState<'WHATSAPP' | 'INSTAGRAM'>('WHATSAPP');
  const live = channels.find((c) => c.channel === channel)?.mode === 'LIVE';
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const ok = await onSend({ action: 'simulate', propertyId, channel, threadId: String(f.get('thread')), name: String(f.get('name')), body: String(f.get('body')), clientMessageId: crypto.randomUUID() });
    if (ok) (form.elements.namedItem('body') as HTMLTextAreaElement).value = '';
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <p className="tone tone-amber rounded-lg px-2 py-1.5 text-[12px]">DEMO: gerçek API bağlı olmadan gelen mesajı simüle eder. AI yanıtı veritabanından üretilir; dışarıya hiçbir mesaj gönderilmez.</p>
      <select className="field min-h-[44px]" value={channel} onChange={(e) => setChannel(e.target.value as 'WHATSAPP' | 'INSTAGRAM')}>
        <option value="WHATSAPP">WhatsApp</option>
        <option value="INSTAGRAM">Instagram</option>
      </select>
      {live && <p className="text-rose-400">Bu kanal gerçek modda; simülasyon kapalı.</p>}
      <input name="name" className="field min-h-[44px]" defaultValue="Ayşe Yılmaz" placeholder="Gönderen adı" />
      <input name="thread" className="field min-h-[44px]" defaultValue={channel === 'WHATSAPP' ? '905321234567' : 'ayse.travels'} key={channel} placeholder="Telefon / kullanıcı" />
      <textarea name="body" required rows={3} className="field text-[14px]" placeholder="Örn: 12-15 Aralık 2 kişi müsait oda var mı?" />
      <button type="submit" disabled={busy || live} className="btn-gold min-h-[48px]">Gelen mesajı simüle et</button>
    </form>
  );
}

function Channels({ property, channels, roomTypes, canManage, money, onSaved, onError, onDemoRate }: {
  property: Props['property']; channels: ChannelConnection[]; roomTypes: Props['roomTypes']; canManage: boolean;
  money: (v: number | string | null | undefined) => string; onSaved: (t: string) => void; onError: (t: string) => void;
  onDemoRate?: (roomTypeId: string, rate: number | null) => void;
}) {
  const [rates, setRates] = useState(() => Object.fromEntries(roomTypes.map((r) => [r.id, r.base_rate === null ? '' : String(r.base_rate)])));
  const chatUrl = typeof window !== 'undefined' ? `${window.location.origin}/chat/${property.orgSlug}/${property.code}` : '';
  const save = async (id: string) => {
    const raw = rates[id]?.replace(',', '.').trim() ?? '';
    const baseRate = raw === '' ? null : Number(raw);
    if (baseRate !== null && (!Number.isFinite(baseRate) || baseRate < 0)) return onError('Fiyat geçersiz.');
    if (onDemoRate) {
      onDemoRate(id, baseRate);
      return onSaved(baseRate === null ? 'Demo: fiyat kaldırıldı; AI asistan bu oda tipi için fiyat söylemez' : 'Demo: fiyat bu tarayıcıda kaydedildi; AI asistan yeni fiyatı kullanır');
    }
    const res = await fetch('/api/rates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomTypeId: id, baseRate }) }).catch(() => null);
    const json = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (res?.ok) onSaved('Fiyat kaydedildi; AI asistan artık bu fiyatı kullanır');
    else onError(json?.error?.message ?? 'Fiyat kaydedilemedi.');
  };
  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {channels.sort((a, b) => a.channel.localeCompare(b.channel)).map((c) => (
          <li key={c.id} className="flex items-center justify-between rounded-xl border border-silver/10 px-3 py-2">
            <span className="font-semibold text-ink">{ICON[c.channel]}</span>
            <span className={`tone ${c.mode === 'LIVE' ? 'tone-green' : 'tone-amber'} rounded px-2 text-[11.5px] font-semibold`}>{c.mode === 'LIVE' ? 'Bağlı' : 'DEMO'}</span>
          </li>
        ))}
      </ul>
      <p className="text-mist">WhatsApp ve Instagram, Meta anahtarları eklenene kadar DEMO kalır; webhook adresleri: <code>/api/webhooks/whatsapp</code>, <code>/api/webhooks/instagram</code>.</p>
      <div>
        <p className="font-semibold text-ink">Web sohbeti (misafir bağlantısı)</p>
        <a href={chatUrl} target="_blank" rel="noreferrer" className="break-all text-gold underline">{chatUrl}</a>
      </div>
      <div>
        <p className="font-semibold text-ink">Gecelik fiyatlar (vergi hariç)</p>
        <p className="mb-2 text-[12px] text-mist">AI asistan yalnızca burada tanımlı fiyatları söyler; fiyatı boş olan oda tipi için fiyat vermez.</p>
        <ul className="space-y-2">
          {roomTypes.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="flex-1 text-ink">{r.name}</span>
              {canManage ? (
                <>
                  <input inputMode="decimal" className="field w-[90px] py-1.5" value={rates[r.id] ?? ''} placeholder="—" onChange={(e) => setRates((s) => ({ ...s, [r.id]: e.target.value }))} />
                  <button type="button" className="btn-line px-3 py-1.5" onClick={() => save(r.id)}>Kaydet</button>
                </>
              ) : (
                <span className="text-ink">{r.base_rate === null ? '—' : money(r.base_rate)}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
