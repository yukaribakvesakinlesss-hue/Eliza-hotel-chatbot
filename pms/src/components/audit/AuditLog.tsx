'use client';
import { useState } from 'react';
import type { AuditEntry, MemberRole } from '@/types/database';
import { getBrowserClient } from '@/lib/supabase/client';
import { AppNav } from '@/components/AppNav';
import { PreferenceToggles } from '@/components/Preferences';

const TABLES: Record<string, string> = {
  reservations: 'Rezervasyon', reservation_guests: 'Rezervasyon misafiri', rooms: 'Oda', room_types: 'Oda tipi', rate_calendar: 'Fiyat takvimi',
  memberships: 'Kullanıcı yetkisi', properties: 'Tesis', organizations: 'Otel grubu', distribution_channels: 'Satış kanalı / komisyon',
  folios: 'Folyo', guests: 'Misafir profili', booking_requests: 'Rezervasyon talebi', channel_connections: 'Mesaj kanalı',
  property_faq: 'SSS cevabı', ota_connections: 'OTA bağlantısı', ota_room_mappings: 'OTA oda eşleştirme'
};
const ACTION: Record<string, string> = { INSERT: 'oluşturdu', UPDATE: 'değiştirdi', DELETE: 'sildi' };
const ACTOR: Record<string, string> = { USER: '', SYSTEM: 'Sistem', DB: 'Veritabanı' };

function show(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60);
  return String(v).slice(0, 60);
}

function Changes({ e }: { e: AuditEntry }) {
  const entries = Object.entries(e.changes).slice(0, e.action === 'UPDATE' ? 12 : 6);
  if (entries.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-[12px] text-mist">
      {entries.map(([k, v]) => {
        const c = v as { old?: unknown; new?: unknown; changed?: boolean } | string;
        let text: string;
        if (e.action !== 'UPDATE') text = c === '•••' ? 'gizli' : show(c);
        else if (typeof c === 'object' && c && 'changed' in c) text = 'değişti (kişisel veri, değer kaydedilmez)';
        else text = `${show((c as { old?: unknown }).old)} → ${show((c as { new?: unknown }).new)}`;
        return <li key={k} className="break-words"><span className="text-ink/80">{k}</span>: {text}</li>;
      })}
    </ul>
  );
}

export function AuditLog({ organizationId, propertyCode, role, initial }: { organizationId: string; propertyCode: string; role: MemberRole; initial: AuditEntry[] }) {
  const [rows, setRows] = useState(initial);
  const [table, setTable] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(initial.length < 100);

  const load = async (nextTable: string, more: boolean) => {
    const supabase = getBrowserClient();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc('audit_feed', {
      p_organization_id: organizationId, p_table: nextTable || null, p_before_id: more ? rows.at(-1)?.id ?? null : null, p_limit: 100
    });
    setBusy(false);
    if (e) return setError('Denetim kaydı yüklenemedi.');
    setRows((r) => (more ? [...r, ...(data ?? [])] : data ?? []));
    setDone((data ?? []).length < 100);
  };

  return (
    <div className="mx-auto max-w-[1100px] px-3 pb-16 pt-5 sm:px-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">AXON PMS · {propertyCode}</p>
          <h1 className="mt-1 font-display text-[1.6rem] font-semibold tracking-tight text-ink sm:text-[2rem]">Denetim kaydı</h1>
          <p className="mt-0.5 text-[13px] text-mist">Kim, ne zaman, neyi değiştirdi. Kayıtlar silinemez; kişisel veriler kaydedilmez.</p>
        </div>
        <PreferenceToggles />
      </header>
      <AppNav role={role} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select aria-label="Kayıt türü" className="field min-h-[44px]" value={table} onChange={(e) => { setTable(e.target.value); void load(e.target.value, false); }}>
          <option value="">Tüm kayıtlar</option>
          {Object.entries(TABLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <p className="text-[12.5px] text-mist">Oda durumu, housekeeping ve folyo hareketlerinin kendi ayrıntılı kayıtları ilgili ekranlardadır.</p>
      </div>
      {error && <p role="alert" className="tone tone-rose mb-3 rounded-xl px-4 py-3 text-[14px]">{error}</p>}
      <ol className="card divide-y divide-silver/[0.06]">
        {rows.length === 0 && <li className="p-4 text-[13px] text-mist">Kayıt yok.</li>}
        {rows.map((e) => (
          <li key={e.id} className="px-4 py-3 text-[13px]">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-semibold text-ink">{e.actor_kind === 'USER' ? e.actor_name : `${ACTOR[e.actor_kind]}${e.actor_kind === 'SYSTEM' ? ` (${e.actor_name})` : ''}`}</span>
              <span className="text-mist">{TABLES[e.table_name] ?? e.table_name} {ACTION[e.action]}</span>
              {e.row_id && <span className="text-[11.5px] text-mist">#{e.row_id.slice(0, 8)}</span>}
              <span className="ml-auto text-[11.5px] text-mist">{new Date(e.at).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'medium' })}</span>
            </div>
            <Changes e={e} />
          </li>
        ))}
      </ol>
      {!done && <button type="button" disabled={busy} className="btn-line mt-3 min-h-[44px]" onClick={() => load(table, true)}>{busy ? '…' : 'Daha eski kayıtlar'}</button>}
    </div>
  );
}
