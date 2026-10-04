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
