'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Folio, FolioTransaction, ReservationWithGuest } from '@/types/database';
import { getBrowserClient } from '@/lib/supabase/client';
import { demoFinance } from '@/lib/demo/reservations';
import { EXTRA_PRESETS } from '@/lib/finance/accounts';
import { formatMoney, toCents } from '@/lib/finance/metrics';
import { newIdempotencyKey } from '@/lib/reservations/client';
import { formatDate } from '@/lib/reservations/dates';
import type { Lang } from '@/lib/i18n/labels';

type PostType = 'EXTRA' | 'DISCOUNT' | 'PAYMENT' | 'REFUND';
const TYPE_LABEL: Record<Lang, Record<FolioTransaction['txn_type'], string>> = {
  tr: { ROOM_CHARGE: 'Konaklama', TAX: 'Vergi', DISCOUNT: 'İndirim', EXTRA: 'Ek hizmet', PAYMENT: 'Tahsilat', REFUND: 'İade' },
  en: { ROOM_CHARGE: 'Room', TAX: 'Tax', DISCOUNT: 'Discount', EXTRA: 'Extra', PAYMENT: 'Payment', REFUND: 'Refund' }
};
const METHODS: Record<Lang, Record<string, string>> = {
  tr: { CARD: 'Kart', CASH: 'Nakit', TRANSFER: 'Havale', OTA: 'OTA sanal kart' },
  en: { CARD: 'Card', CASH: 'Cash', TRANSFER: 'Bank transfer', OTA: 'OTA virtual card' }
};

