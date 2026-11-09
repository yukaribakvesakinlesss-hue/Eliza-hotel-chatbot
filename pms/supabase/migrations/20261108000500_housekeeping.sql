-- =====================================================================
-- AXON Hotel PMS · Phase 4 · Housekeeping operations
--
-- * hk_tasks: one open cleaning task per room. Status follows the room's
--   housekeeping status: DIRTY → IN_PROGRESS → INSPECTION_REQUIRED → CLEAN
--   (+ CANCELLED). Start / finish / inspection times and actors are stored.
-- * A room that becomes DIRTY (check-out or manual) gets a task automatically.
-- * Task RPCs move the room status in the same transaction, so the front desk
--   board (realtime on rooms) updates the moment a room is cleaned.
-- * New role hk_supervisor (kat şefi). Property setting require_inspection:
--   when on, housekeeping staff can never mark a room CLEAN themselves; the
--   database refuses it (RULE_INSPECTION), whatever client is used.
-- Enum literals of the new role are only compared as text in this file so it
-- also runs inside a single transaction (Supabase migrations).
-- Idempotent: safe to run more than once.
-- =====================================================================

alter type public.member_role add value if not exists 'hk_supervisor';

-- property-scoped memberships may now also be housekeeping supervisors
alter table public.memberships drop constraint if exists memberships_check;
alter table public.memberships drop constraint if exists memberships_scope_roles;
alter table public.memberships add constraint memberships_scope_roles
  check (property_id is null or role::text in ('front_desk', 'housekeeping', 'hk_supervisor'));

alter table public.properties
  add column if not exists require_inspection boolean not null default true;

do $$ begin
  create type public.hk_task_status as enum ('DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED', 'CLEAN', 'CANCELLED');
exception when duplicate_object then null; end $$;

create table if not exists public.hk_tasks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,
  room_id          uuid not null references public.rooms(id) on delete cascade,
  task_type        text not null default 'CHECKOUT' check (task_type in ('CHECKOUT', 'STAYOVER', 'DEEP', 'TOUCH_UP')),
  status           public.hk_task_status not null default 'DIRTY',
  priority         smallint not null default 2 check (priority between 1 and 3),   -- 1 = arrival today
  business_date    date not null,
  assigned_to      uuid references public.users(id) on delete set null,
  assigned_at      timestamptz,
  started_at       timestamptz,
  started_by       uuid references public.users(id) on delete set null,
  finished_at      timestamptz,
  finished_by      uuid references public.users(id) on delete set null,
  inspected_at     timestamptz,
  inspected_by     uuid references public.users(id) on delete set null,
  completed_at     timestamptz,
  rework_count     smallint not null default 0,
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (property_id, organization_id) references public.properties(id, organization_id) on delete cascade,
  unique (id, property_id)
);
create unique index if not exists hk_tasks_one_open_per_room on public.hk_tasks (room_id)
  where status in ('DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED');
create index if not exists hk_tasks_property_idx on public.hk_tasks (property_id, status, business_date);
create index if not exists hk_tasks_assignee_idx on public.hk_tasks (assigned_to, status);
drop trigger if exists hk_tasks_touch on public.hk_tasks;
create trigger hk_tasks_touch before update on public.hk_tasks for each row execute function app_private.touch_updated_at();

-- notes (append-only)
create table if not exists public.hk_task_notes (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  property_id      uuid not null,
  task_id          uuid not null,
  author_id        uuid references public.users(id) on delete set null,
  body             text not null check (char_length(body) between 1 and 1000),
  created_at       timestamptz not null default now(),
  foreign key (task_id, property_id) references public.hk_tasks(id, property_id) on delete cascade
);
create index if not exists hk_task_notes_task_idx on public.hk_task_notes (task_id, id);

-- status history (written by trigger)
create table if not exists public.hk_task_events (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  property_id      uuid not null,
  task_id          uuid not null,
  from_status      public.hk_task_status,
  to_status        public.hk_task_status not null,
  actor_id         uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  foreign key (task_id, property_id) references public.hk_tasks(id, property_id) on delete cascade
);
create index if not exists hk_task_events_task_idx on public.hk_task_events (task_id, id);

create or replace function app_private.log_hk_task() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.hk_task_events (organization_id, property_id, task_id, from_status, to_status, actor_id)
    values (new.organization_id, new.property_id, new.id, case when tg_op = 'UPDATE' then old.status end, new.status, auth.uid());
  end if;
  return null;
