-- migration_v61: allow 'cricbuzz' as a valid toss source
-- ─────────────────────────────────────────────────────────────────────────────
-- check-toss (this deploy) adds Cricbuzz as a third independent toss source,
-- alongside CricAPI and CricketAddictor — see check-toss/index.ts header for
-- why: ESPNcricinfo's internal API returned a hard 403 (WAF block, confirmed
-- live from Supabase's edge egress), so it's not usable; Cricbuzz's embedded
-- match-state JSON (state:"Toss", status:"<team> opt to bat/bowl") came back
-- clean from the same egress that gets reset by CricAPI, and is genuinely
-- more reliable than either existing source's text-scraping — structured
-- fields with an explicit toss state instead of a sentence to regex against.
--
-- Both matches.toss_source and toss_source_log.source had a CHECK constraint
-- limited to ('cricapi','cricketaddictor') — widen both to include 'cricbuzz'
-- so a write from the new source doesn't get rejected.
-- ─────────────────────────────────────────────────────────────────────────────

alter table matches drop constraint if exists matches_toss_source_check;
alter table matches
  add constraint matches_toss_source_check
  check (toss_source is null or toss_source = any (array['cricapi','cricketaddictor','cricbuzz']));

alter table toss_source_log drop constraint if exists toss_source_log_source_check;
alter table toss_source_log
  add constraint toss_source_log_source_check
  check (source in ('cricapi', 'cricketaddictor', 'cricbuzz'));
