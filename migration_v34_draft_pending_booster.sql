-- v34: tie the staged-but-unsaved booster pick to the draft row itself, so it
-- can never be silently lost between "Save XI" and the match actually
-- locking. See ShooterXI M25 incident: the booster commit that's supposed to
-- happen on Save XI silently no-op'd because the "which match does this
-- apply to" resolution can drift (clock-driven redirect once a match starts)
-- between when a booster pill is staged and when Save XI / lock actually run.
--
-- pending_booster / pending_booster_match_id durably record "the booster this
-- squad wants applied to this specific match", written every time the draft
-- is saved. slLockForMatch (index.html) then reconciles at lock time — the
-- one moment a match's identity is no longer ambiguous — activating it for
-- real if it somehow never made it into user_booster_activations earlier.

alter table squad_draft_xi
  add column if not exists pending_booster           text,
  add column if not exists pending_booster_match_id   uuid references matches(id);

comment on column squad_draft_xi.pending_booster is
  'Booster key staged for pending_booster_match_id, durable across reloads. Written on every Save XI; reconciled into user_booster_activations at lock time as a safety net.';
comment on column squad_draft_xi.pending_booster_match_id is
  'The match the pending_booster choice applies to, resolved at the moment the draft was last saved.';
