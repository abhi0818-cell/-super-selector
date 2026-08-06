-- v38: how long a notification stays on the HomeScreen ticker
--
-- The ticker was previously tied to notification_reads (migration_v37) — it
-- disappeared the instant a user tapped it once to open the inbox modal,
-- since that's what marks a notification read. That's wrong for a "keep
-- this visible for hours" broadcast: read state should still drive the
-- unread badge/highlight in the inbox modal, but the ticker itself should
-- run for a fixed window of time picked by the admin when sending,
-- independent of whether any individual user has already seen it.
--
-- ticker_hours: how many hours after created_at the ticker should keep
-- showing this notification on Home. Defaults to 6. The client computes
-- expiry itself (created_at + ticker_hours) — no cron/expiry job needed,
-- it's just a filter on the client's read of notifications_log.

alter table notifications_log
  add column if not exists ticker_hours numeric not null default 6;

comment on column notifications_log.ticker_hours is
  'Hours after created_at that this notification stays on the HomeScreen ticker, independent of per-user read state (see notification_reads).';