end $$;
drop trigger if exists hk_tasks_log on public.hk_tasks;
create trigger hk_tasks_log after insert or update of status on public.hk_tasks
  for each row execute function app_private.log_hk_task();

-- ---------------------------------------------------------------------
-- Room status engine: housekeeping supervisors are housekeeping staff for
-- column rules; the inspection rule is enforced here.
-- ---------------------------------------------------------------------
create or replace function app_private.room_status_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_status_changed boolean;
  v_require_inspection boolean;
begin
  if new.organization_id <> old.organization_id or new.property_id <> old.property_id then
    raise exception 'TENANT_IMMUTABLE: a room cannot move to another property' using errcode = '42501';
  end if;

  v_status_changed := new.occupancy_status is distinct from old.occupancy_status
                   or new.housekeeping_status is distinct from old.housekeeping_status
                   or new.maintenance_status is distinct from old.maintenance_status;

  if auth.uid() is not null then
    v_role := app_private.property_role(new.property_id)::text;
    if v_role is null then
      raise exception 'FORBIDDEN: no access to this property' using errcode = '42501';
    end if;

    if v_role not in ('owner', 'manager') and (
         new.number is distinct from old.number or new.floor is distinct from old.floor
      or new.room_type_id is distinct from old.room_type_id) then
      raise exception 'FORBIDDEN: only managers can change room setup' using errcode = '42501';
    end if;

    if v_role in ('housekeeping', 'hk_supervisor') and (
         new.occupancy_status is distinct from old.occupancy_status
      or new.maintenance_status is distinct from old.maintenance_status
      or new.maintenance_note is distinct from old.maintenance_note) then
      raise exception 'FORBIDDEN: housekeeping can only change the housekeeping status' using errcode = '42501';
    end if;

    if v_role = 'housekeeping' and new.housekeeping_status = 'CLEAN' and old.housekeeping_status <> 'CLEAN' then
      select p.require_inspection into v_require_inspection from public.properties p where p.id = new.property_id;
      if v_require_inspection then
        raise exception 'RULE_INSPECTION: Bu otelde kat şefi kontrolü zorunlu; oda kontrol edilmeden temiz işaretlenemez.' using errcode = '23514';
      end if;
    end if;
  end if;

  if new.occupancy_status = 'OCCUPIED' and old.occupancy_status <> 'OCCUPIED'
     and new.maintenance_status = 'OUT_OF_ORDER' then
    raise exception 'RULE_OUT_OF_ORDER: cannot check a guest into an out-of-order room' using errcode = '23514';
  end if;
  if new.maintenance_status = 'OUT_OF_ORDER' and old.maintenance_status <> 'OUT_OF_ORDER'
     and new.occupancy_status = 'OCCUPIED' then
    raise exception 'RULE_OCCUPIED: move the guest before setting the room out of order' using errcode = '23514';
  end if;
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

-- ---------------------------------------------------------------------
-- Room ↔ task sync: a room that gets dirty gets a task; a room changed on the
-- room board moves its open task along (the task RPCs update the task first,
-- so for them this is a no-op).
-- ---------------------------------------------------------------------
create or replace function app_private.sync_hk_task_from_room() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_task public.hk_tasks; v_today date; v_priority smallint;
begin
  if tg_op = 'INSERT' then
    if new.housekeeping_status = 'CLEAN' then return null; end if;
  elsif new.housekeeping_status is not distinct from old.housekeeping_status then
    return null;
  end if;
  select * into v_task from public.hk_tasks
   where room_id = new.id and status in ('DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED') for update;

  if v_task.id is null then
    if new.housekeeping_status = 'CLEAN' then return null; end if;
    v_today := app_private.property_today(new.property_id);
    v_priority := case when exists (select 1 from public.reservations r where r.room_id = new.id and r.check_in = v_today
                                    and r.status in ('CONFIRMED', 'PENDING')) then 1 else 2 end;
    insert into public.hk_tasks (organization_id, property_id, room_id, task_type, status, priority, business_date, created_by,
                                 started_at, finished_at)
    values (new.organization_id, new.property_id, new.id,
            case when tg_op = 'UPDATE' and old.occupancy_status = 'OCCUPIED' and new.occupancy_status = 'VACANT' then 'CHECKOUT'
                 when tg_op = 'INSERT' then 'CHECKOUT' else 'TOUCH_UP' end,
            new.housekeeping_status::text::public.hk_task_status, v_priority, v_today, auth.uid(),
            case when new.housekeeping_status in ('IN_PROGRESS', 'INSPECTION_REQUIRED') then now() end,
            case when new.housekeeping_status = 'INSPECTION_REQUIRED' then now() end);
    return null;
  end if;

  if v_task.status::text = new.housekeeping_status::text then return null; end if;
  update public.hk_tasks set
      status       = new.housekeeping_status::text::public.hk_task_status,
      started_at   = case when new.housekeeping_status <> 'DIRTY' then coalesce(started_at, now()) end,
      finished_at  = case when new.housekeeping_status in ('INSPECTION_REQUIRED', 'CLEAN') then coalesce(finished_at, now()) end,
      completed_at = case when new.housekeeping_status = 'CLEAN' then now() end,
      inspected_at = case when new.housekeeping_status = 'CLEAN' and v_task.status = 'INSPECTION_REQUIRED' then now() else inspected_at end,
      inspected_by = case when new.housekeeping_status = 'CLEAN' and v_task.status = 'INSPECTION_REQUIRED' then auth.uid() else inspected_by end
   where id = v_task.id;
  return null;
