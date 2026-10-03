-- Going That Way: automatic emails to members at each step, sent through Resend.
-- Needs 010_phone_alerts.sql first (it switches on pg_net and creates app_settings).
-- Paste into Supabase SQL Editor -> New query -> Run. Safe to run more than once.
-- Then store your Resend API key with the one-line insert at the bottom (in its own query).
-- Emails come from hello@ (a real address that forwards to the admin), which spam filters trust more than noreply@.

-- Defaults you can change later with an update to app_settings
insert into public.app_settings (key, value) values
  ('email_from', 'Going That Way <hello@goingthatway.co.nz>'),
  ('email_reply_to', 'hello@goingthatway.co.nz'),
  ('site_url', 'https://goingthatway.co.nz')
on conflict (key) do nothing;

create or replace function public.setting(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select value from public.app_settings where key = p_key $$;
revoke execute on function public.setting(text) from public, anon, authenticated;

create or replace function public.esc_html(p text) returns text language sql immutable as $$
  select replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;') $$;

create or replace function public.user_email(p_user uuid) returns text
language sql stable security definer set search_path = public, auth as $$
  select coalesce((select email from auth.users where id = p_user), (select email from public.profiles where id = p_user)) $$;
revoke execute on function public.user_email(uuid) from public, anon, authenticated;

-- One simple, readable email layout
create or replace function public.email_html(p_heading text, p_body text, p_button text default null, p_path text default '')
returns text language plpgsql stable security definer set search_path = public as $$
declare site text := coalesce(public.setting('site_url'), 'https://goingthatway.co.nz');
begin
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1A231E">'
    || '<div style="background:#1F6B45;color:#fff;padding:16px 20px;border-bottom:4px solid #F3C623;font-size:20px;font-weight:bold">Going That Way</div>'
    || '<div style="padding:20px;font-size:15px;line-height:1.5"><h2 style="font-size:19px;margin:0 0 12px">' || p_heading || '</h2>' || p_body
    || case when p_button is not null then '<p style="margin:20px 0"><a href="' || site || '/' || p_path || '" style="background:#1F6B45;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:bold;display:inline-block">' || p_button || '</a></p>' else '' end
    || '<p style="color:#77827B;font-size:12.5px;margin-top:24px">You''re getting this because you have an account with Going That Way. Just reply to this email if you need us.</p></div></div>';
end $$;

-- Send one email. Never blocks or breaks the action that triggered it.
create or replace function public.send_email(p_user uuid, p_subject text, p_html text)
returns void language plpgsql security definer set search_path = public as $$
declare v_key text := public.setting('resend_key'); v_to text := public.user_email(p_user);
begin
  if v_key is null or v_to is null or v_to = '' then return; end if;
  begin
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      body := jsonb_build_object('from', coalesce(public.setting('email_from'), 'Going That Way <hello@goingthatway.co.nz>'),
                                 'to', jsonb_build_array(v_to), 'subject', p_subject, 'html', p_html,
                                 -- a plain-text copy too: spam filters trust emails that have one
                                 'text', trim(regexp_replace(regexp_replace(regexp_replace(replace(replace(replace(p_html, '</p>', E'\n\n'), '</h2>', E'\n\n'), '</div>', E'\n\n'), '<a href="([^"]*)"[^>]*>([^<]*)</a>', '\2: \1', 'g'), '<[^>]+>', '', 'g'), E'\n{3,}', E'\n\n', 'g')),
                                 'reply_to', coalesce(public.setting('email_reply_to'), 'hello@goingthatway.co.nz')),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key));
  exception when others then null;
  end;
end $$;
revoke execute on function public.send_email(uuid, text, text) from public, anon, authenticated;

-- ---------- Job emails ----------
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
        || case when new.kind = 'pickup' then '<p>If you haven''t already, let the seller know a Going That Way driver is coming.</p>' else '' end
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
drop trigger if exists jobs_email_insert on public.jobs;
create trigger jobs_email_insert after insert on public.jobs for each row execute function public.email_job_events();
drop trigger if exists jobs_email_update on public.jobs;
create trigger jobs_email_update after update on public.jobs for each row execute function public.email_job_events();

-- ---------- Account emails ----------
create or replace function public.email_account_events() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := public.esc_html(split_part(coalesce(new.name, ''), ' ', 1));
begin
  if new.id_status = 'verified' and old.id_status is distinct from 'verified' and coalesce(new.driver_status, '') <> 'verified' then
    perform public.send_email(new.id, 'You''re verified', public.email_html('Thanks ' || who || ', you''re verified',
      '<p>Your ID has been checked and your photos deleted. You can now send anything on Going That Way.</p>', 'Post a job', ''));
  end if;
  if new.id_status = 'rejected' and old.id_status is distinct from 'rejected' then
    perform public.send_email(new.id, 'We couldn''t verify your ID', public.email_html('We couldn''t verify your ID',
      '<p>' || coalesce('Reason: ' || public.esc_html(new.review_note) || '. ', '') || 'Your photos have been deleted. Please try again with a clear photo of your ID and a selfie.</p>', 'Try again', '#account'));
  end if;
  if new.driver_status = 'verified' and old.driver_status is distinct from 'verified' then
    perform public.send_email(new.id, 'You''re approved to drive', public.email_html('You''re approved to drive, ' || who,
      '<p>Your licence, WoF and rego have been checked. Post a trip whenever you''re heading somewhere between Christchurch and Dunedin, and take the paid jobs on your route.</p>', 'Post a trip', ''));
  end if;
  if new.driver_status = 'rejected' and old.driver_status is distinct from 'rejected' then
    perform public.send_email(new.id, 'We couldn''t approve you to drive yet', public.email_html('We couldn''t approve you to drive yet',
      '<p>' || coalesce('Reason: ' || public.esc_html(new.review_note) || '. ', '') || 'You can apply again from My account.</p>', 'My account', '#account'));
  end if;
  return new;
end $$;
drop trigger if exists profiles_email_events on public.profiles;
create trigger profiles_email_events after update on public.profiles for each row execute function public.email_account_events();

-- ---------- Problem report sorted ----------
create or replace function public.email_report_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'resolved' and old.status is distinct from 'resolved' then
    perform public.send_email(new.reporter, 'We''ve sorted your report (' || public.gtw_ref(new.job_id) || ')',
      public.email_html('Your report has been sorted', coalesce('<p>' || public.esc_html(new.admin_note) || '</p>', '<p>We''ve looked into it and it''s been sorted.</p>') || '<p>If it''s not right, just reply to this email.</p>', 'See the job', '#account'));
  end if;
  return new;
end $$;
drop trigger if exists job_reports_email_events on public.job_reports;
create trigger job_reports_email_events after update on public.job_reports for each row execute function public.email_report_events();

-- ---------- Your Resend API key ----------
-- Run this on its own, with your key in place of re_xxx (it never goes in the public code):
-- insert into public.app_settings (key, value) values ('resend_key', 're_xxx') on conflict (key) do update set value = excluded.value;

-- Earlier installs sent from noreply@: switch to hello@
update public.app_settings set value = 'Going That Way <hello@goingthatway.co.nz>' where key = 'email_from' and value like '%noreply@%';
