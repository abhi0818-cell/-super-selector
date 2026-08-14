-- migration_v50: backfill_shared_squad_history — M1 history for late joiners
-- Run in Supabase SQL editor.
--
-- REQUIRES migration_v49 to already be applied. The booster copy in step 2
-- below inserts into user_booster_activations for the new (shared) squad,
-- which goes through the enforce_booster_max_uses trigger — only v49's
-- version of that trigger resolves availability through the PRIMARY
-- squad's contest for a shared squad; v47's original version would reject
-- this insert outright ("not available in this contest"), the same failure
-- mode Phase 1 hit for the forward-propagation path.
--
-- Context: Phase 2 of the private-leagues fix (see
-- docs/PRIVATE_LEAGUES_DESIGN.md §4c/§6). A user joining a standard
-- (shared-XI) private league after some matches have already locked gets a
-- shared squad whose primary_squad_id is set going forward, but nothing
-- retroactively fills in the matches that already happened — Phase 1 fixed
-- the ongoing (forward) propagation, this migration adds the one-time
-- catch-up for matches that locked before the join.
--
-- Traced the actual SL/private-league scoring path before writing this
-- (migration_v2's v_match_xi_with_scores view + scrape-scorecard's
-- scoreXIForMatch): per-player scores for Season Long / private squads live
-- in user_match_xi_scores, keyed by (squad_id, match_id, player_id), joined
-- directly off user_match_xi — NOT via user_teams/user_team_players (that
-- pair is the Daily-contest-only path, scoped to squad_id IS NULL rows).
-- So this function does not need to touch user_teams/user_team_players —
-- the earlier draft of this plan assumed it would; it doesn't, and forward
-- propagation (Phase 1) never touched them either.
--
-- For each match the primary squad already has a locked XI for, this
-- copies four things to the new shared squad, scoped to that one match:
--   1. user_match_xi            — the actual picks
--   2. user_booster_activations — if a booster was used
--   3. user_transfers           — if a transfer penalty was incurred
--   4. user_match_xi_scores     — the ALREADY-COMPUTED points
--
-- #4 matters because historical (already-completed) matches aren't
-- re-scanned by the normal scoring cron (scrape-scorecard / poll-cricapi) —
-- copying the primary squad's precomputed score directly is correct here
-- (not a shortcut/approximation), since the shared squad's XI+booster for
-- that match are byte-for-byte identical to what just got copied in #1/#2,
-- so the primary's already-computed score IS the correct score. Live/
-- in-progress matches don't strictly need #4 — the normal scoring cron will
-- pick up the newly-copied XI on its own next pass — but copying whatever
-- score already exists (even partial/live) is harmless and keeps the
-- squad's total from looking wrong in the gap before that next pass runs.
--
-- Runs as ONE Postgres function call, which is one transaction by default —
-- if anything fails partway through the loop, the whole backfill rolls
-- back rather than leaving a half-populated history. Called blocking from
-- db.js's joinLeagueByCode, right after the shared squad row is inserted
-- and before the join call returns success to the UI.
--
-- SECURITY DEFINER (same reasoning as migrations v47/v49): needs to write
-- across squads/contests without depending on the caller's own RLS grants
-- for every table touched. Because of that elevated privilege, the function
-- self-enforces authorization instead of relying on RLS: it only proceeds
-- if p_new_squad_id is owned by the calling user AND its primary_squad_id
-- already matches p_primary_squad_id (i.e. joinLeagueByCode must have
-- already set up the shared-squad link before calling this).

CREATE OR REPLACE FUNCTION backfill_shared_squad_history(
  p_new_squad_id     UUID,
  p_primary_squad_id UUID
) RETURNS INTEGER AS $$
DECLARE
  v_match_id UUID;
  v_count    INTEGER := 0;
BEGIN
  IF p_new_squad_id IS NULL OR p_primary_squad_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Authorization: only the squad's own owner may trigger this, and only
  -- for a squad that's actually already linked to this primary.
  IF NOT EXISTS (
    SELECT 1 FROM user_squads
    WHERE id                = p_new_squad_id
      AND user_id            = auth.uid()
      AND primary_squad_id   = p_primary_squad_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to backfill this squad.';
  END IF;

  FOR v_match_id IN
    SELECT DISTINCT match_id FROM user_match_xi WHERE squad_id = p_primary_squad_id
  LOOP
    -- 1. XI
    DELETE FROM user_match_xi WHERE squad_id = p_new_squad_id AND match_id = v_match_id;
    INSERT INTO user_match_xi (squad_id, match_id, player_id, is_captain, is_vc, role)
    SELECT p_new_squad_id, match_id, player_id, is_captain, is_vc, role
    FROM user_match_xi
    WHERE squad_id = p_primary_squad_id AND match_id = v_match_id;

    -- 2. Booster activation, if any
    DELETE FROM user_booster_activations WHERE squad_id = p_new_squad_id AND match_id = v_match_id;
    INSERT INTO user_booster_activations (squad_id, match_id, booster, snapshot)
    SELECT p_new_squad_id, match_id, booster, snapshot
    FROM user_booster_activations
    WHERE squad_id = p_primary_squad_id AND match_id = v_match_id;

    -- 3. Transfer log, if any
    DELETE FROM user_transfers WHERE squad_id = p_new_squad_id AND match_id = v_match_id;
    INSERT INTO user_transfers (squad_id, match_id, player_out_id, player_in_id, is_free, points_deducted)
    SELECT p_new_squad_id, match_id, player_out_id, player_in_id, is_free, points_deducted
    FROM user_transfers
    WHERE squad_id = p_primary_squad_id AND match_id = v_match_id;

    -- 4. Precomputed scores — copied directly, not recomputed; see header.
    DELETE FROM user_match_xi_scores WHERE squad_id = p_new_squad_id AND match_id = v_match_id;
    INSERT INTO user_match_xi_scores (squad_id, match_id, player_id, base_points, multiplier, total_points, computed_at)
    SELECT p_new_squad_id, match_id, player_id, base_points, multiplier, total_points, computed_at
    FROM user_match_xi_scores
    WHERE squad_id = p_primary_squad_id AND match_id = v_match_id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
