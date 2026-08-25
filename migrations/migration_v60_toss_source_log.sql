-- migration_v60: toss_source_log — per-source toss captures, for corroboration
-- ─────────────────────────────────────────────────────────────────────────────
-- check-toss (migration_v55/v56) already tries both CricAPI and CricketAddictor
-- on every run, but only ever persists whichever ONE source answered first
-- (matches.toss_winner_name/toss_decision/toss_source/toss_checked_at) — the
-- other source's read, if it has one, is discarded. That means matches.* has
-- never actually let you ask "did the two sources agree, and how far apart in
-- time did they each report it" — the question this table exists to answer.
--
-- One row per (match, source), written the FIRST time that source parses a
-- toss result for that match (unique constraint below enforces this — a
-- source's later, possibly-different re-reads on subsequent cron ticks do
-- NOT overwrite the first capture). received_at is that first-capture
-- timestamp, independent of matches.toss_checked_at (which only reflects
-- whichever source won the race to be persisted there).
--
-- This is intentionally NOT a full poll-by-poll audit log — check-toss runs
-- every minute and most of those runs find nothing from either source; only
-- successful, parseable toss reads get a row here.
--
-- check-toss (as of 2026-08-24, same deploy that ships this migration) now
-- writes to this table from both its "Source 1: CricAPI" and "Source 2:
-- CricketAddictor" blocks, regardless of which source ends up being the one
-- matches.toss_status confirms from. No confirmation logic reads from this
-- table yet — it's raw material for a future corroboration check (e.g.
-- "only confirm once 2 sources agree", or "flag a push as single-source if
-- only one source ever reported").
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists toss_source_log (
  id           uuid primary key default gen_random_uuid(),
  match_id     uuid not null references matches(id) on delete cascade,
  source       text not null,
  winner_name  text not null,
  decision     text not null,
  received_at  timestamptz not null,
  created_at   timestamptz not null default now(),
  unique (match_id, source)
);

do $$
begin
  alter table toss_source_log drop constraint if exists toss_source_log_source_check;
exception when others then null;
end $$;

alter table toss_source_log
  add constraint toss_source_log_source_check
  check (source in ('cricapi', 'cricketaddictor'));

do $$
begin
  alter table toss_source_log drop constraint if exists toss_source_log_decision_check;
exception when others then null;
end $$;

alter table toss_source_log
  add constraint toss_source_log_decision_check
  check (decision in ('bat', 'bowl'));

-- Lookups will mostly be "give me every source's read for this match" —
-- the leading column of the (match_id, source) unique index above already
-- covers that, so no separate index needed.

alter table toss_source_log enable row level security;

drop policy if exists "toss_source_log: admin full access" on toss_source_log;
create policy "toss_source_log: admin full access"
  on toss_source_log for all
  using  (is_admin())
  with check (is_admin());
