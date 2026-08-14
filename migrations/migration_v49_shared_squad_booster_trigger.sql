-- migration_v49: let enforce_booster_max_uses resolve availability through
-- a shared squad's PRIMARY squad, not its own (always-null) contest config
-- Run in Supabase SQL editor.
--
-- Context: Phase 1 of the private-leagues fix (see
-- docs/PRIVATE_LEAGUES_DESIGN.md §3) propagates a primary squad's booster
-- activation to every shared squad that mirrors it — both in db.js's
-- propagateXIToSharedSquads (the everyday path, run by slLockForMatch
-- whenever a user has the SL tab open past a match's lock time) and in the
-- equivalent block added to the lock-matches Edge Function (the cron
-- backstop for when no client is open). Without this propagation, a shared
-- squad's private-league score came out unboosted for every match the
-- primary squad boosted, since boosters are looked up strictly by squad_id
-- with no fallback to primary_squad_id.
--
-- That propagated INSERT into user_booster_activations goes through the
-- same enforce_booster_max_uses trigger (migration_v47) as every other
-- activation. v47 resolves booster availability from the ACTIVATING
-- squad's own contest — correct for an independently-picking squad, but
-- wrong for a shared squad: a user-created private league's
-- available_boosters is always null (see migration_v11 / db.js's
-- createPrivateLeague — the user-facing create form never sets it), so v47
-- as written rejects every propagated booster insert with "not available
-- in this contest", even though the SL contest the primary squad actually
-- played under clearly offered it. Confirmed this would otherwise block
-- Phase 1's propagation fix outright, not just leave it incomplete.
--
-- Fix: when the activating squad is a shared squad
-- (user_squads.primary_squad_id IS NOT NULL), resolve available_boosters
-- through the PRIMARY squad's contest instead of the shared squad's own.
-- The per-squad usage count (how many times THIS squad has used this
-- booster) is unchanged — still scoped to NEW.squad_id, same as v47. A
-- shared squad's count naturally mirrors the primary's anyway, since
-- propagation copies one activation row per match, 1:1.

CREATE OR REPLACE FUNCTION enforce_booster_max_uses()
RETURNS TRIGGER AS $$
DECLARE
  v_contest_id       UUID;
  v_primary_squad_id UUID;
  v_boosters         JSONB;
  v_total_uses       INTEGER;
  v_used_count       INTEGER;
BEGIN
  -- Resolve the activating squad's own contest + whether it's a shared
  -- (mirror) squad.
  SELECT us.contest_id, us.primary_squad_id
    INTO v_contest_id, v_primary_squad_id
  FROM user_squads us
  WHERE us.id = NEW.squad_id;

  IF v_contest_id IS NULL THEN
    RAISE EXCEPTION 'Booster activation refers to an unknown squad/contest.';
  END IF;

  IF v_primary_squad_id IS NOT NULL THEN
    -- Shared squad: booster availability mirrors the PRIMARY squad's
    -- contest (the public SL contest it's really playing under), not this
    -- squad's own private-league contest, which is always boosterless by
    -- design for a user-created league.
    SELECT c.available_boosters
      INTO v_boosters
    FROM user_squads us2
    JOIN contests c ON c.id = us2.contest_id
    WHERE us2.id = v_primary_squad_id;
  ELSE
    SELECT c.available_boosters
      INTO v_boosters
    FROM contests c
    WHERE c.id = v_contest_id;
  END IF;

  IF v_boosters IS NULL OR NOT (v_boosters ? NEW.booster) THEN
    RAISE EXCEPTION 'Booster "%" is not available in this contest.', NEW.booster;
  END IF;

  v_total_uses := COALESCE((v_boosters ->> NEW.booster)::INTEGER, 0);

  IF v_total_uses < 1 THEN
    RAISE EXCEPTION 'Booster "%" is not offered in this contest.', NEW.booster;
  END IF;

  -- Usage count stays scoped to the activating squad itself (NEW.squad_id).
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

-- The trigger itself (name, table, timing) is unchanged from migration_v47
-- — CREATE OR REPLACE FUNCTION above is sufficient to pick up the new
-- logic, no DROP/CREATE TRIGGER needed. Shown here only for reference:
--   CREATE TRIGGER trg_enforce_booster_max_uses
--     BEFORE INSERT OR UPDATE OF booster ON user_booster_activations
--     FOR EACH ROW EXECUTE FUNCTION enforce_booster_max_uses();
