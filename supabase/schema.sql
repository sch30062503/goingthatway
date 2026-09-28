-- Going That Way v1 database
-- Paste this whole file into Supabase: SQL Editor -> New query -> Run.
-- Safe to run once on a new project.

-- ---------- Profiles (one per signed-in person, including anonymous posters) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  phone text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- A profile row is created automatically for every new sign-in
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Is the current user an admin? (security definer so policies can call it without recursion)
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ---------- Trips (drivers) ----------
create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  driver_name text not null,
  driver_phone text not null,
  from_town text not null,
  to_town text not null,
  from_suburb text,
  to_suburb text,
  trip_date date not null,
  depart_time time,
  space text not null check (space in ('boot','ute','trailer','van')),
  max_detour_km int not null default 20 check (max_detour_km between 0 and 100),
  vehicle text,
  space_note text,
  regular boolean not null default false,          -- "I do this run most weeks"
  status text not null default 'new' check (status in ('new','open','full','done','cancelled')),
  admin_note text,
  created_at timestamptz not null default now()
);

-- ---------- Jobs (senders and pick-up-only buyers) ----------
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('pickup','parcel')),
  sender_name text not null,
  sender_phone text not null,
  item text not null,
  description text,
  listing_url text,
  from_town text not null,
  to_town text not null,
  pickup_suburb text,
  pickup_address text,        -- private: only the poster and admin can see it
  drop_suburb text,
  drop_address text,          -- private
  size text not null check (size in ('small','medium','large')),
  job_date date not null,
  deadline_time time,         -- null = any time that day
  handover text not null default 'door' check (handover in ('door','route')),
  cover int not null default 500 check (cover in (500,1000,2000)),
  price_estimate numeric(8,2),
  fallback_time time,         -- businesses: courier fallback cut-off
  status text not null default 'new' check (status in ('new','open','matched','delivered','cancelled')),
  matched_trip uuid references public.trips(id) on delete set null,
  admin_note text,
  created_at timestamptz not null default now()
);

-- ---------- Business interest ----------
create table if not exists public.business_interest (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  business_name text not null,
  town text not null,
  contact_name text not null,
  contact_phone text not null,
  contact_email text,
  sends_per_week text,
  notes text,
  created_at timestamptz not null default now()
);

-- ---------- Row level security: nobody sees anyone else's details ----------
alter table public.profiles enable row level security;
alter table public.trips enable row level security;
alter table public.jobs enable row level security;
alter table public.business_interest enable row level security;

drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- trips / jobs / business: insert your own, read your own, admin reads and updates all
do $$ declare t text; begin
  foreach t in array array['trips','jobs','business_interest'] loop
    execute format('drop policy if exists "insert own" on public.%I', t);
    execute format('create policy "insert own" on public.%I for insert to authenticated with check (user_id = auth.uid())', t);
    execute format('drop policy if exists "read own or admin" on public.%I', t);
    execute format('create policy "read own or admin" on public.%I for select to authenticated using (user_id = auth.uid() or public.is_admin())', t);
    execute format('drop policy if exists "admin update" on public.%I', t);
    execute format('create policy "admin update" on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    execute format('drop policy if exists "owner cancel" on public.%I', t);
  end loop;
end $$;

-- Posters may cancel their own trip or job (only the status column, only to 'cancelled')
create policy "owner cancel" on public.trips for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and status = 'cancelled');
create policy "owner cancel" on public.jobs for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and status = 'cancelled');

-- Column privileges: users can never make themselves admin
revoke update on public.profiles from anon, authenticated;
grant update (name, phone) on public.profiles to authenticated;

-- ---------- Public board: approved posts only, suburbs only, no names/phones/addresses ----------
create or replace view public.board_jobs as
  select id, kind, item, from_town, to_town, pickup_suburb, drop_suburb, size,
         job_date, deadline_time, handover, price_estimate, status, created_at
  from public.jobs
  where status in ('open','matched') and job_date >= current_date;

create or replace view public.board_trips as
  select id, from_town, to_town, trip_date, depart_time, space, max_detour_km, created_at
  from public.trips
  where status = 'open' and trip_date >= current_date;

grant select on public.board_jobs, public.board_trips to anon, authenticated;

-- ---------- Make yourself admin (run after creating your admin login) ----------
-- update public.profiles set is_admin = true
--   where id = (select id from auth.users where email = 'YOUR-EMAIL-HERE');

alter table public.jobs add column if not exists payment text not null default 'unpaid';
alter table public.jobs drop constraint if exists jobs_payment_check;
alter table public.jobs add constraint jobs_payment_check check (payment in ('unpaid','paid','refunded','part_refunded'));
alter table public.jobs add column if not exists driver_paid boolean not null default false;

-- Only the admin can change money fields or matching; posters can only cancel
create or replace function public.guard_job_admin_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and (
       new.payment is distinct from old.payment
    or new.driver_paid is distinct from old.driver_paid
    or new.price_estimate is distinct from old.price_estimate
    or new.matched_trip is distinct from old.matched_trip) then
    raise exception 'Only the admin can change payment or matching details';
  end if;
  return new;
end $$;
drop trigger if exists jobs_guard_admin_fields on public.jobs;
create trigger jobs_guard_admin_fields before update on public.jobs
  for each row execute function public.guard_job_admin_fields();
