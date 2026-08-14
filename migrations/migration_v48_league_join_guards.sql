-- migration_v48: atomic member-cap enforcement + duplicate private-league names
-- Run in Supabase SQL editor.
--
-- Context #1 — member cap race: joinLeagueByCode (db.js) checks the member
-- cap by reading the current count, then inserting — a classic
-- read-then-write race. Two people joining a nearly-full league (now capped
-- at 3 by default for user-created leagues — see the Leagues tab's "Create
-- a private league" form) at the same instant could both pass the check and
-- both get in. A hard cap of exactly 3 makes this far more likely to matter
-- in practice than it was with the old default of 5/unlimited: three
-- friends tapping the same invite link around the same time is the normal
-- case for a 3-cap league, not an edge case.
--
-- Fix: a BEFORE INSERT trigger on user_squads that locks the contest row
-- (SELECT ... FOR UPDATE) before re-counting. Concurrent joins targeting
-- the same contest now serialize against each other — the second
-- transaction's count only runs after the first has committed (or rolled
-- back), so it always sees an accurate count. This mirrors migration_v47's
-- booster-max-uses trigger in spirit (a DB backstop behind an app-level
-- check that stays for the fast-path error message), but adds the explicit
-- row lock v47 didn't need — a booster-overuse race just means an extra
-- activation row to clean up, not someone occupying a seat that shouldn't
-- exist.
--
-- Context #2 — duplicate names: flagged as a known gap in index.html's own
-- comment ("No duplicate-name guard — the same league name can be created
-- more than once."). Adds a partial unique index so two active private
-- leagues in the same tournament can't share a name.

CREATE OR REPLACE FUNCTION enforce_league_member_cap()
RETURNS TRIGGER AS $$
DECLARE
  v_cap   INTEGER;
  v_count INTEGER;
BEGIN
  -- Lock the contest row first so a concurrent join targeting the same
  -- contest has to wait for this transaction to finish before it can even
  -- read the cap/count — this row lock is what makes the check atomic
  -- instead of just moving the same race one query later.
  SELECT max_members INTO v_cap FROM contests WHERE id = NEW.contest_id FOR UPDATE;

  IF v_cap IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM user_squads WHERE contest_id = NEW.contest_id;
    IF v_count >= v_cap THEN
      -- Same wording as the existing client-side fast-path check in
      -- db.js's joinLeagueByCode, so no special-casing is needed there —
      -- whichever check catches it, the user sees the same message.
      RAISE EXCEPTION 'This league is full.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_enforce_league_member_cap ON user_squads;

CREATE TRIGGER trg_enforce_league_member_cap
  BEFORE INSERT ON user_squads
  FOR EACH ROW
  EXECUTE FUNCTION enforce_league_member_cap();

-- SECURITY DEFINER for the same reason as migration_v47: RLS on `contests`
-- is scoped to admins/readers, not necessarily the joining user, and this
-- function only reads config to compute a limit — it never writes.

-- ─────────────────────────────────────────────────────────────────────────
-- Duplicate private-league name guard
-- ─────────────────────────────────────────────────────────────────────────
-- Scoped to active private leagues only (is_private = true AND
-- is_active = true) so this never collides with public/daily contest
-- names, and a retired/deactivated league's name frees up again.
-- Case-insensitive via lower(name), so "The Office League" and
-- "the office league" still collide.
--
-- NOTE: if this fails on creation because duplicate active private-league
-- names already exist, rename or deactivate the conflicting rows first,
-- then re-run — e.g.:
--   SELECT tournament_id, lower(name), count(*), array_agg(id)
--   FROM contests WHERE is_private = true AND is_active = true
--   GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS contests_private_league_name_key
  ON contests (tournament_id, lower(name))
  WHERE is_private = true AND is_active = true;
