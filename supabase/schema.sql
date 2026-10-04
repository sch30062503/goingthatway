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

-- ---------- New job details ----------
alter table public.jobs add column if not exists window_end date;          -- deliver by this day (job_date = earliest day)
update public.jobs set window_end = job_date where window_end is null;
alter table public.jobs add column if not exists pickup_mode text not null default 'home';
alter table public.jobs drop constraint if exists jobs_pickup_mode_check;
alter table public.jobs add constraint jobs_pickup_mode_check check (pickup_mode in ('home','left_out','business','meet'));
alter table public.jobs add column if not exists pickup_hours text;         -- shown to drivers before they take it, e.g. "weekdays 8-5"
alter table public.jobs add column if not exists pickup_notes text;         -- private: where it's left, gate codes etc.
alter table public.jobs add column if not exists seller_name text;          -- pick-up-only buys: who to collect from
alter table public.jobs add column if not exists seller_phone text;
alter table public.jobs add column if not exists collected_at timestamptz;
alter table public.jobs add column if not exists delivered_at timestamptz;
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check
  check (status in ('new','open','matched','collected','delivered','cancelled','no_show'));

alter table public.profiles add column if not exists verified_driver boolean not null default false;

-- ---------- New posts can't set their own status, payment or price flags ----------
create or replace function public.guard_new_job() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.status := 'new'; new.payment := 'unpaid'; new.driver_paid := false;
    new.matched_trip := null; new.collected_at := null; new.delivered_at := null; new.admin_note := null;
  end if;
  if new.window_end is null then new.window_end := new.job_date; end if;
  if new.window_end < new.job_date then raise exception 'The deliver-by day is before the start day'; end if;
  return new;
end $$;
drop trigger if exists jobs_guard_new on public.jobs;
create trigger jobs_guard_new before insert on public.jobs for each row execute function public.guard_new_job();

-- Trips from verified drivers go live straight away; everyone else waits for a one-off check
create or replace function public.guard_new_trip() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.status := case when exists (select 1 from public.profiles where id = new.user_id and verified_driver) then 'open' else 'new' end;
    new.admin_note := null;
  end if;
  return new;
end $$;
drop trigger if exists trips_guard_new on public.trips;
create trigger trips_guard_new before insert on public.trips for each row execute function public.guard_new_trip();

-- Money and matching fields: admin only, or through the functions below
create or replace function public.guard_job_admin_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and coalesce(current_setting('gtw.rpc', true), '') <> '1' and (
       new.payment is distinct from old.payment
    or new.driver_paid is distinct from old.driver_paid
    or new.price_estimate is distinct from old.price_estimate
    or new.matched_trip is distinct from old.matched_trip
    or new.collected_at is distinct from old.collected_at
    or new.delivered_at is distinct from old.delivered_at) then
    raise exception 'Only the admin can change payment or matching details';
  end if;
  return new;
end $$;

-- Drivers can read the jobs they've taken (addresses and contacts appear only then)
drop policy if exists "driver reads taken jobs" on public.jobs;
create policy "driver reads taken jobs" on public.jobs for select to authenticated
  using (exists (select 1 from public.trips t where t.id = jobs.matched_trip and t.user_id = auth.uid()));

-- ---------- Driver actions ----------
-- Take a job: only verified drivers, only paid live jobs, only on a day inside the job's window. First in wins.
create or replace function public.claim_job(p_job uuid, p_trip uuid) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare t public.trips; j public.jobs;
begin
  select * into t from public.trips where id = p_trip and user_id = auth.uid() and status = 'open';
  if not found then raise exception 'Your trip isn''t live yet'; end if;
  if not coalesce((select verified_driver from public.profiles where id = auth.uid()), false) then
    raise exception 'We need to check your licence before you can take jobs'; end if;
  select * into j from public.jobs where id = p_job for update;
  if not found or j.status <> 'open' or j.payment <> 'paid' then raise exception 'Sorry, someone else just took this job'; end if;
  if t.trip_date < j.job_date or t.trip_date > j.window_end then raise exception 'Your trip day is outside this job''s delivery window'; end if;
  perform set_config('gtw.rpc', '1', true);
  update public.jobs set status = 'matched', matched_trip = p_trip where id = p_job returning * into j;
  return j;
end $$;

