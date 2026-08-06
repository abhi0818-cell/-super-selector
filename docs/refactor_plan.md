# Super Selector — Refactor Plan
*Ordered by impact-to-risk ratio: highest value, safest changes first.*

---

## Phase 1 — Safety net before anything else
**Goal: make future changes verifiable. Zero structural change to the app.**

### 1a. Unit tests for the scoring engine
- Write a small test file (Vitest or Jest) that imports `app/src/engine/cricketScoringEngine.ts` and asserts expected points output for a fixed set of player-stat fixtures (boundaries, wickets, maidens, duck, dot balls, captain/VC multiplier).
- Duplicate those same fixtures in a second test that calls the equivalent logic extracted from `index.html` (as a standalone JS module or inline script — doesn't need the DOM).
- **Impact:** any future scoring-rule change that drifts between web and mobile immediately fails a test instead of silently producing wrong leaderboard points.
- **Risk:** none. Read-only until tests pass; they don't touch production code.

### 1b. Smoke-test the known duplicated helpers
- One test file asserting that the leaderboard name-fallback (`team_name ?? display_name ?? email`) and the dot-ball clamp (`tournament.dot_ball_enabled`) produce identical output from both the web-side and mobile-side implementations.
- **Impact:** catches drift on the bug class that's already caused multiple multi-file patches this project.
- **Risk:** none.

---

## Phase 2 — Eliminate duplicated deterministic logic
**Goal: one source of truth for decisions that shouldn't be recomputed per-client.**
*Prerequisite: Phase 1 tests pass (so you can verify nothing changes after the consolidation).*

### 2a. Move leaderboard display-name resolution to `db.js` only
- Currently the fallback chain `team_name ?? display_name ?? email` is copied in `db.js` ×2 and in `app/src` ×2 (leaderboardStore.ts, dailyLeaderboard.ts). The mobile app should call a shared Supabase RPC or view that already returns the resolved display name, so neither client decides it independently.
- Alternatively, add a Postgres generated/computed column `resolved_name` on `profiles` so both clients always read the same pre-resolved value.
- **Impact:** eliminates 4 copies of a rule that must agree, future changes propagate from one place.
- **Risk:** low. Change is additive (new column or RPC); existing fallback code can be stripped from clients one at a time, with the tests from 1b as a safety check.

### 2b. Move dot-ball gating to the DB query / scoring RPC
- `dot_ball_enabled` is currently checked in 5 separate places. Rather than having each client fetch the tournament flag and clamp locally, make the scoring-points stored in `user_match_xi_scores` and `user_team_match_scores` already reflect the correct gating at write time (the existing scraper/poller pipeline already sets this — the issue is reads also re-apply it).
- Short of a full server-side compute, at minimum consolidate the "should I show dot-ball?" display check into one shared helper per codebase (one function in `db.js` for web, one import from `matchLock.ts`-style module for mobile) rather than inline per-component.
- **Impact:** eliminates the "patch N files" pattern for any future scoring-flag change.
- **Risk:** low for the display/UI consolidation path. Medium if moving actual score computation server-side (requires re-scoring past matches or careful migration).

### 2c. Centralise match-lock logic on the web side
- Mobile already has `app/src/lib/matchLock.ts`. Web (`index.html`) has its own inline version. Extract a `isMatchLocked(match)` pure function in `db.js` (or a small separate `matchUtils.js`) and replace all inline callers in `index.html`.
- **Impact:** one definition of "has this match started/locked" rather than several that can drift.
- **Risk:** low. Pure function refactor, behavioural output identical.

---

## Phase 3 — Admin / user bundle split
**Goal: regular players don't download and parse ~3,800 lines of admin tooling.**

- Move the admin-only sections (Player Admin, Matches Admin, CricAPI Sync, Teams Admin, CSV Import, Rules Editor — lines 8975–12795) into a separate `admin.js` file loaded only when `is_admin()` is true.
- The `index.html` script drops to roughly 9,000 lines; the admin module loads lazily on first admin action.
- While doing this: audit what the "API key fallback helpers" section exposes client-side (CricAPI keys stored in localStorage/input fields). Consider whether those keys should be managed via a thin server proxy instead.
- **Impact:** ~25% smaller parse cost for every regular user; admin code is no longer in scope for user-visible errors or unintended access.
- **Risk:** medium. Requires verifying that no admin code is accidentally called from user-facing paths (unlikely given section structure but needs a search pass first). The lazy-load itself is straightforward.

---

## Phase 4 — Module boundaries inside `index.html`
**Goal: make the web client navigable and individually testable by feature.**
*Prerequisite: Phase 1 tests, ideally Phase 2–3 done first so scope is smaller.*

This is the highest-effort, highest-risk phase. Recommended approach:

1. **Don't touch existing code yet.** First, draw the intended module map based on the current section comments — what would the files be if this were split today? (e.g. `state.js`, `auth.js`, `rendering/tournament.js`, `rendering/daily.js`, `rendering/seasonLong.js`, `rendering/contest.js`, `live/cricapi.js`, `admin/*.js`). This map is the design step — it can be done in a day without touching code.

2. **Introduce a build step** (Vite or esbuild, minimal config) that bundles multiple ES module files into the single `index.html` output. This is the structural prerequisite for splitting the file without breaking the no-build-step deployment workflow.

3. **Extract one module at a time**, starting with the sections that are most self-contained and have the clearest I/O contract (e.g. the scoring engine is already a pure-function block with no DOM dependency — it should be the first file extracted). Verify with Phase 1 tests after each extraction.

4. **Replace the shared mutable `state` object** with explicit parameter passing or a lightweight reactive store (even just exporting/importing the object across modules is better than one global). This is the riskiest step and should be last.

- **Impact:** dramatically improves maintainability, makes it possible to test individual features in isolation, reduces merge-conflict surface area.
- **Risk:** high if done all at once. Low per-module if done incrementally with tests in place. The risk is mainly in managing the shared `state` object — that refactor touches almost every function.

---

## Phase 5 — Scoring engine unification
**Goal: one scoring implementation that both web and mobile use.**
*Prerequisite: Phase 1 tests (critical), Phase 4 build step (helpful but not required).*

Once a build step exists (Phase 4), the scoring engine can live in a shared package (e.g. a `packages/scoring` workspace) consumed by both the Vite web bundle and the Expo mobile app. Until then, the Phase 1 tests are the mitigation — they catch any drift between the two copies.

- **Impact:** highest long-term value — a single scoring implementation means rule changes deploy everywhere at once.
- **Risk:** medium-high (new monorepo structure, Expo + Vite both need to consume the shared package, requires build-system work). Much lower risk once Phase 4's build step exists.

---

## Summary table

| Phase | What | Impact | Risk | Effort |
|-------|------|--------|------|--------|
| 1a–1b | Scoring + helper unit tests | High (safety net) | None | Low |
| 2a | Name-fallback → DB/column | Medium | Low | Low |
| 2b | Dot-ball gating → one helper | Medium | Low–Medium | Low |
| 2c | Match-lock → shared util | Low–Medium | Low | Low |
| 3 | Admin bundle split | Medium | Medium | Medium |
| 4 | Module boundaries in index.html | High (long-term) | High | High |
| 5 | Scoring engine shared package | High (long-term) | Medium–High | High |

**Recommended starting point:** Phase 1 (tests) first, then Phase 2a + 2c in parallel — they're small, safe, and immediately reduce the multi-file-patch bug class. Phases 4 and 5 are best deferred until the test safety net exists and the codebase's rate of feature change slows slightly.
