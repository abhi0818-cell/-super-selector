-- migration_v51: auto-resync shared squads' picks via trigger (single source
-- of truth for user_match_xi / user_booster_activations / user_transfers)
-- Run in Supabase SQL editor.
--
-- Context: Phase 1 of the private-leagues fix (see
-- docs/PRIVATE_LEAGUES_DESIGN.md §3/§6) fixed booster + transfer propagation
-- to shared squads, but only at the two places that remembered to call it:
-- db.js's propagateXIToSharedSquads (the everyday client-side path, run by
-- slLockForMatch) and the equivalent block in the lock-matches Edge Function
-- (the cron backstop). That's exactly the failure shape that caused the bug
-- in the first place — a third code path (a future admin correction tool, a
-- new cron, a one-off SQL fix) that writes to a primary squad's XI/booster/
-- transfers without also remembering to call the helper would silently
-- reintroduce the same class of gap.
--
-- Investigated whether the same risk applies to user_match_xi_scores (the
-- derived per-player points) before writing this migration: it doesn't, in
-- practice — scrape-scorecard's scoreXIForMatch, poll-cricapi's equivalent,
-- and admin.js's computeAndSaveSLScoresForMatch all already loop over every
-- squad's OWN user_match_xi row (shared squads included) and independently
-- recompute + upsert that squad's own score row every time they run; they
-- never copy a primary's score, they derive it fresh. So the real single
-- point of truth worth protecting structurally is the PICKS, not the scores
-- — this migration covers user_match_xi, user_booster_activations, and
-- user_transfers only.
--
-- Design: one shared helper, resync_shared_squad_match(primary_squad_id,
-- match_id), that wipes and recopies all three tables for every squad
-- mirroring that primary, scoped to that one match — the same delete-then-
-- insert idempotent pattern already used by propagateXIToSharedSquads,
-- lock-matches's propagation block, and migration_v50's backfill function.
-- Three AFTER triggers (one per source table, sharing one trigger function)
-- call this helper whenever a row for a squad changes, but only fan out when
-- that squad is itself a PRIMARY (primary_squad_id IS NULL) — a write to a
-- shared squad's own row (including the ones this migration's own resync
-- writes) is a no-op for fan-out purposes. That guard is also what stops
-- recursion: the resync writes land on shared squads, whose own AFTER
-- triggers immediately hit the guard and stop, one hop deep, every time.
--
-- This fires on every user_match_xi insert, including pre-lock draft saves
-- (saveMatchXI deletes+reinserts on every save, not just at lock) — so a
-- shared squad's picks now track the primary's current draft live, not just
-- what existed as of lock. That's a behavior change from "propagate at lock
-- only," but not a harmful one: a shared squad is explicitly "just a copy of
-- the same user's own picks in another folder" (their words), nothing reads
-- a shared squad's pre-lock state as if it were a separate decision, and
-- keeping it live removes any window where the mirror could plausibly drift.
--
-- This does NOT replace propagateXIToSharedSquads / lock-matches's
-- propagation block / migration_v50's backfill — those still run, and are
-- now fully redundant with this trigger (which is fine; both are idempotent
-- delete-then-insert). Left in place rather than removed: removing them is a
-- separate, lower-value cleanup, and this trigger is meant as the new safety
-- net underneath them, not a required replacement.
--
-- SECURITY DEFINER (same reasoning as v47/v49/v50): needs to write across
-- squads without depending on the caller's own RLS grants for every table
-- touched, and needs to run automatically regardless of which code path (or
-- role) performed the original write.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The resync helper — wipes and recopies one (primary_squad, match) slice
--    of all three picks tables into every squad that mirrors that primary.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION resync_shared_squad_match(
  p_primary_squad_id UUID,
  p_match_id          UUID
) RETURNS VOID AS $$
DECLARE
  v_shared_id UUID;
