-- migration_v52: admin "delete private league" RPC
-- Run in Supabase SQL editor.
--
-- Context: while cleaning up test leagues created before the private-league
-- fixes (Phases 0-3) landed, there was no way to remove one — contests has
-- an admin DELETE policy (migration_v18) but user_squads.contest_id is
-- `ON DELETE RESTRICT` (migration_v2), so a plain `DELETE FROM contests`
-- fails outright the moment any squad has joined the league. And even
-- without that, admin.js's client runs as a regular authenticated user —
-- user_squads RLS only lets someone delete their OWN squad rows, so an admin
-- couldn't clear out OTHER members' squads from that league even if the FK
-- didn't block them first.
--
-- Fix: a SECURITY DEFINER RPC that deletes every member squad in the league
-- first (which cascades away each squad's user_match_xi, user_match_xi_scores,
-- user_booster_activations, and user_transfers automatically — all four are
-- `ON DELETE CASCADE` off user_squads(id), see migration_v2/v12), then
-- deletes the contest row itself now that nothing references it. Confirmed
-- via a full grep of every migration that user_squads.contest_id is the only
-- `ON DELETE RESTRICT` foreign key pointing at contests anywhere in the
-- schema — nothing else can block this.
--
-- Guarded to only ever operate on `is_private = true` rows — this function
-- will refuse to touch a public (Season Long / Daily) contest even if called
-- with the wrong id, since that would delete every user's SL squad/history
-- for the whole tournament, not just one private league's.
--
-- Hard delete, not a soft/is_active toggle — matches what was actually asked
-- for ("delete it so I can start fresh"), and this app already has a
-- soft-delete-equivalent for the "reuse this name" case: migration_v48's
-- unique index is scoped to `is_active = true`, so if a future version of
-- this wants "hide but keep for audit" instead, that's a one-line change
-- (UPDATE is_active = false) rather than this DELETE — not built here since
-- it isn't what was asked for.
--
-- SECURITY DEFINER (same reasoning as v47/v49/v50/v51): needs to delete
-- OTHER users' squad rows, which their own RLS wouldn't otherwise allow.

CREATE OR REPLACE FUNCTION delete_private_league(p_contest_id UUID)
RETURNS VOID AS $$
DECLARE
  v_is_private BOOLEAN;
BEGIN
  IF auth.role() <> 'authenticated' THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT is_private INTO v_is_private FROM contests WHERE id = p_contest_id;

  IF v_is_private IS NULL THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  IF NOT v_is_private THEN
    RAISE EXCEPTION 'Refusing to delete a public contest through this function — only private leagues can be deleted here.';
  END IF;

  -- Cascades away user_match_xi / user_match_xi_scores /
  -- user_booster_activations / user_transfers for every member squad.
  DELETE FROM user_squads WHERE contest_id = p_contest_id;

  -- Now safe — user_squads.contest_id was the only ON DELETE RESTRICT FK
  -- pointing at contests, and it's now empty for this contest.
  DELETE FROM contests WHERE id = p_contest_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
