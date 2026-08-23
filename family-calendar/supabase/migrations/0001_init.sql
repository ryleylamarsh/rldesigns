-- Family Wall Calendar — initial schema
-- Run against a NEW, separate Supabase project (do not reuse another project).
-- Safe to run once via the SQL editor, or via `supabase db push`.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Core tables (§8 of the build spec)
-- ---------------------------------------------------------------------------

create table if not exists family_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color_hex text not null,
  initials text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  google_event_id text unique,
  family_member_id uuid references family_members(id) on delete set null,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz,
  all_day boolean not null default false,
  location text,
  last_synced_at timestamptz not null default now()
);
create index if not exists events_start_at_idx on events (start_at);
create index if not exists events_family_member_idx on events (family_member_id);

-- Secret iCal URLs. This table is intentionally left with NO anon-facing
-- policies below, so RLS denies the anon/publishable key entirely — only
-- the service_role (used by the sync Edge Function) can read it. Writes
-- from the client go through the SECURITY DEFINER functions further down,
-- never through a direct table grant.
create table if not exists ics_sources (
  id uuid primary key default gen_random_uuid(),
  family_member_id uuid not null unique references family_members(id) on delete cascade,
  ics_url text not null,
  last_polled_at timestamptz,
  last_status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists chores (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  assignee_id uuid references family_members(id) on delete set null,
  recurrence text not null default 'none' check (recurrence in ('none','daily','weekly')),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- Presence of a row = "done" for that chore on that date. This is how
-- daily/weekly recurring chores reset without a nightly cron job.
create table if not exists chore_completions (
  id uuid primary key default gen_random_uuid(),
  chore_id uuid not null references chores(id) on delete cascade,
  completed_date date not null,
  unique (chore_id, completed_date)
);

create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color_hex text not null default '#64748b',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references lists(id) on delete cascade,
  text text not null,
  done boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists screensaver_photos (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists app_settings (
  id int primary key default 1 check (id = 1),
  idle_timeout_minutes int not null default 10,
  dark_mode_start time, -- null = auto (fixed 8pm-7am heuristic in the app)
  dark_mode_end time,
  dark_mode_override text check (dark_mode_override in ('auto','on','off')) default 'on',
  countdown_label text,
  countdown_date date,
  updated_at timestamptz not null default now()
);
insert into app_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- v1 ships with no app-level authentication (see spec §13) — the whole site
-- is meant to sit behind Cloudflare Access instead. That means the anon
-- (publishable) key is effectively "logged in" for every table EXCEPT
-- ics_sources, which holds bearer-token-style secrets and must only ever
-- be touched by the service_role key (used solely inside the Edge Function).

alter table family_members enable row level security;
alter table events enable row level security;
alter table chores enable row level security;
alter table chore_completions enable row level security;
alter table lists enable row level security;
alter table list_items enable row level security;
alter table screensaver_photos enable row level security;
alter table app_settings enable row level security;
alter table ics_sources enable row level security;

create policy "anon full access" on family_members for all to anon using (true) with check (true);
create policy "anon full access" on events for all to anon using (true) with check (true);
create policy "anon full access" on chores for all to anon using (true) with check (true);
create policy "anon full access" on chore_completions for all to anon using (true) with check (true);
create policy "anon full access" on lists for all to anon using (true) with check (true);
create policy "anon full access" on list_items for all to anon using (true) with check (true);
create policy "anon full access" on screensaver_photos for all to anon using (true) with check (true);
create policy "anon full access" on app_settings for all to anon using (true) with check (true);

-- No policies at all on ics_sources for anon: RLS defaults to deny.
-- The Edge Function reads it with the service_role key, which bypasses RLS.

-- ---------------------------------------------------------------------------
-- Status view + write RPCs for ics_sources (§9)
-- ---------------------------------------------------------------------------
-- Views run with their owner's privileges by default (not the querying
-- role's), so this view can read the base table despite RLS, while only
-- exposing the non-secret columns to anon.
create or replace view ics_sources_status as
  select id, family_member_id, last_polled_at, last_status, created_at
  from ics_sources;

grant select on ics_sources_status to anon;

-- SECURITY DEFINER functions let the Settings screen submit/clear a
-- family member's secret iCal URL without ever granting the client a
-- direct read/write grant on ics_sources itself.
create or replace function upsert_ics_source(p_family_member_id uuid, p_ics_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into ics_sources (family_member_id, ics_url, last_status)
  values (p_family_member_id, p_ics_url, 'pending')
  on conflict (family_member_id) do update
    set ics_url = excluded.ics_url,
        last_status = 'pending';
end;
$$;
revoke all on function upsert_ics_source(uuid, text) from public;
grant execute on function upsert_ics_source(uuid, text) to anon;

create or replace function delete_ics_source(p_family_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from ics_sources where family_member_id = p_family_member_id;
end;
$$;
revoke all on function delete_ics_source(uuid) from public;
grant execute on function delete_ics_source(uuid) to anon;

-- ---------------------------------------------------------------------------
-- Storage bucket for the screensaver photo slideshow
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('screensaver-photos', 'screensaver-photos', true)
on conflict (id) do nothing;

create policy "anon read screensaver photos"
  on storage.objects for select to anon
  using (bucket_id = 'screensaver-photos');

create policy "anon write screensaver photos"
  on storage.objects for insert to anon
  with check (bucket_id = 'screensaver-photos');

create policy "anon delete screensaver photos"
  on storage.objects for delete to anon
  using (bucket_id = 'screensaver-photos');

-- ---------------------------------------------------------------------------
-- Realtime: broadcast changes so multiple browser tabs / future devices
-- pointed at this project stay in sync live.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table family_members, events, chores, chore_completions, lists, list_items, app_settings;
