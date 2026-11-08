'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { Guest, GuestNote, MemberRole } from '@/types/database';
import { formatMoney, toCents } from '@/lib/finance/metrics';
import { formatDate } from '@/lib/reservations/dates';
import { RES_STATUS_LABELS } from '@/lib/i18n/reservations';
import { GuestsHeader } from './GuestsHeader';

export type ProfileData = {
  guest: Guest;
  stats: { stays: number; upcoming: number; in_house: number; cancellations: number; no_shows: number; nights: number; first_stay: string | null; last_stay: string | null; total_spend: number | string; currency: string | null };
  stays: { id: string; code: string; status: keyof (typeof RES_STATUS_LABELS)['tr']; check_in: string; check_out: string; room: string; property: string; channel: string; spend: number | string }[];
  notes: GuestNote[];
  conversations: { id: string; channel: string; status: string; last_message_at: string; preview: string | null; is_demo: boolean }[];
  requests: { id: string; status: string; check_in: string; check_out: string; created_at: string }[];
};
const CAT: Record<string, { label: string; tone: string }> = {
  PREFERENCE: { label: 'Tercih', tone: 'tone-blue' },
  SPECIAL_REQUEST: { label: 'Özel istek', tone: 'tone-violet' },
  ALERT: { label: 'Uyarı', tone: 'tone-rose' }
};

