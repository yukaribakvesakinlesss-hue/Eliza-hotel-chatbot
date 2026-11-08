'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MemberRole } from '@/types/database';
import { usePreferences } from './Preferences';

const ALL = ['owner', 'manager', 'front_desk', 'housekeeping', 'hk_supervisor'] as const;
export const NAV_ITEMS: { href: string; tr: string; en: string; roles: readonly MemberRole[] }[] = [
  { href: '/rooms', tr: 'Oda durumu', en: 'Room status', roles: ['owner', 'manager', 'front_desk'] },
  { href: '/reservations', tr: 'Rezervasyonlar', en: 'Reservations', roles: ['owner', 'manager', 'front_desk'] },
  { href: '/housekeeping', tr: 'Housekeeping', en: 'Housekeeping', roles: ALL },
  { href: '/reports', tr: 'Raporlar', en: 'Reports', roles: ['owner', 'manager'] }
];

/** Screens a role may open (housekeeping staff only see their operational screen). */
export function navItemsFor(role: MemberRole | null) {
  return NAV_ITEMS.filter((i) => role !== null && i.roles.includes(role));
}

/** Section switcher shared by the PMS pages. */
export function AppNav({ role }: { role: MemberRole | null }) {
  const path = usePathname();
  const { lang } = usePreferences();
  const ITEMS = navItemsFor(role);
  if (ITEMS.length < 2) return null;
  return (
    <nav aria-label="PMS" className="noscroll mb-5 flex max-w-full gap-1 overflow-x-auto rounded-full border border-silver/15 bg-navy-800/60 p-1 text-[13px] font-medium sm:w-fit">
      {ITEMS.map((it) => {
        const active = path === it.href || path.startsWith(`${it.href}/`);
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-[36px] flex-1 items-center justify-center whitespace-nowrap rounded-full px-3 py-1.5 text-center transition sm:flex-none sm:px-4 ${active ? 'bg-gold/15 text-gold' : 'text-mist hover:text-ink'}`}
          >
            {it[lang]}
          </Link>
        );
      })}
    </nav>
  );
}
