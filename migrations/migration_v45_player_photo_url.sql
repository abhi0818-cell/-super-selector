-- migration_v45: add photo_url to the global players table
-- Safe: nullable column, no impact on existing rows or ongoing tournaments
--
-- photo_url is a person-level fact (like name), not a tournament-scoped one
-- (unlike team_id/credits/is_overseas, which live on tournament_players --
-- see migration_v2_squads_transfers.sql and migration_v43). A player's
-- photo doesn't change when they move between IPL and CPL, so it belongs
-- here rather than on tournament_players.
--
-- Populated via import_player_photos.py -> Supabase Storage (public
-- "player-photos" bucket) -> pasted CSV in Admin's "Player photos" panel.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS photo_url TEXT DEFAULT NULL;

COMMENT ON COLUMN players.photo_url IS 'Background-removed, head-and-neck-cropped player photo (Supabase Storage public URL). Null = no photo sourced yet; app falls back to the plain jersey icon or a silhouette placeholder.';
