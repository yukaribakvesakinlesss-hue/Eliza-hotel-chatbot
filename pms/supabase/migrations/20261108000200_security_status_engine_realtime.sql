-- =====================================================================
-- AXON Hotel PMS · Phase 1 · Security (RLS), room status engine, realtime
-- =====================================================================

-- ---------------------------------------------------------------------
-- Security helpers. SECURITY DEFINER so policies can read memberships
-- without recursive RLS; empty search_path to prevent hijacking.
-- ---------------------------------------------------------------------
create or replace function app_private.org_role(p_org uuid)
returns public.member_role language sql stable security definer set search_path = '' as $$
  select m.role from public.memberships m
  where m.organization_id = p_org and m.user_id = auth.uid() and m.property_id is null
  order by case m.role when 'owner' then 1 when 'manager' then 2 when 'front_desk' then 3 else 4 end
  limit 1
$$;

create or replace function app_private.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.organization_id = p_org and m.user_id = auth.uid())
$$;

-- Highest role the current user has for a property (org-wide or property-scoped membership)
create or replace function app_private.property_role(p_property uuid)
returns public.member_role language sql stable security definer set search_path = '' as $$
  select m.role
  from public.memberships m
  join public.properties p on p.organization_id = m.organization_id
  where p.id = p_property and m.user_id = auth.uid()
    and (m.property_id is null or m.property_id = p_property)
  order by case m.role when 'owner' then 1 when 'manager' then 2 when 'front_desk' then 3 else 4 end
  limit 1
$$;

