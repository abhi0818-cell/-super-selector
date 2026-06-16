# Super Selector — Roadmap to Production

Inventory of work between the current prototype and a real, multi-user fantasy cricket app. Grouped by what blocks launch vs. what makes the app competitive.

_Last updated: May 11, 2026_

## Current state (for context)

Single-user prototype running locally. Static HTML + JS served from `python3 -m http.server` on port 8080. Supabase free tier holds players, saved XIs, and per-match scores. Mock IPL squad of 30 players; mock match simulation works; optional CricAPI integration is wired in but blocked by browser CORS. No auth, no RLS, no server-side logic.

## Must-have before any other person uses it

These block sharing the app with even one other person.

### Auth & multi-user data isolation
Anyone with the anon key currently reads and writes everything. Need:

- Supabase Auth wired into the UI (email magic-link or Google OAuth).
- Add `user_id uuid references auth.users(id)` to `user_teams` and `matches`.
- Enable Row-Level Security on every table.
- Policies like `using (user_id = auth.uid())` for SELECT/INSERT/UPDATE/DELETE.

Without this, two friends would overwrite each other's teams.

### Hosting
Currently runs on `localhost`. Push the static files to Vercel, Netlify, or Cloudflare Pages (free tiers handle this). Point a domain at it. Move the Supabase project to a paid tier if usage exceeds the free limits (500 MB DB, 2 GB bandwidth/mo).

### HTTPS everywhere
Hosted = HTTPS by default. Live polling and Supabase already require it. file:// has masked some issues during local dev.

### Basic legal
Terms of Service, Privacy Policy, cookie/consent banner. Template generators (Termly, iubenda) are fine for a beta.

Regulatory note: in India, fantasy sports is regulated as a "game of skill" with state-level bans (Telangana, Andhra Pradesh, Assam, Odisha, Sikkim, Nagaland, Tamil Nadu). Pure free-to-play sidesteps gambling rules, but check the law before charging entry fees.

### Backend proxy for CricAPI
Browsers can't hit CricAPI directly because of CORS. Ship a Supabase Edge Function or Cloudflare Worker that takes a match ID, fetches CricAPI, returns normalized JSON. Side benefit: the API key stays out of the client.

## Required for "real" fantasy cricket

Even with auth + hosting, without these the app is just a personal scorecard.

### Real player and fixture data
The 30-player IPL pool is hardcoded and frozen. Need:
- A feed of current squads per series, updated credits, playing-XI confirmations within ~60 min of toss.
- Schedule of upcoming matches.

CricAPI or RapidAPI fantasy feeds cover this. Budget roughly $50–$200/month for a usable plan.

### Match lock & deadlines
Today you can edit your XI mid-match. Production needs:
- Each `match` row has a `locks_at` timestamp.
- XIs become immutable for that match once locked.
- "Lineups confirmed" gating before scoring starts.

### Server-side scoring
The engine runs in the browser today, so a determined user could fake their own points. Move `cricketScoringEngine.js` to a Supabase Edge Function triggered by a webhook from your match-data provider. The function writes to `player_match_stats` and `user_team_match_scores`. Clients become read-only consumers.

### Contests / leagues
Models that don't exist yet:
- `contests` — id, name, private_or_public, entry_fee, prize_pool, match_id, max_entries
- `contest_entries` — contest_id, user_team_id, joined_at, final_rank
- `prize_distributions` — contest_id, rank_from, rank_to, payout_amount

Without contests it's a personal scorecard, not a fantasy app.

### Leaderboard
A SQL view or RPC that ranks `contest_entries` by `total_points` for a given match. Live updates via Supabase Realtime subscriptions.

## Quality bar before public launch

### Mobile UX
Layout works on phones but the player grid and squad list need work. Phones are ~80% of fantasy sports usage in India.

### Accessibility
Keyboard navigation through the player grid. ARIA labels on the C/V buttons. Contrast audit (WCAG AA). Screen-reader testing.

### Loading & error states
Skeleton loaders while the DB fetches, friendly retry on network failures, offline notice.

### Error monitoring
Sentry or PostHog — free tier is fine for a prototype. Catches bugs you won't reproduce locally.

### Testing
No tests exist. At minimum:
- Unit tests for `cricketScoringEngine.js` (lots of edge cases — duck penalty interactions, multi-format rules, captain/VC math).
- One Playwright E2E test that drafts an XI, saves it, runs a mock match, and saves the result.

### Database backups
Supabase free tier keeps 7 days of point-in-time recovery. Paid is required for longer retention.

## Money / regulated features (only if you ever charge for entry)

This is months of legal work, not weeks. Most teams start fully free and add paid contests only after product-market fit.

- KYC verification, anti-money-laundering checks, geo-fencing by state.
- Payment integration (Razorpay / Stripe), wallet system, withdrawal flow.
- Gambling / skill-game license review in every jurisdiction you serve.

## Nice-to-have, not blocking

- Real player photos and team logos
- Captain / vice-captain suggestion engine
- Recent-form stats per player
- Push notifications for match start
- AI assistant for "build my XI"
- Dark / light theme toggle
- Internationalisation
- Substitutions / late changes
- Daily / weekly / season-long leagues

## Recommended path

The minimum honest launch (free, no money, friends-and-family beta) is roughly 1–2 weeks of focused work:

1. **Auth + RLS** — wire Supabase Auth, add `user_id` to tables, write policies. (2–3 days)
2. **Hosting** — deploy to Vercel/Netlify, custom domain, env config for Supabase. (half day)
3. **CricAPI proxy** — Supabase Edge Function to bypass CORS and hide the key. (1 day)
4. **Match lock** — `locks_at` field, UI enforcement, server-side checks. (1 day)
5. **Server-side scoring** — move engine to Edge Function triggered by webhook. (2–3 days)

That gives you a thing your friends can actually use without trust issues. Everything else builds on that foundation.

## Open questions to decide before any of this

- Does this stay free-to-play (no entry fees), or is monetisation in scope eventually? Answers shape the legal and KYC work above.
- Single-cricket-format (IPL T20 only) or multi-format from day one?
- Self-serve auth (anyone can sign up) or invite-only friends-and-family for beta?
- Do you want to integrate with one fantasy data provider, or build adapter flexibility for several?
