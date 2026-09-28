-- Going That Way: real accounts, one-off ID checks for everyone, driver + vehicle checks.
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

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
