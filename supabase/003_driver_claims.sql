-- Going That Way: pay at posting, delivery windows, collection method, drivers take jobs themselves.
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

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
