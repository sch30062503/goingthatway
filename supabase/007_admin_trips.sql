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
