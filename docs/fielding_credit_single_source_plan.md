# Plan: One source of truth for fielding credit (Fantasy Scorecard preview vs. Review)

**Status:** 🟡 First increment shipped locally, not yet pushed. §5.3/§5.6 turned out to
already exist — see §10. §5.5 (Link rewiring) intentionally held until M15 finishes, per
§8's sequencing.

## At a glance — the problem in one line

The Fantasy Scorecard tab's "N fielding events not credited to anyone" banner is computed
by a *second, independent* re-derivation of fielding credit that runs live in the browser —
it is not reading the real, already-saved data. When that browser-side pass is scoped to the
wrong player pool, it can flag events as "uncredited" that are already correctly credited in
the database. Today's case (CPL M15, 6 Guyana Amazon Warriors players) is confirmed to be
exactly this: all 6 already have correct fielding stats and points saved in
`player_match_stats`; the server-side scraper only ever logged one genuinely unresolved name
for this match ("S Joseph" — ambiguous between two players). The banner was a false alarm.

## §1 How fielding credit actually gets computed today — three engines, not one

**Engine 1 — the scraper edge function (`supabase/functions/scrape-scorecard/index.ts`).**
Real source of truth for any scraper-track match. Runs on a cron, resolves each dismissal's
fielder name against *that match's own two teams* (`resolveFielderName`, deliberately scoped
this way — see its doc comment), writes results straight into `player_match_stats`, and logs
anything it can't resolve into `scraper_fielding_issues` (upsert with `ignoreDuplicates`, so a
resolved row doesn't come back on a later re-scrape).

**Engine 2 — client-side Finalize (`finalizeOneMatch` in admin.js).** Real source of truth for
CricAPI-track matches, and the fallback path when a scraper match is finalized manually. Calls
the same `fromCricAPI()`/`resolveFielder()` logic as the browser preview, but scopes the squad
correctly via `matchSquadFor(m)` — using the *specific match object's* `home_team_id`/
`away_team_id`, not anything tied to "whichever tournament happens to be active in the admin
UI right now." Any fielding credit it can't resolve only ever reaches a `console.warn` — it is
never persisted anywhere for CricAPI-track matches today.

**Engine 3 — the Fantasy Scorecard tab's live preview (`renderFantasyScorecard()` in
admin.js, and the equivalent live-poll path in `connectLive()`/index.html).** Not a source of
truth at all — a redundant, independent re-computation done purely for display, using the same
`fromCricAPI()`/`resolveFielder()` code but scoped via `matchSquadFor(currentMatch)`, where
`currentMatch` is looked up from whatever match ID happens to be sitting in the `#matchId`
field. `matchSquadFor` falls back to the *browser's currently-loaded roster* (`A.PLAYERS`) when
it can't scope by team — and that roster reflects whichever tournament is marked "active"
elsewhere in the admin session, not necessarily the tournament of the match being previewed.

## §2 Root cause of today's false alarm

**Confirmed by tracing the actual code, not just circumstantial** — this doesn't require
multiple tournaments to be "live" at once to happen, which is why linking matches to their
tournament and having only one tournament with a live match today doesn't rule it out.

