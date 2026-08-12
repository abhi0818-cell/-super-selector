# Scorecard Viewer — `show_mlc_final_scorecard.mjs`

A local script that pulls a completed match's scorecard straight from Supabase and renders it as a polished HTML page (instead of scrolling raw JSON in the terminal). It also surfaces dot-ball counts, which aren't present in the cached scorecard payload itself.

## Setup (one time)

1. Open Terminal.
2. Go to the project folder:
   ```
   cd "/Users/vidulagupta/Documents/Claude/Projects/Super Selector"
   ```
3. Install the one dependency it needs:
   ```
   npm install @supabase/supabase-js
   ```

## Running it

Basic form:
```
node show_mlc_final_scorecard.mjs --tournament "<name>" --match <number>
```

Short flags work too:
```
node show_mlc_final_scorecard.mjs -t "<name>" -m <number>
```

Example:
```
node show_mlc_final_scorecard.mjs -t "Major League Cricket" -m 12
```

- `-t` / `--tournament` — partial, case-insensitive match against `tournaments.name`. `"MLC"` and `"Major League Cricket"` both work.
- `-m` / `--match` — the match's `match_number`. If you leave it out, the script looks for a completed match whose `notes` field mentions "final"; if none is found, it falls back to the highest `match_number` in that tournament.

What happens when you run it: it writes `scorecard_output.html` next to the script and opens it automatically in your browser.

## Setting permanent defaults (so you don't type flags every time)

Open `show_mlc_final_scorecard.mjs` and find this line near the top (~line 47):

```js
const out = { tournament: 'MLC', match: null, raw: false, open: true };
```

Change the values to whatever you want as defaults, e.g.:

```js
const out = { tournament: 'Major League Cricket', match: 12, raw: false, open: true };
```

Save the file. From then on, running the script with no flags at all does the same thing:

```
node show_mlc_final_scorecard.mjs
```

You can still override any default by passing a flag on the command line — flags always win.

## Other flags

| Flag | What it does |
|---|---|
| `--raw` | Skips the HTML page and prints the untouched JSON payload to the terminal instead. Useful for debugging a specific match's data shape. |
| `--no-open` | Still writes `scorecard_output.html`, but doesn't auto-open it in your browser (in case you want to open it manually or view it later). |

## Reading the output

- Each innings shows a **batting table** (runs, balls, 4s, 6s, dismissal) and a **bowling table** (overs, maidens, runs, wickets, dots).
- **Dot balls are highlighted in yellow.** These come from `player_match_stats.bowling.dotBalls`, not from the cached scorecard — the scraper (CricketAddictor/Business Standard) computes and scores dot balls correctly, but drops them when it builds the snapshot it caches into `match_scorecards`. A `—` in the Dots column means no matching `player_match_stats` row was found for that bowler's scraped name.
- The subtitle line under the match name shows which **source shape** the cached payload used — `cricapi` (direct CricAPI fetch) or `scraper` (CricketAddictor/Business Standard via the scrape-scorecard Edge Function). They store the scorecard array at different JSON paths (`payload.scorecard` vs `payload.data.scorecard`), and this is handled automatically.

## Known data quirk: truncated batter names

Some dismissals (bowled, LBW, run-out) can show a truncated `batsman.name` — e.g. `"Obus"` instead of `"Obus Pienaar"` — with the rest of the real name leaking into the dismissal text. This comes from the upstream source (CricAPI or the scraper's parsed HTML) — nothing in this script or the app transforms names before caching. It matters because the app's player-name matcher (`findLocalByName`) can't resolve a single truncated token to the right local player, so that player lands in the unmatched-names list during finalize and needs manual reconciliation in the admin panel.

## If something looks wrong

- **"No tournament matching..."** — double check the `-t` spelling, or try a shorter partial string.
- **"No completed match with match_number N..."** — the error message lists all completed match numbers for that tournament; pick one from that list.
- **"No cached scorecard found in match_scorecards"** — finalize hasn't run for that match yet (or failed). The page will fall back to showing raw `player_match_stats` rows if any exist.
