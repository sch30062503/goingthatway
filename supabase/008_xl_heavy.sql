-- Going That Way: extra-large items (trailer or van only) and two-person lifts.
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

alter table public.jobs drop constraint if exists jobs_size_check;
alter table public.jobs add constraint jobs_size_check check (size in ('small','medium','large','xl'));

alter table public.jobs drop constraint if exists jobs_item_type_check;
alter table public.jobs add constraint jobs_item_type_check check (item_type is null or item_type in
  ('big_furniture','furniture','whiteware','bike','outdoor','building','parts','tools','boxed','other'));

-- Needs two people to lift: the seller helps load and the buyer helps unload
alter table public.jobs add column if not exists heavy boolean not null default false;

drop view if exists public.board_jobs;
create view public.board_jobs as
  select id, kind, item, item_type, from_town, to_town, size, heavy, job_date, window_end, deadline_time, handover,
         pickup_mode, pickup_hours, check_first, price_estimate, status, created_at
  from public.jobs
  where status in ('open','matched','collected') and payment = 'paid' and window_end >= current_date;
grant select on public.board_jobs to anon, authenticated;
