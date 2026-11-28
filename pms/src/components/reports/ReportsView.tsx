'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { MemberRole, Property } from '@/types/database';
import type { PMSMetrics } from '@/lib/finance/metrics';
import { formatMoney } from '@/lib/finance/metrics';
import { ACCOUNT_LABELS, ACCOUNT_ORDER } from '@/lib/finance/accounts';
import { presetPeriod, type Period, type PresetKey } from '@/lib/finance/period';
import { addDays, formatDate } from '@/lib/reservations/dates';
import { LABELS } from '@/lib/i18n/labels';
import { AppNav } from '@/components/AppNav';
import { PreferenceToggles, usePreferences } from '@/components/Preferences';

const T = {
  tr: {
    title: 'Raporlar', period: 'Dönem', from: 'Başlangıç', to: 'Bitiş (dahil)', apply: 'Uygula',
    presets: { today: 'Bugün', last7: 'Son 7 gün', last30: 'Son 30 gün', thisMonth: 'Bu ay', lastMonth: 'Geçen ay', next30: 'Gelecek 30 gün', thisYear: 'Bu yıl' } as Record<PresetKey, string>,
    occupancy: 'Doluluk', adr: 'ADR', revpar: 'RevPAR', roomNet: 'Net oda geliri',
    occSub: (s: number, a: number) => `${s} / ${a} oda-gece`, adrSub: 'Net oda geliri / satılan oda-gece', revparSub: 'Net oda geliri / satılabilir oda-gece',
    roomNetSub: 'vergi hariç, indirimler düşülmüş', inclComp: 'complimentary dahil',
    waterfall: 'Gelirden dağıtım sonrasına', gross: 'Brüt gelir (vergi dahil)', vat: 'KDV', lodging: 'Konaklama vergisi',
    net: 'Net gelir (vergi hariç)', commission: 'OTA komisyonu (dağıtım gideri)', afterDist: 'Dağıtım sonrası net gelir',
    breakdown: 'Gelir dağılımı', posted: 'Oda geliri – işlenmiş', forecast: 'Oda geliri – beklenen (henüz işlenmemiş geceler)',
    discounts: 'Oda indirimleri', roomTotal: 'Net oda geliri', noShow: 'No-show geliri (ADR dışında)', extras: 'Ek hizmetler',
    roomGross: 'Oda geliri (vergi dahil)', nights: 'Oda-geceler', physical: 'Fiziksel kapasite', ooo: 'Arızalı (kapasiteden düşülen)',
    available: 'Satılabilir', sold: 'Satılan', comp: 'Complimentary (ücretsiz, ayrı raporlanır)', noShowNights: 'No-show (gelmedi)',
    cancelled: 'İptal (gelire dahil değil)', pending: 'Beklemede (onaysız)', resCount: 'rez.',
    channels: 'Satış kanalları', channel: 'Kanal', rate: 'Komisyon oranı', afterCommission: 'Komisyon sonrası',
    usali: 'USALI hesap eşlemesi', account: 'Hesap', schedule: 'USALI bölümü', amount: 'Tutar',
    daily: 'Günlük', date: 'Tarih', revenue: 'Net oda geliri',
    settlements: 'Tahsilatlar (nakit akışı, gelir değildir)', payments: 'Tahsilat', refunds: 'İade',
    audit: 'Gece denetimi: bu geceyi işle', auditDone: (n: number) => `${n} oda-gece folyolara işlendi.`,
    noAccess: 'Finans raporlarını yalnızca işletme sahibi ve müdür görebilir.',
    notes: [
      'ADR = Net oda geliri / Satılan oda-gece · RevPAR = Net oda geliri / Satılabilir oda-gece · Doluluk = Satılan / Satılabilir × 100.',
      'Satılabilir oda-gece = oda sayısı × gün − arızalı (Out of Order) oda-geceler, tarihli arıza kayıtlarından.',
      'İptaller gelire dahil edilmez. No-show ve complimentary ayrı raporlanır; ADR ve RevPAR\'a girmez.',
      'Beklenen gelir: onaylı ama henüz folyoya işlenmemiş gecelerin rezervasyon fiyatı (vergi hariç).',
      'OTA komisyonu = rezervasyonun net oda geliri × rezervasyon anında kaydedilen komisyon oranı.',
      'Vergi oranları demo değerdir (KDV %10 oda, konaklama vergisi %2); mali müşavirinizle doğrulayın.',
      'Hesap yapısı USALI kategorileriyle eşleştirilebilecek şekilde kurulmuştur; tam USALI uyumluluğu iddia edilmez.'
    ]
  },
  en: {
    title: 'Reports', period: 'Period', from: 'From', to: 'To (inclusive)', apply: 'Apply',
    presets: { today: 'Today', last7: 'Last 7 days', last30: 'Last 30 days', thisMonth: 'This month', lastMonth: 'Last month', next30: 'Next 30 days', thisYear: 'This year' } as Record<PresetKey, string>,
    occupancy: 'Occupancy', adr: 'ADR', revpar: 'RevPAR', roomNet: 'Net room revenue',
    occSub: (s: number, a: number) => `${s} / ${a} room-nights`, adrSub: 'Net room revenue / room-nights sold', revparSub: 'Net room revenue / available room-nights',
    roomNetSub: 'excl. tax, after discounts', inclComp: 'incl. complimentary',
    waterfall: 'From revenue to net after distribution', gross: 'Gross revenue (incl. tax)', vat: 'VAT', lodging: 'Lodging tax',
    net: 'Net revenue (excl. tax)', commission: 'OTA commission (distribution cost)', afterDist: 'Net after distribution',
    breakdown: 'Revenue breakdown', posted: 'Room revenue – posted', forecast: 'Room revenue – forecast (nights not posted yet)',
    discounts: 'Room discounts', roomTotal: 'Net room revenue', noShow: 'No-show revenue (outside ADR)', extras: 'Extras',
    roomGross: 'Room revenue (incl. tax)', nights: 'Room-nights', physical: 'Physical capacity', ooo: 'Out of order (deducted)',
    available: 'Available', sold: 'Sold', comp: 'Complimentary (reported separately)', noShowNights: 'No-show',
    cancelled: 'Cancelled (no revenue)', pending: 'Pending (unconfirmed)', resCount: 'res.',
    channels: 'Channels', channel: 'Channel', rate: 'Commission rate', afterCommission: 'After commission',
    usali: 'USALI account mapping', account: 'Account', schedule: 'USALI schedule', amount: 'Amount',
    daily: 'Daily', date: 'Date', revenue: 'Net room revenue',
    settlements: 'Settlements (cash flow, not revenue)', payments: 'Payments', refunds: 'Refunds',
    audit: 'Night audit: post tonight', auditDone: (n: number) => `${n} room-nights posted to folios.`,
    noAccess: 'Financial reports are available to owners and managers only.',
    notes: [
      'ADR = Net room revenue / Room-nights sold · RevPAR = Net room revenue / Available room-nights · Occupancy = Sold / Available × 100.',
      'Available room-nights = rooms × days − out-of-order room-nights, from dated OOO records.',
      'Cancellations never count as revenue. No-show and complimentary are reported separately and are outside ADR and RevPAR.',
      'Forecast revenue: confirmed nights not posted to a folio yet, at the reservation rate (excl. tax).',
      'OTA commission = reservation net room revenue × commission rate stored at booking time.',
      'Tax rates are demo values (VAT 10 % rooms, lodging tax 2 %); confirm with your accountant.',
      'Accounts are structured so they can be mapped to USALI categories; this is not a claim of full USALI compliance.'
    ]
  }
};

