# Super Selector — Progress Notes

Fantasy cricket app. Working prototype that lets you draft an XI, set captain/VC, and watch live points tick up against either a mock match or a real CricAPI feed.

_Last updated: May 9, 2026_

## Files in this folder

- `cricketScoringEngine.js` — pure scoring engine. Exports `calculateScore`, `scoreTeam`, `SCORING_RULES`, `MULTIPLIERS`, `formatScoreReport`. Supports T20, ODI, Test formats.
- `cricketApiAdapter.js` — normalisation layer for CricAPI, Sportmonks, and generic webhooks into the engine's expected shape. Includes `LiveMatchPoller` class with retry back-off, in-flight dedup, delta detection.
- `index.html` — single-file UI (vanilla JS, no build step). Engine + adapter logic is **inlined** so the page works from a double-click; the standalone .js files remain the source of truth.
- `PROGRESS.md` — this file.

## What's done

- 30-player mock IPL pool across 8 teams (CSK, MI, RCB, KKR, SRH, DC, RR, GT) with roles and credits.
- Player picker with role chips (All / WK / BAT / AR / BOWL) and a search box.
- Selected XI panel showing budget left, role split (WK·BAT·AR·BOWL), and max-from-one-team count.
- Standard Dream11 selection rules enforced:
  - 11 players, 100-credit budget
  - 1–4 WK, 3–6 BAT, 1–4 AR, 3–6 BOWL
  - Max 7 from any one real team
- Captain (2×) and Vice-Captain (1.5×) toggles per player, with auto-swap if the same player is reassigned.
- Live scoreboard with per-player breakdown (click a row to expand).
- Format selector (T20 / ODI / Test) — engine recalculates against the right rule set.
- Mock match simulation: ticks every 1.5 s, generating randomized batting / bowling / fielding events for selected players, fed back through `scoreTeam()`.
- Optional CricAPI live mode (Settings panel): enter a key + match ID, the bundled `LiveMatchPoller` polls every 30 s and maps players back to the XI by name. CORS limitation documented in the UI — may need a backend proxy in production.
- Inline validation messages: warns on incomplete XI, errors on over-budget / role limits / team cap, success state when squad is valid.

## Verified behaviour (test runs)

- Captain 2× / VC 1.5× multipliers apply correctly.
- Duck penalty (-2 T20, -3 ODI, -4 Test) fires for batters/AR/WK on dismissal at 0; not for pure bowlers.
- Strike rate bonuses kick in only after the 10-ball threshold.
- Economy bonuses kick in only after 12 balls bowled (2 overs).
- 4-wicket and 5-wicket haul bonuses (ODI / Test).
- Role limits block selection (e.g. 7th bowler rejected when limit is 6).
- 50-tick mock match produces sensible totals (~250 pts for an XI).

## What's not done / ideas for next

- Persistence of drafted XI (localStorage isn't supported in artifacts, but vanilla HTML can use it freely).
- Multiple saved teams / contests to compare.
- Leaderboard view if multiple users / multiple drafted teams exist.
- Player photos and team logos (currently text-only).
- Player form / recent-match stats to inform credit pricing.
- Better captain-pick heuristics (suggest based on role + form).
- Mobile-tuned layout — currently usable on mobile but not optimized.
- Real CricAPI integration tested against a live match (CORS-aware backend proxy).
- Replace mock IPL squad with a fuller, season-current player list (read from JSON file).
- Test against Sportmonks payload (only the webhook + CricAPI paths are wired into the UI right now).

## Tech notes

- ES modules with `<script type="module">`. No bundler.
- Engine logic is duplicated between `cricketScoringEngine.js` and the inline `<script>` in `index.html`. If you change one, change the other — or refactor to a single source by serving the page via a local dev server (`python3 -m http.server`) so the inline copy can be removed and replaced with a real `import`.
- `window.__SS` is exposed in the page for console debugging: `__SS.state`, `__SS.PLAYERS`, `__SS.scoreTeam(...)`.
