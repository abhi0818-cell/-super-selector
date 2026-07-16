-- Fix: Fedxpress's M32 Free Hit snapshot was recorded wrong, and the
-- consequence has already carried into the M33 draft.
--
--   squad_id = 5f3b82ad-3fb5-496e-9771-857d408936d9  (Fedxpress, MLC Season Long)
--   M31 match_id = fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0  (completed — the true baseline)
--   M32 match_id = 06297f58-3a64-4364-9548-46ccaf0f4a29  (completed — the Free Hit match)
--   M33 match_id = 05eea7b1-e196-468e-85ba-dc8290cb721f  (scheduled, locks 2026-07-17 01:30 UTC)
--
-- Root cause (now also fixed in code — supabase/functions/lock-matches/
-- index.ts): at M32's lock, the free_hit activation's `snapshot` column got
-- overwritten with the XI actually being locked for M32 (the free-hit team
-- itself) instead of the pre-free-hit baseline (M31's team). Every downstream
-- "what should the squad revert to" check (db.js getPreviousMatchXI, this
-- app's own client-side revert step, mobile's transferCap.ts) reads that
-- snapshot as ground truth, so it faithfully carried the M32 team forward —
-- including into squad_draft_xi, which is now saved with target_match_id =
-- M33 but still holding M32's players. Because target_match_id already
-- matches M33, tonight's lock would trust that draft outright and lock the
-- wrong team in again, bypassing every code-level fix.
--
-- This script corrects both the stored snapshot (for correctness/audit) and
-- the M33 draft (so tonight's lock uses the right team). It does NOT touch
-- M31 or M32's already-locked user_match_xi — those stay as they were
-- actually played.

begin;

-- 0. Safety check — confirm current (wrong) state before touching anything.
select 'draft before' as label, target_match_id, player_ids, captain_id, vc_id
from squad_draft_xi
where squad_id = '5f3b82ad-3fb5-496e-9771-857d408936d9';

select 'snapshot before' as label, snapshot
from user_booster_activations
where squad_id = '5f3b82ad-3fb5-496e-9771-857d408936d9'
  and match_id = '06297f58-3a64-4364-9548-46ccaf0f4a29'
  and booster = 'free_hit';

-- 1. Correct the free_hit activation's snapshot to the real pre-free-hit
--    baseline (M31's actually-locked XI: Matt Short C / Andre Russell VC).
update user_booster_activations
set snapshot = jsonb_build_object(
  'playerIds', array['p571','p540','p573','p551','p549','p574','p582','p552','p547','scr_1781916475717','p579'],
  'captainId', 'p571',
  'vcId',      'p540'
)
where squad_id = '5f3b82ad-3fb5-496e-9771-857d408936d9'
  and match_id = '06297f58-3a64-4364-9548-46ccaf0f4a29'
  and booster = 'free_hit';

-- 2. Correct the M33 draft — keep target_match_id as-is (it's already
--    correctly pointed at M33), just fix the content to M31's baseline so
--    tonight's lock locks in the right team.
update squad_draft_xi
set player_ids = array['p571','p540','p573','p551','p549','p574','p582','p552','p547','scr_1781916475717','p579'],
    captain_id = 'p571',
    vc_id      = 'p540',
    updated_at = now()
where squad_id = '5f3b82ad-3fb5-496e-9771-857d408936d9';

-- 3. Verify.
select 'draft after' as label, target_match_id, player_ids, captain_id, vc_id
from squad_draft_xi
where squad_id = '5f3b82ad-3fb5-496e-9771-857d408936d9';

select 'snapshot after' as label, snapshot
from user_booster_activations
where squad_id = '5f3b82ad-3fb5-496e-9771-857d408936d9'
  and match_id = '06297f58-3a64-4364-9548-46ccaf0f4a29'
  and booster = 'free_hit';

commit;

-- After this commits, reload the web app for this account (or just wait for
-- tonight's lock) — Pick 11 should show the M31 XI (Short C / Russell VC)
-- as the current team for M33, and tonight's lock-matches run will lock
-- exactly that in for M33 since target_match_id already matches.
