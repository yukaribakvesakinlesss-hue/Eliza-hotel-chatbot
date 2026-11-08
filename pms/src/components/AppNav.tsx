'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { usePreferences } from './Preferences';

const ITEMS = [
  { href: '/rooms', tr: 'Oda durumu', en: 'Room status' },
  { href: '/reservations', tr: 'Rezervasyonlar', en: 'Reservations' },
  { href: '/reports', tr: 'Raporlar', en: 'Reports' }
];

/** Section switcher shared by the PMS pages. */
export function AppNav() {
  const path = usePathname();
  const { lang } = usePreferences();
  return (
    <nav aria-label="PMS" className="mb-5 flex gap-1 rounded-full border border-silver/15 bg-navy-800/60 p-1 text-[13px] font-medium sm:w-fit">
      {ITEMS.map((it) => {
        const active = path === it.href || path.startsWith(`${it.href}/`);
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? 'page' : undefined}
            className={`flex-1 rounded-full px-4 py-1.5 text-center transition sm:flex-none ${active ? 'bg-gold/15 text-gold' : 'text-mist hover:text-ink'}`}
          >
            {it[lang]}
          </Link>
        );
      })}
    </nav>
  );
}
