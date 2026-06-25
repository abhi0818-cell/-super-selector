-- ============================================================
-- fix_profile_names.sql
-- These 3 rows got the email/display_name fallback applied (from the
-- backfill query) instead of a real name — fill in the placeholders
-- below with the correct values, then run in Supabase SQL Editor.
-- display_name is recomputed from first_name + last_name to stay
-- consistent with what the app shows.
-- ============================================================

-- anuj.sfc@gmail.com
update profiles
   set first_name   = '<First name>',
       last_name    = '<Last name>',
       team_name    = '<Team name>',
       display_name = '<First name>' || ' ' || '<Last name>'
 where id = 'd7cf42cd-659f-4973-8733-f9ba9c258aa8';

-- abhi0818docs@gmail.com
update profiles
   set first_name   = '<First name>',
       last_name    = '<Last name>',
       team_name    = '<Team name>',
       display_name = '<First name>' || ' ' || '<Last name>'
 where id = '4da78693-5f11-4070-bb9e-b1f10f6b9e0a';

-- kumarharshit03@gmail.com — team_name "ShooterXI" already looks like a
-- real chosen name, so only first_name/last_name likely need fixing
-- (left team_name as-is below; change it too if it's wrong).
update profiles
   set first_name   = '<First name>',
       last_name    = '<Last name>',
       display_name = '<First name>' || ' ' || '<Last name>'
 where id = '84b34d83-546b-496e-b83d-e40fd6790fb3';
