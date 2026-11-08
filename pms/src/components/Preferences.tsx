'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Lang } from '@/lib/i18n/labels';

type Theme = 'dark' | 'light';
type Prefs = { lang: Lang; theme: Theme; setLang: (l: Lang) => void; toggleTheme: () => void };

const Ctx = createContext<Prefs>({ lang: 'tr', theme: 'dark', setLang: () => {}, toggleTheme: () => {} });

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: keep the choice for this page only
  }
}

/** Language + light/dark theme, remembered per browser (same convention as the AXON site). */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('tr');
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const l = read('axon-pms-lang');
    if (l === 'en' || l === 'tr') setLangState(l);
    const t = read('axon-pms-theme');
    if (t === 'light' || t === 'dark') setTheme(t);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    document.documentElement.lang = lang;
  }, [theme, lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    write('axon-pms-lang', l);
  }, []);
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      write('axon-pms-theme', next);
      return next;
    });
  }, []);

  return <Ctx.Provider value={{ lang, theme, setLang, toggleTheme }}>{children}</Ctx.Provider>;
}

export const usePreferences = () => useContext(Ctx);

export function PreferenceToggles() {
  const { lang, setLang, theme, toggleTheme } = usePreferences();
  return (
    <div className="flex items-center gap-2">
      <button type="button" className="btn-line px-3" onClick={() => setLang(lang === 'tr' ? 'en' : 'tr')} aria-label="Language">
        {lang === 'tr' ? 'EN' : 'TR'}
      </button>
      <button type="button" className="btn-line px-3" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
        {theme === 'dark' ? '☀' : '☾'}
      </button>
    </div>
  );
}
