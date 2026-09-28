-- Going That Way: payment tracking (held at booking, driver paid after delivery)
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

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