create or replace function app_private.has_property_access(p_property uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.property_role(p_property) is not null
$$;

create or replace function app_private.is_org_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.org_role(p_org) in ('owner', 'manager')
$$;

grant usage on schema app_private to authenticated;
grant execute on all functions in schema app_private to authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.organizations      enable row level security;
alter table public.properties         enable row level security;
alter table public.users              enable row level security;
alter table public.memberships        enable row level security;
alter table public.room_types         enable row level security;
alter table public.rooms              enable row level security;
alter table public.room_status_events enable row level security;

-- organizations
drop policy if exists org_select on public.organizations;
create policy org_select on public.organizations for select to authenticated
  using (app_private.is_org_member(id));
drop policy if exists org_update on public.organizations;
create policy org_update on public.organizations for update to authenticated
  using (app_private.org_role(id) = 'owner') with check (app_private.org_role(id) = 'owner');
-- inserts go through public.create_organization(); deletes are not allowed from the client

-- properties
drop policy if exists prop_select on public.properties;
create policy prop_select on public.properties for select to authenticated
  using (app_private.has_property_access(id));
drop policy if exists prop_insert on public.properties;
create policy prop_insert on public.properties for insert to authenticated
  with check (app_private.is_org_admin(organization_id));
drop policy if exists prop_update on public.properties;
create policy prop_update on public.properties for update to authenticated
  using (app_private.is_org_admin(organization_id)) with check (app_private.is_org_admin(organization_id));
drop policy if exists prop_delete on public.properties;
create policy prop_delete on public.properties for delete to authenticated
  using (app_private.org_role(organization_id) = 'owner');

-- users: see yourself and colleagues; edit only yourself
drop policy if exists users_select on public.users;
create policy users_select on public.users for select to authenticated
  using (id = auth.uid() or exists (
    select 1 from public.memberships mine
    join public.memberships theirs on theirs.organization_id = mine.organization_id
    where mine.user_id = auth.uid() and theirs.user_id = public.users.id));
drop policy if exists users_update on public.users;
create policy users_update on public.users for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- memberships: members see their own; owners/managers see the org; only owners manage
drop policy if exists mem_select on public.memberships;
create policy mem_select on public.memberships for select to authenticated
  using (user_id = auth.uid() or app_private.is_org_admin(organization_id));
drop policy if exists mem_insert on public.memberships;
create policy mem_insert on public.memberships for insert to authenticated
  with check (app_private.org_role(organization_id) = 'owner');
drop policy if exists mem_update on public.memberships;
create policy mem_update on public.memberships for update to authenticated
  using (app_private.org_role(organization_id) = 'owner') with check (app_private.org_role(organization_id) = 'owner');
drop policy if exists mem_delete on public.memberships;
create policy mem_delete on public.memberships for delete to authenticated
  using (app_private.org_role(organization_id) = 'owner' and user_id <> auth.uid());

-- room types
drop policy if exists rt_select on public.room_types;
create policy rt_select on public.room_types for select to authenticated
  using (app_private.has_property_access(property_id));
drop policy if exists rt_write on public.room_types;
create policy rt_write on public.room_types for all to authenticated
  using (app_private.is_org_admin(organization_id)) with check (app_private.is_org_admin(organization_id));

-- rooms: everyone with property access reads; admins create/delete;
-- any member may update, column-level rules are enforced by the status engine trigger
drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms for select to authenticated
  using (app_private.has_property_access(property_id));
drop policy if exists rooms_insert on public.rooms;
create policy rooms_insert on public.rooms for insert to authenticated
  with check (app_private.is_org_admin(organization_id));
drop policy if exists rooms_update on public.rooms;
create policy rooms_update on public.rooms for update to authenticated
  using (app_private.has_property_access(property_id)) with check (app_private.has_property_access(property_id));
drop policy if exists rooms_delete on public.rooms;
create policy rooms_delete on public.rooms for delete to authenticated
  using (app_private.is_org_admin(organization_id));

-- status events: read-only for members (written by trigger)
drop policy if exists rse_select on public.room_status_events;
create policy rse_select on public.room_status_events for select to authenticated
  using (app_private.has_property_access(property_id));

-- ---------------------------------------------------------------------
-- Grants. anon gets nothing; authenticated is filtered by RLS.
-- ---------------------------------------------------------------------
revoke all on public.organizations, public.properties, public.users, public.memberships,
              public.room_types, public.rooms, public.room_status_events from anon;
grant select, update                    on public.organizations      to authenticated;
grant select, insert, update, delete    on public.properties         to authenticated;
grant select, update (full_name)        on public.users              to authenticated;
grant select, insert, update, delete    on public.memberships        to authenticated;
grant select, insert, update, delete    on public.room_types         to authenticated;
grant select, insert, update, delete    on public.rooms              to authenticated;
grant select                            on public.room_status_events to authenticated;

-- ---------------------------------------------------------------------
-- Room status engine (BEFORE UPDATE on rooms)
--   * tenant keys are immutable
--   * role-based column permissions
--   * business rules between the three dimensions
-- ---------------------------------------------------------------------
create or replace function app_private.room_status_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_role public.member_role;
  v_status_changed boolean;
begin
  if new.organization_id <> old.organization_id or new.property_id <> old.property_id then
    raise exception 'TENANT_IMMUTABLE: a room cannot move to another property' using errcode = '42501';
  end if;

  v_status_changed := new.occupancy_status is distinct from old.occupancy_status
                   or new.housekeeping_status is distinct from old.housekeeping_status
                   or new.maintenance_status is distinct from old.maintenance_status;

  -- Role checks apply to end users. Service role / migrations (auth.uid() is null) are trusted.
  if auth.uid() is not null then
    v_role := app_private.property_role(new.property_id);
    if v_role is null then
      raise exception 'FORBIDDEN: no access to this property' using errcode = '42501';
    end if;

    if v_role not in ('owner', 'manager') and (
         new.number is distinct from old.number or new.floor is distinct from old.floor
      or new.room_type_id is distinct from old.room_type_id) then
      raise exception 'FORBIDDEN: only managers can change room setup' using errcode = '42501';
    end if;

    if v_role = 'housekeeping' and (
         new.occupancy_status is distinct from old.occupancy_status
      or new.maintenance_status is distinct from old.maintenance_status
      or new.maintenance_note is distinct from old.maintenance_note) then
      raise exception 'FORBIDDEN: housekeeping can only change the housekeeping status' using errcode = '42501';
    end if;
  end if;

  -- Business rules
  if new.occupancy_status = 'OCCUPIED' and old.occupancy_status <> 'OCCUPIED'
     and new.maintenance_status = 'OUT_OF_ORDER' then
    raise exception 'RULE_OUT_OF_ORDER: cannot check a guest into an out-of-order room' using errcode = '23514';
  end if;
  if new.maintenance_status = 'OUT_OF_ORDER' and old.maintenance_status <> 'OUT_OF_ORDER'
     and new.occupancy_status = 'OCCUPIED' then
    raise exception 'RULE_OCCUPIED: move the guest before setting the room out of order' using errcode = '23514';
  end if;
  -- Check-out: an occupied room that becomes vacant needs cleaning
  if old.occupancy_status = 'OCCUPIED' and new.occupancy_status = 'VACANT'
     and new.housekeeping_status is not distinct from old.housekeeping_status then
    new.housekeeping_status := 'DIRTY';
  end if;
  if new.maintenance_status = 'OPERATIONAL' and old.maintenance_status = 'OUT_OF_ORDER'
     and new.maintenance_note is not distinct from old.maintenance_note then
    new.maintenance_note := null;
  end if;

  if v_status_changed or new.housekeeping_status is distinct from old.housekeeping_status then
    new.status_updated_at := now();
    new.status_updated_by := auth.uid();
  end if;
  return new;
end $$;

drop trigger if exists rooms_status_guard on public.rooms;
create trigger rooms_status_guard before update on public.rooms
  for each row execute function app_private.room_status_guard();

-- Audit trail (AFTER UPDATE): one event per changed dimension
create or replace function app_private.log_room_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.occupancy_status is distinct from old.occupancy_status then
    insert into public.room_status_events (organization_id, property_id, room_id, dimension, from_value, to_value, changed_by)
    values (new.organization_id, new.property_id, new.id, 'occupancy', old.occupancy_status::text, new.occupancy_status::text, auth.uid());
  end if;
  if new.housekeeping_status is distinct from old.housekeeping_status then
    insert into public.room_status_events (organization_id, property_id, room_id, dimension, from_value, to_value, changed_by)
    values (new.organization_id, new.property_id, new.id, 'housekeeping', old.housekeeping_status::text, new.housekeeping_status::text, auth.uid());
  end if;
  if new.maintenance_status is distinct from old.maintenance_status then
    insert into public.room_status_events (organization_id, property_id, room_id, dimension, from_value, to_value, note, changed_by)
    values (new.organization_id, new.property_id, new.id, 'maintenance', old.maintenance_status::text, new.maintenance_status::text, new.maintenance_note, auth.uid());
  end if;
  return null;
end $$;

drop trigger if exists rooms_status_log on public.rooms;
create trigger rooms_status_log after update on public.rooms
  for each row execute function app_private.log_room_status();

-- ---------------------------------------------------------------------
-- RPC: change a room status (one dimension at a time, used by the UI)
-- SECURITY INVOKER: RLS + the guard trigger decide what is allowed.
-- ---------------------------------------------------------------------
create or replace function public.set_room_status(
  p_room_id uuid,
  p_dimension text,
  p_value text,
  p_note text default null
) returns public.rooms language plpgsql security invoker set search_path = '' as $$
declare
  v_room public.rooms;
begin
  if p_dimension = 'occupancy' then
    update public.rooms set occupancy_status = p_value::public.occupancy_status where id = p_room_id returning * into v_room;
  elsif p_dimension = 'housekeeping' then
    update public.rooms set housekeeping_status = p_value::public.housekeeping_status where id = p_room_id returning * into v_room;
  elsif p_dimension = 'maintenance' then
    update public.rooms set maintenance_status = p_value::public.maintenance_status,
                            maintenance_note = case when p_value = 'OUT_OF_ORDER' then nullif(trim(p_note), '') else maintenance_note end
      where id = p_room_id returning * into v_room;
  else
    raise exception 'INVALID_DIMENSION: %', p_dimension using errcode = '22023';
  end if;
  if v_room.id is null then
    raise exception 'NOT_FOUND: room not found or not accessible' using errcode = 'P0002';
  end if;
  return v_room;
end $$;

revoke all on function public.set_room_status(uuid, text, text, text) from public, anon;
grant execute on function public.set_room_status(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- RPC: onboarding. Creates an organization + first property and makes the
-- caller its owner (the only way a client can create an organization).
-- ---------------------------------------------------------------------
create or replace function public.create_organization(
  p_org_name text, p_org_slug text, p_property_name text, p_property_code text,
  p_timezone text default 'Europe/Istanbul', p_currency text default 'EUR'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  insert into public.users (id, email) select v_uid, coalesce(u.email, '') from auth.users u where u.id = v_uid
    on conflict (id) do nothing;
  insert into public.organizations (name, slug) values (p_org_name, p_org_slug) returning id into v_org;
  insert into public.properties (organization_id, name, code, timezone, currency)
    values (v_org, p_property_name, upper(p_property_code), p_timezone, upper(p_currency));
  insert into public.memberships (organization_id, user_id, role) values (v_org, v_uid, 'owner');
  return v_org;
end $$;

revoke all on function public.create_organization(text, text, text, text, text, text) from public, anon;
grant execute on function public.create_organization(text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Admin helper (service_role only): attach an existing auth user to an org
-- e.g. to give your own account access to the demo hotel.
-- ---------------------------------------------------------------------
create or replace function public.admin_add_member(p_email text, p_org_slug text, p_role public.member_role, p_property_code text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid; v_org uuid; v_prop uuid; v_id uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(p_email);
  if v_uid is null then raise exception 'USER_NOT_FOUND: sign up first with %', p_email; end if;
  insert into public.users (id, email) values (v_uid, lower(p_email)) on conflict (id) do nothing;
  select id into v_org from public.organizations where slug = p_org_slug;
  if v_org is null then raise exception 'ORG_NOT_FOUND: %', p_org_slug; end if;
  if p_property_code is not null then
    select id into v_prop from public.properties where organization_id = v_org and code = upper(p_property_code);
  end if;
  insert into public.memberships (organization_id, user_id, property_id, role)
    values (v_org, v_uid, v_prop, p_role) returning id into v_id;
  return v_id;
end $$;

revoke all on function public.admin_add_member(text, text, public.member_role, text) from public, anon, authenticated;
grant execute on function public.admin_add_member(text, text, public.member_role, text) to service_role;

-- ---------------------------------------------------------------------
-- Realtime: broadcast room changes (RLS still applies to subscribers)
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.rooms; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.room_status_events; exception when duplicate_object then null; end;
  end if;
end $$;