const PRESETS: PresetKey[] = ['today', 'last7', 'last30', 'thisMonth', 'lastMonth', 'next30', 'thisYear'];

export function ReportsView({
  demo, property, role, today, period, metrics
}: {
  demo: boolean;
  property: Pick<Property, 'id' | 'name' | 'code' | 'currency'>;
  role: MemberRole;
  today: string;
  period: Period;
  metrics: PMSMetrics | null;
}) {
  const { lang } = usePreferences();
  const t = T[lang];
  const router = useRouter();
  const money = (c: number) => formatMoney(c, property.currency, lang);
  const pct = (n: number) => `${n.toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} %`;
  const [auditMsg, setAuditMsg] = useState<string | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);

  const go = (p: Period) => router.push(`/reports?from=${p.from}&to=${p.to}`);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const from = String(f.get('from'));
    const last = String(f.get('last'));
    if (from && last && last >= from) go({ from, to: addDays(last, 1) });
  };
  const runAudit = async () => {
    setAuditBusy(true);
    setAuditMsg(null);
    try {
      const res = await fetch('/api/night-audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ propertyId: property.id }) });
      const body = (await res.json().catch(() => null)) as { posted?: number; error?: { message?: string } } | null;
      setAuditMsg(res.ok ? t.auditDone(body?.posted ?? 0) : body?.error?.message ?? 'Hata');
      if (res.ok) router.refresh();
    } catch {
      setAuditMsg(lang === 'tr' ? 'Sunucuya ulaşılamadı.' : 'Server unreachable.');
    }
    setAuditBusy(false);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6">
      {demo && <div role="status" className="tone tone-amber mb-5 rounded-xl px-4 py-2.5 text-[13px] font-medium">{LABELS[lang].ui.demo}</div>}
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">AXON PMS · {property.code}</p>
          <h1 className="mt-1 font-display text-[1.7rem] font-semibold tracking-tight text-ink sm:text-[2.1rem]">{property.name}</h1>
          <p className="mt-1 text-[13px] text-mist">
            {t.title} · {formatDate(period.from, lang)} – {formatDate(addDays(period.to, -1), lang)} ({metrics?.period.days ?? 0} {lang === 'tr' ? 'gün' : 'days'})
          </p>
        </div>
        <PreferenceToggles />
      </header>
      <AppNav role={role} />

      {!metrics ? (
        <p className="tone tone-slate rounded-xl px-4 py-3 text-[13.5px]">{t.noAccess}</p>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-end gap-2">
            {PRESETS.map((k) => {
              const p = presetPeriod(k, today);
              const active = p.from === period.from && p.to === period.to;
              return (
                <button key={k} type="button" onClick={() => go(p)} className={`btn-line px-3 py-1.5 ${active ? 'border-gold/60 text-gold' : ''}`}>
                  {t.presets[k]}
                </button>
              );
            })}
            <form key={`${period.from}${period.to}`} onSubmit={submit} className="flex flex-wrap items-end gap-2 sm:ml-auto">
              <label className="text-[11px] text-mist">{t.from}<input name="from" type="date" defaultValue={period.from} className="field mt-0.5 w-[150px] py-1.5 text-[13px]" /></label>
              <label className="text-[11px] text-mist">{t.to}<input name="last" type="date" defaultValue={addDays(period.to, -1)} className="field mt-0.5 w-[150px] py-1.5 text-[13px]" /></label>
              <button type="submit" className="btn-line px-3 py-1.5">{t.apply}</button>
            </form>
          </div>

          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={t.occupancy} value={pct(metrics.kpi.occupancy)} sub={`${t.occSub(metrics.roomNights.sold, metrics.capacity.availableRoomNights)} · ${pct(metrics.kpi.occupancyInclComp)} ${t.inclComp}`} />
            <Kpi label={t.adr} value={money(metrics.kpi.adr)} sub={t.adrSub} />
            <Kpi label={t.revpar} value={money(metrics.kpi.revpar)} sub={t.revparSub} />
            <Kpi label={t.roomNet} value={money(metrics.revenue.roomNet)} sub={t.roomNetSub} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t.waterfall}>
              <Rows rows={[
                [t.gross, money(metrics.revenue.totalGross), 'strong'],
                [`− ${t.vat}`, money(-metrics.revenue.taxes.vat)],
                [`− ${t.lodging}`, money(-metrics.revenue.taxes.lodging)],
                [`= ${t.net}`, money(metrics.revenue.totalNet), 'strong'],
                [`− ${t.commission}`, money(-metrics.distribution.commission)],
                [`= ${t.afterDist}`, money(metrics.distribution.netAfterDistribution), 'gold']
              ]} />
            </Card>
            <Card title={t.breakdown}>
              <Rows rows={[
                [t.posted, money(metrics.revenue.roomPosted)],
                [t.forecast, money(metrics.revenue.roomForecast)],
                [t.discounts, money(metrics.revenue.roomDiscounts)],
                [t.roomTotal, money(metrics.revenue.roomNet), 'strong'],
                [t.roomGross, money(metrics.revenue.roomGross)],
                [t.noShow, money(metrics.revenue.noShowNet)],
                ...Object.entries(metrics.revenue.extrasByAccount).map(([k, v]) => [`${t.extras}: ${ACCOUNT_LABELS[k]?.[lang] ?? k}`, money(v)] as [string, string]),
                [t.extras, money(metrics.revenue.extrasNet), 'strong']
              ]} />
            </Card>
            <Card title={t.nights}>
              <Rows rows={[
                [t.physical, String(metrics.capacity.physicalRoomNights)],
                [`− ${t.ooo}`, String(metrics.capacity.outOfOrderRoomNights)],
                [`= ${t.available}`, String(metrics.capacity.availableRoomNights), 'strong'],
                [t.sold, String(metrics.roomNights.sold), 'strong'],
                [t.comp, `${metrics.roomNights.complimentary} (${metrics.counts.complimentaryReservations} ${t.resCount})`],
                [t.noShowNights, `${metrics.roomNights.noShow} (${metrics.counts.noShowReservations} ${t.resCount})`],
                [t.cancelled, `${metrics.roomNights.cancelled} (${metrics.counts.cancelledReservations} ${t.resCount})`],
                [t.pending, String(metrics.roomNights.pending)]
              ]} />
            </Card>
            <Card title={t.settlements}>
              <Rows rows={[
                [t.payments, money(metrics.settlements.payments)],
                [t.refunds, money(-metrics.settlements.refunds)],
                ['=', money(metrics.settlements.net), 'strong']
              ]} />
              {!demo && (role === 'owner' || role === 'manager') && (
                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-silver/10 pt-4">
                  <button type="button" className="btn-line" disabled={auditBusy} onClick={runAudit}>{t.audit}</button>
                  {auditMsg && <span role="status" className="text-[12.5px] text-mist">{auditMsg}</span>}
                </div>
              )}
            </Card>
          </div>

          <Card title={t.channels} className="mt-4">
            <Table head={[t.channel, t.sold, t.roomTotal, t.rate, t.commission, t.afterCommission]}
              rows={metrics.distribution.byChannel.map((c) => [c.name, String(c.soldRoomNights), money(c.roomRevenueNet), pct(c.effectiveRate * 100), money(c.commission), money(c.roomRevenueNet - c.commission)])} />
          </Card>

          <Card title={t.usali} className="mt-4">
            <Table head={[t.account, t.schedule, t.amount]}
              rows={ACCOUNT_ORDER.filter((k) => metrics.usali[k]).map((k) => [`${ACCOUNT_LABELS[k]![lang]} · ${k}`, ACCOUNT_LABELS[k]!.schedule, money(metrics.usali[k]!)])} />
          </Card>

          <Card title={t.daily} className="mt-4">
            <Table head={[t.date, t.available, t.sold, t.occupancy, t.adr, t.revpar, t.revenue]}
              rows={metrics.daily.map((d) => [
                formatDate(d.date, lang), String(d.availableRoomNights), String(d.soldRoomNights),
                <span key="o" className="inline-flex items-center gap-2"><span className="inline-block h-1.5 rounded-full bg-gold/70" style={{ width: `${Math.min(100, d.occupancy) * 0.6}px` }} />{pct(d.occupancy)}</span>,
                money(d.adr), money(d.revpar), money(d.roomRevenueNet)
              ])} />
          </Card>

          <ul className="mt-5 space-y-1 text-[11.5px] leading-relaxed text-mist">
            {t.notes.map((n) => <li key={n}>• {n}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-mist">{label}</p>
      <p className="mt-1 font-display text-[1.6rem] font-semibold leading-tight text-ink">{value}</p>
      <p className="mt-1 text-[11.5px] text-mist">{sub}</p>
    </div>
  );
}

function Card({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-4 ${className}`}>
      <h2 className="mb-3 font-display text-[15px] font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, string, ('strong' | 'gold')?][] }) {
  return (
    <dl className="divide-y divide-silver/10 text-[13.5px]">
      {rows.map(([k, v, s], i) => (
        <div key={`${k}${i}`} className="flex justify-between gap-4 py-1.5">
          <dt className={s ? 'font-semibold text-ink' : 'text-mist'}>{k}</dt>
          <dd className={`tabular-nums ${s === 'gold' ? 'font-semibold text-gold' : s ? 'font-semibold text-ink' : 'text-ink'}`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-silver/10 text-[11px] uppercase tracking-wider text-mist">
            {head.map((h, i) => <th key={h} className={`py-2 pr-3 font-semibold ${i > 0 ? 'text-right' : ''}`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-silver/[0.06]">
              {r.map((c, j) => <td key={j} className={`py-1.5 pr-3 tabular-nums text-ink ${j > 0 ? 'text-right' : ''}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
