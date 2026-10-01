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
