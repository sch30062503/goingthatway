-- Going That Way: click and collect orders from stores in another town.
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.

alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('pickup','parcel','collect'));
alter table public.jobs add column if not exists store_name text;   -- shown to drivers on the board
alter table public.jobs add column if not exists order_ref text;    -- private: only the driver who takes it and the admin
alter table public.jobs add column if not exists order_name text;   -- private: the name the order is under

-- Public board: add the store name (a business, not a person; still no addresses or contacts)
drop view if exists public.board_jobs;
create view public.board_jobs as
  select id, kind, item, item_type, store_name, from_town, to_town, size, heavy, job_date, window_end, deadline_time, handover,
         pickup_mode, pickup_hours, check_first, urgent, urgent_bonus, admin_bonus, price_estimate, status, created_at
  from public.jobs
  where status in ('open','matched','collected') and payment = 'paid' and window_end >= current_date;
grant select on public.board_jobs to anon, authenticated;

-- Emails: tell click and collect buyers who to name as the collector
create or replace function public.email_job_events() returns trigger
language plpgsql security definer set search_path = public as $$
declare item text := public.esc_html(new.item); ref text := public.gtw_ref(new.id);
        route text := public.esc_html(new.from_town || ' to ' || new.to_town);
        t public.trips; drv text;
begin
  if tg_op = 'INSERT' then
    perform public.send_email(new.user_id, 'Pay to make your job live (' || ref || ')',
      public.email_html('Your ' || item || ' is posted',
        '<p>' || route || ', by ' || to_char(new.window_end, 'Dy FMDD Mon') || '.</p><p>It goes on the board as soon as we see your payment of <b>$' || round(coalesce(new.price_estimate, 0)) || '</b> with the reference <b>' || ref || '</b>. The bank details are in the app under My account.</p><p>We hold your money until it''s delivered. If no driver takes it in time, you get a full refund.</p>',
        'See it in My account', '#account'));
    return new;
  end if;

  select * into t from public.trips where id = new.matched_trip;
  drv := public.esc_html(split_part(coalesce(t.driver_name, 'Your driver'), ' ', 1));

  if new.payment = 'paid' and old.payment is distinct from 'paid' and new.status = 'open' then
    perform public.send_email(new.user_id, 'Your job is live (' || ref || ')',
      public.email_html('Payment received: your ' || item || ' is live',
        '<p>Drivers heading ' || route || ' can now see it and take it. We''ll email you as soon as someone does.</p>', 'See it in My account', '#account'));
  end if;

  if new.status = 'matched' and old.status = 'open' then
    perform public.send_email(new.user_id, 'A driver is taking your ' || new.item,
      public.email_html(drv || ' is taking your ' || item,
        '<p>They''re heading ' || public.esc_html(t.from_town || ' to ' || t.to_town) || ' on ' || to_char(t.trip_date, 'Dy FMDD Mon') || coalesce(', leaving about ' || to_char(t.depart_time, 'FMHH12:MI am'), '') || '. They''ll text before pickup to arrange a time.</p>'
        || case when new.kind = 'pickup' then '<p>If you haven''t already, let the seller know a Going That Way driver is coming.</p>'
                when new.kind = 'collect' then '<p>They''ll collect order <b>' || public.esc_html(new.order_ref) || '</b> from ' || public.esc_html(new.store_name) || '. If the store needs you to name who''s collecting, add <b>' || public.esc_html(t.driver_name) || '</b>.</p>' else '' end
        || case when new.check_first then '<p>You asked for it to be checked first, so they''ll send you photos from the seller''s before loading it. Keep your phone handy on the day.</p>' else '' end,
        'See their details', '#account'));
  end if;

  if new.check_status = 'waiting' and old.check_status is distinct from 'waiting' then
    perform public.send_email(new.user_id, 'Photos of your ' || new.item || ': yes or no?',
      public.email_html(drv || ' is at the seller''s with your ' || item,
        '<p>They''ve sent photos so you can check it before it''s loaded.' || coalesce(' Their note: "' || public.esc_html(new.check_note) || '"', '') || '</p><p>Please have a look and tap <b>Yes, collect it</b> or <b>No, leave it</b>. They''re waiting.</p>',
        'See the photos', '#account'));
  end if;

  if new.check_status in ('approved', 'declined') and old.check_status = 'waiting' and t.user_id is not null then
    perform public.send_email(t.user_id, case when new.check_status = 'approved' then 'The buyer said yes: load it up' else 'The buyer said no: leave it with the seller' end,
      public.email_html(case when new.check_status = 'approved' then 'Yes: collect the ' || item else 'No: please leave the ' || item || ' with the seller' end,
        case when new.check_status = 'approved' then '<p>Take the pickup photo when it''s loaded.</p>' else '<p>Let the seller know politely. You''re still paid for this trip in the weekly payout.</p>' end,
        'Open the job', '#account'));
  end if;

  if new.status = 'collected' and old.status is distinct from 'collected' then
    perform public.send_email(new.user_id, 'Your ' || new.item || ' has been collected',
      public.email_html('Collected and on its way', '<p>' || drv || ' has picked up your ' || item || ' and is heading ' || route || '. There''s a photo in the app.</p>', 'See the photo', '#account'));
  end if;

  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    perform public.send_email(new.user_id, 'Delivered: your ' || new.item,
      public.email_html('Your ' || item || ' has been delivered',
        '<p>There''s a drop-off photo in the app. Thanks for using Going That Way!</p><p>If anything''s wrong, use <b>Report a problem</b> on the job within 30 days.</p>', 'See the photo', '#account'));
  end if;

  if new.status = 'declined' and old.status is distinct from 'declined' then
    perform public.send_email(new.user_id, 'Your ' || new.item || ' wasn''t collected',
      public.email_html('It''s been left with the seller', '<p>You said no after the check photos, so the driver hasn''t collected it. We''ll refund everything except the driver''s trip, usually within 2 working days.</p>', null));
  end if;
  return new;
end $$;
