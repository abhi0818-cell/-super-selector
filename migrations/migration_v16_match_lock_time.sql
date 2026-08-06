-- migration_v16_match_lock_time
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds `lock_time` to matches and allows 'delayed' as a status value.
--
-- lock_time (nullable timestamptz)
--   When set, this is the time at which player XIs are frozen — overriding
--   the default behaviour of locking at start_time.
--   When null and status = 'delayed', the lock never fires (admin controls it).
--   When null and status != 'delayed', locking falls back to start_time as before.
--
-- Status constraint is widened to include 'delayed'.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add lock_time column (safe to run multiple times)
alter table matches
  add column if not exists lock_time timestamptz;

-- 2. Widen the status check constraint to include 'delayed'.
--    Postgres doesn't support ALTER CONSTRAINT, so we drop and recreate.
--    The DO block makes the script idempotent.
do $$
begin
  -- Drop old constraint if it exists (name may vary; cover both common names)
  alter table matches drop constraint if exists matches_status_check;
exception when others then null;
end $$;

alter table matches
  add constraint matches_status_check
  check (status in ('scheduled', 'delayed', 'live', 'in_progress', 'completed', 'abandoned', 'cancelled'));

-- 3. Index — admin schedule view filters by status frequently
create index if not exists matches_status_idx on matches(status);
