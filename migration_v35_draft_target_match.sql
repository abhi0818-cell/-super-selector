-- v35: tie a saved draft's XI (player_ids/captain_id/vc_id) to the specific
-- match it was explicitly saved for, closing the same class of bug v34 fixed
-- for boosters — but for the XI itself.
--
-- squad_draft_xi is one row per squad with NO match association today. That
-- means whichever match's auto-lock catch-up (slCheckAutoLock) happens to
-- run next just grabs "whatever's currently in the draft" and locks it in,
-- with no way to verify it was actually meant for THAT match. If a user
-- saves for match A close to its lock time, and something delays the lock
-- check for A (closed tab, no session ran the catch-up in time, etc.), their
-- draft can sit unlocked — and by the time they come back and start editing
-- for match B, the same draft row carries forward. A later catch-up run can
-- then lock match A (or worse, both A and B) using content that was never
-- explicitly confirmed for that specific match.
--
-- target_match_id records "this player_ids/captain_id/vc_id snapshot was
-- explicitly Saved for this match_id". lockMatchXI (db.js) checks this
-- before trusting the draft — if it doesn't match the match being locked,
-- it safely carries the previous locked XI forward unchanged instead of
-- guessing, rather than ever locking in an unconfirmed snapshot.

alter table squad_draft_xi
  add column if not exists target_match_id uuid references matches(id);

comment on column squad_draft_xi.target_match_id is
  'The match this draft''s player_ids/captain_id/vc_id were explicitly Saved for. lockMatchXI only trusts the draft when this matches the match being locked; otherwise it carries the previous locked XI forward unchanged.';
