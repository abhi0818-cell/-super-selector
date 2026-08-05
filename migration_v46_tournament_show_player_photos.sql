-- migration_v46: per-tournament player-photos kill switch
-- Run in Supabase SQL Editor.
--
-- Background: player photos are a new, visually risky feature (real photos
-- composited onto the jersey icon, with a rembg background-removal pipeline
-- feeding players.photo_url — see migration_v45). Rather than an all-or-
-- nothing code deploy to disable it if it looks off in the app, this gives
-- an explicit per-tournament ON/OFF switch, same pattern as
-- migration_v30_dot_ball_toggle.sql:
--
--   ON  (default) — Jersey renders player.photoUrl when present, falling
--                    back to the plain jersey icon / silhouette otherwise.
--   OFF            — Jersey ignores photoUrl entirely and always renders the
--                     plain jersey icon, regardless of whether photos have
--                     been imported for this tournament's players.
--
-- Defaults to true (not false, unlike dot_ball) because this is meant to be
-- on by default once photos exist for a tournament -- the switch exists so
-- it can be turned OFF quickly if needed, not opted into per tournament.

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS show_player_photos BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN tournaments.show_player_photos IS 'Kill switch for player photos on the jersey icon (pool list + pitch map). true = show photoUrl when present; false = always render the plain jersey regardless of photo_url data.';
