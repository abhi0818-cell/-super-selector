# Plan: One track-aware Finalize action (Recalc retired) + manual-correction guard

Status: ✅ **All 8 steps shipped (2026-08-22).** One design question in §7 is still genuinely open (worth a decision, not blocking); two others got resolved along the way and are marked as such below. See the "Testing note" for what's been verified vs. what still needs a real click-through in the app.
Scope: `admin.js` (Schedule tab match rows, Score Audit panel), no DB schema changes required.

## At a glance — end state

This is the part to check first if the sections below start blurring together. Everything after this is the reasoning that justifies these rows.

**Recalc is retired as a separate button.** Everything it did that was actually worth keeping (reuse a cached scorecard instead of spending a fresh CricAPI call, when the cache already looks finished) gets folded into a single, smarter **Finalize**. Recalc's only genuinely distinct behavior beyond that was *not* flipping `matches.status` to completed — which was never a feature, it was a gap (click Recalc right as a match ends and it gets stuck un-completed forever). Nothing of real value is lost; see §3.2 for the full reasoning.

**Schedule tab row, by lifecycle stage:**

| Stage | CricAPI track | Scraper track |
|---|---|---|
| Scheduled, not started | *(unchanged)* Delay / +15m / +30m / Abandon only | *(unchanged)* same |
| In play | Finalize, 📡 Poll | Finalize, 🕷 Scrape |
| Completed | Finalize, 🥎 Fielding, ↩ Revert-to-Live | Finalize, 🥎 Fielding, ↩ Revert-to-Live |

Compared to today: **Recalc is gone everywhere** (folded into Finalize). **In play / CricAPI** also loses the 🕷 Scrape button (shows on every live match today regardless of track — §3.2). **Completed / Scraper** gains a working Finalize button — today a completed scraper match with no `external_id` shows no buttons at all (§3.5).

**What each button does, per track, once this lands:**

| Button | CricAPI track | Scraper track |
|---|---|---|
| Finalize | Reuse a cached CricAPI scorecard if it already looks finished (no API spend), else fetch fresh; score, save, flip status to completed if the data says so; skips any player row tagged `scraper_manual` (§3.6) | Same job via the `scrape-scorecard` edge function |
| Poll (in-play only) | Manually run the 15-min cron early | *(not shown — CricAPI-only action)* |
| Scrape (in-play only) | *(not shown — scraper-only action)* | Manually run the scraper early |
| Fielding (completed only) | Manually add missed catch/stumping/run-out/bowled/LBW credit — protected from being clobbered by a later Finalize (§3.6) | Same, same protection |
| Fix (Score Audit) | Rescale stored stats to current rules, no fetch — unaffected by track, unaffected by this plan | Same |

Score Audit's per-row mismatch actions become **Fix** (unchanged — stored-only rescale) and **Re-finalize** (calls the same merged Finalize function instead of a separate Recalc implementation).

**The four real fixes, in one line each:**
1. **§3.1** — one `resolveMatchTrack()` helper instead of three copies of the same rule.
2. **§3.2** — Finalize and Recalc merge into one cache-aware, status-correct action; Recalc disappears as a concept.
3. **§3.5** — the merged Finalize is actually visible for scraper matches that lack a CricAPI `external_id`.
4. **§3.6** — Finalize stops silently overwriting a fielding correction you just made by hand.

## 1. The problem

The tournament already has a real "which track am I on" concept:

