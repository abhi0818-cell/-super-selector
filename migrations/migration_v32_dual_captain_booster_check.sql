-- migration_v32: allow 'dual_captain' in user_booster_activations.booster
-- Run in Supabase SQL editor.
--
-- migration_v12_boosters.sql created user_booster_activations with a CHECK
-- constraint listing the allowed booster keys, but 'dual_captain' was added
-- to the app (BOOSTER_META, scoring engine, UI) afterwards and the constraint
-- was never updated to match. Activating Dual Captain therefore fails with:
--   new row for relation "user_booster_activations" violates check
--   constraint "user_booster_activations_booster_check"
--
-- This drops and recreates the constraint with 'dual_captain' included,
-- matching the full set of keys BOOSTER_META supports in index.html.

ALTER TABLE user_booster_activations
  DROP CONSTRAINT IF EXISTS user_booster_activations_booster_check;

ALTER TABLE user_booster_activations
  ADD CONSTRAINT user_booster_activations_booster_check
  CHECK (booster IN (
    'triple_captain',
    'dual_captain',
    'wildcard',
    'free_hit',
    'os_double',
    'indian_double',
    'team_double'
  ));
