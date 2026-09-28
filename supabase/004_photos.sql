-- Going That Way: pickup / drop-off / no-show photos.
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

-- Private storage for job photos (5 MB max each; the app shrinks them first)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('job-photos', 'job-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- Who can see a job's photos: the sender, the driver on the job, the admin
create or replace function public.is_job_driver(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.jobs j join public.trips t on t.id = j.matched_trip
                 where j.id = p_job and t.user_id = auth.uid());
$$;
create or replace function public.can_see_job(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or public.is_job_driver(p_job)
      or exists (select 1 from public.jobs where id = p_job and user_id = auth.uid());
$$;
create or replace function public.safe_uuid(p text) returns uuid
language plpgsql immutable as $$ begin return p::uuid; exception when others then return null; end $$;

-- A record of each photo
create table if not exists public.job_photos (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  kind text not null check (kind in ('pickup','dropoff','no_show')),
  path text not null,
  uploaded_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.job_photos enable row level security;
drop policy if exists "driver adds photos" on public.job_photos;
create policy "driver adds photos" on public.job_photos for insert to authenticated
  with check (uploaded_by = auth.uid() and public.is_job_driver(job_id) and path like job_id::text || '/%');
drop policy if exists "people on the job see photos" on public.job_photos;
create policy "people on the job see photos" on public.job_photos for select to authenticated
  using (public.can_see_job(job_id));

-- Storage rules: files live at <job id>/<name>.jpg
drop policy if exists "gtw driver uploads job photo" on storage.objects;
create policy "gtw driver uploads job photo" on storage.objects for insert to authenticated
  with check (bucket_id = 'job-photos' and public.is_job_driver(public.safe_uuid((storage.foldername(name))[1])));
drop policy if exists "gtw people on the job view photo" on storage.objects;
create policy "gtw people on the job view photo" on storage.objects for select to authenticated
  using (bucket_id = 'job-photos' and public.can_see_job(public.safe_uuid((storage.foldername(name))[1])));

-- Collected needs a pickup photo, delivered needs a drop-off photo
create or replace function public.job_progress(p_job uuid, p_step text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_step not in ('collected','delivered') then raise exception 'Unknown step'; end if;
  if not exists (select 1 from public.job_photos where job_id = p_job
                 and kind = case when p_step = 'collected' then 'pickup' else 'dropoff' end) then
    raise exception 'Please add a % photo first', case when p_step = 'collected' then 'pickup' else 'drop-off' end;
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

revoke execute on function public.is_job_driver(uuid), public.can_see_job(uuid) from public, anon;
grant execute on function public.is_job_driver(uuid), public.can_see_job(uuid) to authenticated;
