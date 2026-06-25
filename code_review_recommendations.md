# Super Selector — Architecture & Duplication Review

Scope: read-only review of `index.html` (14,734 lines), `db.js` (4,223 lines), and the mobile app under `app/src` (~11,937 lines across TS/TSX). No code was changed — this is recommendations only.

## Summary

The dominant issue isn't function-level code quality — individual functions are generally readable and commented. The dominant issue is structural: `index.html` has grown into a single 14.7k-line file with no module boundaries, and several pieces of business logic are independently reimplemented in both the web client and the mobile app, with no shared source of truth. Those two things are the highest-leverage targets.

## Finding 1 — `index.html` is one script, not an app

The file has exactly two `<script>` tags: a tiny inline one, and a single `type="module"` block that runs from line 1948 to the end of the file (~12,800 lines). Everything lives in that one scope, sharing one global `state` object: the scoring engine, the CricAPI adapter, auth, the DB layer glue, every page's rendering, every admin tool, CSV import, the rules editor, live-score polling, and event wiring. There are 276 top-level function declarations in that single scope.

Concretely, the file currently reads as one long sequence of section-comment dividers (`// ─── SECTION NAME ───`) rather than separate modules — e.g. `AUTH SETUP`, `DB SETUP`, `RENDERING`, `XI PICKER TAB`, `SEASON TAB`, `PLAYER ADMIN`, `MATCHES ADMIN`, `CRICAPI MATCH SYNC`, `TEAMS ADMIN`, `CSV IMPORT`, `RULES EDITOR`, `EVENT WIRING`. Each section is a real, coherent feature — the problem is they're all concatenated into one un-namespaced script rather than separated into modules with explicit boundaries.

**Why it matters:** any change anywhere can in principle touch shared global state (`state`, `lbState`, `activeRulesContest`, etc.), there's no way to load/test a piece (e.g. the rules editor) in isolation, and onboarding or navigating the file by hand requires scrolling through admin tooling to find user-facing code and vice versa.

## Finding 2 — Admin tooling ships inside the same bundle as the player-facing app

Roughly 3,800 lines (~26% of the file, lines 8975–12795) are admin-only features — Player Admin, Matches Admin, CricAPI Match Sync, Teams Admin, CSV Import, Rules Editor — living in the same file, same script scope, and same global `state` as the code every regular player loads. Separation today is presumably just a UI-level `is_admin()` check, not a build-time split. Every visitor's browser downloads and parses the full admin toolkit even though only one user (the admin) ever uses it.

Related observation, not a deep security review but worth flagging: the "API key fallback helpers" section (line 10823) manages CricAPI keys via a plain `<input>` + `localStorage` on the client. If that input is reachable outside the admin-gated UI, or if multiple keys are visible client-side, that's a separate exposure question worth a dedicated security pass if you want one later.

## Finding 3 — The same business logic is independently reimplemented in web and mobile

This is the most concrete, evidence-backed finding, and the one most likely to cause real bugs (as it already has this session). Three pieces of logic exist as **separate, hand-synchronized implementations** in `index.html`/`db.js` versus `app/src`:

1. **The scoring engine itself.** `index.html` has its own `SCORING_ENGINE` section (~line 1954) computing batting/bowling/fielding points and captain/VC multipliers. The mobile app has a fully separate 253-line implementation at `app/src/engine/cricketScoringEngine.ts`. These are two independent codebases computing the same fantasy-points math — any scoring rule change has to be ported by hand to both, and nothing guarantees they stay identical.

2. **Dot-ball clamping** (`dot_ball_enabled`/`dotBallEnabled`/`dotBallOn`). Confirmed present, separately implemented, in `index.html`, `db.js`, `app/src/screens/RulesScreen.tsx`, `app/src/lib/seasonHistory.ts`, and `app/src/lib/dailyLeaderboard.ts` — five separate spots that all need to agree on the same gating rule. (This is exactly the bug pattern from earlier this project's history, where the same toggle had to be patched into the scraper, the poller, the web client, and three mobile files individually.)

3. **Match lock-time / "has this match started" logic.** Present in `index.html`, `db.js`, and five mobile files (`HomeScreen.tsx`, `MyLiveTeamModal.tsx`, `seasonHistory.ts`, `matchLock.ts`, `teamStore.ts`). Mobile at least centralizes its own copy in `matchLock.ts` — but web has no equivalent shared helper, so web and mobile each maintain their own version of "is this match locked" with no shared definition.

4. **Leaderboard display-name fallback** (`team_name ?? display_name ?? …`). The exact same fallback chain is duplicated in `db.js` (`getProfiles`, `getLeaderboardSL`) and in mobile (`leaderboardStore.ts`, `dailyLeaderboard.ts`) — four copies of a one-line rule.

**Why it matters:** web and mobile are different runtimes (browser JS vs. React Native/TypeScript), so they can't literally share a JS module without introducing a build step — but the actual fix doesn't require that. The values in cases 2–4 are deterministic and already computed server-side or known at write-time; they could be computed once (in Postgres, or in the API layer) and read by both clients instead of being recomputed independently in four or five places. Case 1 (the full scoring engine) is the hardest to centralize this way since it needs to run client-side for live/optimistic UI, but it's also the highest-risk duplication — a scoring rule change made on one platform and missed on the other directly produces wrong leaderboard points.

## Finding 4 — Large feature blocks mix templating, business logic, and event wiring inline

Looking at gaps between named function declarations, several stretches run 200–900+ lines with only one or two named functions and dozens of inline arrow-function event handlers and template strings interleaved (e.g. `renderTournamentActiveToggles()` at line 3844 is followed by ~900 lines containing 46 inline `addEventListener`/arrow-function closures before the next named function). This isn't necessarily wrong — it's a common pattern for "render a list, wire each row's buttons inline" — but it does mean a single conceptual feature (e.g. tournament admin) is one long unbroken block rather than composed of smaller named, testable pieces.

## Finding 5 — No automated tests anywhere in the repo

A search for test files (`*.test.*`, `__tests__/`) across the whole project returned nothing. Combined with Finding 3, this means the duplicated logic across web and mobile has no automated check that would catch drift when one side changes and the other doesn't.

## Prioritized recommendations (no action taken — for your review)

1. **Centralize the duplicated deterministic logic (Finding 3, items 2–4) server-side or in the API layer**, so web and mobile both read one computed value instead of each recomputing it. This is the highest ratio of risk-reduced to effort.
2. **Decide on a strategy for the scoring engine duplication (Finding 3, item 1)** — e.g. a small shared package built once and consumed by both a web bundle step and the RN app, or accept the duplication but add a test that asserts both engines produce identical output for a fixed set of fixtures.
3. **Split `index.html`'s admin tooling out of the player-facing bundle (Finding 2)** — even keeping it as plain JS, loading admin code only behind the `is_admin()` gate (lazy-loaded script) would shrink what every regular player downloads by roughly a quarter.
4. **Introduce module boundaries inside `index.html` (Finding 1)** along the lines the section comments already imply — state, rendering, DB glue, and each major feature area are logically separable today; making that explicit (even via plain ES module files loaded by the existing `type="module"` script, without a build step) would make the file navigable and reduce the blast radius of changes.
5. **Add a minimal test suite (Finding 5)**, starting with the scoring engine and the duplicated fallback/clamp logic identified above — these are pure functions and cheap to test, and would catch the exact class of bug this project has already hit more than once.
