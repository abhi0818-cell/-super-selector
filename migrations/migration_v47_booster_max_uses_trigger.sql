-- migration_v47: server-side enforcement of per-booster max uses
-- Run in Supabase SQL editor.
--
-- Context: contests.available_boosters is a JSONB map of
--   booster_key -> uses_per_squad_member  (e.g. {"triple_captain": 2})
-- Today the "you've used all N boosts" check only happens in application
-- code (db.js activateBooster / boosterStore.ts dbActivate) via a
-- SELECT count(*) before the INSERT. Nothing in the database stops a
-- second client, a race between two rapid taps, or a direct call to the
-- Supabase REST API from inserting more user_booster_activations rows
-- than available_boosters allows — RLS only checks squad ownership.
--
-- This migration adds a BEFORE INSERT trigger that re-derives the same
-- limit from contests.available_boosters (via user_squads.contest_id)
-- and rejects the insert if the squad has already used that booster
-- available_boosters[booster] times. This mirrors the app-level check
-- exactly, so normal usage is unaffected; it only closes the gap where
-- the app-level check is bypassed or raced.

CREATE OR REPLACE FUNCTION enforce_booster_max_uses()
RETURNS TRIGGER AS $$
DECLARE
  v_contest_id   UUID;
  v_boosters     JSONB;
  v_total_uses   INTEGER;
  v_used_count   INTEGER;
BEGIN
  -- Resolve the contest this squad belongs to, and its booster config.
  SELECT us.contest_id, c.available_boosters
    INTO v_contest_id, v_boosters
  FROM user_squads us
  JOIN contests c ON c.id = us.contest_id
  WHERE us.id = NEW.squad_id;

  IF v_contest_id IS NULL THEN
    RAISE EXCEPTION 'Booster activation refers to an unknown squad/contest.';
  END IF;

  IF v_boosters IS NULL OR NOT (v_boosters ? NEW.booster) THEN
    RAISE EXCEPTION 'Booster "%" is not available in this contest.', NEW.booster;
  END IF;

  v_total_uses := COALESCE((v_boosters ->> NEW.booster)::INTEGER, 0);

  IF v_total_uses < 1 THEN
    RAISE EXCEPTION 'Booster "%" is not offered in this contest.', NEW.booster;
  END IF;

  -- Count activations already recorded for this squad + booster,
  -- excluding the row being inserted (relevant for UPDATE, not INSERT,
  -- but kept for safety since the trigger also fires on UPDATE OF booster).
  SELECT count(*) INTO v_used_count
  FROM user_booster_activations uba
  WHERE uba.squad_id = NEW.squad_id
    AND uba.booster  = NEW.booster
    AND uba.id      IS DISTINCT FROM NEW.id;

  IF v_used_count >= v_total_uses THEN
    RAISE EXCEPTION 'You have already used all % % boost%.',
      v_total_uses, replace(NEW.booster, '_', ' '),
      CASE WHEN v_total_uses > 1 THEN 's' ELSE '' END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_enforce_booster_max_uses ON user_booster_activations;

CREATE TRIGGER trg_enforce_booster_max_uses
  BEFORE INSERT OR UPDATE OF booster ON user_booster_activations
  FOR EACH ROW
  EXECUTE FUNCTION enforce_booster_max_uses();

-- Note: SECURITY DEFINER is required because RLS on `contests` (if any)
-- is scoped to admins/readers, not necessarily the acting user; the
-- function only reads config to compute a limit, it never writes.
