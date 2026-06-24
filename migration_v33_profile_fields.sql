-- ============================================================
-- migration_v33_profile_fields.sql
-- Splits the single "display name" on profiles into first_name +
-- last_name, and adds a team_name (the user's persistent leaderboard
-- identity, set once at signup and shown read-only afterwards).
-- Run once in Supabase SQL Editor.
-- ============================================================

-- ── 1. New columns ───────────────────────────────────────────
alter table profiles add column if not exists first_name text;
alter table profiles add column if not exists last_name  text;
alter table profiles add column if not exists team_name  text;

-- display_name is kept (not dropped) — it's still used as a fallback
-- everywhere a profile lookup happens, and dropping it would break any
-- code we miss. New code should prefer first_name/last_name/team_name.

-- ── 2. Backfill existing users ───────────────────────────────
-- team_name: existing users have been showing display_name on
-- leaderboards up to now, so seed team_name from it 1:1 — no visible
-- regression, and it's editable... actually it's a one-time field, so
-- this backfilled value becomes their permanent team name unless they
-- haven't set one yet (NULL), in which case the app will ask once.
update profiles
   set team_name = display_name
 where team_name is null
   and display_name is not null;

-- first_name / last_name: best-effort split of display_name on the
-- first space. Single-word names (most OAuth "full_name" values, or
-- emails-as-names) land entirely in first_name with last_name NULL —
-- fine, since the profile-edit screen lets a user fill in last_name
-- later, but team_name stays locked.
update profiles
   set first_name = split_part(display_name, ' ', 1),
       last_name  = case
                      when position(' ' in display_name) > 0
                        then trim(substring(display_name from position(' ' in display_name) + 1))
                      else null
                    end
 where first_name is null
   and display_name is not null
   and display_name <> '';

-- Rows with no display_name at all (shouldn't exist, but just in case)
-- get nothing backfilled — the app will prompt them to complete their
-- profile on next sign-in.

-- ── Done ─────────────────────────────────────────────────────
-- No RLS changes needed — the existing "profiles: owner write" policy
-- (migration_v9) already covers UPDATE on the whole row, new columns
-- included. The existing "profiles: authenticated read" policy already
-- exposes these new columns to the leaderboard queries too.
