-- =====================================================================
-- AXON Hotel PMS · Phase 1 · Core tenancy, users, room types, rooms
-- Target: Supabase PostgreSQL (15+). Idempotent where practical.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Enums: three independent room status dimensions + membership roles
-- ---------------------------------------------------------------------
do $$ begin
  create type public.occupancy_status as enum ('VACANT', 'RESERVED', 'OCCUPIED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.housekeeping_status as enum ('CLEAN', 'DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.maintenance_status as enum ('OPERATIONAL', 'OUT_OF_ORDER');
exception when duplicate_object then null; end $$;

do $$ begin
  -- owner: everything incl. members · manager: everything in the org except members
  -- front_desk: room statuses · housekeeping: housekeeping status only
  create type public.member_role as enum ('owner', 'manager', 'front_desk', 'housekeeping');
exception when duplicate_object then null; end $$;

-- Private schema for security helpers (not exposed through the Supabase API)
create schema if not exists app_private;
revoke all on schema app_private from public;

-- ---------------------------------------------------------------------
-- Shared trigger: updated_at
-- ---------------------------------------------------------------------
create or replace function app_private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Organizations (tenants)
-- ---------------------------------------------------------------------
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 120),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Properties (hotels) belong to exactly one organization
-- ---------------------------------------------------------------------
create table if not exists public.properties (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (char_length(name) between 2 and 120),
  code             text not null check (code ~ '^[A-Z0-9]{2,12}$'),
  timezone         text not null default 'Europe/Istanbul',
  currency         char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id)                    -- target for tenant-consistent composite FKs
);
create index if not exists properties_org_idx on public.properties (organization_id);

-- ---------------------------------------------------------------------
-- Users (application profile for auth.users) and memberships
-- ---------------------------------------------------------------------
create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.memberships (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  -- null = all properties of the organization; otherwise scoped to one property
  property_id      uuid,
  role             public.member_role not null,
  created_at       timestamptz not null default now(),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade,
  -- owners and managers are organization-wide
  check (property_id is null or role in ('front_desk', 'housekeeping'))
);
create unique index if not exists memberships_unique_scope
  on public.memberships (organization_id, user_id, coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists memberships_user_idx on public.memberships (user_id);

-- ---------------------------------------------------------------------
-- Room types
-- ---------------------------------------------------------------------
create table if not exists public.room_types (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,
  code             text not null check (code ~ '^[A-Z0-9_]{2,16}$'),
  name             text not null check (char_length(name) between 2 and 80),
  base_occupancy   smallint not null default 2 check (base_occupancy between 1 and 20),
  max_occupancy    smallint not null default 2 check (max_occupancy between 1 and 20),
  description      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade,
  unique (property_id, code),
  unique (id, property_id),
  check (max_occupancy >= base_occupancy)
);
create index if not exists room_types_property_idx on public.room_types (property_id);

-- ---------------------------------------------------------------------
-- Rooms with three independent status dimensions
-- ---------------------------------------------------------------------
create table if not exists public.rooms (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  property_id          uuid not null,
  room_type_id         uuid not null,
  number               text not null check (number ~ '^[A-Za-z0-9-]{1,10}$'),
  floor                smallint,
  occupancy_status     public.occupancy_status    not null default 'VACANT',
  housekeeping_status  public.housekeeping_status not null default 'CLEAN',
  maintenance_status   public.maintenance_status  not null default 'OPERATIONAL',
  maintenance_note     text check (maintenance_note is null or char_length(maintenance_note) <= 500),
  status_updated_at    timestamptz not null default now(),
  status_updated_by    uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade,
  foreign key (room_type_id, property_id) references public.room_types(id, property_id) on delete restrict,
  unique (property_id, number),
  -- an out-of-order room cannot hold a guest
  constraint rooms_out_of_order_not_occupied check (not (maintenance_status = 'OUT_OF_ORDER' and occupancy_status = 'OCCUPIED'))
);
create index if not exists rooms_property_idx on public.rooms (property_id);
create index if not exists rooms_status_idx on public.rooms (property_id, occupancy_status, housekeeping_status, maintenance_status);

-- ---------------------------------------------------------------------
-- Room status audit trail (append-only, written by trigger)
-- ---------------------------------------------------------------------
create table if not exists public.room_status_events (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  property_id      uuid not null,
  room_id          uuid not null references public.rooms(id) on delete cascade,
  dimension        text not null check (dimension in ('occupancy', 'housekeeping', 'maintenance')),
  from_value       text,
  to_value         text not null,
  note             text,
  changed_by       uuid references public.users(id) on delete set null,
  changed_at       timestamptz not null default now(),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade
);
create index if not exists room_status_events_room_idx on public.room_status_events (room_id, changed_at desc);
create index if not exists room_status_events_property_idx on public.room_status_events (property_id, changed_at desc);

-- updated_at triggers
drop trigger if exists organizations_touch on public.organizations;
create trigger organizations_touch before update on public.organizations for each row execute function app_private.touch_updated_at();
drop trigger if exists properties_touch on public.properties;
create trigger properties_touch before update on public.properties for each row execute function app_private.touch_updated_at();
drop trigger if exists users_touch on public.users;
create trigger users_touch before update on public.users for each row execute function app_private.touch_updated_at();
drop trigger if exists room_types_touch on public.room_types;
create trigger room_types_touch before update on public.room_types for each row execute function app_private.touch_updated_at();
drop trigger if exists rooms_touch on public.rooms;
create trigger rooms_touch before update on public.rooms for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- Create public.users row when someone signs up through Supabase Auth
-- ---------------------------------------------------------------------
create or replace function app_private.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.users (id, email, full_name)
  values (new.id, coalesce(new.email, ''), nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app_private.handle_new_auth_user();
