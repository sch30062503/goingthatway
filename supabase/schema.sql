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
