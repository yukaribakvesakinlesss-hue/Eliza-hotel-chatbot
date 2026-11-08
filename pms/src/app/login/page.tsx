'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { PreferenceToggles, usePreferences } from '@/components/Preferences';
import { getBrowserClient } from '@/lib/supabase/client';

const TEXT = {
  tr: { title: 'Giriş yap', email: 'E-posta', password: 'Şifre', submit: 'Giriş yap', wait: 'Giriş yapılıyor…', bad: 'E-posta veya şifre hatalı.', demo: 'Supabase bağlı değil · demo modundasınız.', open: 'Demo oda panosunu aç' },
  en: { title: 'Sign in', email: 'Email', password: 'Password', submit: 'Sign in', wait: 'Signing in…', bad: 'Wrong email or password.', demo: 'Supabase is not connected · you are in demo mode.', open: 'Open the demo room board' }
};

export default function LoginPage() {
  const { lang } = usePreferences();
  const t = TEXT[lang];
  const router = useRouter();
  const supabase = getBrowserClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!supabase || pending) return;
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: String(form.get('email') ?? '').trim(),
      password: String(form.get('password') ?? '')
    });
    if (err) {
      setPending(false);
      setError(t.bad);
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
        {!supabase ? (
          <div className="mt-4 space-y-4">
            <p className="tone tone-amber rounded-xl px-3 py-2 text-[13px]">{t.demo}</p>
            <Link href="/rooms" className="btn-gold w-full">{t.open}</Link>
          </div>
        ) : (
          <form className="mt-5 space-y-4" onSubmit={submit} noValidate>
            <label className="block text-[13px] text-mist">
              {t.email}
              <input className="field mt-1" name="email" type="email" autoComplete="email" required />
            </label>
            <label className="block text-[13px] text-mist">
              {t.password}
              <input className="field mt-1" name="password" type="password" autoComplete="current-password" required />
            </label>
            {error && <p role="alert" className="text-[13px] text-rose-400">{error}</p>}
            <button type="submit" className="btn-gold w-full" disabled={pending}>{pending ? t.wait : t.submit}</button>
          </form>
        )}
      </div>
    </main>
  );
}
