-- Repairs MLC's tournament_players.is_overseas for the players shared with
-- CPL, restoring the values recorded before CPL's import (which ran on the
-- old, pre-migration_v43 code and overwrote the global players.is_overseas
-- column) corrupted them. migration_v43's backfill then copied that already-
-- wrong global value into MLC's row, since MLC had never had this column
-- before. This restores MLC's true original values from that pre-corruption
-- snapshot.

update tournament_players
set is_overseas = v.correct_overseas
from (values
  ('p614', true),   -- Akeal Hosein
  ('p537', true),   -- Alex Hales
  ('p623', false),  -- Amshi de Silva
  ('p538', true),   -- Andre Fletcher
  ('p540', true),   -- Andre Russell
  ('p539', true),   -- Colin Munro
  ('p595', true),   -- Dasun Shanaka
  ('p580', true),   -- Hassan Khan
  ('p544', true),   -- Jahmar Hamilton
  ('p554', true),   -- Kieron Pollard
  ('p591', true),   -- Matthew Breetzke
  ('p617', false),  -- Milind Kumar
  ('p553', true),   -- Nicholas Pooran
  ('p642', true),   -- Nikhil Chaudhary
  ('p556', true),   -- Quinton de Kock
  ('p558', true),   -- Romario Shepherd
  ('p550', false),  -- Shadley van Schalkwyk
  ('p599', false),  -- Shayan Jahangir
  ('p590', true),   -- Shimron Hetmyer
  ('p541', true),   -- Sunil Narine
  ('p566', false),  -- Tajinder Singh
  ('p589', true),   -- Tim Seifert
  ('scr_1781916475717', true),  -- Jason Holder
  ('scr_1781916608352', true)   -- Rovman Powell
) as v(player_id, correct_overseas)
where tournament_players.player_id = v.player_id
  and tournament_players.tournament_id = (select id from tournaments where name = 'Major League Cricket');
