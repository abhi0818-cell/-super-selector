# Deploying poll-cricapi (server-side CricAPI polling)

New this round: `supabase/functions/poll-cricapi/index.ts` ports the browser's CricAPI
live-poll + finalize pipeline server-side, same pattern as `scrape-scorecard`. Live
viewing in the browser is now DB-only for every tournament — no more direct
browser→CricAPI calls, no open tab required.

## 1. Set your CricAPI key(s) as a secret (you do this — I can't enter API keys for you)

```bash
supabase secrets set CRICAPI_KEYS="key1,key2,key3" --project-ref gepltclaeczgtruvekci
```

Comma-separate multiple keys if you have them; the function rotates through them on
quota/auth failures. One key is fine too.

## 2. Deploy the function

```bash
supabase functions deploy poll-cricapi --project-ref gepltclaeczgtruvekci
```

## 3. Run the migration

Open the Supabase SQL Editor and run `migration_v25_cricapi_cron.sql`. It:
- widens `player_name_aliases.source` and `scraper_unmatched.source` CHECK constraints to allow `'cricapi'`
- registers a pg_cron job (`poll-cricapi-matches`) that calls the function every 2 minutes

To change the interval later, edit the `'*/2 * * * *'` line and re-run the file — it's
safe to re-run (unschedule-then-schedule).

## 4. Verify

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'poll-cricapi-matches';
```

Then watch a live CricAPI match: the admin matches table now shows a "📡 Poll" button
for CricAPI-driven (non-scraper) live matches, for on-demand triggering without waiting
for the cron tick. The browser live view reads only from the DB now (`player_match_stats`),
same as scraper-enabled tournaments always have.

## One thing to flag

The scraper function's hardcoded T20 scoring defaults are stale relative to the
canonical rules in `index.html`. `poll-cricapi` intentionally uses the **correct**
index.html values, not the scraper's. Worth fixing `scrape-scorecard`'s defaults to
match at some point, but that's a separate, pre-existing discrepancy — not something
this change touches.

## Git

Changed files this round: `index.html`, `db.js`, `supabase/functions/poll-cricapi/index.ts`
(new), `migration_v25_cricapi_cron.sql` (new). Commit and push when ready — if `git`
complains about a lock file (`.git/index.lock` or `.git/HEAD.lock`), delete it yourself
first (I can't reach your local `.git` directory from here).
