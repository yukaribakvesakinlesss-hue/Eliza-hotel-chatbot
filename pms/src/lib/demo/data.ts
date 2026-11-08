/**
 * Demo data · same hotel and room pattern as supabase/seed.sql, used when no Supabase
 * project is configured (and in tests). Never written to a real database from here.
 */
import type { MemberRole, Organization, Property, RoomType, RoomWithType } from '@/types/database';

const ORG = '00000000-0000-4000-a000-000000000001';
const PROP = '00000000-0000-4000-a000-000000000101';
const T0 = '2026-11-08T08:00:00.000Z';

export const demoOrganization: Organization = { id: ORG, name: 'AXON Demo Hotels', slug: 'axon-demo', created_at: T0, updated_at: T0 };
export const demoProperty: Property = { id: PROP, organization_id: ORG, name: 'Aurelia Boutique Hotel', code: 'AUR', timezone: 'Europe/Istanbul', currency: 'EUR', vat_rate_rooms: 0.1, lodging_tax_rate: 0.02, no_show_charge_nights: 1, require_inspection: true, created_at: T0, updated_at: T0 };
export const demoRole: MemberRole = 'owner';

export const demoRoomTypes: RoomType[] = [
  { id: '00000000-0000-4000-a000-000000000201', organization_id: ORG, property_id: PROP, code: 'CDBL', name: 'Classic Double', base_occupancy: 2, max_occupancy: 2, description: '22 m², city side', created_at: T0, updated_at: T0 },
  { id: '00000000-0000-4000-a000-000000000202', organization_id: ORG, property_id: PROP, code: 'DDBL', name: 'Deluxe Double', base_occupancy: 2, max_occupancy: 2, description: '28 m², city view', created_at: T0, updated_at: T0 },
  { id: '00000000-0000-4000-a000-000000000203', organization_id: ORG, property_id: PROP, code: 'JSTE', name: 'Junior Suite', base_occupancy: 2, max_occupancy: 3, description: '38 m², sitting area', created_at: T0, updated_at: T0 }
];

const OCC = ['OCCUPIED', 'OCCUPIED', 'VACANT', 'RESERVED', 'OCCUPIED', 'VACANT'] as const;
const HK = ['CLEAN', 'DIRTY', 'CLEAN', 'IN_PROGRESS', 'CLEAN', 'INSPECTION_REQUIRED', 'CLEAN'] as const;

export function demoRooms(): RoomWithType[] {
  const rooms: RoomWithType[] = [];
  for (let f = 1; f <= 4; f++) {
    for (let n = 1; n <= 6; n++) {
      const type = n % 6 === 0 ? demoRoomTypes[2]! : n % 2 === 0 ? demoRoomTypes[1]! : demoRoomTypes[0]!;
      const ooo = f === 3 && n === 4;
      rooms.push({
        id: `00000000-0000-4000-b000-${String(f * 100 + n).padStart(12, '0')}`,
        organization_id: ORG,
        property_id: PROP,
        room_type_id: type.id,
        number: String(f * 100 + n),
        floor: f,
        occupancy_status: ooo ? 'VACANT' : OCC[(f * 7 + n) % 6]!,
        housekeeping_status: HK[(f * 5 + n) % 7]!,
        maintenance_status: ooo ? 'OUT_OF_ORDER' : 'OPERATIONAL',
        maintenance_note: ooo ? 'Air conditioning repair' : null,
        status_updated_at: T0,
        status_updated_by: null,
        created_at: T0,
        updated_at: T0,
        room_type: { id: type.id, code: type.code, name: type.name, max_occupancy: type.max_occupancy }
      });
    }
  }
  return rooms;
}
