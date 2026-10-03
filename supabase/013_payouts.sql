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
