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
