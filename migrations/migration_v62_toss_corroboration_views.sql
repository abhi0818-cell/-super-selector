-- migration_v62_toss_corroboration_views.sql
-- Three read-only views on top of toss_source_log (migration_v60/v61) for
-- analyzing real multi-source toss timing/agreement as it accumulates from
-- M18 onward — v11's check-toss change (keeping a CONFIRMED match in the
-- polling query for CORROBORATION_WINDOW_MINUTES past confirmation) is what
-- makes multi-source data possible at all; M17 and earlier only ever have
-- one source logged, since the old query dropped a match the instant ONE
-- source confirmed it.
--
-- Built specifically so the pattern here — "when does each source actually
-- land relative to start_time, and how often do they agree" — can inform an
-- auto-push/auto-confirm function later, without needing to hand-roll the
-- same join/aggregation every time.

-- One row per (match, source) that reported a toss, with timing relative to
-- start_time computed directly. Positive minutes_before_start = reported
-- before kickoff (the normal case); negative = reported after start_time
-- had already passed.
create or replace view toss_source_timing as
select
  tsl.match_id,
  m.match_number,
  t.name as tournament,
  ht.name as home_team,
  at.name as away_team,
  m.start_time,
  tsl.source,
  tsl.winner_name,
  tsl.decision,
  tsl.received_at,
  round(extract(epoch from (m.start_time - tsl.received_at)) / 60.0, 1) as minutes_before_start
from toss_source_log tsl
join matches m on m.id = tsl.match_id
join teams ht on ht.id = m.home_team_id
join teams at on at.id = m.away_team_id
join tournaments t on t.id = m.tournament_id;

-- One row per match that has AT LEAST ONE source reported, aggregating
-- across whichever sources actually landed (1, 2, or 3 — never assumes all
-- three showed up). "agree" is true only when every reporting source's
-- (winner, decision) pair matches exactly (case/whitespace-insensitive on
-- the name). A match with only one source reporting is trivially
-- "agree = true" (nothing to disagree with) — filter on source_count >= 2
-- in any query where genuine corroboration (not just a single source) is
-- what matters, rather than relying on "agree" alone for that.
create or replace view toss_corroboration as
select
  tsl.match_id,
  m.match_number,
  t.name as tournament,
  ht.name as home_team,
  at.name as away_team,
  m.start_time,
  m.toss_status,
  m.toss_source as confirmed_source,
  m.toss_winner_name as confirmed_winner,
  m.toss_decision as confirmed_decision,
  count(*) as source_count,
  array_agg(tsl.source order by tsl.received_at) as sources_in_order,
  min(tsl.received_at) as first_received_at,
  max(tsl.received_at) as last_received_at,
  round(extract(epoch from (m.start_time - min(tsl.received_at))) / 60.0, 1) as first_minutes_before_start,
  round(extract(epoch from (max(tsl.received_at) - min(tsl.received_at))) / 60.0, 1) as spread_minutes,
  (count(distinct lower(trim(tsl.winner_name)) || '|' || tsl.decision) = 1) as agree
from toss_source_log tsl
join matches m on m.id = tsl.match_id
join teams ht on ht.id = m.home_team_id
join teams at on at.id = m.away_team_id
join tournaments t on t.id = m.tournament_id
group by tsl.match_id, m.match_number, t.name, ht.name, at.name, m.start_time,
         m.toss_status, m.toss_source, m.toss_winner_name, m.toss_decision;

-- Per-source rollup across all matches so far: how often each source shows
-- up at all, and how early relative to start_time it typically lands. This
-- is the "pattern of when toss information is received accurately" view —
-- directly what an auto-push threshold (e.g. "trust CricketAddictor alone
-- past T-X, else wait for a second source") would be tuned against.
create or replace view toss_source_reliability as
select
  source,
  count(*) as matches_reported,
  round(avg(minutes_before_start), 1) as avg_minutes_before_start,
  round(min(minutes_before_start), 1) as earliest_minutes_before_start,
  round(max(minutes_before_start), 1) as latest_minutes_before_start,
  count(*) filter (where minutes_before_start < 0) as reported_after_start_count
from toss_source_timing
group by source
order by source;
