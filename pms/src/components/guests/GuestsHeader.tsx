'use client';
import type { MemberRole } from '@/types/database';
import { AppNav } from '@/components/AppNav';
import { PreferenceToggles } from '@/components/Preferences';

export function GuestsHeader({ role, propertyCode, title = 'Misafirler' }: { role: MemberRole; propertyCode: string; title?: string }) {
  return (
    <>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">AXON PMS · {propertyCode}</p>
          <h1 className="mt-1 font-display text-[1.6rem] font-semibold tracking-tight text-ink sm:text-[2rem]">{title}</h1>
        </div>
        <PreferenceToggles />
      </header>
      <AppNav role={role} />
    </>
  );
}
