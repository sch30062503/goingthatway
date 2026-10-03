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