end $$;
drop trigger if exists rooms_sync_hk_task on public.rooms;
-- WHEN instead of "update of housekeeping_status": on check-out the status is changed by the
-- BEFORE trigger, not by the UPDATE's SET list, and a column trigger would not fire.
create trigger rooms_sync_hk_task after update on public.rooms
  for each row when (old.housekeeping_status is distinct from new.housekeeping_status)
  execute function app_private.sync_hk_task_from_room();
drop trigger if exists rooms_insert_hk_task on public.rooms;
create trigger rooms_insert_hk_task after insert on public.rooms
  for each row when (new.housekeeping_status <> 'CLEAN')
  execute function app_private.sync_hk_task_from_room();

-- rooms that are not clean right now get an open task
insert into public.hk_tasks (organization_id, property_id, room_id, task_type, status, priority, business_date, started_at, finished_at)
select r.organization_id, r.property_id, r.id, 'CHECKOUT', r.housekeeping_status::text::public.hk_task_status, 2,
       (now() at time zone p.timezone)::date,
       case when r.housekeeping_status in ('IN_PROGRESS', 'INSPECTION_REQUIRED') then r.status_updated_at end,
       case when r.housekeeping_status = 'INSPECTION_REQUIRED' then r.status_updated_at end
from public.rooms r join public.properties p on p.id = r.property_id
where r.housekeeping_status <> 'CLEAN'
  and not exists (select 1 from public.hk_tasks t where t.room_id = r.id and t.status in ('DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED'));

-- ---------------------------------------------------------------------
-- Task RPCs
-- ---------------------------------------------------------------------
drop function if exists app_private.hk_lock_task(uuid);
create or replace function app_private.hk_lock_task(p_task_id uuid) returns public.hk_tasks
language plpgsql security definer set search_path = '' as $$
declare v_task public.hk_tasks;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED: Oturum açmanız gerekiyor.' using errcode = '42501';
  end if;
  select * into v_task from public.hk_tasks where id = p_task_id for update;
  if v_task.id is null or app_private.property_role(v_task.property_id) is null then
    raise exception 'HK_NOT_FOUND: Görev bulunamadı.' using errcode = 'P0001';
  end if;
  return v_task;
end $$;