`A.PLAYERS` (the pool `matchSquadFor` filters down to build the preview's squad) is assigned
in exactly one place: `A.PLAYERS = await state.db.getPlayersForTournament(state.activeTournamentId)`
(admin.js:4431). `state.activeTournamentId` is a **separate, admin-panel-wide toggle** — the
same one that drives the Tournament tab and Score Audit — set independently of which match is
currently connected for live viewing (that's a different piece of state, `#matchId`, set by
picking a match in the live-connect dropdown). These two "which tournament" values have no
relationship to each other. So even with CPL as the only tournament that has a live match
today, `state.activeTournamentId` could easily still be sitting on whatever tournament was last
opened in the Tournament tab or Score Audit (IPL, MLC, whatever) — while the live-connect
dropdown lets you watch a match from *any* tournament regardless. If those two happen to point
at different tournaments, `A.PLAYERS` holds the wrong roster, `matchSquadFor` can't find any of
the away team's players, and every fielding credit in that match fails to match at once —
exactly today's pattern (6 names, one team, all failing together), while batting/bowling rows
are unaffected because `fromCricAPI`'s `ensure()` builds those from the payload directly, no
squad lookup required.

Also confirmed while tracing this: `connectLiveViaScraper()` (the actual live path for a
scraper-track match like today's) already reads real per-player stats correctly, straight from
the database via `DbScorePoller` — "rows are keyed by our own player_id already, no name
matching needed," per its own comment — and uses that for `state.stats` (XI highlighting,
etc.). But `renderFantasyScorecard()` doesn't reuse that already-correct data — it does its own
separate `fromCricAPI()` pass over the raw cached scorecard, independent of `state.stats`, purely
to build the Fantasy Scorecard panel. That's the actual duplication §5.2 is aimed at.

## §3 Why Review's Score Audit didn't catch it either

It was never designed to. `runScoreAudit()` only recomputes points from stats *already saved*
in `player_match_stats` and flags a mismatch when the recompute disagrees with the stored
`raw_points`. It has no visibility into raw scorecard/dismissal text at all, so it has no way to
notice "this catch never got attributed to anyone" — there's no row to compare against for a
credit that was never attributed in the first place. That check already exists, just narrowly:
server-side, scraper-track only, in `scraper_fielding_issues` — and today, nothing surfaces it
in the admin UI at all.

## §4 Design goal

One source of truth per track (the two real engines above are already correctly scoped — they
don't need to change). The preview tab should stop re-deriving fielding credit for display and
instead reflect what's actually saved wherever it's saved. Anything genuinely unresolved should
surface exactly once, in exactly one place, backed by a persisted record — not a live browser
recompute that can silently disagree with the database. No user-facing button should ever be
able to overwrite correct saved data with a recompute done against a possibly-wrong squad
scope.

## §5 Proposed changes

**§5.1 — Fix the root scoping bug in `matchSquadFor`.** Whatever else changes, this needs
fixing regardless: squad scoping for *any* caller should derive from the specific match's own
tournament roster, never from "whichever tournament is currently active in the admin UI." This
closes the hole that let today's false alarm happen in the first place, independent of the
other changes below.

**§5.2 — Fantasy Scorecard tab reads saved truth first.** For any player who already has a
`player_match_stats` row for this match, show that saved fielding/points data directly instead
of re-deriving it client-side. Only fall back to a live `fromCricAPI()` computation for a
genuinely in-progress match with nothing saved yet — and label that state clearly as a live,
unsaved estimate, not indistinguishable from real credited data the way it is today.

**§5.3 — Persist unresolved fielding events for the CricAPI-track path too.** Right now only
the scraper engine writes unresolved credits anywhere (`scraper_fielding_issues`); the client
Finalize path's `fieldingIssues` only ever reaches `console.warn`. Extend persistence to cover
both tracks — either by widening `scraper_fielding_issues` (it already has a `source` column,
though that currently means *which scraper site*, not *which track* — needs a clean decision,
not a silent conflation) or a small sibling table. Exact shape is a Step 2 decision, not locked
in here.

**§5.4 — The "not credited to anyone" banner reads from that persisted table, scoped to the
current match — not from a fresh client recompute.** Only genuinely still-open entries show;
anything already resolved (by the cron re-matching a corrected alias, or by an admin fixing it)
drops off automatically, same as `scraper_fielding_issues`'s `ignoreDuplicates` convention
already gives the scraper side today.

**§5.5 — "Link" becomes scoped and safe.** Today, linking a fielding name re-runs
`linkPlayerAndRescore()` → `rescoreCurrentMatch()`, which recomputes and blind-upserts *every*
player in the match from a fresh client-side pass — risking overwriting other players' already-
correct, cron-maintained rows, and racing the scraper cron's own next run. Once a fielding
credit is confirmed genuinely unresolved (§5.3/§5.4), "Link" should instead route through the
existing, already-safe `applyManualFieldingCredit` path — the same one Review tab's "Credit" and
the Schedule tab's 🥎 button already use — which patches just that one player's row and tags it
`source: 'scraper_manual'` so it can't be silently clobbered later. `linkPlayerAndRescore` stays
as-is for its original purpose (CricAPI player-identity name aliasing for batting/bowling rows),
which is a different, legitimately-safe case — that's not what caused today's confusion.

**§5.6 — Review tab becomes the one action queue.** Both tracks' unresolved fielding events
surface there, alongside the existing raw-points mismatches, each actionable through the same
safe Credit mechanism. The Fantasy Scorecard tab becomes purely diagnostic/read-only for this —
no action button that can diverge from the database.

## §6 What does NOT change

The server-side scraper's `resolveFielderName` and its per-match team scoping — already
correct. `finalizeOneMatch`'s squad scoping via `matchSquadFor(m)` — already correct, it's the
`currentMatch`/`#matchId`-driven callers that are the problem. Batting/bowling name matching —
not affected by this bug at all, since it doesn't require a squad match to populate a row.

## §7 Proposed implementation steps

1. ~~Confirm the root cause~~ — **done**. §2 traces it precisely through the code
   (`A.PLAYERS` ← `state.activeTournamentId`, a toggle independent of the live-connect match
   selection) — no live instrumentation needed, the mechanism is unambiguous from the source.
2. ~~Decide and build the unresolved-fielding-events storage~~ — **done, and simpler than
   planned**. No new table, no schema decision needed — `scraper_fielding_issues` already
   accepts `source: 'cricapi'` (migration_v41). Added `db.js`'s `insertFieldingIssues()` and
   wired it into `finalizeOneMatch`. See §10.
3. **Fix `matchSquadFor`'s roster scoping** (§5.1) — **deferred, optional**. Lower-stakes now
   that the actionable-but-wrong banner is gone (see §10's "deliberately not done").
4. **Rework the Fantasy Scorecard tab's rendering** (§5.2) — **deferred, optional**, same reason.
5. ~~Rework the "not credited to anyone" banner~~ — **done**, but landed as a simplification
   of the original idea: rather than sourcing the banner from a persisted table, the banner just
   stopped being actionable — it's a passive count + a pointer to Review → 🥎 Fielding Issues,
   which was already the persisted, correct source all along. See §10.
6. **Rewire fielding "Link" actions to the safe, scoped Credit path** (§5.5) — **moot for
   fielding**, since that Link button no longer exists (removed as part of step 5/§10). The
   *player-identity* Link case (a different, always-safe path) is untouched.
7. ~~Surface both tracks' unresolved fielding events in Review tab~~ — **already existed**
   (migration_v24), turned out to need no work. The only real gap was the CricAPI-track client
   Finalize path never writing to it — closed by step 2. See §10.
8. **Testing note**: verify against today's live M15 (already known-good real data — should show
   zero banner once the fix lands, and the passive note should never appear for these 6 players)
   and against a match with a genuinely unresolved name (the "S Joseph" ambiguity is a live, real
   example — should still show up correctly in Review → 🥎 Fielding Issues, unaffected by any of
   this). Not yet click-tested against the running app — implemented and `node --check`/logic-
   simulated only so far.

## §8 Safe to build/ship while M15 is live?

Yes, with one exception. None of this touches the actual scoring pipeline for a live match —
the scraper cron and `DbScorePoller`'s DB-read path (confirmed correct above) are untouched by
every item in §5. §5.1–§5.4 and §5.6 are read/display-layer only: fixing what the preview shows
and where the "unresolved" list is sourced from, never touching `player_match_stats` writes.
Worst case if something's off after deploy is the preview looks wrong again, same failure mode
as today, not a new one — and since `db.js`/`admin.js` are cache-busted by version number, an
admin's *already-open* tab keeps running today's code untouched until they reload, so shipping
mid-match can't disrupt a session that's already watching M15.

The one item worth sequencing after the rest, not bundling in: §5.5 (rewiring "Link" to the
scoped Credit path). It changes what a live button actually does, and although the new
behavior is strictly safer, changing it while someone might be actively using it mid-match is
the kind of "action that creates an issue" worth avoiding on principle. Suggest landing §5.1–
§5.4/§5.6 as one deploy, confirming M15's banner clears (or stays correctly silent) on the next
admin page load, then doing §5.5 on its own once nothing's actively live — or immediately after
M15 finishes today, whichever's sooner. No need to wait for a *future* match; M15 finishing
later today is enough of a gap.

## §10 Correction: most of the "review action queue" already existed

Starting implementation surfaced something the earlier review missed entirely: **Review tab
already has a working, DB-backed "🥎 Fielding Issues" queue**, built in migration_v24, reading
`scraper_fielding_issues` via `db.js`'s `getFieldingIssues`/`resolveFieldingIssueAsCredit`/
`ignoreFieldingIssue`. It already does exactly what §5.3/§5.4/§5.6 proposed: persisted,
DB-backed, one safe Credit action per issue (routes through `applyManualFieldingCredit`, the
same single-player-scoped write Schedule's 🥎 button uses — never a whole-match rescore).
`poll-cricapi` (the CricAPI-track cron) already writes into it too, with `source: 'cricapi'`
already a valid value (migration_v41) — so the missing piece was never "build persistence and a
queue," it was narrower than that:

**The actual gap**: `finalizeOneMatch` (admin.js's client-side manual CricAPI Finalize — the
path actually relied on day to day, since `poll-cricapi`'s cron is currently network-blocked
from Supabase's egress, per `connectLive()`'s own comments) computed `fieldingIssues` but never
persisted them anywhere — only `console.warn`. Worse, `finalizeMatchById`'s own status text
explicitly told the admin to go "Open Fantasy Scorecard ↓, click Link on the red rows" to fix
it — pointing at the one path this whole review flagged as unsafe (a live, possibly-mis-scoped
client recompute that blind-upserts the entire match). That's the real mechanism behind today's
confusion: two genuinely separate "fix a fielding credit" surfaces existed side by side, one
correct, one not, and the app's own copy told you to use the wrong one.

**What shipped in this increment** (all read/display-layer or additive — no scoring/write path
touched, safe alongside the live M15 match per §8):

- `db.js`: new `insertFieldingIssues(tournamentId, matchId, issues, source)` — the client-side
  counterpart to what `poll-cricapi`/`scrape-scorecard` already do server-side. Skips
  stage-`'parse'` entries (no raw name to persist — mirrors the server silently dropping the
  same case). Writes one row per (rawName, field) actually left uncredited, same
  `onConflict`/`ignoreDuplicates` convention as the two edge functions.
- `db.js`: `listMatchesNeedingFinalization` now also selects `tournament_id` — needed by the
  above, wasn't in the select list before.
- `admin.js`: `finalizeOneMatch` now calls `insertFieldingIssues(..., 'cricapi')` before
  returning — best-effort, wrapped so a failure here can't fail the finalize itself.
- `admin.js`: `finalizeMatchById`'s status text no longer tells the admin to fix fielding
  credit via Fantasy Scorecard's Link — it now says fielding credit is queued in Review → 🥎
  Fielding Issues. The unmatched-*player* Link guidance (a different, legitimately-safe case —
  see §5.5's carve-out) is unchanged.
- `admin.js`: removed the Fantasy Scorecard tab's own "Credit to X"/"Link" controls for
  fielding issues entirely (`fieldingIssueRowHtml`'s action branches, `expandFieldingLinkRow`,
  and their event wiring). The banner is now informational only — it names the count and points
  at Review → 🥎 Fielding Issues, with no button that could disagree with the database.

**Deliberately not done in this increment**: §5.1 (the `matchSquadFor`/`A.PLAYERS` scoping fix)
and §5.2 (Fantasy tab preferring saved stats over live recompute) are now lower-stakes, since
the piece that made a mis-scoped live guess actionable (and thus dangerous) is gone — what's
left is a cosmetic accuracy question for the preview's own point totals, not a "which button do
I trust" question. Left as an optional follow-up, not blocking. §5.5 (rewiring `linkPlayerAndRescore`
callers) is now largely moot for the fielding case specifically, since there's no fielding
"Link" button left to rewire — it still stands as a real precaution for the *player-identity*
Link case, which was never part of today's confusion and is left untouched.

## §9 Open questions

- ~~Widen `scraper_fielding_issues` vs. a separate table~~ — **resolved**: neither was needed,
  `source: 'cricapi'` was already a valid value. See §10.
- Should the Fantasy Scorecard tab keep *any* live-preview fielding computation for genuinely
  in-progress, nothing-saved-yet matches, or should it just show "pending" until the next
  scrape/poll lands? Keeping a live estimate is more useful mid-match but reintroduces exactly
  the "could disagree with reality" risk this plan is trying to remove — worth deciding
  deliberately rather than defaulting to keeping it.
