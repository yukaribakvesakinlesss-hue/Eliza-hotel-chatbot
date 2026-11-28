'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { PreferenceToggles, usePreferences } from '@/components/Preferences';
import { getBrowserClient } from '@/lib/supabase/client';
import { slugify } from '@/lib/slug';

const TEXT = {
  tr: { title: 'Otelinizi oluşturun', lead: 'İşletme ve ilk tesis bilgileri. Hesabınız bu işletmenin sahibi olur.', org: 'İşletme adı', prop: 'Tesis adı', code: 'Tesis kodu (2–10 harf)', submit: 'Oluştur', wait: 'Oluşturuluyor…', fail: 'Oluşturulamadı: ', demo: 'Demo modunda kurulum gerekmez.' },
  en: { title: 'Create your hotel', lead: 'Company and first property. Your account becomes the owner.', org: 'Company name', prop: 'Property name', code: 'Property code (2–10 letters)', submit: 'Create', wait: 'Creating…', fail: 'Could not create: ', demo: 'No setup needed in demo mode.' }
};

export default function OnboardingPage() {
  const { lang } = usePreferences();
  const t = TEXT[lang];
  const router = useRouter();
  const supabase = getBrowserClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!supabase || pending) return;
    const f = new FormData(e.currentTarget);
    const org = String(f.get('org') ?? '').trim();
    const prop = String(f.get('prop') ?? '').trim();
    const code = String(f.get('code') ?? '').trim().toUpperCase();
    if (org.length < 2 || prop.length < 2 || !/^[A-Z0-9]{2,10}$/.test(code)) {
      setError(t.fail + t.code);
      return;
    }
    setPending(true);
    setError(null);
    const { error: err } = await supabase.rpc('create_organization', {
      p_org_name: org,
      p_org_slug: `${slugify(org) || 'hotel'}-${Math.random().toString(36).slice(2, 6)}`,
      p_property_name: prop,
      p_property_code: code
    });
    if (err) {
      setPending(false);
      setError(t.fail + err.message);
      return;
    }
    router.replace('/rooms');
    router.refresh();
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <div className="mb-6 flex items-center justify-between">
        <p className="eyebrow">AXON PMS</p>
        <PreferenceToggles />
      </div>
      <div className="card p-6">
        <h1 className="font-display text-[1.6rem] font-semibold text-ink">{t.title}</h1>
        <p className="mt-1 text-[14px] text-mist">{supabase ? t.lead : t.demo}</p>
        {supabase && (
          <form className="mt-5 space-y-4" onSubmit={submit} noValidate>
            <label className="block text-[13px] text-mist">
              {t.org}
              <input className="field mt-1" name="org" required maxLength={120} />
            </label>
            <label className="block text-[13px] text-mist">
              {t.prop}
              <input className="field mt-1" name="prop" required maxLength={120} />
            </label>
            <label className="block text-[13px] text-mist">
              {t.code}
              <input className="field mt-1 uppercase" name="code" required maxLength={10} pattern="[A-Za-z0-9]{2,10}" />
            </label>
            {error && <p role="alert" className="text-[13px] text-rose-400">{error}</p>}
            <button type="submit" className="btn-gold w-full" disabled={pending}>{pending ? t.wait : t.submit}</button>
          </form>
        )}
      </div>
    </main>
  );
}
