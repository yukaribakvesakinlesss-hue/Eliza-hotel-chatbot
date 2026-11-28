/**
 * AXON PMS · database types (single source of truth on the TypeScript side).
 * Mirrors supabase/migrations/*. When the Supabase project is linked you can regenerate with
 *   npx supabase gen types typescript --project-id <id> > src/types/supabase.generated.ts
 * and compare; keep this file in sync with every migration.
 */

export const OCCUPANCY_STATUSES = ['VACANT', 'RESERVED', 'OCCUPIED'] as const;
export const HOUSEKEEPING_STATUSES = ['CLEAN', 'DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED'] as const;
export const MAINTENANCE_STATUSES = ['OPERATIONAL', 'OUT_OF_ORDER'] as const;
export const MEMBER_ROLES = ['owner', 'manager', 'front_desk', 'housekeeping', 'hk_supervisor'] as const;
export const HK_TASK_STATUSES = ['DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED', 'CLEAN', 'CANCELLED'] as const;
export const HK_TASK_TYPES = ['CHECKOUT', 'STAYOVER', 'DEEP', 'TOUCH_UP'] as const;
export const RESERVATION_STATUSES = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] as const;
export const FOLIO_TXN_TYPES = ['ROOM_CHARGE', 'TAX', 'DISCOUNT', 'EXTRA', 'PAYMENT', 'REFUND'] as const;
export const PAYMENT_METHODS = ['CASH', 'CARD', 'TRANSFER', 'OTA'] as const;
export const EXTRA_ACCOUNTS = ['FB_FOOD', 'FB_BEVERAGE', 'OOD_OTHER', 'MISC_INCOME'] as const;
export const RESERVATION_SOURCES = ['direct', 'phone', 'walk_in', 'email', 'website', 'ota'] as const;

export type OccupancyStatus = (typeof OCCUPANCY_STATUSES)[number];
export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];
export type MemberRole = (typeof MEMBER_ROLES)[number];
export type HkTaskStatus = (typeof HK_TASK_STATUSES)[number];
export type HkTaskType = (typeof HK_TASK_TYPES)[number];
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];
export type FolioTxnType = (typeof FOLIO_TXN_TYPES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type ExtraAccount = (typeof EXTRA_ACCOUNTS)[number];

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
  /** demo defaults: KDV 10 % on rooms, konaklama vergisi 2 % */
  vat_rate_rooms: number;
  lodging_tax_rate: number;
  no_show_charge_nights: number;
  /** housekeeping: supervisor inspection mandatory before a room is CLEAN */
  require_inspection: boolean;
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
  /** tax-exclusive base nightly rate (the assistant may only quote database rates) */
  base_rate: number | null;
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
  /** tax-exclusive nightly rate */
  nightly_rate: number;
  channel_code: string;
  /** commission rate snapshotted from the channel at booking time (0..1) */
  commission_rate: number;
  is_complimentary: boolean;
  /** the channel's own reservation number (OTA bookings) */
  external_ref?: string | null;
  created_at: string;
  updated_at: string;
};

