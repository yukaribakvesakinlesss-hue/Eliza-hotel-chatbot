import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { demoProperty, demoRoomTypes, demoRooms } from '@/lib/demo/data';
import { slugify } from '@/lib/slug';

const rooms = demoRooms();

describe('demo data', () => {
  it('has 24 unique rooms on 4 floors of the demo property', () => {
    expect(rooms).toHaveLength(24);
    expect(new Set(rooms.map((r) => r.number)).size).toBe(24);
    expect(new Set(rooms.map((r) => r.floor))).toEqual(new Set([1, 2, 3, 4]));
    expect(rooms.every((r) => r.property_id === demoProperty.id)).toBe(true);
  });
  it('respects the database invariant: no room is out of order and occupied', () => {
    expect(rooms.some((r) => r.maintenance_status === 'OUT_OF_ORDER' && r.occupancy_status === 'OCCUPIED')).toBe(false);
    expect(rooms.find((r) => r.number === '304')?.maintenance_status).toBe('OUT_OF_ORDER');
  });
  it('every room references a known room type', () => {
    const ids = new Set(demoRoomTypes.map((t) => t.id));
    expect(rooms.every((r) => ids.has(r.room_type_id) && r.room_type?.id === r.room_type_id)).toBe(true);
  });
  it('matches supabase/seed.sql room for room', () => {
    const seed = readFileSync(new URL('../supabase/seed.sql', import.meta.url), 'utf8');
    expect(seed).toContain(demoProperty.id);
    for (const t of demoRoomTypes) expect(seed).toContain(t.id);
  });
});

describe('slugify', () => {
  it('produces slugs accepted by organizations.slug', () => {
    for (const name of ['Aurelia Boutique Hotel', 'Çeşme Güneş Otelİ', '  Şile & Ağva — Resort  ', 'X'.repeat(200)]) {
      expect(`${slugify(name) || 'hotel'}-ab12`).toMatch(/^[a-z0-9][a-z0-9-]{1,62}$/);
    }
    expect(slugify('Çeşme Güneş Oteli')).toBe('cesme-gunes-oteli');
  });
});