async function call(id: string, body: Record<string, unknown>) {
  try {
    const res = await fetch(`/api/guests/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> & { error?: { message?: string } } | null;
    return res.ok ? { ok: true as const, data: json } : { ok: false as const, message: json?.error?.message ?? 'İşlem tamamlanamadı.' };
  } catch {
    return { ok: false as const, message: 'Sunucuya ulaşılamadı; işlem kaydedilmedi.' };
  }
}

export function GuestProfile({ role, propertyCode, data }: { role: MemberRole; propertyCode: string; data: ProfileData }) {
  const router = useRouter();
  const g = data.guest;
  const manager = role === 'owner' || role === 'manager';
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const money = (v: number | string) => formatMoney(toCents(v), data.stats.currency ?? 'EUR', 'tr');
  const anonymized = Boolean(g.anonymized_at);

  const run = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    const r = await call(g.id, body);
    setBusy(false);
    setFlash(r.ok ? { ok: true, text: done } : { ok: false, text: r.message });
    if (r.ok) router.refresh();
    return r;
  };

  const saveProfile = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const changes: Record<string, unknown> = {
      full_name: String(f.get('full_name') ?? ''), email: String(f.get('email') ?? ''), phone: String(f.get('phone') ?? ''),
      nationality: String(f.get('nationality') ?? ''), language: String(f.get('language') ?? '')
    };
    if (manager) {
      changes.vip_level = Number(f.get('vip_level') ?? 0);
      changes.vip_note = String(f.get('vip_note') ?? '');
    }
    const r = await run({ action: 'update', changes }, 'Profil kaydedildi');
    if (r.ok) setEdit(false);
  };

  const exportData = async () => {
    const r = await call(g.id, { action: 'export' });
    if (!r.ok) return setFlash({ ok: false, text: r.message });
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kvkk-${g.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setFlash({ ok: true, text: 'KVKK veri dökümü indirildi (kayıt altına alındı)' });
  };

  return (
    <div className="mx-auto max-w-5xl px-3 pb-16 pt-5 sm:px-6">
      <GuestsHeader role={role} propertyCode={propertyCode} title="Misafir profili" />
      <Link href="/guests" className="mb-3 inline-block text-[13px] text-gold">← Misafirler</Link>

      <section className="card mb-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[1.5rem] font-semibold text-ink">{g.full_name}</h2>
            <p className="text-[13px] text-mist">{[g.email, g.phone, g.nationality, g.language?.toUpperCase()].filter(Boolean).join(' · ') || 'İletişim bilgisi yok'}</p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[12px] font-semibold">
              {g.vip_level > 0 && <span className="tone tone-amber rounded-full px-2.5 py-0.5">{'★'.repeat(g.vip_level)} VIP{g.vip_note ? ` · ${g.vip_note}` : ''}</span>}
              <span className={`tone ${g.marketing_consent ? 'tone-green' : 'tone-slate'} rounded-full px-2.5 py-0.5`}>{g.marketing_consent ? 'Pazarlama izni var' : 'Pazarlama izni yok'}</span>
              <span className={`tone ${g.kvkk_notice_at ? 'tone-green' : 'tone-amber'} rounded-full px-2.5 py-0.5`}>{g.kvkk_notice_at ? `KVKK aydınlatma ${new Date(g.kvkk_notice_at).toLocaleDateString('tr-TR')}` : 'KVKK aydınlatma kaydı yok'}</span>
              {anonymized && <span className="tone tone-slate rounded-full px-2.5 py-0.5">Anonimleştirildi {new Date(g.anonymized_at!).toLocaleDateString('tr-TR')}</span>}
            </div>
          </div>
          {!anonymized && <button type="button" className="btn-line min-h-[44px]" onClick={() => setEdit((v) => !v)}>{edit ? 'Vazgeç' : 'Düzenle'}</button>}
        </div>
        {edit && (
          <form onSubmit={saveProfile} className="mt-4 grid gap-2 sm:grid-cols-2">
            <input name="full_name" defaultValue={g.full_name} className="field min-h-[44px]" placeholder="Ad soyad" />
            <input name="email" defaultValue={g.email ?? ''} className="field min-h-[44px]" placeholder="E-posta" />
            <input name="phone" defaultValue={g.phone ?? ''} className="field min-h-[44px]" placeholder="Telefon" />
            <input name="nationality" defaultValue={g.nationality ?? ''} className="field min-h-[44px]" placeholder="Uyruk" />
            <input name="language" defaultValue={g.language ?? ''} className="field min-h-[44px]" placeholder="Dil (tr, en …)" />
            {manager && (
              <>
                <select name="vip_level" defaultValue={g.vip_level} className="field min-h-[44px]">
                  <option value={0}>VIP değil</option><option value={1}>★ VIP</option><option value={2}>★★ VIP</option><option value={3}>★★★ VIP</option>
                </select>
                <input name="vip_note" defaultValue={g.vip_note ?? ''} className="field min-h-[44px] sm:col-span-2" placeholder="VIP notu" />
              </>
            )}
            <button type="submit" disabled={busy} className="btn-gold min-h-[48px] sm:col-span-2">Kaydet</button>
          </form>
        )}
      </section>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Konaklama" value={String(data.stats.stays)} sub={`${data.stats.nights} gece`} />
        <Stat label="Toplam harcama" value={money(data.stats.total_spend)} sub="vergi dahil, folyodan" />
        <Stat label="Yaklaşan" value={String(data.stats.upcoming + data.stats.in_house)} sub={data.stats.in_house ? 'şu an otelde' : ''} />
        <Stat label="İptal / gelmedi" value={`${data.stats.cancellations} / ${data.stats.no_shows}`} sub={data.stats.last_stay ? `son konaklama ${formatDate(data.stats.last_stay)}` : ''} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h3 className="mb-2 font-display text-[15px] font-semibold text-ink">Tercihler ve özel istekler</h3>
          <ul className="mb-3 space-y-1.5">
            {data.notes.length === 0 && <li className="text-[13px] text-mist">Not yok.</li>}
            {data.notes.map((n) => (
              <li key={n.id} className="flex items-start gap-2 text-[13.5px]">
                <span className={`tone ${CAT[n.category]?.tone} rounded px-1.5 text-[11px] font-semibold`}>{CAT[n.category]?.label}</span>
                <span className="flex-1 text-ink">{n.body}</span>
                {!anonymized && <button type="button" disabled={busy} className="text-[12px] text-mist hover:text-rose-400" onClick={() => run({ action: 'archive_note', noteId: n.id }, 'Not kaldırıldı')}>Kaldır</button>}
              </li>
            ))}
          </ul>
          {!anonymized && (
            <form className="flex flex-wrap gap-2" onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = new FormData(form);
              const r = await run({ action: 'note', category: f.get('category'), body: f.get('body') }, 'Not eklendi');
              if (r.ok) form.reset();
            }}>
              <select name="category" className="field min-h-[44px] w-auto">
                <option value="PREFERENCE">Tercih</option><option value="SPECIAL_REQUEST">Özel istek</option><option value="ALERT">Uyarı</option>
              </select>
              <input name="body" required maxLength={500} className="field min-h-[44px] flex-1" placeholder="Örn. yüksek kat, glutensiz kahvaltı" />
              <button type="submit" disabled={busy} className="btn-gold min-h-[44px]">Ekle</button>
            </form>
          )}
        </section>

        <section className="card p-4">
          <h3 className="mb-2 font-display text-[15px] font-semibold text-ink">İletişim geçmişi</h3>
          <ul className="space-y-2 text-[13px]">
            {data.conversations.length === 0 && <li className="text-mist">Mesaj geçmişi yok.</li>}
            {data.conversations.map((c) => (
              <li key={c.id} className="rounded-lg border border-silver/10 px-3 py-2">
                <p className="font-semibold text-ink">{c.channel}{c.is_demo ? ' · DEMO' : ''} · {new Date(c.last_message_at).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}</p>
                <p className="truncate text-mist">{c.preview}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card mt-4 p-4">
        <h3 className="mb-2 font-display text-[15px] font-semibold text-ink">Konaklama geçmişi</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-[13px]">
            <thead><tr className="text-[11px] uppercase tracking-wider text-mist"><th className="py-1.5">Rez.</th><th>Tarih</th><th>Oda</th><th>Kanal</th><th>Durum</th><th className="text-right">Harcama</th></tr></thead>
            <tbody>
              {data.stays.length === 0 && <tr><td colSpan={6} className="py-2 text-mist">Konaklama yok.</td></tr>}
              {data.stays.map((s) => (
                <tr key={s.id} className="border-t border-silver/[0.06]">
                  <td className="py-1.5 text-ink">{s.code}</td>
                  <td className="text-ink">{formatDate(s.check_in)} – {formatDate(s.check_out)}</td>
                  <td className="text-ink">{s.room}</td>
                  <td className="text-mist">{s.channel}</td>
                  <td className="text-ink">{RES_STATUS_LABELS.tr[s.status] ?? s.status}</td>
                  <td className="text-right tabular-nums text-ink">{money(s.spend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card mt-4 p-4">
        <h3 className="mb-1 font-display text-[15px] font-semibold text-ink">KVKK</h3>
        <p className="mb-3 text-[12.5px] text-mist">Misafir verisini yalnızca sahip, müdür ve resepsiyon görür; profil görüntüleme, değişiklik, dışa aktarma ve anonimleştirme kayıt altına alınır. Saklama süresi işletme ayarıdır (varsayılan 36 ay). Hukuki uygunluk için KVKK danışmanınızın onayı gerekir.</p>
        {!anonymized && (
          <div className="flex flex-wrap gap-2">
            {!g.kvkk_notice_at && <button type="button" disabled={busy} className="btn-line min-h-[44px]" onClick={() => run({ action: 'update', changes: { kvkk_notice: true } }, 'Aydınlatma metni verildi olarak işaretlendi')}>Aydınlatma metni verildi</button>}
            <button type="button" disabled={busy} className="btn-line min-h-[44px]" onClick={() => run({ action: 'update', changes: { marketing_consent: !g.marketing_consent } }, g.marketing_consent ? 'Pazarlama izni geri alındı' : 'Pazarlama izni kaydedildi')}>
              {g.marketing_consent ? 'Pazarlama iznini geri al' : 'Pazarlama izni kaydet'}
            </button>
            {manager && <button type="button" disabled={busy} className="btn-line min-h-[44px]" onClick={exportData}>Veri dökümünü indir (JSON)</button>}
          </div>
        )}
        {manager && !anonymized && (
          <div className="mt-4 rounded-xl border border-rose-400/30 p-3">
            <p className="text-[13px] font-semibold text-rose-400">Anonimleştir (silme talebi)</p>
            <p className="mb-2 text-[12px] text-mist">Ad, iletişim bilgileri, notlar ve misafir mesajları kalıcı olarak silinir; rezervasyonlar ve muhasebe kayıtları yasal saklama için anonim olarak kalır. Geri alınamaz.</p>
            <div className="flex flex-wrap gap-2">
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className="field min-h-[44px] flex-1" placeholder='Onay için "ANONİMLEŞTİR" yazın' />
              <button type="button" disabled={busy || confirmText !== 'ANONİMLEŞTİR'} className="btn-line min-h-[44px] border-rose-400/50 text-rose-400"
                onClick={() => run({ action: 'anonymize', confirm: confirmText }, 'Misafir anonimleştirildi')}>Anonimleştir</button>
            </div>
          </div>
        )}
      </section>

      {flash && (
        <div role={flash.ok ? 'status' : 'alert'} className={`tone ${flash.ok ? 'tone-green' : 'tone-rose'} fixed inset-x-3 bottom-4 z-[60] mx-auto max-w-md rounded-2xl px-4 py-3 text-[14px] font-semibold shadow-2xl`}>
          {flash.ok ? '✓ ' : ''}{flash.text}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-mist">{label}</p>
      <p className="mt-1 font-display text-[1.3rem] font-semibold text-ink">{value}</p>
      <p className="text-[11.5px] text-mist">{sub}</p>
    </div>
  );
}