export type DistributionChannel = {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  commission_rate: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type OutOfOrderPeriod = {
  id: number;
  organization_id: string;
  property_id: string;
  room_id: string;
  start_date: string;
  /** exclusive; null = still out of order */
  end_date: string | null;
  reason: string | null;
  created_at: string;
};

export type UsaliAccount = {
  code: string;
  name_tr: string;
  name_en: string;
  kind: 'REVENUE' | 'ALLOWANCE' | 'TAX_LIABILITY' | 'SETTLEMENT' | 'EXPENSE';
  usali_schedule: string;
  sort_order: number;
};

export type Folio = {
  id: string;
  organization_id: string;
  property_id: string;
  reservation_id: string;
  status: 'OPEN' | 'CLOSED';
  currency: string;
  closed_at: string | null;
  closed_by: string | null;
  created_at: string;
};

/** Append-only ledger row. Sign = effect on the guest balance (charges +, discounts/payments −). */
export type FolioTransaction = {
  id: number;
  organization_id: string;
  property_id: string;
  folio_id: string;
  reservation_id: string;
  txn_type: FolioTxnType;
  account_code: string;
  description: string;
  service_date: string;
  amount: number;
  tax_code: 'VAT' | 'LODGING' | null;
  tax_rate: number | null;
  parent_id: number | null;
  reverses_id: number | null;
  payment_method: PaymentMethod | null;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: string;
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

export type HkTask = {
  id: string;
  organization_id: string;
  property_id: string;
  room_id: string;
  task_type: HkTaskType;
  status: HkTaskStatus;
  /** 1 = guest arriving today */
  priority: number;
  business_date: string;
  assigned_to: string | null;
  assigned_at: string | null;
  started_at: string | null;
  started_by: string | null;
  finished_at: string | null;
  finished_by: string | null;
  inspected_at: string | null;
  inspected_by: string | null;
  completed_at: string | null;
  rework_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type HkTaskNote = {
  id: number;
  organization_id: string;
  property_id: string;
  task_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
};

export type HkStaff = { user_id: string; display_name: string; role: 'housekeeping' | 'hk_supervisor' };

export type Guest = {
  id: string;
  organization_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  phone_normalized: string | null;
  nationality: string | null;
  language: string | null;
  /** 0 = none, 1–3 = VIP levels */
  vip_level: number;
  vip_note: string | null;
  marketing_consent: boolean;
  marketing_consent_at: string | null;
  marketing_consent_source: string | null;
  kvkk_notice_at: string | null;
  anonymized_at: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
};
export type GuestNoteCategory = 'PREFERENCE' | 'SPECIAL_REQUEST' | 'ALERT';
export type GuestNote = { id: number; organization_id: string; guest_id: string; category: GuestNoteCategory; body: string; created_by: string | null; created_at: string; archived_at: string | null };

export type InboxChannel = 'WHATSAPP' | 'INSTAGRAM' | 'WEBCHAT';
export type ChannelConnection = { id: string; organization_id: string; property_id: string; channel: InboxChannel; mode: 'DEMO' | 'LIVE'; external_account_id: string | null; display_name: string | null; created_at: string; updated_at: string };
export type Conversation = {
  id: string;
  organization_id: string;
  property_id: string;
  channel: InboxChannel;
  external_thread_id: string;
  guest_id: string | null;
  contact_name: string | null;
  contact_handle: string | null;
  /** AI = assistant answers; HUMAN = staff took over */
  status: 'AI' | 'HUMAN' | 'CLOSED';
  is_demo: boolean;
  context: Record<string, unknown>;
  unread_count: number;
  last_message_at: string;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
};
export type Message = {
  id: number;
  organization_id: string;
  property_id: string;
  conversation_id: string;
  channel: InboxChannel;
  direction: 'IN' | 'OUT';
  sender: 'GUEST' | 'AI' | 'STAFF' | 'SYSTEM';
  body: string;
  /** structured, database-verified data behind an AI reply (availability options, request id …) */
  payload: Record<string, unknown> | null;
  external_id: string | null;
  delivery_status: 'RECEIVED' | 'PENDING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'DEMO_NOT_SENT';
  author_id: string | null;
  created_at: string;
  delivery_attempts?: number;
  next_delivery_at?: string | null;
};
export type Quote = { complete: boolean; currency: string; nights: { date: string; rate: number | null }[]; net: number | null; vat: number | null; lodging: number | null; gross: number | null };
export type BookingRequest = {
  id: string;
  organization_id: string;
  property_id: string;
  conversation_id: string | null;
  guest_id: string | null;
  room_type_id: string;
  check_in: string;
  check_out: string;
  adults: number;
  contact_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  quote: Quote;
  status: 'NEW' | 'CONFIRMED' | 'DECLINED';
  reservation_id: string | null;
  handled_by: string | null;
  handled_at: string | null;
  decline_reason: string | null;
  created_at: string;
};
export type AvailabilityOption = { room_type_id: string; code: string; name: string; max_occupancy: number; available: number; quote: Quote };

// ---------- Phase 6: OTA channel manager and audit log ----------
export type OtaChannel = 'BOOKING' | 'EXPEDIA';
export type OtaConnection = {
  id: string; organization_id: string; property_id: string; channel_code: OtaChannel; mode: 'DEMO' | 'LIVE'; enabled: boolean;
  external_hotel_id: string | null; last_push_at: string | null; last_pull_at: string | null; last_error: string | null; created_at: string; updated_at: string;
};
export type OtaRoomMapping = {
  id: string; organization_id: string; property_id: string; connection_id: string; room_type_id: string; external_room_id: string; external_rate_plan_id: string; created_at: string;
};
export type OtaOutboxStatus = 'PENDING' | 'FAILED' | 'SENT' | 'DEMO_SKIPPED' | 'DEAD';
export type OtaOutboxRow = {
  id: number; organization_id: string; property_id: string; connection_id: string; room_type_id: string; stay_date: string; status: OtaOutboxStatus;
  attempts: number; next_attempt_at: string; last_error: string | null; last_sent: { available?: number; rate?: number; closed?: boolean } | null; queued_at: string; sent_at: string | null;
};
export type OtaEventStatus = 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED' | 'NEEDS_ATTENTION' | 'DEAD' | 'DISMISSED';
export type OtaInboundEvent = {
  id: number; organization_id: string; property_id: string; connection_id: string; external_event_id: string; kind: 'NEW' | 'MODIFY' | 'CANCEL';
  external_reservation_id: string; payload: Record<string, unknown>; is_demo: boolean; status: OtaEventStatus; outcome: string | null; attempts: number;
  next_attempt_at: string | null; last_error: string | null; reservation_id: string | null; received_at: string; processed_at: string | null; handled_by: string | null;
};
/** One availability + rate update, read from the database at send time. */
export type AriItem = {
  id: number; channel: OtaChannel; mode: 'DEMO' | 'LIVE'; hotel_id: string | null; room_id: string; rate_plan_id: string; date: string;
  available: number; rate: number | null; currency: string; closed: boolean; attempts: number;
};
export type AuditEntry = {
  id: number; at: string; actor_kind: 'USER' | 'SYSTEM' | 'DB'; actor_name: string; action: 'INSERT' | 'UPDATE' | 'DELETE';
  table_name: string; row_id: string | null; property_id: string | null; changes: Record<string, unknown>;
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
      distribution_channels: Table<DistributionChannel>;
      room_out_of_order_periods: Table<OutOfOrderPeriod>;
      usali_accounts: Table<UsaliAccount>;
      folios: Table<Folio>;
      folio_transactions: Table<FolioTransaction>;
      hk_tasks: Table<HkTask>;
      hk_task_notes: Table<HkTaskNote>;
      guests: Table<Guest>;
      guest_notes: Table<GuestNote>;
      channel_connections: Table<ChannelConnection>;
      conversations: Table<Conversation>;
      messages: Table<Message>;
      booking_requests: Table<BookingRequest>;
      ota_connections: Table<OtaConnection>;
      ota_room_mappings: Table<OtaRoomMapping>;
      ota_outbox: Table<OtaOutboxRow>;
      ota_inbound_events: Table<OtaInboundEvent>;
      audit_log: Table<AuditEntry & { organization_id: string | null; actor_id: string | null }>;
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
          p_nightly_rate?: number;
          p_channel_code?: string;
          p_is_complimentary?: boolean;
        };
        Returns: Reservation;
      };
      post_room_charges: { Args: { p_reservation_id: string; p_through?: string | null }; Returns: number };
      run_night_audit: { Args: { p_property_id: string; p_business_date?: string | null }; Returns: number };
      post_folio_transaction: {
        Args: {
          p_reservation_id: string;
          p_type: FolioTxnType;
          p_amount: number;
          p_description?: string | null;
          p_account_code?: string | null;
          p_service_date?: string | null;
          p_tax_rate?: number | null;
          p_payment_method?: PaymentMethod | null;
          p_idempotency_key?: string | null;
        };
        Returns: number;
      };
      reverse_folio_transaction: { Args: { p_transaction_id: number; p_reason?: string | null }; Returns: number };
      close_folio: { Args: { p_reservation_id: string }; Returns: Folio };
      hk_create_task: { Args: { p_room_id: string; p_task_type?: HkTaskType; p_priority?: number; p_assigned_to?: string | null; p_note?: string | null }; Returns: HkTask };
      hk_assign_task: { Args: { p_task_id: string; p_user_id: string | null }; Returns: HkTask };
      hk_start_task: { Args: { p_task_id: string }; Returns: HkTask };
      hk_finish_task: { Args: { p_task_id: string; p_note?: string | null }; Returns: HkTask };
      hk_inspect_task: { Args: { p_task_id: string; p_passed: boolean; p_note?: string | null }; Returns: HkTask };
      hk_cancel_task: { Args: { p_task_id: string }; Returns: HkTask };
      hk_add_note: { Args: { p_task_id: string; p_body: string }; Returns: HkTaskNote };
      hk_list_staff: { Args: { p_property_id: string }; Returns: HkStaff[] };
      hk_set_require_inspection: { Args: { p_property_id: string; p_required: boolean }; Returns: boolean };
      check_availability: { Args: { p_property_id: string; p_check_in: string; p_check_out: string; p_adults?: number }; Returns: AvailabilityOption[] };
      ota_worker_context: { Args: { p_org_slug: string; p_property_code: string; p_secret: string }; Returns: { property_id: string; timezone: string; currency: string; connections: { channel: OtaChannel; mode: 'DEMO' | 'LIVE'; enabled: boolean; hotel_id: string | null; last_pull_at: string | null }[] } };
      ota_ingest_event: { Args: { p_org_slug: string; p_property_code: string; p_channel: OtaChannel; p_secret: string; p_event: Record<string, unknown> }; Returns: { event_id: number; inserted: boolean; status: OtaEventStatus; outcome: string | null; reservation_id: string | null; error: string | null } };
      ota_simulate_event: { Args: { p_property_id: string; p_channel: OtaChannel; p_event: Record<string, unknown> }; Returns: OtaInboundEvent };
      ota_retry_event: { Args: { p_event_id: number }; Returns: OtaInboundEvent };
      ota_dismiss_event: { Args: { p_event_id: number; p_note: string }; Returns: OtaInboundEvent };
      ota_retry_due: { Args: { p_property_id: string; p_secret?: string | null }; Returns: { retried: number; succeeded: number; purged: number } };
      ota_claim_outbox: { Args: { p_property_id: string; p_secret?: string | null; p_limit?: number }; Returns: AriItem[] };
      ota_outbox_result: { Args: { p_property_id: string; p_secret: string | null; p_results: Record<string, unknown>[] }; Returns: { updated: number } };
      ota_mark_pulled: { Args: { p_property_id: string; p_secret: string | null; p_channel: OtaChannel; p_error?: string | null }; Returns: undefined };
      ota_configure: { Args: { p_property_id: string; p_channel: OtaChannel; p_mode: 'DEMO' | 'LIVE'; p_hotel_id?: string | null; p_secret?: string | null; p_enabled?: boolean }; Returns: OtaConnection };
      ota_set_mapping: { Args: { p_property_id: string; p_channel: OtaChannel; p_room_type_id: string; p_external_room_id: string | null; p_rate_plan_id?: string | null }; Returns: OtaRoomMapping | null };
      ota_full_resync: { Args: { p_property_id: string }; Returns: { queued: number } };
      inbox_due_deliveries: { Args: { p_org_slug: string; p_property_code: string; p_channel: InboxChannel; p_secret: string }; Returns: { id: number; body: string; delivery_status: string; thread_id: string; attempts: number }[] };
      audit_feed: { Args: { p_organization_id: string; p_table?: string | null; p_before_id?: number | null; p_limit?: number }; Returns: AuditEntry[] };
      health_check: { Args: Record<string, never>; Returns: { ok: boolean; db_time: string; schema: string } };
      channel_configure: { Args: { p_property_id: string; p_channel: InboxChannel; p_mode: 'DEMO' | 'LIVE'; p_external_account_id?: string | null; p_ingest_secret?: string | null }; Returns: ChannelConnection };
      set_room_type_rate: { Args: { p_room_type_id: string; p_base_rate: number | null }; Returns: RoomType };
      inbox_public_property: { Args: { p_org_slug: string; p_property_code: string }; Returns: unknown };
      webchat_start: { Args: { p_org_slug: string; p_property_code: string; p_name?: string | null }; Returns: { conversation_id: string; token: string; property_name: string } };
      webchat_send: { Args: { p_conversation_id: string; p_token: string; p_body: string; p_client_message_id: string }; Returns: { inserted: boolean; message_id: number | null } };
      webchat_messages: { Args: { p_conversation_id: string; p_token: string; p_after_id?: number }; Returns: Message[] };
      inbox_ingest: { Args: { p_org_slug: string; p_property_code: string; p_channel: InboxChannel; p_secret: string; p_external_message_id: string; p_thread_id: string; p_contact_name: string | null; p_body: string }; Returns: { conversation_id: string; inserted: boolean; message_id: number | null; status: string; last_assistant_type: string | null } };
      inbox_simulate_inbound: { Args: { p_property_id: string; p_channel: InboxChannel; p_thread_id: string; p_contact_name: string | null; p_body: string; p_external_message_id: string }; Returns: { conversation_id: string; inserted: boolean; message_id: number | null; status: string } };
      inbox_assistant_turn: { Args: { p_conversation_id: string; p_token: string | null; p_intent: string; p_slots: Record<string, unknown>; p_lang?: string }; Returns: unknown };
      inbox_send_staff_message: { Args: { p_conversation_id: string; p_body: string; p_client_message_id?: string | null }; Returns: Message };
      inbox_set_delivery: { Args: { p_message_id: number; p_status: string; p_token?: string | null }; Returns: Message };
      inbox_set_status: { Args: { p_conversation_id: string; p_status: 'AI' | 'HUMAN' | 'CLOSED' }; Returns: Conversation };
      inbox_mark_read: { Args: { p_conversation_id: string }; Returns: Conversation };
      inbox_link_guest: { Args: { p_conversation_id: string; p_guest_id: string | null }; Returns: Conversation };
      booking_request_confirm: { Args: { p_request_id: string }; Returns: BookingRequest };
      booking_request_decline: { Args: { p_request_id: string; p_reason?: string | null }; Returns: BookingRequest };
      guest_profile: { Args: { p_guest_id: string }; Returns: unknown };
      guest_update: { Args: { p_guest_id: string; p_changes: Record<string, unknown> }; Returns: Guest };
      guest_add_note: { Args: { p_guest_id: string; p_category: GuestNoteCategory; p_body: string }; Returns: GuestNote };
      guest_archive_note: { Args: { p_note_id: number }; Returns: GuestNote };
      kvkk_export_guest: { Args: { p_guest_id: string }; Returns: unknown };
      kvkk_anonymize_guest: { Args: { p_guest_id: string }; Returns: Guest };
      kvkk_retention_candidates: { Args: { p_organization_id: string }; Returns: { guest_id: string; full_name: string; last_activity_at: string }[] };
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
      folio_txn_type: FolioTxnType;
      hk_task_status: HkTaskStatus;
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
