-- Retroactively activate Team Double for ShooterXI on M25 (Major League Cricket,
-- live match). Confirmed via diagnose_shooterxi_m25.sql:
--   squad_id   = a5c2cde4-71e6-43bb-9be4-8876d75987d6   (MLC Season Long)
--   match_id   = 19071f9b-cf05-46f7-b5fb-9004cf9d5241   (M25, MNY vs SO, live)
--   contest available_boosters includes "team_double": 1

begin;

-- 0. Safety check — make sure this squad hasn't already used team_double
--    somewhere else this season, and doesn't already have a different
--    booster committed for M25 (only one booster can be active per match).
select *
from user_booster_activations
where squad_id = 'a5c2cde4-71e6-43bb-9be4-8876d75987d6'
  and (booster = 'team_double' or match_id = '19071f9b-cf05-46f7-b5fb-9004cf9d5241');
-- Expect ZERO rows back. If anything shows up here, stop and check before
-- continuing — either it's already fixed, or another booster is already
-- committed to M25 for this squad.

-- 1. The actual fix.
insert into user_booster_activations (squad_id, match_id, booster)
values (
  'a5c2cde4-71e6-43bb-9be4-8876d75987d6',
  '19071f9b-cf05-46f7-b5fb-9004cf9d5241',
  'team_double'
)
on conflict (squad_id, match_id, booster) do nothing;

-- 2. Verify.
select *
from user_booster_activations
where squad_id = 'a5c2cde4-71e6-43bb-9be4-8876d75987d6'
  and match_id = '19071f9b-cf05-46f7-b5fb-9004cf9d5241';

commit;

-- After this commits: Admin → Matches → M25 (MLC, MNY vs SO) → Poll Now /
-- Recalculate. computeAndSaveSLScoresForMatch re-reads
-- user_booster_activations from scratch every run, so ShooterXI's whole M25
-- XI will get the 2x team_double multiplier applied on the next recompute —
-- no code change needed for this backfill.