async function folioCall(reservationId: string, body: Record<string, unknown>): Promise<{ ok: boolean; message: string; data?: Record<string, unknown> }> {
  try {
    const res = await fetch(`/api/reservations/${reservationId}/folio`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> & { error?: { message?: string } } | null;
    if (res.ok && data) return { ok: true, message: '', data };
    return { ok: false, message: data?.error?.message ?? 'İşlem tamamlanamadı.' };
  } catch {
    return { ok: false, message: 'Sunucuya ulaşılamadı; işlem doğrulanamadı. Tekrar gönderirseniz aynı işlem anahtarı kullanılır, çift kayıt oluşmaz.' };
  }
}

/** Guest folio: append-only ledger view + cashiering actions (all saved through the API). */
export function FolioPanel({ lang, demo, canEdit, reservation, today, currency }: {
  lang: Lang; demo: boolean; canEdit: boolean; reservation: ReservationWithGuest; today: string; currency: string;
}) {
  const [folio, setFolio] = useState<Pick<Folio, 'status' | 'currency'> | null>(null);
  const [lines, setLines] = useState<FolioTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<PostType>('PAYMENT');
  const [preset, setPreset] = useState<string>(EXTRA_PRESETS[1].account);
  const [method, setMethod] = useState('CARD');
  const key = useRef(newIdempotencyKey());
  const money = (v: number | string) => formatMoney(toCents(v), folio?.currency ?? currency, lang);
  const tr = lang === 'tr';

  const load = useCallback(async () => {
    setLoading(true);
    if (demo) {
      setFolio({ status: 'OPEN', currency });
      setLines(demoFinance(today).transactions.filter((t) => t.reservation_id === reservation.id));
      setLoading(false);
      return;
    }
    const supabase = getBrowserClient();
    if (!supabase) return;
    const [{ data: f }, { data: tx, error: e }] = await Promise.all([
      supabase.from('folios').select('status, currency').eq('reservation_id', reservation.id).maybeSingle(),
      supabase.from('folio_transactions').select('*').eq('reservation_id', reservation.id).order('id')
    ]);
    setLoading(false);
    if (e) {
      setError(tr ? 'Folyo yüklenemedi.' : 'Could not load the folio.');
      return;
    }
    setFolio(f ?? null);
    setLines(tx ?? []);
  }, [demo, reservation.id, today, currency, tr]);

  useEffect(() => {
    void load();
  }, [load]);

  const reversed = useMemo(() => new Set(lines.filter((l) => l.reverses_id !== null).map((l) => l.reverses_id)), [lines]);
  const totals = useMemo(() => {
    let charges = 0, credits = 0, balance = 0;
    for (const l of lines) {
      const c = toCents(l.amount);
      balance += c;
      if (l.txn_type === 'PAYMENT' || l.txn_type === 'REFUND') credits += -c;
      else charges += c;
    }
    return { charges, credits, balance };
  }, [lines]);

  const writable = canEdit && !demo && folio?.status === 'OPEN';
  const inHouse = reservation.status === 'CHECKED_IN' || reservation.status === 'CHECKED_OUT';
  const finished = reservation.status === 'CHECKED_OUT' || reservation.status === 'CANCELLED' || reservation.status === 'NO_SHOW';

  const act = async (body: Record<string, unknown>, success: (d?: Record<string, unknown>) => string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await folioCall(reservation.id, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    setNotice(success(r.data));
    await load();
    return true;
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const amount = Number(String(f.get('amount') ?? '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      setError(tr ? 'Tutar 0\'dan büyük olmalı.' : 'Amount must be greater than 0.');
      return;
    }
    const p = EXTRA_PRESETS.find((x) => x.account === preset);
    const ok = await act(
      {
        action: 'post',
        type,
        amount: Math.round(amount * 100) / 100,
        description: String(f.get('description') ?? '').trim() || null,
        accountCode: type === 'EXTRA' ? preset : null,
        taxRate: type === 'EXTRA' ? p?.taxRate ?? 0 : null,
        paymentMethod: type === 'PAYMENT' || type === 'REFUND' ? method : null,
        idempotencyKey: key.current
      },
      () => (tr ? 'Hareket folyoya işlendi.' : 'Posted to the folio.')
    );
    if (ok) {
      key.current = newIdempotencyKey(); // next entry is a new operation
      form.reset();
    }
  };

  if (loading) return <p className="text-[13px] text-mist">…</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label={tr ? 'Masraflar' : 'Charges'} value={formatMoney(totals.charges, folio?.currency ?? currency, lang)} />
        <Stat label={tr ? 'Ödemeler' : 'Payments'} value={formatMoney(totals.credits, folio?.currency ?? currency, lang)} />
        <Stat label={tr ? 'Bakiye' : 'Balance'} value={formatMoney(totals.balance, folio?.currency ?? currency, lang)} tone={totals.balance === 0 ? 'tone-green' : totals.balance > 0 ? 'tone-amber' : 'tone-blue'} />
      </div>
      <p className="text-[11.5px] text-mist">
        {tr ? 'Folyo' : 'Folio'}: {folio?.status === 'CLOSED' ? (tr ? 'kapalı' : 'closed') : tr ? 'açık' : 'open'} ·{' '}
        {tr ? 'Hareketler değiştirilemez; düzeltme ters kayıtla yapılır.' : 'Entries are immutable; corrections are reversals.'}
      </p>

      <div className="max-h-[260px] overflow-y-auto rounded-xl border border-silver/10">
        <table className="w-full text-[12.5px]">
          <tbody>
            {lines.length === 0 && (
              <tr><td className="px-3 py-3 text-mist">{tr ? 'Henüz hareket yok.' : 'No entries yet.'}</td></tr>
            )}
            {lines.map((l) => {
              const isReversed = reversed.has(l.id);
              const isChild = l.parent_id !== null && l.txn_type === 'TAX';
              return (
                <tr key={l.id} className="border-b border-silver/[0.06]">
                  <td className="whitespace-nowrap px-3 py-1.5 text-mist">{formatDate(l.service_date, lang)}</td>
                  <td className={`px-2 py-1.5 ${isChild ? 'pl-6 text-mist' : 'text-ink'} ${isReversed ? 'line-through opacity-60' : ''}`}>
                    {l.description}
                    {!isChild && <span className="ml-1 text-[10.5px] text-mist">· {TYPE_LABEL[lang][l.txn_type]}{l.payment_method ? ` · ${METHODS[lang][l.payment_method]}` : ''}</span>}
                  </td>
                  <td className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums ${toCents(l.amount) < 0 ? 'text-emerald-400' : 'text-ink'}`}>{money(l.amount)}</td>
                  <td className="w-[70px] px-2 py-1.5 text-right">
                    {writable && !isChild && l.reverses_id === null && !isReversed && (
                      <button type="button" disabled={busy} className="text-[11px] text-rose-400 hover:underline"
                        onClick={() => act({ action: 'reverse', transactionId: l.id, reason: null }, () => (tr ? 'Ters kayıt oluşturuldu.' : 'Reversal posted.'))}>
                        {tr ? 'Ters kayıt' : 'Reverse'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {demo && <p className="tone tone-amber rounded-xl px-3 py-2 text-[12.5px]">{tr ? 'Demo modu: folyo örnek veridir, işlem yapılamaz.' : 'Demo mode: sample folio, actions disabled.'}</p>}

      {writable && (
        <>
          {inHouse && (
            <button type="button" className="btn-line" disabled={busy}
              onClick={() => act({ action: 'post_charges' }, (d) => (tr ? `${Number(d?.posted ?? 0)} gece işlendi.` : `${Number(d?.posted ?? 0)} night(s) posted.`))}>
              {tr ? 'Konaklama ücretlerini işle (bu geceye kadar)' : 'Post room charges (through tonight)'}
            </button>
          )}
          <form onSubmit={submit} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className="text-[11px] text-mist">
              {tr ? 'Tür' : 'Type'}
              <select className="field mt-0.5 py-1.5 text-[13px]" value={type} onChange={(e) => setType(e.target.value as PostType)}>
                <option value="PAYMENT">{TYPE_LABEL[lang].PAYMENT}</option>
                <option value="EXTRA">{TYPE_LABEL[lang].EXTRA}</option>
                <option value="DISCOUNT">{TYPE_LABEL[lang].DISCOUNT}</option>
                <option value="REFUND">{TYPE_LABEL[lang].REFUND}</option>
              </select>
            </label>
            {type === 'EXTRA' && (
              <label className="text-[11px] text-mist">
                {tr ? 'Hizmet' : 'Service'}
                <select className="field mt-0.5 py-1.5 text-[13px]" value={preset} onChange={(e) => setPreset(e.target.value)}>
                  {EXTRA_PRESETS.map((p) => <option key={p.account} value={p.account}>{p[lang]} · KDV %{p.taxRate * 100}</option>)}
                </select>
              </label>
            )}
            {(type === 'PAYMENT' || type === 'REFUND') && (
              <label className="text-[11px] text-mist">
                {tr ? 'Yöntem' : 'Method'}
                <select className="field mt-0.5 py-1.5 text-[13px]" value={method} onChange={(e) => setMethod(e.target.value)}>
                  {Object.entries(METHODS[lang]).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
            )}
            <label className="text-[11px] text-mist">
              {tr ? (type === 'EXTRA' ? 'Tutar (KDV hariç)' : 'Tutar') : type === 'EXTRA' ? 'Amount (excl. VAT)' : 'Amount'}
              <input name="amount" inputMode="decimal" required className="field mt-0.5 py-1.5 text-[13px]" placeholder="0,00" />
            </label>
            <label className="text-[11px] text-mist">
              {tr ? 'Açıklama' : 'Description'}
              <input name="description" maxLength={200} className="field mt-0.5 py-1.5 text-[13px]" />
            </label>
            <div className="col-span-2 flex flex-wrap justify-end gap-2 sm:col-span-4">
              {finished && (
                <button type="button" className="btn-line" disabled={busy}
                  onClick={() => act({ action: 'close' }, () => (tr ? 'Folyo kapatıldı.' : 'Folio closed.'))}>
                  {tr ? 'Folyoyu kapat' : 'Close folio'}
                </button>
              )}
              <button type="submit" className="btn-gold" disabled={busy}>{busy ? '…' : tr ? 'Folyoya işle' : 'Post'}</button>
            </div>
          </form>
        </>
      )}
      {notice && <p role="status" className="tone tone-green rounded-xl px-3 py-2 text-[12.5px]">✓ {notice}</p>}
      {error && <p role="alert" className="tone tone-rose rounded-xl px-3 py-2 text-[12.5px] font-medium">{error}</p>}
    </div>
  );
}

function Stat({ label, value, tone = 'tone-slate' }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`tone ${tone} rounded-xl px-2 py-2`}>
      <p className="text-[10.5px] uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-0.5 font-display text-[15px] font-semibold tabular-nums">{value}</p>
    </div>
  );
}