-- Give a job back before collecting it
create or replace function public.release_job(p_job uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('gtw.rpc', '1', true);
  update public.jobs j set status = 'open', matched_trip = null
   where j.id = p_job and j.status = 'matched'
     and exists (select 1 from public.trips t where t.id = j.matched_trip and t.user_id = auth.uid());
  if not found then raise exception 'You can only give back a job you''ve taken and not collected'; end if;
end $$;

-- Mark a taken job as collected or delivered
create or replace function public.job_progress(p_job uuid, p_step text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_step not in ('collected','delivered') then raise exception 'Unknown step'; end if;
  perform set_config('gtw.rpc', '1', true);
  update public.jobs j set
      status = p_step,
      collected_at = case when p_step = 'collected' then now() else coalesce(j.collected_at, now()) end,
      delivered_at = case when p_step = 'delivered' then now() else j.delivered_at end
   where j.id = p_job
     and ((p_step = 'collected' and j.status = 'matched') or (p_step = 'delivered' and j.status in ('matched','collected')))
     and exists (select 1 from public.trips t where t.id = j.matched_trip and t.user_id = auth.uid());
  if not found then raise exception 'That job isn''t yours to update, or it''s already done'; end if;
end $$;

-- Senders see who's collecting their job
create or replace function public.my_job_driver(p_job uuid)
returns table (driver_name text, driver_phone text, trip_date date, depart_time time)
language sql stable security definer set search_path = public as $$
  select t.driver_name, t.driver_phone, t.trip_date, t.depart_time
  from public.jobs j join public.trips t on t.id = j.matched_trip
  where j.id = p_job and j.user_id = auth.uid();
$$;

-- Admin: verify (or un-verify) a driver once; their waiting trips go live
create or replace function public.admin_verify_driver(p_user uuid, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update public.profiles set verified_driver = p_ok where id = p_user;
  if p_ok then update public.trips set status = 'open' where user_id = p_user and status = 'new'; end if;
end $$;

revoke execute on function public.claim_job(uuid, uuid), public.release_job(uuid), public.job_progress(uuid, text),
  public.my_job_driver(uuid), public.admin_verify_driver(uuid, boolean) from public, anon;
grant execute on function public.claim_job(uuid, uuid), public.release_job(uuid), public.job_progress(uuid, text),
  public.my_job_driver(uuid), public.admin_verify_driver(uuid, boolean) to authenticated;

-- ---------- Public board: only paid, live jobs; never addresses, notes or contacts ----------
drop view if exists public.board_jobs;
create view public.board_jobs as
  select id, kind, item, from_town, to_town, size, job_date, window_end, deadline_time, handover,
         pickup_mode, pickup_hours, price_estimate, status, created_at
  from public.jobs
  where status in ('open','matched','collected') and payment = 'paid' and window_end >= current_date;
grant select on public.board_jobs to anon, authenticated;

-- Senders can cancel only before a driver has taken the job (after that, it goes through the admin)
drop policy if exists "owner cancel" on public.jobs;
create policy "owner cancel" on public.jobs for update to authenticated
  using (user_id = auth.uid() and status in ('new','open'))
  with check (user_id = auth.uid() and status = 'cancelled');

-- Private storage for job photos (5 MB max each; the app shrinks them first)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('job-photos', 'job-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- Who can see a job's photos: the sender, the driver on the job, the admin
create or replace function public.is_job_driver(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.jobs j join public.trips t on t.id = j.matched_trip
                 where j.id = p_job and t.user_id = auth.uid());
$$;
create or replace function public.can_see_job(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or public.is_job_driver(p_job)
      or exists (select 1 from public.jobs where id = p_job and user_id = auth.uid());
$$;
create or replace function public.safe_uuid(p text) returns uuid
language plpgsql immutable as $$ begin return p::uuid; exception when others then return null; end $$;

-- A record of each photo
create table if not exists public.job_photos (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  kind text not null check (kind in ('pickup','dropoff','no_show')),
  path text not null,
  uploaded_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.job_photos enable row level security;
drop policy if exists "driver adds photos" on public.job_photos;
create policy "driver adds photos" on public.job_photos for insert to authenticated
  with check (uploaded_by = auth.uid() and public.is_job_driver(job_id) and path like job_id::text || '/%');
drop policy if exists "people on the job see photos" on public.job_photos;
create policy "people on the job see photos" on public.job_photos for select to authenticated
  using (public.can_see_job(job_id));

-- Storage rules: files live at <job id>/<name>.jpg
drop policy if exists "gtw driver uploads job photo" on storage.objects;
create policy "gtw driver uploads job photo" on storage.objects for insert to authenticated
  with check (bucket_id = 'job-photos' and public.is_job_driver(public.safe_uuid((storage.foldername(name))[1])));
drop policy if exists "gtw people on the job view photo" on storage.objects;
create policy "gtw people on the job view photo" on storage.objects for select to authenticated
  using (bucket_id = 'job-photos' and public.can_see_job(public.safe_uuid((storage.foldername(name))[1])));

-- Collected needs a pickup photo, delivered needs a drop-off photo
create or replace function public.job_progress(p_job uuid, p_step text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_step not in ('collected','delivered') then raise exception 'Unknown step'; end if;
  if not exists (select 1 from public.job_photos where job_id = p_job
                 and kind = case when p_step = 'collected' then 'pickup' else 'dropoff' end) then
    raise exception 'Please add a % photo first', case when p_step = 'collected' then 'pickup' else 'drop-off' end;
  end if;
  perform set_config('gtw.rpc', '1', true);
  update public.jobs j set
      status = p_step,
      collected_at = case when p_step = 'collected' then now() else coalesce(j.collected_at, now()) end,
      delivered_at = case when p_step = 'delivered' then now() else j.delivered_at end
   where j.id = p_job
     and ((p_step = 'collected' and j.status = 'matched') or (p_step = 'delivered' and j.status in ('matched','collected')))
     and exists (select 1 from public.trips t where t.id = j.matched_trip and t.user_id = auth.uid());
  if not found then raise exception 'That job isn''t yours to update, or it''s already done'; end if;
end $$;

revoke execute on function public.is_job_driver(uuid), public.can_see_job(uuid) from public, anon;
grant execute on function public.is_job_driver(uuid), public.can_see_job(uuid) to authenticated;

-- ---------- Profile details and verification status ----------
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists address text;
alter table public.profiles add column if not exists id_status text not null default 'none';
alter table public.profiles drop constraint if exists profiles_id_status_check;
alter table public.profiles add constraint profiles_id_status_check check (id_status in ('none','pending','verified','rejected'));
alter table public.profiles add column if not exists id_type text;
alter table public.profiles drop constraint if exists profiles_id_type_check;
alter table public.profiles add constraint profiles_id_type_check check (id_type is null or id_type in ('driver_licence','passport','kiwi_access','other'));
alter table public.profiles add column if not exists id_verified_at timestamptz;
alter table public.profiles add column if not exists id_verified_by uuid;
alter table public.profiles add column if not exists review_note text;
alter table public.profiles add column if not exists driver_status text not null default 'none';
alter table public.profiles drop constraint if exists profiles_driver_status_check;
alter table public.profiles add constraint profiles_driver_status_check check (driver_status in ('none','pending','verified','rejected'));
alter table public.profiles add column if not exists licence_class text;
alter table public.profiles add column if not exists vehicle_plate text;
alter table public.profiles add column if not exists vehicle_make text;
alter table public.profiles add column if not exists vehicle_space text;
alter table public.profiles add column if not exists wof_expiry date;
alter table public.profiles add column if not exists rego_expiry date;
alter table public.profiles add column if not exists driver_verified_at timestamptz;

-- People can edit their own contact details, never their verification status
revoke update on public.profiles from anon, authenticated;
grant update (name, phone, address) on public.profiles to authenticated;

-- Admin can read everyone's profile (already covered by "own profile read" via is_admin())

-- New accounts: copy the sign-up details into the profile
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, phone, address)
  values (new.id, new.email,
          nullif(new.raw_user_meta_data->>'name', ''),
          nullif(new.raw_user_meta_data->>'phone', ''),
          nullif(new.raw_user_meta_data->>'address', ''))
  on conflict (id) do update set email = excluded.email,
    name = coalesce(public.profiles.name, excluded.name),
    phone = coalesce(public.profiles.phone, excluded.phone),
    address = coalesce(public.profiles.address, excluded.address);
  return new;
end $$;

-- Is the caller a real (non-anonymous) account?
create or replace function public.is_real_account() returns boolean
language sql stable as $$
  select auth.uid() is not null and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false;
$$;

-- ---------- Private ID documents: owner uploads, only the admin can view or delete ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('id-docs', 'id-docs', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
drop policy if exists "gtw owner uploads id docs" on storage.objects;
create policy "gtw owner uploads id docs" on storage.objects for insert to authenticated
  with check (bucket_id = 'id-docs' and public.is_real_account() and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "gtw admin views id docs" on storage.objects;
create policy "gtw admin views id docs" on storage.objects for select to authenticated
  using (bucket_id = 'id-docs' and public.is_admin());
drop policy if exists "gtw admin deletes id docs" on storage.objects;
create policy "gtw admin deletes id docs" on storage.objects for delete to authenticated
  using (bucket_id = 'id-docs' and public.is_admin());

-- ---------- Member actions ----------
-- "I've uploaded my ID and selfie, please check them"
create or replace function public.submit_id(p_type text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_real_account() then raise exception 'Please create an account first'; end if;
  if p_type not in ('driver_licence','passport','kiwi_access','other') then raise exception 'Unknown ID type'; end if;
  update public.profiles set id_type = p_type, id_status = 'pending', review_note = null
   where id = auth.uid() and id_status <> 'verified';
  if not found then
    -- already verified with another ID: a new driver licence is checked through apply_driver instead
    raise exception 'Your ID is already verified';
  end if;
end $$;

-- "I'd like to drive": licence (uploaded) + vehicle details
create or replace function public.apply_driver(p_licence_class text, p_plate text, p_make text, p_space text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_real_account() then raise exception 'Please create an account first'; end if;
  if p_licence_class not in ('full','restricted') then raise exception 'Drivers need a full or restricted licence'; end if;
  if coalesce(trim(p_plate), '') = '' then raise exception 'Please add your number plate'; end if;
  if p_space not in ('boot','ute','trailer','van') then raise exception 'Unknown vehicle space'; end if;
  update public.profiles set licence_class = p_licence_class, vehicle_plate = upper(regexp_replace(p_plate, '\s', '', 'g')),
         vehicle_make = p_make, vehicle_space = p_space, driver_status = 'pending', review_note = null
   where id = auth.uid();
end $$;

-- ---------- Admin reviews ----------
create or replace function public.admin_review_id(p_user uuid, p_ok boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update public.profiles set id_status = case when p_ok then 'verified' else 'rejected' end,
         id_verified_at = case when p_ok then now() else null end,
         id_verified_by = case when p_ok then auth.uid() else null end,
         review_note = p_note
   where id = p_user;
end $$;

create or replace function public.admin_review_driver(p_user uuid, p_ok boolean, p_wof date, p_rego date, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_ok and (p_wof is null or p_rego is null or p_wof < current_date or p_rego < current_date) then
    raise exception 'Add current WoF and rego expiry dates before approving';
  end if;
  update public.profiles set driver_status = case when p_ok then 'verified' else 'rejected' end,
         verified_driver = p_ok,
         -- a driver licence also counts as verified ID
         id_status = case when p_ok then 'verified' else id_status end,
         id_type = case when p_ok then 'driver_licence' else id_type end,
         id_verified_at = case when p_ok then coalesce(id_verified_at, now()) else id_verified_at end,
         wof_expiry = p_wof, rego_expiry = p_rego,
         driver_verified_at = case when p_ok then now() else null end, review_note = p_note
   where id = p_user;
  if p_ok then update public.trips set status = 'open' where user_id = p_user and status = 'new'; end if;
end $$;

revoke execute on function public.submit_id(text), public.apply_driver(text, text, text, text),
  public.admin_review_id(uuid, boolean, text), public.admin_review_driver(uuid, boolean, date, date, text) from public, anon;
grant execute on function public.submit_id(text), public.apply_driver(text, text, text, text),
  public.admin_review_id(uuid, boolean, text), public.admin_review_driver(uuid, boolean, date, date, text) to authenticated;

-- ---------- Posting rules ----------
-- Jobs: must be a real account that has sent its ID for checking
create or replace function public.guard_new_job() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    if not public.is_real_account() then raise exception 'Please create an account to post'; end if;
    if coalesce((select id_status from public.profiles where id = auth.uid()), 'none') not in ('pending','verified') then
      raise exception 'Please verify your ID before posting'; end if;
    new.status := 'new'; new.payment := 'unpaid'; new.driver_paid := false;
    new.matched_trip := null; new.collected_at := null; new.delivered_at := null; new.admin_note := null;
  end if;
  if new.window_end is null then new.window_end := new.job_date; end if;
  if new.window_end < new.job_date then raise exception 'The deliver-by day is before the start day'; end if;
  return new;
end $$;

-- Trips: must have applied to drive; live straight away once approved
create or replace function public.guard_new_trip() returns trigger
language plpgsql security definer set search_path = public as $$
declare ds text;
begin
  if not public.is_admin() then
    if not public.is_real_account() then raise exception 'Please create an account to post a trip'; end if;
    select driver_status into ds from public.profiles where id = new.user_id;
    if coalesce(ds, 'none') not in ('pending','verified') then raise exception 'Please apply to drive before posting a trip'; end if;
    new.status := case when ds = 'verified' then 'open' else 'new' end;
    new.admin_note := null;
  end if;
  return new;
end $$;

-- A job only goes live once the sender's ID is verified
create or replace function public.guard_job_go_live() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'open' and old.status = 'new'
     and coalesce((select id_status from public.profiles where id = new.user_id), 'none') <> 'verified' then
    raise exception 'The sender''s ID isn''t verified yet. Check it under ID checks first.';
  end if;
  return new;
end $$;
drop trigger if exists jobs_guard_go_live on public.jobs;
create trigger jobs_guard_go_live before update on public.jobs for each row execute function public.guard_job_go_live();


-- ===================== 006: item types and check it before you buy =====================
-- Going That Way: item types for bulky pick-up-only buys, and "check it before you buy".
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

-- ---------- Item types ----------
alter table public.jobs add column if not exists item_type text;
alter table public.jobs drop constraint if exists jobs_item_type_check;
alter table public.jobs add constraint jobs_item_type_check check (item_type is null or item_type in
  ('furniture','whiteware','bike','outdoor','building','parts','tools','boxed','other'));

-- ---------- Check it before you buy ----------
-- The driver sends photos from the seller's; the buyer says yes (collect it) or no (leave it).
alter table public.jobs add column if not exists check_first boolean not null default false;
alter table public.jobs add column if not exists check_status text;   -- null, waiting, approved, declined
alter table public.jobs drop constraint if exists jobs_check_status_check;
alter table public.jobs add constraint jobs_check_status_check check (check_status is null or check_status in ('waiting','approved','declined'));
alter table public.jobs add column if not exists check_note text;
alter table public.jobs add column if not exists checked_at timestamptz;

alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check
  check (status in ('new','open','matched','collected','delivered','cancelled','no_show','declined'));

alter table public.job_photos drop constraint if exists job_photos_kind_check;
alter table public.job_photos add constraint job_photos_kind_check check (kind in ('pickup','dropoff','no_show','check'));

-- New posts can't set their own status, payment or check answer
create or replace function public.guard_new_job() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    if not public.is_real_account() then raise exception 'Please create an account to post'; end if;
    if coalesce((select id_status from public.profiles where id = auth.uid()), 'none') not in ('pending','verified') then
      raise exception 'Please verify your ID before posting'; end if;
    new.status := 'new'; new.payment := 'unpaid'; new.driver_paid := false;
    new.matched_trip := null; new.collected_at := null; new.delivered_at := null; new.admin_note := null;
    new.check_status := null; new.check_note := null; new.checked_at := null;
  end if;
  if new.kind <> 'pickup' then new.check_first := false; end if;
  if new.window_end is null then new.window_end := new.job_date; end if;
  if new.window_end < new.job_date then raise exception 'The deliver-by day is before the start day'; end if;
  return new;
end $$;

-- Money, matching and check answers: admin only, or through the functions below
create or replace function public.guard_job_admin_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and coalesce(current_setting('gtw.rpc', true), '') <> '1' and (
       new.payment is distinct from old.payment
    or new.driver_paid is distinct from old.driver_paid
    or new.price_estimate is distinct from old.price_estimate
    or new.matched_trip is distinct from old.matched_trip
    or new.collected_at is distinct from old.collected_at
    or new.delivered_at is distinct from old.delivered_at
    or new.check_first is distinct from old.check_first
    or new.check_status is distinct from old.check_status) then
    raise exception 'Only the admin can change payment or matching details';
  end if;
  return new;
end $$;

-- Driver: send the check photos to the buyer (needs at least one check photo)
create or replace function public.job_check_send(p_job uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.job_photos where job_id = p_job and kind = 'check') then
    raise exception 'Please take at least one photo of the item first';
  end if;
  perform set_config('gtw.rpc', '1', true);
  update public.jobs j set check_status = 'waiting', check_note = nullif(trim(coalesce(p_note, '')), ''), checked_at = now()
   where j.id = p_job and j.check_first and j.status = 'matched' and coalesce(j.check_status, 'waiting') = 'waiting'
     and exists (select 1 from public.trips t where t.id = j.matched_trip and t.user_id = auth.uid());
  if not found then raise exception 'That job isn''t yours to update, or the buyer has already answered'; end if;
end $$;

-- Buyer: yes, collect it / no, leave it
create or replace function public.job_check_answer(p_job uuid, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('gtw.rpc', '1', true);
  update public.jobs set
      check_status = case when p_ok then 'approved' else 'declined' end,
      status = case when p_ok then status else 'declined' end
   where id = p_job and user_id = auth.uid() and check_status = 'waiting' and status = 'matched';
  if not found then raise exception 'This check has already been answered'; end if;
end $$;

-- Collected needs a pickup photo, delivered a drop-off photo, and check-first jobs need the buyer's yes
create or replace function public.job_progress(p_job uuid, p_step text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_step not in ('collected','delivered') then raise exception 'Unknown step'; end if;
  if not exists (select 1 from public.job_photos where job_id = p_job
                 and kind = case when p_step = 'collected' then 'pickup' else 'dropoff' end) then
    raise exception 'Please add a % photo first', case when p_step = 'collected' then 'pickup' else 'drop-off' end;
  end if;
  if exists (select 1 from public.jobs where id = p_job and check_first and coalesce(check_status, '') <> 'approved') then
    raise exception 'The buyer hasn''t said yes to the check photos yet';
  end if;
  perform set_config('gtw.rpc', '1', true);
  update public.jobs j set
      status = p_step,
      collected_at = case when p_step = 'collected' then now() else coalesce(j.collected_at, now()) end,
      delivered_at = case when p_step = 'delivered' then now() else j.delivered_at end
   where j.id = p_job
     and ((p_step = 'collected' and j.status = 'matched') or (p_step = 'delivered' and j.status in ('matched','collected')))
     and exists (select 1 from public.trips t where t.id = j.matched_trip and t.user_id = auth.uid());
  if not found then raise exception 'That job isn''t yours to update, or it''s already done'; end if;
end $$;

-- Give a job back before collecting it (not once the buyer is answering a check)
create or replace function public.release_job(p_job uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('gtw.rpc', '1', true);
  update public.jobs j set status = 'open', matched_trip = null, check_status = null, check_note = null, checked_at = null
   where j.id = p_job and j.status = 'matched' and j.check_status is null
     and exists (select 1 from public.trips t where t.id = j.matched_trip and t.user_id = auth.uid());
  if not found then raise exception 'You can only give back a job you''ve taken and not collected'; end if;
end $$;

revoke execute on function public.job_check_send(uuid, text), public.job_check_answer(uuid, boolean) from public, anon;
grant execute on function public.job_check_send(uuid, text), public.job_check_answer(uuid, boolean) to authenticated;

-- ---------- Public board: add item type and check-first (still no addresses or contacts) ----------
drop view if exists public.board_jobs;
create view public.board_jobs as
  select id, kind, item, item_type, from_town, to_town, size, job_date, window_end, deadline_time, handover,
         pickup_mode, pickup_hours, check_first, price_estimate, status, created_at
  from public.jobs
  where status in ('open','matched','collected') and payment = 'paid' and window_end >= current_date;
grant select on public.board_jobs to anon, authenticated;


-- ===================== 007: admin trips go live; expired WoF/rego blocks taking jobs =====================
-- Going That Way: trips posted by the admin (testing as a driver) go live like anyone else's,
-- and drivers can't take jobs once their WoF or rego has run out.
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

create or replace function public.guard_new_trip() returns trigger
language plpgsql security definer set search_path = public as $$
declare ds text;
begin
  select driver_status into ds from public.profiles where id = new.user_id;
  if not public.is_admin() then
    if not public.is_real_account() then raise exception 'Please create an account to post a trip'; end if;
    if coalesce(ds, 'none') not in ('pending','verified') then raise exception 'Please apply to drive before posting a trip'; end if;
    new.admin_note := null;
  end if;
  -- Live straight away for approved drivers (admin included); everyone else waits for the check
  new.status := case when ds = 'verified' then 'open' else 'new' end;
  return new;
end $$;

-- Take a job: approved drivers with a current WoF and rego, paid live jobs, inside the job's window. First in wins.
create or replace function public.claim_job(p_job uuid, p_trip uuid) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare t public.trips; j public.jobs; p public.profiles;
begin
  select * into t from public.trips where id = p_trip and user_id = auth.uid() and status = 'open';
  if not found then raise exception 'Your trip isn''t live yet'; end if;
  select * into p from public.profiles where id = auth.uid();
  if not coalesce(p.verified_driver, false) or coalesce(p.driver_status, 'none') <> 'verified' then
    raise exception 'We need to check your licence before you can take jobs'; end if;
  if p.wof_expiry < current_date or p.rego_expiry < current_date then
    raise exception 'Your WoF or rego has expired. Renew it, then text us the new date so you can take jobs again'; end if;
  select * into j from public.jobs where id = p_job for update;
  if not found or j.status <> 'open' or j.payment <> 'paid' then raise exception 'Sorry, someone else just took this job'; end if;
  if t.trip_date < j.job_date or t.trip_date > j.window_end then raise exception 'Your trip day is outside this job''s delivery window'; end if;
  perform set_config('gtw.rpc', '1', true);
  update public.jobs set status = 'matched', matched_trip = p_trip where id = p_job returning * into j;
  return j;
end $$;

-- Switch on any trips that got stuck waiting even though the driver is approved
update public.trips t set status = 'open'
  from public.profiles p
 where p.id = t.user_id and p.driver_status = 'verified' and t.status = 'new' and t.trip_date >= current_date;


-- ===================== 008: extra-large items and two-person lifts =====================
-- Going That Way: extra-large items (trailer or van only) and two-person lifts.
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

alter table public.jobs drop constraint if exists jobs_size_check;
alter table public.jobs add constraint jobs_size_check check (size in ('small','medium','large','xl'));

alter table public.jobs drop constraint if exists jobs_item_type_check;
alter table public.jobs add constraint jobs_item_type_check check (item_type is null or item_type in
  ('big_furniture','furniture','whiteware','bike','outdoor','building','parts','tools','boxed','other'));

-- Needs two people to lift: the seller helps load and the buyer helps unload
alter table public.jobs add column if not exists heavy boolean not null default false;

drop view if exists public.board_jobs;
create view public.board_jobs as
  select id, kind, item, item_type, from_town, to_town, size, heavy, job_date, window_end, deadline_time, handover,
         pickup_mode, pickup_hours, check_first, price_estimate, status, created_at
  from public.jobs
  where status in ('open','matched','collected') and payment = 'paid' and window_end >= current_date;
grant select on public.board_jobs to anon, authenticated;


-- ===================== 009: report a problem; urgent same-day jobs =====================
-- Going That Way: "Report a problem" on any job, and urgent same-day jobs with a driver bonus.
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

-- =====================================================================
-- Report a problem
-- =====================================================================
create table if not exists public.job_reports (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  reporter uuid not null default auth.uid(),
  role text not null default 'sender',
  kind text not null,
  details text not null,
  status text not null default 'open',
  admin_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table public.job_reports drop constraint if exists job_reports_role_check;
alter table public.job_reports add constraint job_reports_role_check check (role in ('sender','driver','admin'));
alter table public.job_reports drop constraint if exists job_reports_kind_check;
alter table public.job_reports add constraint job_reports_kind_check check (kind in
  ('damaged','late','not_turned_up','wrong_item','not_as_described','payment','safety','other'));
alter table public.job_reports drop constraint if exists job_reports_status_check;
alter table public.job_reports add constraint job_reports_status_check check (status in ('open','resolved'));
alter table public.job_reports drop constraint if exists job_reports_details_check;
alter table public.job_reports add constraint job_reports_details_check check (length(trim(details)) between 1 and 2000);

-- Who's reporting is worked out here, not trusted from the app
create or replace function public.guard_new_report() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.reporter := auth.uid();
  new.role := case when exists (select 1 from public.jobs where id = new.job_id and user_id = auth.uid()) then 'sender'
                   when public.is_job_driver(new.job_id) then 'driver' else 'admin' end;
  new.status := 'open'; new.admin_note := null; new.resolved_at := null; new.created_at := now();
  return new;
end $$;
drop trigger if exists job_reports_guard_new on public.job_reports;
create trigger job_reports_guard_new before insert on public.job_reports for each row execute function public.guard_new_report();

alter table public.job_reports enable row level security;
drop policy if exists "people on the job report" on public.job_reports;
create policy "people on the job report" on public.job_reports for insert to authenticated
  with check (public.is_real_account() and public.can_see_job(job_id));
drop policy if exists "read own reports or admin" on public.job_reports;
create policy "read own reports or admin" on public.job_reports for select to authenticated
  using (reporter = auth.uid() or public.is_admin());
drop policy if exists "admin resolves reports" on public.job_reports;
create policy "admin resolves reports" on public.job_reports for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update on public.job_reports to authenticated;

-- Photos with a report: drivers can already add photos; let the sender add 'report' photos to their own job
alter table public.job_photos drop constraint if exists job_photos_kind_check;
alter table public.job_photos add constraint job_photos_kind_check check (kind in ('pickup','dropoff','no_show','check','report'));
drop policy if exists "sender adds report photos" on public.job_photos;
create policy "sender adds report photos" on public.job_photos for insert to authenticated
  with check (uploaded_by = auth.uid() and kind = 'report' and path like job_id::text || '/%'
              and exists (select 1 from public.jobs where id = job_id and user_id = auth.uid()));
drop policy if exists "gtw sender uploads report photo" on storage.objects;
create policy "gtw sender uploads report photo" on storage.objects for insert to authenticated
  with check (bucket_id = 'job-photos' and (storage.foldername(name))[2] is null
              and split_part(name, '/', 2) like 'report-%'
              and exists (select 1 from public.jobs where id = public.safe_uuid((storage.foldername(name))[1]) and user_id = auth.uid()));

-- =====================================================================
-- Urgent same-day jobs
-- =====================================================================
alter table public.jobs add column if not exists urgent boolean not null default false;
alter table public.jobs add column if not exists urgent_bonus int not null default 0;   -- paid by the sender, all to the driver
alter table public.jobs add column if not exists admin_bonus int not null default 0;    -- extra the admin adds to find a driver
alter table public.jobs drop constraint if exists jobs_urgent_bonus_check;
alter table public.jobs add constraint jobs_urgent_bonus_check check (urgent_bonus in (0,15,30,50));
alter table public.jobs drop constraint if exists jobs_admin_bonus_check;
alter table public.jobs add constraint jobs_admin_bonus_check check (admin_bonus between 0 and 500);

create or replace function public.guard_new_job() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    if not public.is_real_account() then raise exception 'Please create an account to post'; end if;
    if coalesce((select id_status from public.profiles where id = auth.uid()), 'none') not in ('pending','verified') then
      raise exception 'Please verify your ID before posting'; end if;
    new.status := 'new'; new.payment := 'unpaid'; new.driver_paid := false;
    new.matched_trip := null; new.collected_at := null; new.delivered_at := null; new.admin_note := null;
    new.check_status := null; new.check_note := null; new.checked_at := null;
    new.admin_bonus := 0;
  end if;
  if new.kind <> 'pickup' then new.check_first := false; end if;
  if not new.urgent then new.urgent_bonus := 0; end if;
  if new.window_end is null then new.window_end := new.job_date; end if;
  if new.urgent then new.window_end := new.job_date; end if;   -- urgent means that day
  if new.window_end < new.job_date then raise exception 'The deliver-by day is before the start day'; end if;
  return new;
end $$;

create or replace function public.guard_job_admin_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and coalesce(current_setting('gtw.rpc', true), '') <> '1' and (
       new.payment is distinct from old.payment
    or new.driver_paid is distinct from old.driver_paid
    or new.price_estimate is distinct from old.price_estimate
    or new.matched_trip is distinct from old.matched_trip
    or new.collected_at is distinct from old.collected_at
    or new.delivered_at is distinct from old.delivered_at
    or new.check_first is distinct from old.check_first
    or new.check_status is distinct from old.check_status
    or new.urgent is distinct from old.urgent
    or new.urgent_bonus is distinct from old.urgent_bonus
    or new.admin_bonus is distinct from old.admin_bonus) then
    raise exception 'Only the admin can change payment or matching details';
  end if;
  return new;
end $$;

-- Public board: add urgency (still no addresses or contacts)
drop view if exists public.board_jobs;
create view public.board_jobs as
  select id, kind, item, item_type, from_town, to_town, size, heavy, job_date, window_end, deadline_time, handover,
         pickup_mode, pickup_hours, check_first, urgent, urgent_bonus, admin_bonus, price_estimate, status, created_at
  from public.jobs
  where status in ('open','matched','collected') and payment = 'paid' and window_end >= current_date;
grant select on public.board_jobs to anon, authenticated;


-- ===================== 010: phone alerts for the admin (ntfy) =====================
-- Going That Way: free push alerts to the admin's phone (ntfy app) when something needs attention.
-- Alerts never include names, phone numbers or addresses: just the job reference, towns and price.
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.
-- The last line shows your private alert channel name. Subscribe to it in the ntfy app.

create extension if not exists pg_net;

-- Admin-only settings (the alert channel name lives here, not in the public code)
create table if not exists public.app_settings (key text primary key, value text not null);
alter table public.app_settings enable row level security;
drop policy if exists "admin settings" on public.app_settings;
create policy "admin settings" on public.app_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
insert into public.app_settings (key, value)
  values ('ntfy_topic', 'gtw-' || substr(md5(random()::text || clock_timestamp()::text), 1, 20))
  on conflict (key) do nothing;

-- Send one alert. Never blocks or breaks the action that triggered it.
create or replace function public.notify_admin(p_title text, p_message text, p_priority int default 3)
returns void language plpgsql security definer set search_path = public as $$
declare v_topic text;
begin
  select value into v_topic from public.app_settings where key = 'ntfy_topic';
  if v_topic is null then return; end if;
  begin
    perform net.http_post(
      url := 'https://ntfy.sh/',
      body := jsonb_build_object('topic', v_topic, 'title', p_title, 'message', p_message, 'priority', p_priority),
      headers := jsonb_build_object('Content-Type', 'application/json'));
  exception when others then null;
  end;
end $$;
revoke execute on function public.notify_admin(text, text, int) from public, anon, authenticated;

create or replace function public.gtw_ref(p_id uuid) returns text language sql immutable as $$
  select 'GTW-' || upper(substr(replace(p_id::text, '-', ''), 1, 6)) $$;

-- New job posted (needs a payment check); urgent ones are flagged high priority
create or replace function public.alert_new_job() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_admin(
    case when new.urgent then 'URGENT job today' else 'New job to check' end,
    public.gtw_ref(new.id) || ': ' || new.from_town || ' to ' || new.to_town || ', $' || round(coalesce(new.price_estimate, 0))
      || case when new.urgent then '. Wants delivery today. Check the payment and the Urgent tab.' else '. Check the payment in admin.' end,
    case when new.urgent then 5 else 3 end);
  return new;
end $$;
drop trigger if exists jobs_alert_new on public.jobs;
create trigger jobs_alert_new after insert on public.jobs for each row execute function public.alert_new_job();

-- Buyer said no after the check photos (a refund to sort out)
create or replace function public.alert_job_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'declined' and old.status is distinct from 'declined' then
    perform public.notify_admin('Buyer said no', public.gtw_ref(new.id) || ': not collected after the check photos. Sort the refund in admin.', 4);
  end if;
  return new;
end $$;
drop trigger if exists jobs_alert_change on public.jobs;
create trigger jobs_alert_change after update on public.jobs for each row execute function public.alert_job_change();

-- A problem reported
create or replace function public.alert_new_report() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_admin('Problem reported', public.gtw_ref(new.job_id) || ': ' || replace(new.kind, '_', ' ') || ' (from the ' || new.role || '). See Problems in admin.', 4);
  return new;
end $$;
drop trigger if exists job_reports_alert_new on public.job_reports;
create trigger job_reports_alert_new after insert on public.job_reports for each row execute function public.alert_new_report();

-- ID or driver check waiting
create or replace function public.alert_checks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.id_status = 'pending' and old.id_status is distinct from 'pending' then
    perform public.notify_admin('ID check waiting', 'Someone has sent their ID and selfie. See ID checks in admin.', 3);
  end if;
  if new.driver_status = 'pending' and old.driver_status is distinct from 'pending' then
    perform public.notify_admin('Driver check waiting', 'Someone has applied to drive. See Driver checks in admin.', 3);
  end if;
  return new;
end $$;
drop trigger if exists profiles_alert_checks on public.profiles;
create trigger profiles_alert_checks after update on public.profiles for each row execute function public.alert_checks();

-- Your private alert channel: subscribe to this name in the ntfy app
select value as your_ntfy_channel from public.app_settings where key = 'ntfy_topic';


-- ===================== 011: automatic emails (Resend) =====================
-- Going That Way: automatic emails to members at each step, sent through Resend.
-- Needs 010_phone_alerts.sql first (it switches on pg_net and creates app_settings).
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.
-- Then store your Resend API key with the one-line insert at the bottom (in its own query).
-- Emails come from hello@ (a real address that forwards to the admin), which spam filters trust more than noreply@.

-- Defaults you can change later with an update to app_settings
insert into public.app_settings (key, value) values
  ('email_from', 'Going That Way <hello@goingthatway.co.nz>'),
  ('email_reply_to', 'hello@goingthatway.co.nz'),
  ('site_url', 'https://goingthatway.co.nz')
on conflict (key) do nothing;

create or replace function public.setting(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select value from public.app_settings where key = p_key $$;
revoke execute on function public.setting(text) from public, anon, authenticated;

create or replace function public.esc_html(p text) returns text language sql immutable as $$
  select replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;') $$;

create or replace function public.user_email(p_user uuid) returns text
language sql stable security definer set search_path = public, auth as $$
  select coalesce((select email from auth.users where id = p_user), (select email from public.profiles where id = p_user)) $$;
revoke execute on function public.user_email(uuid) from public, anon, authenticated;

-- One simple, readable email layout
create or replace function public.email_html(p_heading text, p_body text, p_button text default null, p_path text default '')
returns text language plpgsql stable security definer set search_path = public as $$
declare site text := coalesce(public.setting('site_url'), 'https://goingthatway.co.nz');
begin
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1A231E">'
    || '<div style="background:#1F6B45;color:#fff;padding:16px 20px;border-bottom:4px solid #F3C623;font-size:20px;font-weight:bold">Going That Way</div>'
    || '<div style="padding:20px;font-size:15px;line-height:1.5"><h2 style="font-size:19px;margin:0 0 12px">' || p_heading || '</h2>' || p_body
    || case when p_button is not null then '<p style="margin:20px 0"><a href="' || site || '/' || p_path || '" style="background:#1F6B45;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:bold;display:inline-block">' || p_button || '</a></p>' else '' end
    || '<p style="color:#77827B;font-size:12.5px;margin-top:24px">You''re getting this because you have an account with Going That Way. Just reply to this email if you need us.</p></div></div>';
end $$;

-- Send one email. Never blocks or breaks the action that triggered it.
create or replace function public.send_email(p_user uuid, p_subject text, p_html text)
returns void language plpgsql security definer set search_path = public as $$
declare v_key text := public.setting('resend_key'); v_to text := public.user_email(p_user);
begin
  if v_key is null or v_to is null or v_to = '' then return; end if;
  begin
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      body := jsonb_build_object('from', coalesce(public.setting('email_from'), 'Going That Way <hello@goingthatway.co.nz>'),
                                 'to', jsonb_build_array(v_to), 'subject', p_subject, 'html', p_html,
                                 -- a plain-text copy too: spam filters trust emails that have one
                                 'text', trim(regexp_replace(regexp_replace(regexp_replace(replace(replace(replace(p_html, '</p>', E'\n\n'), '</h2>', E'\n\n'), '</div>', E'\n\n'), '<a href="([^"]*)"[^>]*>([^<]*)</a>', '\2: \1', 'g'), '<[^>]+>', '', 'g'), E'\n{3,}', E'\n\n', 'g')),
                                 'reply_to', coalesce(public.setting('email_reply_to'), 'hello@goingthatway.co.nz')),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key));
  exception when others then null;
  end;
end $$;
revoke execute on function public.send_email(uuid, text, text) from public, anon, authenticated;

-- ---------- Job emails ----------
create or replace function public.email_job_events() returns trigger
language plpgsql security definer set search_path = public as $$
declare item text := public.esc_html(new.item); ref text := public.gtw_ref(new.id);
        route text := public.esc_html(new.from_town || ' to ' || new.to_town);
        t public.trips; drv text;
begin
  if tg_op = 'INSERT' then
    perform public.send_email(new.user_id, 'Pay to make your job live (' || ref || ')',
      public.email_html('Your ' || item || ' is posted',
        '<p>' || route || ', by ' || to_char(new.window_end, 'Dy FMDD Mon') || '.</p><p>It goes on the board as soon as we see your payment of <b>$' || round(coalesce(new.price_estimate, 0)) || '</b> with the reference <b>' || ref || '</b>. The bank details are in the app under My account.</p><p>We hold your money until it''s delivered. If no driver takes it in time, you get a full refund.</p>',
        'See it in My account', '#account'));
    return new;
  end if;

  select * into t from public.trips where id = new.matched_trip;
  drv := public.esc_html(split_part(coalesce(t.driver_name, 'Your driver'), ' ', 1));

  if new.payment = 'paid' and old.payment is distinct from 'paid' and new.status = 'open' then
    perform public.send_email(new.user_id, 'Your job is live (' || ref || ')',
      public.email_html('Payment received: your ' || item || ' is live',
        '<p>Drivers heading ' || route || ' can now see it and take it. We''ll email you as soon as someone does.</p>', 'See it in My account', '#account'));
  end if;

  if new.status = 'matched' and old.status = 'open' then
    perform public.send_email(new.user_id, 'A driver is taking your ' || new.item,
      public.email_html(drv || ' is taking your ' || item,
        '<p>They''re heading ' || public.esc_html(t.from_town || ' to ' || t.to_town) || ' on ' || to_char(t.trip_date, 'Dy FMDD Mon') || coalesce(', leaving about ' || to_char(t.depart_time, 'FMHH12:MI am'), '') || '. They''ll text before pickup to arrange a time.</p>'
        || case when new.kind = 'pickup' then '<p>If you haven''t already, let the seller know a Going That Way driver is coming.</p>' else '' end
        || case when new.check_first then '<p>You asked for it to be checked first, so they''ll send you photos from the seller''s before loading it. Keep your phone handy on the day.</p>' else '' end,
        'See their details', '#account'));
  end if;

  if new.check_status = 'waiting' and old.check_status is distinct from 'waiting' then
    perform public.send_email(new.user_id, 'Photos of your ' || new.item || ': yes or no?',
      public.email_html(drv || ' is at the seller''s with your ' || item,
        '<p>They''ve sent photos so you can check it before it''s loaded.' || coalesce(' Their note: "' || public.esc_html(new.check_note) || '"', '') || '</p><p>Please have a look and tap <b>Yes, collect it</b> or <b>No, leave it</b>. They''re waiting.</p>',
        'See the photos', '#account'));
  end if;

  if new.check_status in ('approved', 'declined') and old.check_status = 'waiting' and t.user_id is not null then
    perform public.send_email(t.user_id, case when new.check_status = 'approved' then 'The buyer said yes: load it up' else 'The buyer said no: leave it with the seller' end,
      public.email_html(case when new.check_status = 'approved' then 'Yes: collect the ' || item else 'No: please leave the ' || item || ' with the seller' end,
        case when new.check_status = 'approved' then '<p>Take the pickup photo when it''s loaded.</p>' else '<p>Let the seller know politely. You''re still paid for this trip in the weekly payout.</p>' end,
        'Open the job', '#account'));
  end if;

  if new.status = 'collected' and old.status is distinct from 'collected' then
    perform public.send_email(new.user_id, 'Your ' || new.item || ' has been collected',
      public.email_html('Collected and on its way', '<p>' || drv || ' has picked up your ' || item || ' and is heading ' || route || '. There''s a photo in the app.</p>', 'See the photo', '#account'));
  end if;

  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    perform public.send_email(new.user_id, 'Delivered: your ' || new.item,
      public.email_html('Your ' || item || ' has been delivered',
        '<p>There''s a drop-off photo in the app. Thanks for using Going That Way!</p><p>If anything''s wrong, use <b>Report a problem</b> on the job within 30 days.</p>', 'See the photo', '#account'));
  end if;

  if new.status = 'declined' and old.status is distinct from 'declined' then
    perform public.send_email(new.user_id, 'Your ' || new.item || ' wasn''t collected',
      public.email_html('It''s been left with the seller', '<p>You said no after the check photos, so the driver hasn''t collected it. We''ll refund everything except the driver''s trip, usually within 2 working days.</p>', null));
  end if;
  return new;
end $$;
drop trigger if exists jobs_email_insert on public.jobs;
create trigger jobs_email_insert after insert on public.jobs for each row execute function public.email_job_events();
drop trigger if exists jobs_email_update on public.jobs;
create trigger jobs_email_update after update on public.jobs for each row execute function public.email_job_events();

-- ---------- Account emails ----------
create or replace function public.email_account_events() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := public.esc_html(split_part(coalesce(new.name, ''), ' ', 1));
begin
  if new.id_status = 'verified' and old.id_status is distinct from 'verified' and coalesce(new.driver_status, '') <> 'verified' then
    perform public.send_email(new.id, 'You''re verified', public.email_html('Thanks ' || who || ', you''re verified',
      '<p>Your ID has been checked and your photos deleted. You can now send anything on Going That Way.</p>', 'Post a job', ''));
  end if;
  if new.id_status = 'rejected' and old.id_status is distinct from 'rejected' then
    perform public.send_email(new.id, 'We couldn''t verify your ID', public.email_html('We couldn''t verify your ID',
      '<p>' || coalesce('Reason: ' || public.esc_html(new.review_note) || '. ', '') || 'Your photos have been deleted. Please try again with a clear photo of your ID and a selfie.</p>', 'Try again', '#account'));
  end if;
  if new.driver_status = 'verified' and old.driver_status is distinct from 'verified' then
    perform public.send_email(new.id, 'You''re approved to drive', public.email_html('You''re approved to drive, ' || who,
      '<p>Your licence, WoF and rego have been checked. Post a trip whenever you''re heading somewhere between Christchurch and Dunedin, and take the paid jobs on your route.</p>', 'Post a trip', ''));
  end if;
  if new.driver_status = 'rejected' and old.driver_status is distinct from 'rejected' then
    perform public.send_email(new.id, 'We couldn''t approve you to drive yet', public.email_html('We couldn''t approve you to drive yet',
      '<p>' || coalesce('Reason: ' || public.esc_html(new.review_note) || '. ', '') || 'You can apply again from My account.</p>', 'My account', '#account'));
  end if;
  return new;
end $$;
drop trigger if exists profiles_email_events on public.profiles;
create trigger profiles_email_events after update on public.profiles for each row execute function public.email_account_events();

-- ---------- Problem report sorted ----------
create or replace function public.email_report_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'resolved' and old.status is distinct from 'resolved' then
    perform public.send_email(new.reporter, 'We''ve sorted your report (' || public.gtw_ref(new.job_id) || ')',
      public.email_html('Your report has been sorted', coalesce('<p>' || public.esc_html(new.admin_note) || '</p>', '<p>We''ve looked into it and it''s been sorted.</p>') || '<p>If it''s not right, just reply to this email.</p>', 'See the job', '#account'));
  end if;
  return new;
end $$;
drop trigger if exists job_reports_email_events on public.job_reports;
create trigger job_reports_email_events after update on public.job_reports for each row execute function public.email_report_events();

-- ---------- Your Resend API key ----------
-- Run this on its own, with your key in place of re_xxx (it never goes in the public code):
-- insert into public.app_settings (key, value) values ('resend_key', 're_xxx') on conflict (key) do update set value = excluded.value;

-- Earlier installs sent from noreply@: switch to hello@
update public.app_settings set value = 'Going That Way <hello@goingthatway.co.nz>' where key = 'email_from' and value like '%noreply@%';


-- ===================== 012: click and collect =====================
-- Going That Way: click and collect orders from stores in another town.
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('pickup','parcel','collect'));
alter table public.jobs add column if not exists store_name text;   -- shown to drivers on the board
alter table public.jobs add column if not exists order_ref text;    -- private: only the driver who takes it and the admin
alter table public.jobs add column if not exists order_name text;   -- private: the name the order is under

-- Public board: add the store name (a business, not a person; still no addresses or contacts)
drop view if exists public.board_jobs;
create view public.board_jobs as
  select id, kind, item, item_type, store_name, from_town, to_town, size, heavy, job_date, window_end, deadline_time, handover,
         pickup_mode, pickup_hours, check_first, urgent, urgent_bonus, admin_bonus, price_estimate, status, created_at
  from public.jobs
  where status in ('open','matched','collected') and payment = 'paid' and window_end >= current_date;
grant select on public.board_jobs to anon, authenticated;

-- Emails: tell click and collect buyers who to name as the collector
create or replace function public.email_job_events() returns trigger
language plpgsql security definer set search_path = public as $$
declare item text := public.esc_html(new.item); ref text := public.gtw_ref(new.id);
        route text := public.esc_html(new.from_town || ' to ' || new.to_town);
        t public.trips; drv text;
begin
  if tg_op = 'INSERT' then
    perform public.send_email(new.user_id, 'Pay to make your job live (' || ref || ')',
      public.email_html('Your ' || item || ' is posted',
        '<p>' || route || ', by ' || to_char(new.window_end, 'Dy FMDD Mon') || '.</p><p>It goes on the board as soon as we see your payment of <b>$' || round(coalesce(new.price_estimate, 0)) || '</b> with the reference <b>' || ref || '</b>. The bank details are in the app under My account.</p><p>We hold your money until it''s delivered. If no driver takes it in time, you get a full refund.</p>',
        'See it in My account', '#account'));
    return new;
  end if;

  select * into t from public.trips where id = new.matched_trip;
  drv := public.esc_html(split_part(coalesce(t.driver_name, 'Your driver'), ' ', 1));

  if new.payment = 'paid' and old.payment is distinct from 'paid' and new.status = 'open' then
    perform public.send_email(new.user_id, 'Your job is live (' || ref || ')',
      public.email_html('Payment received: your ' || item || ' is live',
        '<p>Drivers heading ' || route || ' can now see it and take it. We''ll email you as soon as someone does.</p>', 'See it in My account', '#account'));
  end if;

  if new.status = 'matched' and old.status = 'open' then
    perform public.send_email(new.user_id, 'A driver is taking your ' || new.item,
      public.email_html(drv || ' is taking your ' || item,
        '<p>They''re heading ' || public.esc_html(t.from_town || ' to ' || t.to_town) || ' on ' || to_char(t.trip_date, 'Dy FMDD Mon') || coalesce(', leaving about ' || to_char(t.depart_time, 'FMHH12:MI am'), '') || '. They''ll text before pickup to arrange a time.</p>'
        || case when new.kind = 'pickup' then '<p>If you haven''t already, let the seller know a Going That Way driver is coming.</p>'
                when new.kind = 'collect' then '<p>They''ll collect order <b>' || public.esc_html(new.order_ref) || '</b> from ' || public.esc_html(new.store_name) || '. If the store needs you to name who''s collecting, add <b>' || public.esc_html(t.driver_name) || '</b>.</p>' else '' end
        || case when new.check_first then '<p>You asked for it to be checked first, so they''ll send you photos from the seller''s before loading it. Keep your phone handy on the day.</p>' else '' end,
        'See their details', '#account'));
  end if;

  if new.check_status = 'waiting' and old.check_status is distinct from 'waiting' then
    perform public.send_email(new.user_id, 'Photos of your ' || new.item || ': yes or no?',
      public.email_html(drv || ' is at the seller''s with your ' || item,
        '<p>They''ve sent photos so you can check it before it''s loaded.' || coalesce(' Their note: "' || public.esc_html(new.check_note) || '"', '') || '</p><p>Please have a look and tap <b>Yes, collect it</b> or <b>No, leave it</b>. They''re waiting.</p>',
        'See the photos', '#account'));
  end if;

  if new.check_status in ('approved', 'declined') and old.check_status = 'waiting' and t.user_id is not null then
    perform public.send_email(t.user_id, case when new.check_status = 'approved' then 'The buyer said yes: load it up' else 'The buyer said no: leave it with the seller' end,
      public.email_html(case when new.check_status = 'approved' then 'Yes: collect the ' || item else 'No: please leave the ' || item || ' with the seller' end,
        case when new.check_status = 'approved' then '<p>Take the pickup photo when it''s loaded.</p>' else '<p>Let the seller know politely. You''re still paid for this trip in the weekly payout.</p>' end,
        'Open the job', '#account'));
  end if;

  if new.status = 'collected' and old.status is distinct from 'collected' then
    perform public.send_email(new.user_id, 'Your ' || new.item || ' has been collected',
      public.email_html('Collected and on its way', '<p>' || drv || ' has picked up your ' || item || ' and is heading ' || route || '. There''s a photo in the app.</p>', 'See the photo', '#account'));
  end if;

  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    perform public.send_email(new.user_id, 'Delivered: your ' || new.item,
      public.email_html('Your ' || item || ' has been delivered',
        '<p>There''s a drop-off photo in the app. Thanks for using Going That Way!</p><p>If anything''s wrong, use <b>Report a problem</b> on the job within 30 days.</p>', 'See the photo', '#account'));
  end if;

  if new.status = 'declined' and old.status is distinct from 'declined' then
    perform public.send_email(new.user_id, 'Your ' || new.item || ' wasn''t collected',
      public.email_html('It''s been left with the seller', '<p>You said no after the check photos, so the driver hasn''t collected it. We''ll refund everything except the driver''s trip, usually within 2 working days.</p>', null));
  end if;
  return new;
end $$;


-- ===================== 013: driver bank accounts and payout dates =====================
-- Going That Way: drivers' bank accounts for weekly payouts, and when each job was paid out.
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

-- Bank account for payouts (only the member and the admin can see it)
alter table public.profiles add column if not exists bank_account text;
alter table public.profiles add column if not exists bank_account_name text;
alter table public.profiles drop constraint if exists profiles_bank_account_check;
alter table public.profiles add constraint profiles_bank_account_check
  check (bank_account is null or bank_account ~ '^[0-9]{2}-[0-9]{4}-[0-9]{7}-[0-9]{2,3}$');

-- Members can edit their contact and bank details, never their verification status
revoke update on public.profiles from anon, authenticated;
grant update (name, phone, address, bank_account, bank_account_name) on public.profiles to authenticated;

-- When the driver was paid for a job
alter table public.jobs add column if not exists driver_paid_at timestamptz;

create or replace function public.guard_job_admin_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and coalesce(current_setting('gtw.rpc', true), '') <> '1' and (
       new.payment is distinct from old.payment
    or new.driver_paid is distinct from old.driver_paid
    or new.driver_paid_at is distinct from old.driver_paid_at
    or new.price_estimate is distinct from old.price_estimate
    or new.matched_trip is distinct from old.matched_trip
    or new.collected_at is distinct from old.collected_at
    or new.delivered_at is distinct from old.delivered_at
    or new.check_first is distinct from old.check_first
    or new.check_status is distinct from old.check_status
    or new.urgent is distinct from old.urgent
    or new.urgent_bonus is distinct from old.urgent_bonus
    or new.admin_bonus is distinct from old.admin_bonus) then
    raise exception 'Only the admin can change payment or matching details';
  end if;
  return new;
end $$;

-- Record the payout time automatically when the admin ticks "driver paid"
create or replace function public.stamp_driver_paid() returns trigger
language plpgsql as $$
begin
  if new.driver_paid and not coalesce(old.driver_paid, false) then new.driver_paid_at := coalesce(new.driver_paid_at, now()); end if;
  if not new.driver_paid then new.driver_paid_at := null; end if;
  return new;
end $$;
drop trigger if exists jobs_stamp_driver_paid on public.jobs;
create trigger jobs_stamp_driver_paid before update on public.jobs for each row execute function public.stamp_driver_paid();


-- ===================== 014: route alerts, ratings, driver card, daily reminders, photo clean-up =====================
-- Going That Way: route alerts for drivers, thumbs up after delivery and a driver card for buyers,
-- daily WoF/rego reminders, and clean-up of old job photos.
-- Needs 011_emails.sql first. Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

-- =====================================================================
-- Towns along the corridor (km from Hanmer Springs), same as the app
-- =====================================================================
create or replace function public.town_km(p text) returns int language sql immutable as $$
  select km from (values
    ('Hanmer Springs',0),('Culverden',38),('Amberley',88),('Rangiora',108),('Christchurch Airport',125),('Christchurch',135),
    ('Rolleston',158),('Dunsandel',176),('Rakaia',192),('Ashburton',220),('Hinds',242),('Geraldine',268),('Winchester',271),
    ('Temuka',280),('Timaru',296),('Pareora',313),('St Andrews',320),('Makikihi',329),('Waimate',340),('Glenavy',357),
    ('Oamaru',380),('Hampden',416),('Moeraki',420),('Palmerston',435),('Waikouaiti',454),('Dunedin',495)) t(name, km)
  where name = p $$;

-- What the driver is paid for a job (the app's formula): price less our fee, plus any bonuses
create or replace function public.driver_pay(j public.jobs) returns int language sql immutable as $$
  select (case when (coalesce(j.price_estimate,0) - j.urgent_bonus) / 1.15 >= 20
               then round((coalesce(j.price_estimate,0) - j.urgent_bonus) / 1.15)
               else coalesce(j.price_estimate,0) - j.urgent_bonus - 3 end)::int + j.urgent_bonus + j.admin_bonus $$;

-- =====================================================================
-- Route alerts: "email me when a paid job comes up between these towns"
-- =====================================================================
create table if not exists public.route_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  from_town text not null,
  to_town text not null,
  created_at timestamptz not null default now()
);
alter table public.route_alerts drop constraint if exists route_alerts_towns_check;
alter table public.route_alerts add constraint route_alerts_towns_check
  check (public.town_km(from_town) is not null and public.town_km(to_town) is not null and from_town <> to_town);
alter table public.route_alerts enable row level security;
drop policy if exists "own route alerts" on public.route_alerts;
create policy "own route alerts" on public.route_alerts for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() and coalesce((select driver_status from public.profiles where id = auth.uid()), 'none') in ('pending','verified'));
grant select, insert, delete on public.route_alerts to authenticated;

-- Email every driver whose alert covers a job that has just gone live
create or replace function public.alert_drivers_new_job() returns trigger
language plpgsql security definer set search_path = public as $$
declare a record; jf int := public.town_km(new.from_town); jt int := public.town_km(new.to_town); pay int := public.driver_pay(new);
begin
  if not (new.status = 'open' and new.payment = 'paid' and (old.status is distinct from 'open' or old.payment is distinct from 'paid')) then return new; end if;
  if jf is null or jt is null then return new; end if;
  for a in
    select distinct on (ra.user_id) ra.user_id, ra.from_town, ra.to_town
    from public.route_alerts ra join public.profiles p on p.id = ra.user_id
    where ra.user_id <> new.user_id and p.driver_status = 'verified'
      and (public.town_km(ra.to_town) - public.town_km(ra.from_town)) * (jt - jf) > 0
      and jf between least(public.town_km(ra.from_town), public.town_km(ra.to_town)) and greatest(public.town_km(ra.from_town), public.town_km(ra.to_town))
      and jt between least(public.town_km(ra.from_town), public.town_km(ra.to_town)) and greatest(public.town_km(ra.from_town), public.town_km(ra.to_town))
      and (new.size in ('small','medium') or (new.size = 'large' and p.vehicle_space in ('ute','trailer','van')) or (new.size = 'xl' and p.vehicle_space in ('trailer','van')))
  loop
    perform public.send_email(a.user_id, case when new.urgent then 'Urgent job today: ' else 'New job on your route: ' end || new.item || ', $' || pay,
      public.email_html(case when new.urgent then 'Urgent: ' else '' end || public.esc_html(new.item) || ' pays you $' || pay,
        '<p>' || public.esc_html(new.from_town || ' to ' || new.to_town) || ', delivered by ' || to_char(new.window_end, 'Dy FMDD Mon') || '.'
        || case when new.heavy then ' It''s a two-person lift (help at both ends).' else '' end
        || case when new.urgent then ' It needs to get there today.' else '' end || '</p>'
        || '<p>Post your trip for that day and you can take it. First in gets it.</p>'
        || '<p style="color:#77827B;font-size:13px">You asked for alerts on ' || public.esc_html(a.from_town || ' to ' || a.to_town) || '. You can turn them off under Drive.</p>',
        'Post a trip and take it', '#drive'));
  end loop;
  return new;
end $$;
drop trigger if exists jobs_alert_drivers on public.jobs;
create trigger jobs_alert_drivers after update on public.jobs for each row execute function public.alert_drivers_new_job();

-- =====================================================================
-- Thumbs up or down after delivery, and the driver card buyers see
-- =====================================================================
alter table public.jobs add column if not exists rating smallint;
alter table public.jobs drop constraint if exists jobs_rating_check;
alter table public.jobs add constraint jobs_rating_check check (rating is null or rating in (-1, 1));
alter table public.jobs add column if not exists rating_note text;
alter table public.jobs add column if not exists rated_at timestamptz;

create or replace function public.rate_job(p_job uuid, p_up boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('gtw.rpc', '1', true);
  update public.jobs set rating = case when p_up then 1 else -1 end, rating_note = nullif(left(trim(coalesce(p_note, '')), 1000), ''), rated_at = now()
   where id = p_job and user_id = auth.uid() and status = 'delivered' and rating is null;
  if not found then raise exception 'You''ve already rated this one, or it isn''t delivered yet'; end if;
end $$;
revoke execute on function public.rate_job(uuid, boolean, text) from public, anon;
grant execute on function public.rate_job(uuid, boolean, text) to authenticated;

-- The driver of one of your jobs: name, vehicle, checks, jobs done and thumbs up
create or replace function public.job_driver_card(p_job uuid)
returns table (driver_name text, driver_phone text, trip_date date, depart_time time, vehicle_make text, vehicle_space text,
               verified boolean, jobs_done int, thumbs_up int, thumbs_total int)
language sql stable security definer set search_path = public as $$
  select t.driver_name, t.driver_phone, t.trip_date, t.depart_time, p.vehicle_make, coalesce(t.space, p.vehicle_space),
         p.driver_status = 'verified',
         (select count(*)::int from public.jobs x join public.trips y on y.id = x.matched_trip where y.user_id = t.user_id and x.status = 'delivered'),
         (select count(*)::int from public.jobs x join public.trips y on y.id = x.matched_trip where y.user_id = t.user_id and x.rating = 1),
         (select count(*)::int from public.jobs x join public.trips y on y.id = x.matched_trip where y.user_id = t.user_id and x.rating is not null)
  from public.jobs j join public.trips t on t.id = j.matched_trip join public.profiles p on p.id = t.user_id
  where j.id = p_job and (j.user_id = auth.uid() or public.is_admin()) $$;
revoke execute on function public.job_driver_card(uuid) from public, anon;
grant execute on function public.job_driver_card(uuid) to authenticated;

-- Ratings are set only through rate_job
create or replace function public.guard_job_admin_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and coalesce(current_setting('gtw.rpc', true), '') <> '1' and (
       new.payment is distinct from old.payment
    or new.driver_paid is distinct from old.driver_paid
    or new.driver_paid_at is distinct from old.driver_paid_at
    or new.price_estimate is distinct from old.price_estimate
    or new.matched_trip is distinct from old.matched_trip
    or new.collected_at is distinct from old.collected_at
    or new.delivered_at is distinct from old.delivered_at
    or new.check_first is distinct from old.check_first
    or new.check_status is distinct from old.check_status
    or new.urgent is distinct from old.urgent
    or new.urgent_bonus is distinct from old.urgent_bonus
    or new.admin_bonus is distinct from old.admin_bonus
    or new.rating is distinct from old.rating
    or new.rating_note is distinct from old.rating_note
    or new.rated_at is distinct from old.rated_at) then
    raise exception 'Only the admin can change payment or matching details';
  end if;
  return new;
end $$;

-- Phone alert to the admin on a thumbs down
create or replace function public.alert_thumbs_down() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rating = -1 and old.rating is null then
    perform public.notify_admin('Thumbs down', public.gtw_ref(new.id) || ': the buyer wasn''t happy. See the job in admin.', 4);
  end if;
  return new;
end $$;
drop trigger if exists jobs_alert_thumbs_down on public.jobs;
create trigger jobs_alert_thumbs_down after update on public.jobs for each row execute function public.alert_thumbs_down();

-- =====================================================================
-- Old job photos: the admin can delete them (the app does it from the Accounts tab)
-- =====================================================================
drop policy if exists "gtw admin deletes job photos" on storage.objects;
create policy "gtw admin deletes job photos" on storage.objects for delete to authenticated
  using (bucket_id = 'job-photos' and public.is_admin());
drop policy if exists "admin deletes photo records" on public.job_photos;
create policy "admin deletes photo records" on public.job_photos for delete to authenticated using (public.is_admin());
grant delete on public.job_photos to authenticated;

-- Delivered email: damage must be reported within 48 hours (matches the terms)
create or replace function public.email_job_events() returns trigger
language plpgsql security definer set search_path = public as $$
declare item text := public.esc_html(new.item); ref text := public.gtw_ref(new.id);
        route text := public.esc_html(new.from_town || ' to ' || new.to_town);
        t public.trips; drv text;
begin
  if tg_op = 'INSERT' then
    perform public.send_email(new.user_id, 'Pay to make your job live (' || ref || ')',
      public.email_html('Your ' || item || ' is posted',
        '<p>' || route || ', by ' || to_char(new.window_end, 'Dy FMDD Mon') || '.</p><p>It goes on the board as soon as we see your payment of <b>$' || round(coalesce(new.price_estimate, 0)) || '</b> with the reference <b>' || ref || '</b>. The bank details are in the app under My account.</p><p>We hold your money until it''s delivered. If no driver takes it in time, you get a full refund.</p>',
        'See it in My account', '#account'));
    return new;
  end if;

  select * into t from public.trips where id = new.matched_trip;
  drv := public.esc_html(split_part(coalesce(t.driver_name, 'Your driver'), ' ', 1));

  if new.payment = 'paid' and old.payment is distinct from 'paid' and new.status = 'open' then
    perform public.send_email(new.user_id, 'Your job is live (' || ref || ')',
      public.email_html('Payment received: your ' || item || ' is live',
        '<p>Drivers heading ' || route || ' can now see it and take it. We''ll email you as soon as someone does.</p>', 'See it in My account', '#account'));
  end if;

  if new.status = 'matched' and old.status = 'open' then
    perform public.send_email(new.user_id, 'A driver is taking your ' || new.item,
      public.email_html(drv || ' is taking your ' || item,
        '<p>They''re heading ' || public.esc_html(t.from_town || ' to ' || t.to_town) || ' on ' || to_char(t.trip_date, 'Dy FMDD Mon') || coalesce(', leaving about ' || to_char(t.depart_time, 'FMHH12:MI am'), '') || '. They''ll text before pickup to arrange a time.</p>'
        || case when new.kind = 'pickup' then '<p>If you haven''t already, let the seller know a Going That Way driver is coming.</p>'
                when new.kind = 'collect' then '<p>They''ll collect order <b>' || public.esc_html(new.order_ref) || '</b> from ' || public.esc_html(new.store_name) || '. If the store needs you to name who''s collecting, add <b>' || public.esc_html(t.driver_name) || '</b>.</p>' else '' end
        || case when new.check_first then '<p>You asked for it to be checked first, so they''ll send you photos from the seller''s before loading it. Keep your phone handy on the day.</p>' else '' end,
        'See their details', '#account'));
  end if;

  if new.check_status = 'waiting' and old.check_status is distinct from 'waiting' then
    perform public.send_email(new.user_id, 'Photos of your ' || new.item || ': yes or no?',
      public.email_html(drv || ' is at the seller''s with your ' || item,
        '<p>They''ve sent photos so you can check it before it''s loaded.' || coalesce(' Their note: "' || public.esc_html(new.check_note) || '"', '') || '</p><p>Please have a look and tap <b>Yes, collect it</b> or <b>No, leave it</b>. They''re waiting.</p>',
        'See the photos', '#account'));
  end if;

  if new.check_status in ('approved', 'declined') and old.check_status = 'waiting' and t.user_id is not null then
    perform public.send_email(t.user_id, case when new.check_status = 'approved' then 'The buyer said yes: load it up' else 'The buyer said no: leave it with the seller' end,
      public.email_html(case when new.check_status = 'approved' then 'Yes: collect the ' || item else 'No: please leave the ' || item || ' with the seller' end,
        case when new.check_status = 'approved' then '<p>Take the pickup photo when it''s loaded.</p>' else '<p>Let the seller know politely. You''re still paid for this trip in the weekly payout.</p>' end,
        'Open the job', '#account'));
  end if;

  if new.status = 'collected' and old.status is distinct from 'collected' then
    perform public.send_email(new.user_id, 'Your ' || new.item || ' has been collected',
      public.email_html('Collected and on its way', '<p>' || drv || ' has picked up your ' || item || ' and is heading ' || route || '. There''s a photo in the app.</p>', 'See the photo', '#account'));
  end if;

  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    perform public.send_email(new.user_id, 'Delivered: your ' || new.item,
      public.email_html('Your ' || item || ' has been delivered',
        '<p>There''s a drop-off photo in the app. Thanks for using Going That Way!</p><p>If it''s damaged, use <b>Report a problem</b> on the job within 48 hours, with photos. For anything else, you have 30 days.</p>', 'See the photo', '#account'));
  end if;

  if new.status = 'declined' and old.status is distinct from 'declined' then
    perform public.send_email(new.user_id, 'Your ' || new.item || ' wasn''t collected',
      public.email_html('It''s been left with the seller', '<p>You said no after the check photos, so the driver hasn''t collected it. We''ll refund everything except the driver''s trip, usually within 2 working days.</p>', null));
  end if;
  return new;
end $$;

-- =====================================================================
-- Daily jobs, 8 am NZ: WoF and rego reminders, and a nudge about old photos
-- =====================================================================
create or replace function public.gtw_daily() returns void
language plpgsql security definer set search_path = public as $$
declare d record; old_photos int;
begin
  for d in select id, name, wof_expiry, rego_expiry from public.profiles where driver_status = 'verified' loop
    if d.wof_expiry in (current_date + 14, current_date + 3) or d.rego_expiry in (current_date + 14, current_date + 3) then
      perform public.send_email(d.id, 'Your ' || case when d.wof_expiry in (current_date + 14, current_date + 3) then 'WoF' else 'rego' end || ' is due soon',
        public.email_html('A reminder about your ' || case when d.wof_expiry in (current_date + 14, current_date + 3) then 'WoF' else 'rego' end,
          '<p>Hi ' || public.esc_html(split_part(coalesce(d.name, ''), ' ', 1)) || ', your '
          || case when d.wof_expiry in (current_date + 14, current_date + 3) then 'WoF runs out on ' || to_char(d.wof_expiry, 'FMDD Mon') else 'rego runs out on ' || to_char(d.rego_expiry, 'FMDD Mon') end
          || '. Once it does, you can''t take Going That Way jobs until it''s renewed.</p><p>When you''ve renewed it, just reply to this email with the new expiry date and we''ll update your account.</p>', null));
    end if;
    if d.wof_expiry = current_date or d.rego_expiry = current_date then
      perform public.send_email(d.id, 'Your ' || case when d.wof_expiry = current_date then 'WoF' else 'rego' end || ' runs out today',
        public.email_html('Your ' || case when d.wof_expiry = current_date then 'WoF' else 'rego' end || ' runs out today',
          '<p>From tomorrow you can''t take jobs until it''s renewed. Reply to this email with the new expiry date once you have, and we''ll switch you back on.</p>', null));
      perform public.notify_admin('Driver expiry', 'A driver''s ' || case when d.wof_expiry = current_date then 'WoF' else 'rego' end || ' runs out today. See Driver checks if they send a new date.', 3);
    end if;
  end loop;
  if extract(isodow from current_date) = 1 then
    select count(*) into old_photos from public.job_photos where created_at < now() - interval '12 months';
    if old_photos > 0 then
      perform public.notify_admin('Photo clean-up', old_photos || ' job photos are over 12 months old. Delete them from the Accounts tab in admin.', 2);
    end if;
  end if;
end $$;
revoke execute on function public.gtw_daily() from public, anon, authenticated;

create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'gtw-daily';
select cron.schedule('gtw-daily', '0 19 * * *', 'select public.gtw_daily()');   -- 19:00 UTC = 8 am NZDT (7 am in winter)


-- ===================== 015: over-$500 requests =====================
-- Going That Way: "worth more than $500? tell me when you can carry it" requests,
-- so the admin can see real demand before paying for insurance.
-- Needs 010_phone_alerts.sql first. Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

create table if not exists public.high_value_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item text not null,
  value int not null,
  from_town text,
  to_town text,
  created_at timestamptz not null default now()
);
alter table public.high_value_requests drop constraint if exists high_value_requests_check;
alter table public.high_value_requests add constraint high_value_requests_check
  check (length(trim(item)) between 1 and 200 and value between 500 and 100000);
alter table public.high_value_requests enable row level security;
drop policy if exists "add own request" on public.high_value_requests;
create policy "add own request" on public.high_value_requests for insert to authenticated
  with check (user_id = auth.uid() and public.is_real_account());
drop policy if exists "read own requests or admin" on public.high_value_requests;
create policy "read own requests or admin" on public.high_value_requests for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
grant select, insert on public.high_value_requests to authenticated;

create or replace function public.alert_high_value() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_admin('Over $500 request', 'Someone wants to send something worth $' || new.value
    || coalesce(' (' || new.from_town || ' to ' || new.to_town || ')', '') || '. See Over $500 in admin.', 2);
  return new;
end $$;
drop trigger if exists high_value_alert on public.high_value_requests;
create trigger high_value_alert after insert on public.high_value_requests for each row execute function public.alert_high_value();
