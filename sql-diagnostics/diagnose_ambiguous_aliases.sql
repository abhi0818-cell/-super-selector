-- Flags existing player_name_aliases rows where the aliased name shares a
-- last name with ANOTHER player rostered to the same tournament — i.e. an
-- alias that could plausibly be cross-matching two different real people.
--
-- Why this matters: resolvePlayerName/resolveFielderName in
-- scrape-scorecard/index.ts (and poll-cricapi) check the alias map BEFORE
-- doing any ambiguity check. Once a raw name is aliased — whether by a
-- one-time fuzzy match or an admin's manual pick — every future occurrence
-- of that exact string in that tournament+source resolves straight to that
-- one player_id forever, on either team, in any match, with no re-check.
-- The fielding path's deliberate "flag instead of guess" ambiguity logic
-- (the "Bryce sisters" fix) only runs the FIRST time a name is seen, before
-- an alias exists — after that it's bypassed entirely.
--
-- A row here doesn't necessarily mean something's wrong — most will be
-- unrelated players who just happen to share a surname. It means "worth a
-- 30-second look at whether this alias has ever been applied to a match
-- where it was actually the OTHER player."

with norm_players as (
  select id, name,
    lower(regexp_replace(trim(name), '\s+', ' ', 'g')) as norm_name
  from players
),
last_named as (
  select id, norm_name, (regexp_match(norm_name, '(\S+)$'))[1] as last_word
  from norm_players
),
roster as (
  select tp.tournament_id, ln.id as player_id, ln.norm_name, ln.last_word, tp.team_id
  from tournament_players tp
  join last_named ln on ln.id = tp.player_id
)
select
  t.name as tournament_name,
  pna.source,
  pna.alias,
  p.name as aliased_to_name,
  p.team_id as aliased_to_team,
  p2.name as other_candidate_name,
  p2.team_id as other_candidate_team,
  (select count(*) from user_match_xi where player_id = pna.player_id) as aliased_to_xi_rows,
  (select count(*) from user_match_xi where player_id = r2.player_id) as other_candidate_xi_rows
from player_name_aliases pna
join players p       on p.id = pna.player_id
join tournaments t    on t.id = pna.tournament_id
join roster r2        on r2.tournament_id = pna.tournament_id
                     and r2.player_id <> pna.player_id
                     and r2.last_word = (regexp_match(lower(trim(pna.alias)), '(\S+)$'))[1]
join players p2       on p2.id = r2.player_id
order by t.name, pna.alias;
