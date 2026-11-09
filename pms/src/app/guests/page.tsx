import Link from 'next/link';
import { redirect } from 'next/navigation';
import { demoProperty, demoRole } from '@/lib/demo/data';
import { demoGuests } from '@/lib/demo/crm';
import { todayIn } from '@/lib/reservations/dates';
import type { Guest, MemberRole } from '@/types/database';
import { GuestsHeader } from '@/components/guests/GuestsHeader';
import { maskEmail, maskPhone } from '@/lib/crm/api';
import { isHousekeepingRole } from '@/lib/rooms/rules';
import { getPropertyContext } from '@/lib/supabase/context';
import { getServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
const VIP = ['', '★ VIP', '★★ VIP', '★★★ VIP'];

export default async function GuestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const supabase = await getServerClient();
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q.trim().slice(0, 60) : '';
  const vipOnly = sp.vip === '1';
  if (!supabase) {
    // sales demo: sample guests built from the demo hotel's stays (nothing is stored)
    const needle = q.toLocaleLowerCase('tr');
    const list = demoGuests(todayIn(demoProperty.timezone)).guests
      .filter((g) => (!vipOnly || g.vip_level > 0) && (!needle || g.full_name.toLocaleLowerCase('tr').includes(needle) || (g.email ?? '').includes(needle)));
    return <GuestList role={demoRole} propertyCode={demoProperty.code} q={q} vipOnly={vipOnly} guests={list} demo />;
  }
  const ctx = await getPropertyContext(supabase);
  if (isHousekeepingRole(ctx.role)) redirect('/housekeeping');

  let query = supabase.from('guests').select('id, full_name, email, phone, vip_level, last_activity_at, anonymized_at, marketing_consent')
    .eq('organization_id', ctx.property.organization_id).order('last_activity_at', { ascending: false }).limit(200);
  if (q) {
    const safe = q.replace(/[%_,()]/g, ' ');
    const digits = q.replace(/\D/g, '');
    query = query.or([`full_name.ilike.%${safe}%`, `email.ilike.%${safe}%`, ...(digits.length >= 4 ? [`phone_normalized.ilike.%${digits}%`] : [])].join(','));
  }
  if (vipOnly) query = query.gt('vip_level', 0);
  const { data: guests, error } = await query;
  if (error) throw new Error(error.message);
  return <GuestList role={ctx.role} propertyCode={ctx.property.code} q={q} vipOnly={vipOnly} guests={guests ?? []} />;
}

type ListGuest = Pick<Guest, 'id' | 'full_name' | 'email' | 'phone' | 'vip_level' | 'last_activity_at' | 'anonymized_at' | 'marketing_consent'>;

function GuestList({ role, propertyCode, q, vipOnly, guests, demo = false }: { role: MemberRole; propertyCode: string; q: string; vipOnly: boolean; guests: ListGuest[]; demo?: boolean }) {
  return (
    <div className="mx-auto max-w-5xl px-3 pb-16 pt-5 sm:px-6">
      <GuestsHeader role={role} propertyCode={propertyCode} />
      {demo && <p className="tone tone-amber mb-3 rounded-xl px-4 py-2.5 text-[13px]">Demo: kurgusal misafirler (örnek otel). Gerçek sistemde profiller rezervasyon ve mesajlardan otomatik oluşur.</p>}
      <form className="mb-4 flex flex-wrap gap-2" action="/guests">
        <input name="q" defaultValue={q} placeholder="Ad, e-posta veya telefon" className="field min-h-[44px] flex-1" />
        <label className="flex items-center gap-2 text-[13px] text-mist"><input type="checkbox" name="vip" value="1" defaultChecked={vipOnly} className="h-5 w-5" /> Yalnızca VIP</label>
        <button className="btn-gold min-h-[44px]" type="submit">Ara</button>
      </form>
      <p className="mb-2 text-[12px] text-mist">KVKK: listede iletişim bilgileri maskelidir. Tam bilgi profilde görünür ve her görüntüleme kayıt altına alınır.</p>
      <ul className="card divide-y divide-silver/[0.08]">
        {guests.length === 0 && <li className="p-4 text-[14px] text-mist">Misafir bulunamadı. Profiller rezervasyon ve mesajlardan otomatik oluşur.</li>}
        {guests.map((g) => (
          <li key={g.id}>
            <Link href={`/guests/${g.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition hover:bg-silver/[0.05]">
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{g.full_name}</span>
              {g.vip_level > 0 && <span className="tone tone-amber rounded-full px-2 text-[11.5px] font-semibold">{VIP[g.vip_level]}</span>}
              {g.anonymized_at && <span className="tone tone-slate rounded-full px-2 text-[11.5px]">anonimleştirildi</span>}
              <span className="w-full text-[12.5px] text-mist sm:w-auto">{[maskEmail(g.email), maskPhone(g.phone)].filter(Boolean).join(' · ')}</span>
              <span className="text-[11.5px] text-mist">son etkileşim {new Date(g.last_activity_at).toLocaleDateString('tr-TR')}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
