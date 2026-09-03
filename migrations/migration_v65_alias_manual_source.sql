-- migration_v65: allow source = 'manual' on player_name_aliases.
--
-- migration_v64 widened scraper_unmatched.source_check and
-- scraper_fielding_issues.source_check to accept 'manual', for fielding
-- issues/unmatched names created by admin.js's manual-scorecard-paste path
-- (saveManualScorecardForMatch). But db.js's resolveFieldingIssueAsCredit
-- upserts into player_name_aliases with source = issue.source — so crediting
-- and aliasing a manually-entered fielding issue (source='manual') was
-- rejected by player_name_aliases_source_check, which had never been widened
-- to match. Symptom: "new row for relation \"player_name_aliases\" violates
-- check constraint \"player_name_aliases_source_check\"" when an admin used
-- Review → Fielding Issues → Credit & Alias on a manually-entered credit
-- (e.g. Amir Jagnoo, run-out assist).
--
-- Applied directly to the live DB on 2026-09-03; this file documents it for
-- the repo/schema history.

ALTER TABLE player_name_aliases DROP CONSTRAINT IF EXISTS player_name_aliases_source_check;
ALTER TABLE player_name_aliases
  ADD CONSTRAINT player_name_aliases_source_check
  CHECK (source IN ('cricketaddictor','business_standard','cricapi','manual'));