create or replace function app_private.hk_set_room(p_room uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.rooms set housekeeping_status = p_status::public.housekeeping_status
   where id = p_room and housekeeping_status::text <> p_status;
end $$;

create or replace function public.hk_create_task(p_room_id uuid, p_task_type text default 'STAYOVER', p_priority int default 2,
  p_assigned_to uuid default null, p_note text default null)
returns public.hk_tasks language plpgsql security definer set search_path = '' as $$
declare v_room public.rooms; v_role text; v_task public.hk_tasks;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Oturum açmanız gerekiyor.' using errcode = '42501'; end if;
  select * into v_room from public.rooms where id = p_room_id for update;
  v_role := case when v_room.id is null then null else app_private.property_role(v_room.property_id)::text end;
  if v_room.id is null or v_role is null then raise exception 'HK_NOT_FOUND: Oda bulunamadı.' using errcode = 'P0001'; end if;
  if v_role not in ('owner', 'manager', 'front_desk', 'hk_supervisor') then
    raise exception 'FORBIDDEN: Görev oluşturma yetkiniz yok.' using errcode = '42501';
  end if;
  if p_task_type not in ('CHECKOUT', 'STAYOVER', 'DEEP', 'TOUCH_UP') or p_priority not between 1 and 3 then
    raise exception 'HK_INVALID: Görev türü veya önceliği geçersiz.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.hk_tasks where room_id = p_room_id and status in ('DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED')) then
    raise exception 'HK_OPEN_TASK: Oda % için zaten açık bir temizlik görevi var.', v_room.number using errcode = 'P0001';
  end if;
  insert into public.hk_tasks (organization_id, property_id, room_id, task_type, status, priority, business_date, created_by)
  values (v_room.organization_id, v_room.property_id, v_room.id, p_task_type, 'DIRTY', p_priority,
          app_private.property_today(v_room.property_id), auth.uid())
  returning * into v_task;
  perform app_private.hk_set_room(v_room.id, 'DIRTY');
  if p_assigned_to is not null then
    v_task := public.hk_assign_task(v_task.id, p_assigned_to);
  end if;
  if nullif(trim(p_note), '') is not null then
    perform public.hk_add_note(v_task.id, p_note);
  end if;
  return v_task;
end $$;

create or replace function public.hk_assign_task(p_task_id uuid, p_user_id uuid)
returns public.hk_tasks language plpgsql security definer set search_path = '' as $$
declare v_task public.hk_tasks; v_role text; v_target text;
begin
  v_task := app_private.hk_lock_task(p_task_id);
  v_role := app_private.property_role(v_task.property_id)::text;
  if v_role not in ('owner', 'manager', 'hk_supervisor') then
    raise exception 'FORBIDDEN: Görev atama yetkiniz yok.' using errcode = '42501';
  end if;
  if v_task.status not in ('DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED') then
    raise exception 'HK_BAD_STATE: Kapanmış bir görev atanamaz.' using errcode = 'P0001';
  end if;
  if p_user_id is not null then
    select m.role::text into v_target from public.memberships m join public.properties p on p.organization_id = m.organization_id
     where p.id = v_task.property_id and m.user_id = p_user_id and (m.property_id is null or m.property_id = v_task.property_id)
       and m.role::text in ('housekeeping', 'hk_supervisor')
     limit 1;
    if v_target is null then
      raise exception 'HK_BAD_ASSIGNEE: Görev yalnızca bu otelin kat hizmetleri personeline atanabilir.' using errcode = 'P0001';
    end if;
  end if;
  update public.hk_tasks set assigned_to = p_user_id, assigned_at = case when p_user_id is null then null else now() end
   where id = v_task.id returning * into v_task;
  return v_task;
end $$;

create or replace function public.hk_start_task(p_task_id uuid)
returns public.hk_tasks language plpgsql security definer set search_path = '' as $$
declare v_task public.hk_tasks; v_role text;
begin
  v_task := app_private.hk_lock_task(p_task_id);
  v_role := app_private.property_role(v_task.property_id)::text;
  if v_role not in ('owner', 'manager', 'hk_supervisor', 'housekeeping') then
    raise exception 'FORBIDDEN: Temizlik görevi başlatma yetkiniz yok.' using errcode = '42501';
  end if;
  if v_task.status <> 'DIRTY' then
    raise exception 'HK_BAD_STATE: Görev şu an "%" durumunda; başlatılamaz.', v_task.status using errcode = 'P0001';
  end if;
  if v_role = 'housekeeping' and v_task.assigned_to is not null and v_task.assigned_to <> auth.uid() then
    raise exception 'HK_NOT_YOURS: Bu görev başka bir personele atanmış.' using errcode = 'P0001';
  end if;
  update public.hk_tasks set status = 'IN_PROGRESS', started_at = now(), started_by = auth.uid(),
         assigned_to = coalesce(assigned_to, case when v_role = 'housekeeping' then auth.uid() end),
         assigned_at = coalesce(assigned_at, case when v_role = 'housekeeping' then now() end)
   where id = v_task.id returning * into v_task;
  perform app_private.hk_set_room(v_task.room_id, 'IN_PROGRESS');
  return v_task;
end $$;

create or replace function public.hk_finish_task(p_task_id uuid, p_note text default null)
returns public.hk_tasks language plpgsql security definer set search_path = '' as $$
declare v_task public.hk_tasks; v_role text; v_inspect boolean; v_next text;
begin
  v_task := app_private.hk_lock_task(p_task_id);
  v_role := app_private.property_role(v_task.property_id)::text;
  if v_role not in ('owner', 'manager', 'hk_supervisor', 'housekeeping') then
    raise exception 'FORBIDDEN: Temizlik görevi bitirme yetkiniz yok.' using errcode = '42501';
  end if;
  if v_task.status <> 'IN_PROGRESS' then
    raise exception 'HK_BAD_STATE: Görev şu an "%" durumunda; bitirilemez.', v_task.status using errcode = 'P0001';
  end if;
  if v_role = 'housekeeping' and v_task.assigned_to is distinct from auth.uid() then
    raise exception 'HK_NOT_YOURS: Bu görev başka bir personele atanmış.' using errcode = 'P0001';
  end if;
  select require_inspection into v_inspect from public.properties where id = v_task.property_id;
  -- a supervisor or manager who cleans the room themselves does not need a second inspection
  v_next := case when v_inspect and v_role = 'housekeeping' then 'INSPECTION_REQUIRED' else 'CLEAN' end;
  if nullif(trim(p_note), '') is not null then perform public.hk_add_note(v_task.id, p_note); end if;
  update public.hk_tasks set status = v_next::public.hk_task_status, finished_at = now(), finished_by = auth.uid(),
         completed_at = case when v_next = 'CLEAN' then now() end
   where id = v_task.id returning * into v_task;
  perform app_private.hk_set_room(v_task.room_id, v_next);
  return v_task;
end $$;

create or replace function public.hk_inspect_task(p_task_id uuid, p_passed boolean, p_note text default null)
returns public.hk_tasks language plpgsql security definer set search_path = '' as $$
declare v_task public.hk_tasks; v_role text;
begin
  v_task := app_private.hk_lock_task(p_task_id);
  v_role := app_private.property_role(v_task.property_id)::text;
  if v_role not in ('owner', 'manager', 'hk_supervisor') then
    raise exception 'FORBIDDEN: Kontrol onayı yalnızca kat şefi veya müdür tarafından verilebilir.' using errcode = '42501';
  end if;
  if v_task.status <> 'INSPECTION_REQUIRED' then
    raise exception 'HK_BAD_STATE: Görev şu an "%" durumunda; kontrol edilemez.', v_task.status using errcode = 'P0001';
  end if;
  if not p_passed and nullif(trim(p_note), '') is null then
    raise exception 'HK_NOTE_REQUIRED: Tekrar temizlik istenirken neyin eksik olduğunu yazın.' using errcode = 'P0001';
  end if;
  if nullif(trim(p_note), '') is not null then perform public.hk_add_note(v_task.id, p_note); end if;
  if p_passed then
    update public.hk_tasks set status = 'CLEAN', inspected_at = now(), inspected_by = auth.uid(), completed_at = now()
     where id = v_task.id returning * into v_task;
    perform app_private.hk_set_room(v_task.room_id, 'CLEAN');
  else
    update public.hk_tasks set status = 'DIRTY', inspected_at = now(), inspected_by = auth.uid(),
           started_at = null, started_by = null, finished_at = null, finished_by = null, rework_count = rework_count + 1
     where id = v_task.id returning * into v_task;
    perform app_private.hk_set_room(v_task.room_id, 'DIRTY');
  end if;
  return v_task;
end $$;

create or replace function public.hk_cancel_task(p_task_id uuid)
returns public.hk_tasks language plpgsql security definer set search_path = '' as $$
declare v_task public.hk_tasks; v_role text;
begin
  v_task := app_private.hk_lock_task(p_task_id);
  v_role := app_private.property_role(v_task.property_id)::text;
  if v_role not in ('owner', 'manager', 'hk_supervisor') then
    raise exception 'FORBIDDEN: Görev iptal yetkiniz yok.' using errcode = '42501';
  end if;
  if v_task.status not in ('DIRTY', 'IN_PROGRESS', 'INSPECTION_REQUIRED') then
    raise exception 'HK_BAD_STATE: Görev zaten kapanmış.' using errcode = 'P0001';
  end if;
  update public.hk_tasks set status = 'CANCELLED', completed_at = now() where id = v_task.id returning * into v_task;
  return v_task;
end $$;

create or replace function public.hk_add_note(p_task_id uuid, p_body text)
returns public.hk_task_notes language plpgsql security definer set search_path = '' as $$
declare v_task public.hk_tasks; v_role text; v_note public.hk_task_notes;
begin
  v_task := app_private.hk_lock_task(p_task_id);
  v_role := app_private.property_role(v_task.property_id)::text;
  if nullif(trim(p_body), '') is null or char_length(trim(p_body)) > 1000 then
    raise exception 'HK_INVALID: Not 1–1000 karakter olmalı.' using errcode = 'P0001';
  end if;
  insert into public.hk_task_notes (organization_id, property_id, task_id, author_id, body)
  values (v_task.organization_id, v_task.property_id, v_task.id, auth.uid(), trim(p_body))
  returning * into v_note;
  return v_note;
end $$;

-- staff that can be assigned (and who is who) for the task screen
create or replace function public.hk_list_staff(p_property_id uuid)
returns table (user_id uuid, display_name text, role text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if app_private.property_role(p_property_id) is null then
    raise exception 'FORBIDDEN: Bu otele erişiminiz yok.' using errcode = '42501';
  end if;
  return query
    select distinct on (u.id) u.id, coalesce(nullif(u.full_name, ''), split_part(u.email, '@', 1)), m.role::text
    from public.memberships m
    join public.properties p on p.organization_id = m.organization_id
    join public.users u on u.id = m.user_id
    where p.id = p_property_id and (m.property_id is null or m.property_id = p_property_id)
      and m.role::text in ('housekeeping', 'hk_supervisor')
    order by u.id, m.role::text;
end $$;

-- property setting (owners and managers)
create or replace function public.hk_set_require_inspection(p_property_id uuid, p_required boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(app_private.property_role(p_property_id)::text, '') not in ('owner', 'manager') then
    raise exception 'FORBIDDEN: Bu ayarı yalnızca otel sahibi veya müdür değiştirebilir.' using errcode = '42501';
  end if;
  update public.properties set require_inspection = p_required where id = p_property_id;
  return p_required;
end $$;

-- ---------------------------------------------------------------------
-- RLS and privileges: every property member reads tasks; writes only via RPCs
-- ---------------------------------------------------------------------
alter table public.hk_tasks enable row level security;
alter table public.hk_task_notes enable row level security;
alter table public.hk_task_events enable row level security;

drop policy if exists hk_tasks_select on public.hk_tasks;
create policy hk_tasks_select on public.hk_tasks for select to authenticated using (app_private.has_property_access(property_id));
drop policy if exists hk_notes_select on public.hk_task_notes;
create policy hk_notes_select on public.hk_task_notes for select to authenticated using (app_private.has_property_access(property_id));
drop policy if exists hk_events_select on public.hk_task_events;
create policy hk_events_select on public.hk_task_events for select to authenticated using (app_private.has_property_access(property_id));

-- financial data stays with front desk and up (housekeeping supervisors are not included)
revoke all on public.hk_tasks, public.hk_task_notes, public.hk_task_events from anon, authenticated;
grant select on public.hk_tasks, public.hk_task_notes, public.hk_task_events to authenticated;

revoke all on function app_private.hk_lock_task(uuid) from public, authenticated;
revoke all on function app_private.hk_set_room(uuid, text) from public, authenticated;
revoke all on function app_private.sync_hk_task_from_room() from public, authenticated;
revoke all on function app_private.log_hk_task() from public, authenticated;

revoke all on function public.hk_create_task(uuid, text, int, uuid, text) from public, anon;
revoke all on function public.hk_assign_task(uuid, uuid) from public, anon;
revoke all on function public.hk_start_task(uuid) from public, anon;
revoke all on function public.hk_finish_task(uuid, text) from public, anon;
revoke all on function public.hk_inspect_task(uuid, boolean, text) from public, anon;
revoke all on function public.hk_cancel_task(uuid) from public, anon;
revoke all on function public.hk_add_note(uuid, text) from public, anon;
revoke all on function public.hk_list_staff(uuid) from public, anon;
revoke all on function public.hk_set_require_inspection(uuid, boolean) from public, anon;
grant execute on function public.hk_create_task(uuid, text, int, uuid, text) to authenticated;
grant execute on function public.hk_assign_task(uuid, uuid) to authenticated;
grant execute on function public.hk_start_task(uuid) to authenticated;
grant execute on function public.hk_finish_task(uuid, text) to authenticated;
grant execute on function public.hk_inspect_task(uuid, boolean, text) to authenticated;
grant execute on function public.hk_cancel_task(uuid) to authenticated;
grant execute on function public.hk_add_note(uuid, text) to authenticated;
grant execute on function public.hk_list_staff(uuid) to authenticated;
grant execute on function public.hk_set_require_inspection(uuid, boolean) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.hk_tasks; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.hk_task_notes; exception when duplicate_object then null; end;
  end if;
end $$;
