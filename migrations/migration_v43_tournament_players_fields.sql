-- ─────────────────────────────────────────────────────────────────────────────
-- Super Selector — Migration v43: tournament-scoped is_overseas
--
-- Closes the gap discussed at length while setting up CPL 2026: team_id and
-- credits were already tournament-scoped via tournament_players, but
-- is_overseas was only ever a column on the GLOBAL players table — even
-- though "overseas" is relative to which league/country you're playing in,
-- not a fixed fact about the player (an Indian player is domestic in IPL but
-- overseas in CPL/MLC/Big Bash; unlike role, which genuinely doesn't change
-- tournament to tournament).
--
-- This adds tournament_players.is_overseas and backfills it from the current
-- global players.is_overseas value (the best-known value at migration time —
-- since a player is only ever active in one tournament at once, today's
-- global value reflects whichever tournament they were most recently
-- imported/edited for). Going forward, CSV import and the admin edit UI
-- write here instead of overwriting the global column on every import.
--
-- players.is_overseas itself is left in place — it's now just the bootstrap
-- default used when a brand-new player is created (addPlayer) or when a
-- tournament has no tournament_players rows yet (the getPlayers() fallback
-- path). It's no longer treated as authoritative once a tournament has real
-- tournament_players rows.
--
-- Paste into Supabase SQL Editor → Run.
-- ─────────────────────────────────────────────────────────────────────────────

alter table tournament_players
  add column if not exists is_overseas boolean;

update tournament_players tp
set is_overseas = p.is_overseas
from players p
where tp.player_id = p.id
  and tp.is_overseas is null;

-- From here on, is_overseas should always be set on write — but default to
-- false rather than leaving new rows null if some future insert path misses it.
alter table tournament_players
  alter column is_overseas set default false;

update tournament_players set is_overseas = false where is_overseas is null;

alter table tournament_players
  alter column is_overseas set not null;

comment on column tournament_players.is_overseas is
  'Tournament-specific overseas designation — a player can be domestic in one tournament and overseas in another (e.g. Indian player: domestic in IPL, overseas in CPL/MLC). Authoritative once set; players.is_overseas is only the bootstrap default for new players / tournaments with no roster imported yet.';
