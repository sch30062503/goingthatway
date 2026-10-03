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