- `tournaments.scraper_enabled` — the tournament-level default (Tournament tab's 🕷 Scraper switch).
- `matches.data_source` — a per-match override (`auto` / `cricapi` / `scraper`), editable in the Schedule tab row.
- Resolution rule: per-match override wins; `auto` falls back to the tournament's `scraper_enabled`.

That resolution logic is implemented **three separate times**, and only two of the three actually use it:

| Where | Uses data_source + scraper_enabled? |
|---|---|
| `poll-cricapi/index.ts` (cron + manual 📡 Poll button) | Yes — own copy of the resolver |
| `scrape-scorecard/index.ts` (cron + manual 🕷 Scrape button) | Yes — own copy of the resolver |
| `admin.js` `isCricApiDriven` (decides whether to *show* the Poll button) | Yes — third copy of the resolver, client-side |
| `admin.js` `finalizeOneMatch` / `finalizeMatchById` (Finalize button) | **No** — always fetches live from CricAPI, no matter what |
| `admin.js` `forceRefinalizeMatch` (Recalc button) | **No** — CricAPI only (cache-if-finished, else live fetch); no scraper path exists at all |
| `admin.js` `recomputeStoredStatsForMatch` (Score Audit "Fix" button) | N/A — rescales already-stored stats, source-agnostic (this one's already correct) |
| Score Audit's row-level "Recalc" button | **No** — unconditionally calls the CricAPI-only `forceRefinalizeMatch`, even for scraper-tournament rows |
| `finalizeCompletedMatches` (bulk "Finalize completed") | **No** — same CricAPI-only path, filtered only by "has an `external_id`", not by track |

Consequences visible today:

- A scraper-tournament match row shows **both** "Finalize"/"Recalc" (CricAPI, wrong track) **and** "🕷 Scrape" (correct track) at the same time — two buttons that look like alternatives but one of them is silently wrong for that match.
- "Recalc" and Score Audit's "Recalc" have a code comment admitting they're unreliable for scraper tournaments ("...matches usually have no real CricAPI external_id to refetch from") — a known gap.
- 🕷 Scrape only renders while `isInPlay` — once a scraper-driven match is marked completed, there is **no correct one-click "redo this match" action** in the UI at all. Whether the leftover buttons are "wrong track" or genuinely nothing depends on `external_id`: Finalize/Recalc are gated on `m.external_id` existing, and scraper matches usually don't have one — so a completed scraper match with no `external_id` shows **zero** action buttons, not just wrong-track ones. See §3.5.
- Bulk "Finalize completed" decides eligibility purely by `external_id IS NOT NULL`. A scraper-tournament match that happens to have a stale `external_id` set would get silently CricAPI-finalized against the wrong track.
- Separately from track: a manual fielding correction (Review tab "Credit", or the row's 🥎 Fielding button) can be silently undone by a later Finalize/Recalc click, on **either** track — see §3.6.
- **Recalc and Finalize turned out to mostly duplicate each other, with Recalc carrying an actual bug:** mid-match, Recalc's one distinguishing feature (cache reuse) never triggers — a live match's cache never "looks finished" — so it falls through to the exact same live CricAPI fetch Finalize always does. The one place they genuinely differ is that Recalc never updates `matches.status`, in any circumstance. That means clicking Recalc instead of Finalize right as a match ends saves correct final stats but leaves the match permanently stuck as not-completed — worse than doing nothing, since every "needs finalization" / live-polling filter keys off `status='completed'`. See §3.2 for why the fix is to retire Recalc rather than patch it.

None of this is a data-integrity bug in the automated pipeline — `poll-cricapi`/`scrape-scorecard` are already track-correct and are what actually keep stats current day to day. The gaps are entirely in the **manual admin actions**.

## 2. Design goal

One resolver, one action per match row, routed to the track that's actually configured — instead of a CricAPI-shaped action set (Finalize + Recalc) with a scraper action (Scrape) bolted on separately, and two near-duplicate buttons for admins to choose between.

```
resolveMatchTrack(match, tournament) → 'cricapi' | 'scraper'
  1. match.data_source === 'cricapi' → 'cricapi'
  2. match.data_source === 'scraper' → 'scraper'
  3. otherwise (data_source is 'auto'/unset) → tournament.scraper_enabled ? 'scraper' : 'cricapi'
```

This already exists three times (poll-cricapi, scrape-scorecard, `isCricApiDriven`) — the fix is to write it once, client-side, and use it everywhere admin.js currently guesses or hardcodes CricAPI.

## 3. Proposed changes

### 3.1 One shared resolver (admin.js)

Add `function resolveMatchTrack(match, tournament)` near the top of admin.js, matching the exact rule already documented in `poll-cricapi/index.ts` and `scrape-scorecard/index.ts` (`data_source` override → `scraper_enabled` fallback). Replace the inline `isCricApiDriven` computation with a call to it, so there's exactly one place this rule lives client-side (the two edge functions keep their own copies server-side — see §5 on why we're not merging those).

### 3.2 Merge Finalize + Recalc into one track-aware, cache-aware action

**Why merge instead of just fixing Recalc's track routing:** working through Recalc's actual behavior turned up that it doesn't have an independent reason to exist.

- **Mid-match**, Recalc's only distinguishing feature — reuse a cached scorecard — never activates, because a live match's cache can never "look finished." So mid-match it falls through to the same live CricAPI fetch Finalize always does. The one place it *does* differ from Finalize is that it never calls `updateMatch` to flip `matches.status` — not a deliberate feature, just an omission. Click Recalc right as a match completes and you get correct final stats but a match permanently stuck as not-completed, silently breaking every `status='completed'` filter downstream.
- **Post-completion**, Recalc's cache-reuse *is* real and worth keeping — it avoids spending a CricAPI call when a finished-looking scorecard is already cached, and it re-parses that cached payload from scratch rather than just rescaling whatever's currently stored (so it can catch a bad *parse*, not just a bad *score calculation*, unlike Score Audit's "Fix"). But that's an argument for making **Finalize** smarter, not for keeping a second button — Finalize today deliberately always fetches fresh ("a cached version may be mid-match... overwrite with final result"), specifically to avoid reusing a stale in-progress cache. Recalc's actual check — reuse the cache *only if it already looks finished*, otherwise fetch fresh — gives the exact same protection Finalize wants, plus the free re-parse when it's safe. There's no scenario where Finalize's blunter "always fetch" is preferable once that check is folded in.

**The merge:** `finalizeOneMatch` (called by both the per-row Finalize button and bulk "Finalize completed") adopts `forceRefinalizeMatch`'s cache-check as its first step, keeps its own status-flip logic, and gains the §3.6 manual-correction guard. `forceRefinalizeMatch` is deleted. The Recalc button disappears from the Schedule tab row and from Score Audit's per-row actions (Score Audit's "Recalc" becomes "Re-finalize," calling the same merged function).

**Track routing, on the single remaining button:**

- `cricapi` track → merged behavior above (cache-if-finished else fetch, score, save, conditionally flip status, guard manual corrections).
- `scraper` track → call the `scrape-scorecard` edge function for this match (same call the manual 🕷 Scrape button already makes) instead of pretending the CricAPI path exists.

**Poll and Scrape** stay as separate, lighter-weight, in-play-only convenience actions — they were never redundant with Finalize, only with each other:

```js
${isInPlay && isCricApiDriven ? `<button class="row-poll">📡 Poll</button>`   : ''}
${isInPlay                    ? `<button class="row-scrape">🕷 Scrape</button>` : ''}
```

`Poll` is already gated by `isCricApiDriven` — only shows on the CricAPI track. `Scrape` has no track check at all — it shows on every in-play match regardless of track, so a CricAPI-tracked live match shows both Poll (correct) and Scrape (would try scraping a match that may not be listed on CricketAddictor/Business Standard) side by side. Fix: gate `Scrape` to `resolveMatchTrack === 'scraper' && isInPlay`, the same way Poll is already gated, so it stops appearing on the wrong track.

One nuance worth keeping in mind: `poll-cricapi`'s own docstring says the manual "Poll Now" call (body `{matchId}`) "polls one match regardless of `scraper_enabled` (manual override)" — the function itself is deliberately built to allow being forced off-track, even though the button's default visibility is track-gated. That's intentional, not a bug, and doesn't need to change — see §7 for whether a visible override affordance is worth adding on top of the default gating.

Button tooltips get track info baked in, e.g. `title="Fetch & score via CricAPI"` vs `title="Re-run scraper & re-score"`.

Net effect: one action per row that does the right (and only) sensible thing for however that match is configured, plus two small always-safe convenience buttons, instead of four buttons with overlapping, partly-wrong-track, partly-buggy behavior.

### 3.3 Score Audit panel: "Recalc" becomes "Re-finalize"

`renderScoreAuditResults()`'s per-row action that used to hardcode `forceRefinalizeMatch(matchId)` now calls the merged Finalize function from §3.2 (looking up the match's tournament + `resolveMatchTrack()` first, same as the Schedule tab row). Relabel the button "Re-finalize" so it doesn't imply a different mechanism than the Schedule tab's Finalize. "Fix" stays untouched — it's already track-agnostic by design (rescales stored stats, no fetch, no parse), which is correct and doesn't need a track branch.

### 3.4 Bulk "Finalize completed"

`listMatchesNeedingFinalization` currently filters on `external_id IS NOT NULL` only. Add a per-row track check using `resolveMatchTrack()` before calling the merged Finalize in the loop:

- `cricapi` track → merged behavior (§3.2), unchanged from what bulk finalize does today except now cache-aware.
- `scraper` track → route to the scrape-scorecard edge function instead (or, simpler for v1, skip it from this bulk action with a note in the summary — "N scraper-tracked matches skipped, use Schedule tab Scrape/Finalize per row" — since bulk-triggering scrapes for many matches at once is a bigger behavior change than bulk CricAPI finalize and probably deserves its own decision later).

This closes the "scraper match with a stale `external_id` gets wrongly CricAPI-finalized in bulk" edge case from §1. It does **not** by itself pull scraper matches with no `external_id` into the bulk pending list — see §3.5, which the underlying query also needs.

Small bonus once the merge lands: `finalizeCompletedMatches` already computes and displays "(`N` from cache, `M` from CricAPI)" in its status line — but today that's aspirational, since `finalizeOneMatch` never actually checks the cache, it always fetches. Once the merge adopts the cache-check, that existing status message becomes accurate for the first time, at no extra cost.

### 3.5 Visibility gate: `external_id` vs `scorecard_url` (the fix that actually closes the "no button at all" gap)

Today, Finalize/Recalc are gated purely on `m.external_id`:

```js
${(isFinished || isInPlay) && m.external_id ? /* Finalize button */ '' : ''}
```

That assumes every actionable match has a CricAPI `external_id`. Scraper-tracked matches identify by `m.scorecard_url` instead, and — per the code's own comment elsewhere — "usually have no real CricAPI external_id to refetch from." So a **completed scraper-tracked match with no `external_id`** currently renders zero action buttons: Finalize is hidden (no `external_id`), and Scrape is also hidden (`isInPlay` is false once completed). There is no way to redo that match's stats from this row today — only Score Audit's stored-only "Fix" (which can't help if the stats were never captured right in the first place), or manual SQL.

Fix — make the gate track-aware instead of `external_id`-only:

```js
const track = resolveMatchTrack(m, matchTournament);
const hasSourceId = track === 'cricapi' ? !!m.external_id : !!m.scorecard_url;
${(isFinished || isInPlay) && hasSourceId ? /* Finalize button */ '' : ''}
```

This is the change that actually closes the "no correct redo action for a completed scraper match" gap. §3.2's routing fix (send scraper-track clicks to `scrape-scorecard` instead of CricAPI) only matters once the button is allowed to render in the first place — without this gate fix, §3.2 would have no effect for the exact matches it's meant to help.

The same gate applies to bulk "Finalize completed" (§3.4): `listMatchesNeedingFinalization`'s current `.not('external_id', 'is', null)` filter needs to become "has `external_id` on the cricapi track, OR has `scorecard_url` on the scraper track" — otherwise scraper matches with no `external_id` are excluded from the bulk pending-list query itself, before any track-checking even runs, and never even reach the per-row logic §3.4 describes.

### 3.6 Manual fielding corrections can be silently overwritten by Finalize

Found while answering "if I resolve a fielding issue and then hit Finalize or Recalc, does that clear the discrepancy?" — the answer turned out to be more important than the track question: resolving the issue already fully resolves it by itself, and clicking Finalize (or, previously, Recalc) afterward can **undo** it.

**How a fielding correction is applied.** Both the Review tab's "Credit" button and the Schedule tab's 🥎 Fielding button call the same function, `applyManualFieldingCredit`. It patches the player's `player_match_stats` row directly: adds the event to `fielding`, adds the points to `raw_points` (additively), tags the row `source: 'scraper_manual'`, and the caller immediately follows up with `computeAndSaveXIScoresForMatch` + `computeAndSaveSLScoresForMatch` to push the corrected total into the daily/season-long score tables. The fix is fully applied and cascaded the moment you click Credit — nothing else needs to run.

**Why Finalize can undo it.** `finalizeOneMatch` (and, before the merge, `forceRefinalizeMatch` too) rebuilds the row from a fresh CricAPI parse and calls `bulkUpsertPlayerMatchStats` with new `batting`/`bowling`/`fielding`/`raw_points` — with **no check of the row's `source` at all**. Compare that to `scrape-scorecard/index.ts`'s own cron, which the code explicitly documents as having a "per-player regression guard" specifically so it never overwrites a `source='scraper_manual'` row. The client-side code never got that same guard, and `bulkUpsertPlayerMatchStats` itself doesn't add one either — it upserts whatever payload it's given. Since the payload doesn't include `source`, the tag itself survives the upsert (Postgres/PostgREST only updates columns present in the payload) — but the tag surviving is actually worse: the row still *reads* as `source: 'scraper_manual'` afterward even though the actual `fielding`/`raw_points` values it's tagged as protecting were just silently replaced. No error, no warning — the correction is just gone.

This applies on **both tracks** — it's not a track-routing bug, it's a missing regression guard.

**Recommended fix:** before overwriting a row in the merged Finalize (§3.2, both the CricAPI branch and the scraper-track edge-function call), check the existing row's `source`. If it's `scraper_manual`, skip overwriting `fielding`/`raw_points` for that player (or merge additively instead of replacing) — mirroring the guard `scrape-scorecard/index.ts` already has. This is a small, surgical change: one existing-row lookup per player before the upsert, same shape as `applyManualFieldingCredit` already does. Now that Finalize is the only function doing this overwrite (Recalc is gone), there's exactly one place that needs the guard instead of two.

### 3.7 `scraper_manual` protection never expires — mid-match manual entries need a second manual re-save at the end

**Not yet implemented — follow-up, raised while building the Manual Scorecard admin feature.**

Manual Scorecard (`saveManualScorecardForMatch`, admin.js) tags its rows `source: 'scraper_manual'` so a mid-match paste survives `scrape-scorecard`'s 15-min cron (§3.6's guard, and the identical one `bulkUpsertPlayerMatchStats` now honors via an optional `source` param). That protection is correct but permanent: once a row is tagged, the cron's per-player guard (`ex.source === 'scraper_manual'` → always skip) never writes to it again, full stop — there's no path back to automated updates.

**The gap this creates.** An admin who pastes mid-match because the scraper is currently stuck/broken has no way to hand control back once the scraper recovers and would otherwise have legitimately caught up (or surpassed) the manually-entered state. The match's real, final result never lands automatically — the admin has to remember to come back and manually re-paste the complete scorecard once the game actually ends. Forgetting this leaves the match's fantasy points permanently frozen at whatever partial state was pasted mid-match.

**Recommended fix.** Make the guard catch-up-aware instead of unconditional: for a `scraper_manual` row, compare the fresh scrape's ball-count (batting `ballsFaced` / bowling `ballsBowled`) against the stored row's. If the fresh read is *strictly ahead*, treat it as the scraper having legitimately caught up and let it overwrite normally — the same monotonic-progress reasoning §1's regression guard already uses for ordinary rows, just inverted (currently `scraper_manual` skips regardless of direction; the fix would make it skip only when the fresh read isn't ahead). This closes the loop without weakening protection during the window that actually matters — while the scraper is still stuck at or behind where the manual entry left off.

