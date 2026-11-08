/**
 * AXON PMS · database types (single source of truth on the TypeScript side).
 * Mirrors supabase/migrations/*. When the Supabase project is linked you can regenerate with
 *   npx supabase gen types typescript --project-id <id> > src/types/supabase.generated.ts
 * and compare; keep this file in sync with every migration.
 */

export const OCCUPANCY_STATUSES = ['VACANT', 'RESERVED', 'OCCUPIED'] as const;
export const HOUSEKEEPING_STATUSES = ['CLEAN', 'DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED'] as const;
export const MAINTENANCE_STATUSES = ['OPERATIONAL', 'OUT_OF_ORDER'] as const;
export const MEMBER_ROLES = ['owner', 'manager', 'front_desk', 'housekeeping'] as const;
export const RESERVATION_STATUSES = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] as const;
export const RESERVATION_SOURCES = ['direct', 'phone', 'walk_in', 'email', 'website', 'ota'] as const;

export type OccupancyStatus = (typeof OCCUPANCY_STATUSES)[number];
export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];
export type MemberRole = (typeof MEMBER_ROLES)[number];
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

export type StatusDimension = 'occupancy' | 'housekeeping' | 'maintenance';
export type StatusValue<D extends StatusDimension> = D extends 'occupancy'
  ? OccupancyStatus
  : D extends 'housekeeping'
    ? HousekeepingStatus
    : MaintenanceStatus;

export type Organization = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
}

export type Property = {
  id: string;
  organization_id: string;
  name: string;
  code: string;
  timezone: string;
  currency: string;
  created_at: string;
  updated_at: string;
}

export type AppUser = {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  updated_at: string;
}

export type Membership = {
  id: string;
  organization_id: string;
  user_id: string;
  property_id: string | null;
  role: MemberRole;
  created_at: string;
}

export type RoomType = {
  id: string;
  organization_id: string;
  property_id: string;
  code: string;
  name: string;
  base_occupancy: number;
  max_occupancy: number;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export type Room = {
  id: string;
  organization_id: string;
  property_id: string;
  room_type_id: string;
  number: string;
  floor: number | null;
  occupancy_status: OccupancyStatus;
  housekeeping_status: HousekeepingStatus;
  maintenance_status: MaintenanceStatus;
  maintenance_note: string | null;
  status_updated_at: string;
  status_updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export type RoomStatusEvent = {
  id: number;
  organization_id: string;
  property_id: string;
  room_id: string;
  dimension: StatusDimension;
  from_value: string | null;
  to_value: string;
  note: string | null;
  changed_by: string | null;
  changed_at: string;
}

/** Dates are ISO 'YYYY-MM-DD'; the stay is the half-open range [check_in, check_out). */
export type Reservation = {
  id: string;
  organization_id: string;
  property_id: string;
  room_id: string;
  code: string;
  status: ReservationStatus;
  check_in: string;
  check_out: string;
  stay: string;
  adults: number;
  children: number;
  source: ReservationSource;
  notes: string | null;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  checked_in_at: string | null;
  checked_out_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type ReservationGuest = {
  id: string;
  organization_id: string;
  property_id: string;
  reservation_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
};

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

/** Shape expected by @supabase/supabase-js generics (type aliases, not interfaces: the generics need index-compatible object types). */
export type Database = {
  public: {
    Tables: {
      organizations: Table<Organization>;
      properties: Table<Property>;
      users: Table<AppUser>;
      memberships: Table<Membership>;
      room_types: Table<RoomType>;
      rooms: Table<Room>;
      room_status_events: Table<RoomStatusEvent>;
      reservations: Table<Reservation>;
      reservation_guests: Table<ReservationGuest>;
    };
    Views: Record<string, never>;
    Functions: {
      set_room_status: {
        Args: { p_room_id: string; p_dimension: StatusDimension; p_value: string; p_note?: string | null };
        Returns: Room;
      };
      create_reservation: {
        Args: {
          p_property_id: string;
          p_room_id: string;
          p_check_in: string;
          p_check_out: string;
          p_adults: number;
          p_children?: number;
          p_guest_name?: string | null;
          p_guest_email?: string | null;
          p_guest_phone?: string | null;
          p_notes?: string | null;
          p_source?: ReservationSource;
          p_status?: ReservationStatus;
          p_idempotency_key?: string | null;
        };
        Returns: Reservation;
      };
      update_reservation: {
        Args: {
          p_reservation_id: string;
          p_room_id?: string | null;
          p_check_in?: string | null;
          p_check_out?: string | null;
          p_adults?: number | null;
          p_children?: number | null;
          p_notes?: string | null;
          p_expected_version?: number | null;
        };
        Returns: Reservation;
      };
      cancel_reservation: {
        Args: { p_reservation_id: string; p_reason?: string | null };
        Returns: Reservation;
      };
      set_reservation_status: {
        Args: { p_reservation_id: string; p_status: ReservationStatus };
        Returns: Reservation;
      };
      create_organization: {
        Args: {
          p_org_name: string;
          p_org_slug: string;
          p_property_name: string;
          p_property_code: string;
          p_timezone?: string;
          p_currency?: string;
        };
        Returns: string;
      };
    };
    Enums: {
      occupancy_status: OccupancyStatus;
      housekeeping_status: HousekeepingStatus;
      maintenance_status: MaintenanceStatus;
      member_role: MemberRole;
      reservation_status: ReservationStatus;
    };
    CompositeTypes: Record<string, never>;
  };
}

/** Room joined with its type, as used by the room board. */
export type RoomWithType = Room & {
  room_type: Pick<RoomType, 'id' | 'code' | 'name' | 'max_occupancy'> | null;
};

/** Reservation with its primary guest's name, as used by the tape chart. */
export type ReservationWithGuest = Reservation & { guest_name: string | null };
