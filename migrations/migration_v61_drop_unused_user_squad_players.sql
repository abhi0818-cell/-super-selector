-- migration_v61: drop unused user_squad_players + v_squad_current_players
-- ─────────────────────────────────────────────────────────────────────────────
-- user_squad_players was created in migration_v2_squads_transfers.sql as part
-- of the original season-long squad design (per-player acquired_before_match_id
-- /released_before_match_id timeline). The squad model moved on to
-- user_squads + squad_draft_xi + user_match_xi instead, and this table was
-- left behind — it has 0 rows in production and no code anywhere (db.js,
-- admin.js, index.html, the mobile app, any edge function) reads or writes it,
-- directly or via its only dependent view, v_squad_current_players (also
-- unreferenced anywhere despite a stale comment in migration_v58 claiming it
-- "is used by squad selection" — verified false).
--
-- It also never got RLS: migration_v8_auth.sql (the RLS rollout) only covered
-- tables with a direct user_id column (user_teams/user_squads/user_transfers/
-- user_match_xi); migration_v17 later added the harder join-through-parent
-- policy for the daily-team equivalent, user_team_players — but the
-- season-long equivalent here was never written. Flagged by Supabase's
-- advisor as RLS-disabled and fully exposed to anon/authenticated roles.
--
-- Given it's confirmed dead (0 rows, 0 callers, only self-referential FKs
-- outward to user_squads/players/matches, nothing references it as a parent),
-- dropping it is simpler and safer than adding RLS to something nothing uses.
-- ─────────────────────────────────────────────────────────────────────────────

drop view if exists v_squad_current_players;
drop table if exists user_squad_players;
