-- ───────────────────────────────────────────────────────────────────────────
-- Clears the bad alias: "Player Not Found" → Abayanga Khaka.
-- CricAPI (and the other scraper sources) sends a literal "Player Not Found"
-- string when IT can't identify someone — the same literal string recurs for
-- DIFFERENT real players across different matches, so it should never have
-- been aliased to one specific player in the first place. This script finds
-- whichever row(s) created that mapping and deletes them.
--
-- Step 0 (read-only, optional) — scraper_unmatched keeps a row per resolved
-- name too (resolved_at/resolved_by stamped, not deleted), so this shows
-- every match where "Player Not Found" actually got auto-resolved to Khaka
-- while the bad alias was live — i.e. exactly which matches may have
-- incorrectly counted someone else's runs/wickets/fielding as his.
-- Worth a manual look at player_match_stats for those matches afterward.
SELECT su.match_id, su.context, su.source, su.created_at, su.resolved_at
FROM scraper_unmatched su
WHERE su.raw_name = 'player not found' AND su.resolved_by = 'alias'
ORDER BY su.created_at;

-- Step 1 (read-only) — run this first and review the output before deleting.
-- ───────────────────────────────────────────────────────────────────────────
SELECT pna.id, pna.alias, pna.source, pna.tournament_id, pna.player_id, p.name AS player_name
FROM player_name_aliases pna
JOIN players p ON p.id = pna.player_id
WHERE pna.alias = 'player not found';

-- ───────────────────────────────────────────────────────────────────────────
-- Step 2 — delete it. Scoped to alias='player not found' only (not to a
-- specific player_id), so this clears the bad mapping regardless of which
-- source ('cricapi' / 'cricketaddictor' / 'business_standard') created it,
-- and regardless of which player it got wrongly mapped to.
-- ───────────────────────────────────────────────────────────────────────────
DELETE FROM player_name_aliases
WHERE alias = 'player not found';

-- Step 3 (verify) — should return 0 rows.
SELECT count(*) AS remaining_bad_aliases
FROM player_name_aliases
WHERE alias = 'player not found';
