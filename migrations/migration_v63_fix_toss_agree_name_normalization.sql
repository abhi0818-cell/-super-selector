-- migration_v63_fix_toss_agree_name_normalization.sql
-- toss_corroboration's `agree` column did a literal (lower/trim) string
-- compare on winner_name, which produced a FALSE disagreement on the very
-- first real multi-source data point (M18, 2026-08-27): Cricbuzz reported
-- "St Kitts and Nevis Patriots", CricketAddictor reported "St Kitts &
-- Nevis Patriots" — same team, same decision (bowl), just a spelling
-- variant ("&" vs "and") that check-toss's own team-name regex
-- (TEAM_NAME_CHARS) already had to account for after an identical miss on
-- CPL 2026 M10. That normalization never made it into this view's
-- comparison. Fix: replace '&' with ' and ' (padded so words don't merge)
-- and collapse whitespace before comparing, so this specific variant (and
-- any other double-space artifact from that substitution) no longer reads
-- as a disagreement.
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
  (count(distinct
    regexp_replace(regexp_replace(lower(trim(tsl.winner_name)), '&', ' and ', 'g'), '\s+', ' ', 'g')
    || '|' || tsl.decision
  ) = 1) as agree
from toss_source_log tsl
join matches m on m.id = tsl.match_id
join teams ht on ht.id = m.home_team_id
join teams at on at.id = m.away_team_id
join tournaments t on t.id = m.tournament_id
group by tsl.match_id, m.match_number, t.name, ht.name, at.name, m.start_time,
         m.toss_status, m.toss_source, m.toss_winner_name, m.toss_decision;
