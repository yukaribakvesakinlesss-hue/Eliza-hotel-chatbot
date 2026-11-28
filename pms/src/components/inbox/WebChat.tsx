'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Message } from '@/types/database';

type Session = { conversationId: string; token: string; propertyName: string };
type Resp = Record<string, unknown> & { error?: { code?: string; message?: string } };

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; data: Resp | null; status: number }> {
  try {
    const res = await fetch('/api/webchat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    return { ok: res.ok, data: (await res.json().catch(() => null)) as Resp | null, status: res.status };
  } catch {
    return { ok: false, data: null, status: 0 };
  }
}
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/** Guest-facing chat. Answers about rooms and prices come from the hotel's database, never invented. */
export function WebChat({ org, code }: { org: string; code: string }) {
  const key = `axon-chat:${org}/${code}`;
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const lastId = useRef(0);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const saved = read(key);
    if (saved) {
      try {
        setSession(JSON.parse(saved) as Session);
      } catch {
        /* ignore */
      }
    }
  }, [key]);

  const poll = useCallback(async (s: Session) => {
    const r = await post({ action: 'poll', conversationId: s.conversationId, token: s.token, afterId: lastId.current });
    if (r.status === 403) {
      setSession(null);
      write(key, '');
      return;
    }
    const fresh = (r.data?.messages as Message[] | undefined) ?? [];
    if (fresh.length) {
      lastId.current = fresh[fresh.length - 1]!.id;
      setMessages((m) => [...m, ...fresh.filter((x) => !m.some((y) => y.id === x.id))]);
    }
  }, [key]);

  useEffect(() => {
    if (!session) return;
    void poll(session);
    const id = setInterval(() => void poll(session), 3000);
    return () => clearInterval(id);
  }, [session, poll]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  const send = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = String(new FormData(form).get('body') ?? '').trim();
    if (!body || pending) return;
    setPending(true);
    setError(null);
    let s = session;
    if (!s) {
      const r = await post({ action: 'start', org, code });
      if (!r.ok || !r.data) {
        setPending(false);
        setError(r.data?.error?.message ?? 'Sohbet başlatılamadı. Lütfen daha sonra tekrar deneyin.');
        return;
      }
      s = { conversationId: String(r.data.conversation_id), token: String(r.data.token), propertyName: String(r.data.property_name) };
      setSession(s);
      write(key, JSON.stringify(s));
    }
    const clientMessageId = crypto.randomUUID().replace(/-/g, '');
    const r = await post({ action: 'send', org, code, conversationId: s.conversationId, token: s.token, body, clientMessageId });
    setPending(false);
    if (!r.ok) {
      setError(r.data?.error?.message ?? 'Mesaj gönderilemedi. Tekrar deneyin.');
      return;
    }
    form.reset();
    await poll(s);
  };

  return (
    <main className="mx-auto flex h-[100dvh] max-w-xl flex-col px-3 py-3">
      <header className="card mb-2 px-4 py-3">
        <p className="eyebrow">Canlı destek</p>
        <h1 className="font-display text-[1.2rem] font-semibold text-ink">{session?.propertyName ?? 'Otel'} · Mesaj</h1>
        <p className="text-[12px] text-mist">Müsaitlik ve fiyatlar otelin sisteminden anlık kontrol edilir. "Resepsiyon" yazarak bir görevliye bağlanabilirsiniz.</p>
      </header>
      <ol ref={listRef} className="card flex flex-1 flex-col gap-2 overflow-y-auto p-3">
        {messages.length === 0 && <li className="m-auto text-center text-[14px] text-mist">Merhaba! Konaklama tarihlerinizi ve kişi sayısını yazın; müsaitliği ve fiyatı hemen kontrol edeyim.</li>}
        {messages.map((m) => (
          <li key={m.id} className={`flex ${m.direction === 'IN' ? 'justify-end' : m.sender === 'SYSTEM' ? 'justify-center' : 'justify-start'}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[15px] ${m.direction === 'IN' ? 'bg-gold/20 text-ink' : m.sender === 'SYSTEM' ? 'tone tone-green text-[13px]' : 'bg-silver/10 text-ink'}`}>
              {m.body}
              {m.direction === 'OUT' && <span className="mt-1 block text-[10.5px] text-mist">{m.sender === 'AI' ? 'Asistan' : m.sender === 'STAFF' ? 'Resepsiyon' : ''}</span>}
            </div>
          </li>
        ))}
      </ol>
      {error && <p role="alert" className="tone tone-rose mt-2 rounded-xl px-3 py-2 text-[13px]">{error}</p>}
      <form onSubmit={send} className="mt-2 flex gap-2">
        <input name="body" required maxLength={2000} autoComplete="off" className="field min-h-[52px] flex-1 text-[16px]" placeholder="Örn: 12-15 Aralık 2 kişi müsait mi?" />
        <button type="submit" disabled={pending} className="btn-gold min-h-[52px] min-w-[88px] text-[16px]">{pending ? '…' : 'Gönder'}</button>
      </form>
      <p className="mt-1 text-center text-[10.5px] text-mist">Mesajlarınız otel tarafından KVKK kapsamında işlenir.</p>
    </main>
  );
}
