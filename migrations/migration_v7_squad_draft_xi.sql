-- Migration v7: Add squad_draft_xi table for carry-forward SL model
-- Run this in the Supabase SQL editor

-- One row per squad — the user's current editable season XI.
-- Saves here are free (no transfer counting). Transfers are counted
-- automatically when a match locks (start_time arrives).

DROP TABLE IF EXISTS squad_draft_xi;

CREATE TABLE squad_draft_xi (
  squad_id   UUID PRIMARY KEY REFERENCES user_squads(id) ON DELETE CASCADE,
  player_ids TEXT[]       NOT NULL DEFAULT '{}',
  captain_id TEXT,
  vc_id      TEXT,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