Same fix would apply symmetrically to `poll-cricapi` if/when CricAPI polling is re-enabled (see the standalone note: `poll-cricapi` currently has no `scraper_manual` check of any kind, unlike `scrape-scorecard` — a separate, pre-existing gap, not introduced by this feature, but worth closing at the same time since it's the same guard).

## 4. What does NOT change

- The cron pipeline (`poll-cricapi`, `scrape-scorecard`) — already correct, not touched.
- `recomputeStoredStatsForMatch` ("Fix") — already track-agnostic, correct as-is, and unaffected by the §3.6 guard (it never overwrites `fielding`, only recomputes `raw_points` from whatever's currently stored).
- The Tournament tab's 🕷 Scraper switch and the per-match `data_source` dropdown — these are the inputs the new resolver reads, not touched.
- DB schema — no new columns; `data_source` and `scraper_enabled` already exist and already carry the information needed.
- Run Score Audit's own compare pass (bulk, stored-copy-only) — no change, it's already source-agnostic since it just diffs stored `raw_points` against a recompute.
- Poll and Scrape's actual fetch/parse/score logic — only their row-visibility gating changes (§3.2); the edge functions themselves are untouched.

## 5. Why not just call the edge functions for everything (incl. CricAPI)?

The merged Finalize still reimplements CricAPI fetch+parse+score client-side rather than calling `poll-cricapi` for a single match. That's a second source of duplication worth flagging, but it's a bigger, riskier change (moves scoring logic execution from the browser to the edge function for the manual path, changes error-handling/latency characteristics, and the two implementations have already drifted slightly — e.g. role-handling nuances). Recommend treating "unify CricAPI-path duplication between admin.js and poll-cricapi" as a **separate, later** cleanup, not bundled into this change.

Worth noting: §3.6's guard is exactly the kind of thing that already exists correctly in `poll-cricapi`/`scrape-scorecard` and was missing only in admin.js's own reimplementation — a second concrete data point (alongside the scraper-track gap, and the Recalc status-flip gap) for why that reimplementation keeps drifting from the edge functions it duplicates. Still recommending this stay a later cleanup rather than pulled into this change — but worth weighing against the fact that we're now up to three correctness gaps found in the client-side copy, not just a missing feature.

## 6. Implementation steps (small, independently shippable)

1. ✅ **Done.** Added `resolveMatchTrack(match, tournament)` near the top of admin.js (after the destructured context block, before "PLAYER ADMIN"); swapped the inline `isCricApiDriven` computation to call it. Verified equivalence against the old inline logic across all 224 combinations of `data_source` (undefined/null/''/'auto'/'cricapi'/'scraper'/mixed-case), `scraper_enabled` (undefined/null/false/true), `external_id` (undefined/null/''/set), and tournament (undefined/null) — 0 mismatches. `node --check admin.js` passes.
2. ✅ **Done — combined with step 6, see note below.** `finalizeOneMatch` now leads with `forceRefinalizeMatch`'s cache-check (reuse a cached scorecard only if it already looks finished, else fetch fresh) and its fielding-summary console logging; `forceRefinalizeMatch` itself is deleted. The Recalc button and its `data-act="recalc"` wiring are removed from the Schedule tab row, along with the now-dead `.row-recalc` CSS in index.html. `window.__recalcMatch` (console debug shortcut) is repointed to `finalizeMatchById` instead of dangling on a deleted function.
   **Why step 6 got pulled in here too:** Score Audit's row-level "Recalc" button called `forceRefinalizeMatch` directly — deleting that function without also fixing this call site would have shipped a broken button. So this pass also relabels it "Re-finalize" and points it at `finalizeMatchById` (§3.3), and updates two stale code comments that named `forceRefinalizeMatch`. Verified: no remaining references to `forceRefinalizeMatch`, `.row-recalc`, or `data-act="recalc"` anywhere in admin.js/index.html; `node --check admin.js` passes.
3. ✅ **Done.** `finalizeOneMatch` now looks up each match's existing `player_match_stats` rows via `state.db.getPlayerStatsForMatch()` before building the upsert payload, and excludes any player tagged `source='scraper_manual'` from being overwritten — mirroring `scrape-scorecard/index.ts`'s own "per-player regression guard" exactly (skip-the-row, not merge-the-row, matching that guard's actual behavior rather than the "merge additively" alternative §3.6 also mentioned). The protected count flows through `finalizeOneMatch`'s return value as `manuallyProtected`, and is now surfaced to the admin — in the per-row Finalize status/toast (`finalizeMatchById`) and in bulk Finalize's summary (`finalizeCompletedMatches`) — as "🛡 N manually-corrected player row(s) preserved," so the protection is visible instead of silent. Verified with a standalone simulation of the filter/guard logic across four cases (no corrections / one corrected / all corrected / genuinely nothing matched) — behaves correctly in each, including the edge case where every matched player is protected (no rows to write, but correctly does *not* throw the "nothing matched" error, since that error is for a different failure mode). `node --check admin.js` passes.
4. ✅ **Done.** The row's `hasSourceId` check is now track-aware — `!!m.external_id` on the `cricapi` track, `!!m.scorecard_url` on the `scraper` track — replacing the old `m.external_id`-only gate, so Finalize now actually renders for a completed scraper match with no `external_id` (verified: this is the specific case that showed zero buttons before, confirmed fixed by simulation — see below). Finalize's click handler now goes through a new dispatcher, `finalizeMatchRouted(matchId)`, which resolves the match's track and calls the CricAPI path (`finalizeMatchById`, unchanged) or the scraper path. The scraper path used to be inlined only inside the 🕷 Scrape button's own click handler — pulled it out into a standalone `scrapeMatchNow(matchId)` function so both Scrape and Finalize (on the scraper track) call the same code instead of duplicating ~110 lines of fetch/parse/render logic. Score Audit's "Finalize" (missing-scorecard rows) and "Re-finalize" (mismatch rows) buttons were also switched from calling `finalizeMatchById` directly to calling `finalizeMatchRouted` — needed because `finalizeMatchById`'s internal lookup (`listMatchesNeedingFinalization`, filtered on `external_id IS NOT NULL`) would otherwise misreport a scraper match with no `external_id` as "already finalized" instead of actually scraping it, silently defeating the exact rows Score Audit exists to catch. `window.__recalcMatch` (console shortcut) now points at `finalizeMatchRouted` too, for the same reason.
5. ✅ **Done — shipped together with step 4** (they're the two halves of one behavior change, see step 4's note on why the gate fix and routing fix can't land independently). 🕷 Scrape's visibility is now `isInPlay && track === 'scraper'`, symmetric with Poll's existing `isInPlay && isCricApiDriven` gate — it no longer shows on CricAPI-tracked live matches.

   Verified with a table-driven simulation across 7 track × lifecycle-stage combinations (CricAPI in-play/completed, scraper in-play/completed with and without `scorecard_url`, a scraper match carrying a stale `external_id`, and a degenerate CricAPI match with no `external_id`) — every case's Finalize/Poll/Scrape visibility matched the "At a glance" table above, including the two cases that mattered most: the historically-broken "completed scraper match, no `external_id`" now correctly shows Finalize, and a scraper match with a stale `external_id` correctly stays gated/routed as scraper rather than falling back to CricAPI. `node --check admin.js` passes.
6. ✅ **Done — shipped as part of step 2 above** (the two were coupled by a shared call site, see step 2's note).
7. ✅ **Done.** `listMatchesNeedingFinalization` (db.js) now selects `data_source`/`scorecard_url` and filters on `external_id IS NOT NULL OR scorecard_url IS NOT NULL` instead of `external_id IS NOT NULL` alone — so scraper-tracked matches are no longer silently excluded from the pending list itself. `finalizeCompletedMatches` (admin.js) then splits that pending list by `resolveMatchTrack()`: CricAPI-track matches go through the existing loop unchanged; scraper-track matches are skipped (per the plan's "simpler for v1" recommendation — `scrape-scorecard` wasn't built to be called N times in a tight client loop) with a visible note in both the status line and the final toast ("N scraper-tracked match(es) skipped, use Schedule tab Scrape/Finalize per row"), plus a `scraperSkipped` array on `window.__lastFinalize` for console inspection. Also closes the §1 edge case where a scraper match with a stale `external_id` could get bulk-finalized against the wrong track — it's now correctly classified by `resolveMatchTrack()` regardless of a leftover `external_id`.
8. ✅ **Done.** Finalize's row tooltip became track-aware as a side effect of step 4 ("Fetch scorecard from CricAPI…" vs "…from the scraper…"). Score Audit's "Finalize" (missing-scorecard rows, previously had no tooltip at all) and "Re-finalize" (mismatch rows, previously CricAPI-specific wording) tooltips are now updated to describe both tracks accurately, since both buttons route through `finalizeMatchRouted` and can land on either. Poll/Scrape's tooltips were already accurate and didn't need changes.
8. Update button tooltips/labels to show which track is active per row.

Steps 1, 2, and 6–8 are independently testable and shippable on their own. Steps 4–5 depend on each other and should land as one change. Step 3 should land no later than step 4, so the newly-visible/newly-routed scraper-track Finalize never has a window where it can clobber a manual correction either.

## Testing note

Everything above was verified statically — `node --check` on every touched file after each step, plus targeted standalone simulations of the pure-logic pieces (the `resolveMatchTrack`/`isCricApiDriven` equivalence check in step 1, the manual-correction filter in step 3, and the 7-case track × lifecycle visibility/routing matrix in steps 4–5). None of this was clicked through in the running app against a real Supabase project — worth doing before this reaches anything beyond a test tournament: at minimum, Finalize on one CricAPI match, one scraper match, and one scraper match with no `external_id` (the case that used to show zero buttons); a manual fielding correction followed by a re-Finalize to confirm it survives; and bulk "Finalize completed" on a tournament with at least one match of each track.

## 7. Open questions

**Still genuinely open — worth a decision:**

- Is a visible "try the other source anyway" override worth building for Poll/Scrape, given `poll-cricapi`'s manual path already supports being forced off-track by matchId? Or is hiding the off-track button entirely fine, with a manual `data_source` override on the row as the escape hatch instead? Not built either way — the row simply shows whichever button matches the resolved track, full stop.

**Resolved while building:**

- ~~For bulk "Finalize completed" hitting scraper-track matches: skip-with-note or loop and call scrape-scorecard per match?~~ Went with skip-with-note (step 7) — simplest, and avoids hammering `scrape-scorecard` in a tight client loop it wasn't built for.
- ~~Any workflow relies on Recalc's old "re-parse from cache without touching `matches.status`" behavior?~~ Proceeded with deleting `forceRefinalizeMatch` (step 2) without an explicit answer from anyone but the codebase's own comments, which never suggested that was an intentional use case rather than a side effect of a missing status update. Flagging this here retrospectively rather than pretending it was confirmed — worth a sentence of sanity-check if anyone surfaces a workflow that misses the old behavior.

**Still worth doing, not a design question:**

- Any tournaments currently mid-season with `data_source` overrides set per-match (i.e., a mixed-track tournament) — worth testing against specifically, since that's the case most likely to expose an edge this plan's simulations didn't cover. See the Testing note below.