BEGIN
  IF p_primary_squad_id IS NULL OR p_match_id IS NULL THEN
    RETURN;
  END IF;

  FOR v_shared_id IN
    SELECT id FROM user_squads WHERE primary_squad_id = p_primary_squad_id
  LOOP
    -- 1. XI
    DELETE FROM user_match_xi WHERE squad_id = v_shared_id AND match_id = p_match_id;
    INSERT INTO user_match_xi (squad_id, match_id, player_id, is_captain, is_vc, role)
    SELECT v_shared_id, match_id, player_id, is_captain, is_vc, role
    FROM user_match_xi
    WHERE squad_id = p_primary_squad_id AND match_id = p_match_id;

    -- 2. Booster activation(s), if any
    DELETE FROM user_booster_activations WHERE squad_id = v_shared_id AND match_id = p_match_id;
    INSERT INTO user_booster_activations (squad_id, match_id, booster, snapshot)
    SELECT v_shared_id, match_id, booster, snapshot
    FROM user_booster_activations
    WHERE squad_id = p_primary_squad_id AND match_id = p_match_id;

    -- 3. Transfer log, if any
    DELETE FROM user_transfers WHERE squad_id = v_shared_id AND match_id = p_match_id;
    INSERT INTO user_transfers (squad_id, match_id, player_out_id, player_in_id, is_free, points_deducted)
    SELECT v_shared_id, match_id, player_out_id, player_in_id, is_free, points_deducted
    FROM user_transfers
    WHERE squad_id = p_primary_squad_id AND match_id = p_match_id;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. One trigger function, reused on all three tables — they all share the
--    same (squad_id, match_id) shape, so there's nothing table-specific here.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_resync_shared_squads()
RETURNS TRIGGER AS $$
DECLARE
  v_squad_id  UUID := COALESCE(NEW.squad_id, OLD.squad_id);
  v_match_id  UUID := COALESCE(NEW.match_id, OLD.match_id);
  v_is_shared BOOLEAN;
BEGIN
  SELECT (primary_squad_id IS NOT NULL) INTO v_is_shared
  FROM user_squads WHERE id = v_squad_id;

  -- Only fan out from a PRIMARY squad's own row changes. If v_squad_id is a
  -- shared squad (v_is_shared = true) — including when THIS function's own
  -- resync just wrote to it — do nothing. If the squad row can't be found
  -- (e.g. mid-cascade-delete), v_is_shared is null, IS NOT TRUE still lets it
  -- through, but resync_shared_squad_match then finds zero shared squads to
  -- update, which is a harmless no-op.
  IF v_is_shared IS NOT TRUE THEN
    PERFORM resync_shared_squad_match(v_squad_id, v_match_id);
  END IF;

  RETURN NULL; -- AFTER trigger; return value is ignored either way
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Wire the trigger function to all three tables.
-- ─────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_resync_shared_on_xi ON user_match_xi;
CREATE TRIGGER trg_resync_shared_on_xi
  AFTER INSERT OR UPDATE OR DELETE ON user_match_xi
  FOR EACH ROW
  EXECUTE FUNCTION trg_resync_shared_squads();

DROP TRIGGER IF EXISTS trg_resync_shared_on_booster ON user_booster_activations;
CREATE TRIGGER trg_resync_shared_on_booster
  AFTER INSERT OR UPDATE OR DELETE ON user_booster_activations
  FOR EACH ROW
  EXECUTE FUNCTION trg_resync_shared_squads();

DROP TRIGGER IF EXISTS trg_resync_shared_on_transfer ON user_transfers;
CREATE TRIGGER trg_resync_shared_on_transfer
  AFTER INSERT OR UPDATE OR DELETE ON user_transfers
  FOR EACH ROW
  EXECUTE FUNCTION trg_resync_shared_squads();

-- Note on redundant work: saveMatchXI deletes-then-reinserts all 11 XI rows
-- on every draft save, so one save fires this trigger 11 times (once per
-- inserted row), each doing a full idempotent resync of that (squad, match)
-- slice rather than one. At the member counts private leagues actually run
-- at (single-digit, admin-capped) this is not a real cost; if it ever
-- becomes one, the fix is switching FOR EACH ROW to a statement-level
-- trigger with transition tables (REFERENCING NEW TABLE/OLD TABLE) to
-- collapse it to one resync per distinct (squad, match) per statement —
-- not done here to keep this migration simple and match the FOR EACH ROW
-- style used throughout (v47/v48/v49).
