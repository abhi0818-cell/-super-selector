/**
 * cricsheet-parser.js — Super Selector
 * ──────────────────────────────────────────────────────────────────────────────
 * Parses a Cricsheet JSON match file into player_match_stats rows that plug
 * directly into db.bulkUpsertPlayerMatchStats().
 *
 * Cricsheet is an open, free, ball-by-ball dataset for every IPL match:
 *   https://cricsheet.org/matches/  →  "IPL" section  →  JSON format
 *
 * Usage (in index.html after connecting to DB):
 *
 *   import { downloadCricsheetMatch, parseCricsheet } from './cricsheet-parser.js';
 *
 *   // 1. Download the match file from Cricsheet (routed via local proxy)
 *   const raw = await downloadCricsheetMatch('1234567');
 *
 *   // 2. Parse into stat rows (scoring rules from SCORING_RULES in index.html)
 *   const { rows, unmatched, matchInfo } = parseCricsheet(raw, state.players, SCORING_RULES);
 *
 *   // 3. Optionally surface unmatched names for manual linking
 *   if (unmatched.length) console.warn('Unmatched players:', unmatched);
 *
 *   // 4. Persist
 *   await state.db.bulkUpsertPlayerMatchStats(matchId, rows);
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Cricsheet JSON structure (condensed):
 *
 *   {
 *     info: {
 *       teams: ['KKR', 'MI'],
 *       dates: ['2026-05-20'],
 *       match_type: 'T20',
 *       venue: 'Eden Gardens',
 *       event: { name: 'Indian Premier League', match_number: 65 },
 *       outcome: { winner: 'KKR', by: { runs: 25 } },
 *       players: { KKR: ['Phil Salt', ...], MI: ['Rohit Sharma', ...] }
 *     },
 *     innings: [
 *       {
 *         team: 'KKR',
 *         overs: [
 *           {
 *             over: 0,
 *             deliveries: [
 *               {
 *                 batter: 'Phil Salt',
 *                 bowler: 'Jasprit Bumrah',
 *                 non_striker: 'Sunil Narine',
 *                 runs: { batter: 4, extras: 0, total: 4 },
 *                 extras: { wides: 1 },      // optional
 *                 wickets: [                  // optional
 *                   {
 *                     player_out: 'Phil Salt',
 *                     kind: 'caught',         // bowled|caught|lbw|stumped|run out|...
 *                     fielders: [{ name: 'Rohit Sharma' }]
 *                   }
 *                 ]
 *               }
 *             ]
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * ──────────────────────────────────────────────────────────────────────────────
 */


// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT SCORING RULES
// Mirrors DEFAULT_SCORING_RULES in index.html — kept in sync manually.
// Pass your live SCORING_RULES object to parseCricsheet() to use DB overrides.
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_RULES = {
  T20: {
    run: 1, boundary4: 1, boundary6: 2,
    thirty_run_bonus: 4, half_century: 8, century: 16, duck: -2,
    sr_above_170: 6, sr_140_to_170: 4, sr_below_70: -6, sr_70_to_100: -2,
    wicket: 25, lbw_bowled_bonus: 8, maiden_over: 12, dot_ball: 1,
    three_wicket_haul: 8, four_wicket_haul: 8, five_wicket_haul: 16,
    economy_below_5: 6, economy_5_to_6: 4, economy_10_to_11: -4, economy_above_11: -6,
    catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
    no_ball: -1, wide: -1,
  },
  ODI: {
    run: 1, boundary4: 1, boundary6: 2,
    half_century: 4, century: 8, duck: -3,
    wicket: 20, lbw_bowled_bonus: 8, maiden_over: 4, five_wicket_haul: 8, dot_ball: 0,
    economy_below_2_5: 6, economy_2_5_to_3_5: 4, economy_7_to_8: -4, economy_above_9: -6,
    catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
    no_ball: -1, wide: -1,
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// NAME NORMALISATION + FUZZY MATCHING
// Cricsheet uses full names ('Jasprit Bumrah') which often differ slightly from
// your local pool. The matcher tries four strategies in order.
// ═══════════════════════════════════════════════════════════════════════════════

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z ]/g, '')   // strip punctuation / diacritics
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a multi-strategy lookup index from the local player list.
 */
function buildIndex(localPlayers) {
  const exact    = new Map();   // full norm name → player
  const lastName = new Map();   // last word → player (first match wins)
  const tokens   = [];          // [{ words: Set, player }] for partial matching

  for (const p of localPlayers) {
    const n = norm(p.name);
    exact.set(n, p);

    const parts = n.split(' ');
    const last  = parts[parts.length - 1];
    if (!lastName.has(last)) lastName.set(last, p);

    tokens.push({ words: new Set(parts), player: p });
  }

  return { exact, lastName, tokens };
}

/**
 * Find the best local player for a Cricsheet player name.
 * Returns null if no match is found (caller handles as "unmatched").
 */
function findPlayer(cricsheetName, index) {
  if (!cricsheetName) return null;
  const n = norm(cricsheetName);
  if (!n) return null;

  // Strategy 1: exact full name
  if (index.exact.has(n)) return index.exact.get(n);

  // Strategy 2: last name only (handles 'Phil Salt' → local 'Phil Salt')
  const parts = n.split(' ');
  const last  = parts[parts.length - 1];
  if (index.lastName.has(last)) return index.lastName.get(last);

  // Strategy 3: substring — local name contains cricsheet name or vice versa
  for (const [ln, p] of index.exact) {
    if (ln.includes(n) || n.includes(ln)) return p;
  }

  // Strategy 4: token overlap ≥ 2 words (handles initials / middle names)
  const nWords = new Set(parts.filter(w => w.length > 1));
  let best = null, bestCount = 1;   // require at least 2 shared words
  for (const { words, player } of index.tokens) {
    let shared = 0;
    for (const w of nWords) if (words.has(w)) shared++;
    if (shared > bestCount) { best = player; bestCount = shared; }
  }
  if (best) return best;

  return null;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SCORING HELPERS
// Mirror the functions in index.html so this file is self-contained.
// ═══════════════════════════════════════════════════════════════════════════════

function strikeRate(runs, balls) {
  return balls > 0 ? (runs / balls) * 100 : 0;
}

function economy(runs, balls) {
  return balls > 0 ? (runs / balls) * 6 : 0;
}

function srBonus(sr, fmt, r) {
  if (fmt === 'T20') {
    if (sr > 170) return r.sr_above_170  || 0;
    if (sr >= 140) return r.sr_140_to_170 || 0;
    if (sr < 70)   return r.sr_below_70   || 0;
    if (sr < 100)  return r.sr_70_to_100  || 0;
  }
  return 0;
}

function ecoBonus(eco, fmt, r) {
  if (fmt === 'T20') {
    if (eco < 5)   return r.economy_below_5    || 0;
    if (eco < 6)   return r.economy_5_to_6     || 0;
    if (eco >= 11) return r.economy_above_11   || 0;
    if (eco >= 10) return r.economy_10_to_11   || 0;
  }
  if (fmt === 'ODI') {
    if (eco < 2.5) return r.economy_below_2_5  || 0;
    if (eco < 3.5) return r.economy_2_5_to_3_5 || 0;
    if (eco >= 9)  return r.economy_above_9    || 0;
    if (eco >= 7)  return r.economy_7_to_8     || 0;
  }
  return 0;
}

function scoreBatting(bat, fmt, rules) {
  const r = rules[fmt] || rules['T20'];
  const { runs = 0, ballsFaced = 0, fours = 0, sixes = 0, isDismissed = false, role = '' } = bat;
  let pts = 0;
  pts += runs * r.run;
  pts += fours  * (r.boundary4 || 0);
  pts += sixes  * (r.boundary6 || 0);
  if (runs >= 100) pts += r.century      || 0;
  else if (runs >= 50) pts += r.half_century || 0;
  else if (runs >= 30) pts += r.thirty_run_bonus || 0;
  if (isDismissed && runs === 0 && role !== 'bowl') pts += r.duck || 0;
  if (r.sr_above_170 !== undefined && ballsFaced >= 10) {
    pts += srBonus(strikeRate(runs, ballsFaced), fmt, r);
  }
  return pts;
}

function scoreBowling(bowl, fmt, rules) {
  const r = rules[fmt] || rules['T20'];
  const { wickets = 0, wicketTypes = [], maidens = 0, runsConceded = 0,
          ballsBowled = 0, dotBalls = 0, noBalls = 0, wides = 0 } = bowl;
  let pts = 0;
  pts += wickets * r.wicket;
  const premium = wicketTypes.filter(t => ['lbw', 'bowled'].includes(String(t).toLowerCase())).length;
  pts += premium * (r.lbw_bowled_bonus || 0);
  if (wickets >= 5 && r.five_wicket_haul) pts += r.five_wicket_haul;
  else if (wickets >= 4 && r.four_wicket_haul) pts += r.four_wicket_haul;
  else if (wickets >= 3 && r.three_wicket_haul) pts += r.three_wicket_haul;
  pts += maidens  * (r.maiden_over || 0);
  pts += dotBalls * (r.dot_ball    || 0);
  if (ballsBowled >= 12) pts += ecoBonus(economy(runsConceded, ballsBowled), fmt, r);
  pts += noBalls * (r.no_ball || 0);
  pts += wides   * (r.wide    || 0);
  return pts;
}

function scoreFielding(field, fmt, rules) {
  const r = rules[fmt] || rules['T20'];
  const { catches = 0, stumpings = 0, runOutDirect = 0, runOutIndirect = 0 } = field;
  let pts = 0;
  pts += catches       * (r.catch          || 0);
  pts += stumpings     * (r.stumping       || 0);
  pts += runOutDirect  * (r.run_out_direct  || 0);
  pts += runOutIndirect * (r.run_out_indirect || 0);
  return pts;
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PARSER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a Cricsheet JSON match object into player_match_stats rows.
 *
 * @param {object} match
 *   The parsed Cricsheet JSON (fetch + JSON.parse the .json file from cricsheet.org).
 *
 * @param {Array<{id:string, name:string, role:string, team:string}>} localPlayers
 *   Your local player pool — result of db.getPlayers().
 *
 * @param {object} [rules]
 *   Scoring rules object. Pass your live SCORING_RULES from index.html so DB
 *   overrides apply. Defaults to DEFAULT_RULES (T20 baseline).
 *
 * @param {string} [fmt]
 *   Override the format. If omitted, derived from match.info.match_type.
 *
 * @returns {{
 *   rows: Array<{playerId, batting, bowling, fielding, rawPoints}>,
 *   unmatched: string[],
 *   matchInfo: object
 * }}
 *
 *   rows      — ready for db.bulkUpsertPlayerMatchStats(matchId, rows)
 *   unmatched — Cricsheet player names that couldn't be mapped to a local player
 *   matchInfo — extracted metadata (teams, date, venue, winner, match_number)
 */
export function parseCricsheet(match, localPlayers, rules = DEFAULT_RULES, fmt = null) {
  const format = fmt ?? inferFormat(match);
  const idx    = buildIndex(localPlayers);

  // Accumulator maps: Cricsheet player name → stat object
  const bats   = {};   // name → { runs, ballsFaced, fours, sixes, isDismissed }
  const bowls  = {};   // name → { wickets, wicketTypes, maidens, runsConceded, ballsBowled, dotBalls, noBalls, wides }
  const fields = {};   // name → { catches, stumpings, runOutDirect, runOutIndirect }

  // Track everyone seen (batters + bowlers + fielders)
  const allNames = new Set();

  // ── Accumulator helpers ─────────────────────────────────────────────────────

  function bat(name) {
    if (!bats[name]) bats[name] = { runs: 0, ballsFaced: 0, fours: 0, sixes: 0, isDismissed: false };
    return bats[name];
  }
  function bowl(name) {
    if (!bowls[name]) bowls[name] = { wickets: 0, wicketTypes: [], maidens: 0, runsConceded: 0, ballsBowled: 0, dotBalls: 0, noBalls: 0, wides: 0 };
    return bowls[name];
  }
  function field(name) {
    if (!fields[name]) fields[name] = { catches: 0, stumpings: 0, runOutDirect: 0, runOutIndirect: 0 };
    return fields[name];
  }

  // ── Walk every delivery ────────────────────────────────────────────────────

  for (const inning of (match.innings || [])) {
    for (const over of (inning.overs || [])) {
      let overLegalRuns = 0;    // for maiden detection
      let overHasExtra  = false;

      for (const d of (over.deliveries || [])) {
        const batter     = d.batter;
        const bowler     = d.bowler;
        const isWide     = !!(d.extras?.wides);
        const isNoBall   = !!(d.extras?.noballs);
        const batterRuns = d.runs?.batter ?? 0;
        const totalRuns  = d.runs?.total  ?? 0;

        allNames.add(batter);
        allNames.add(bowler);

        // ── Batting stats ──────────────────────────────────────────────────
        const b = bat(batter);
        if (!isWide) b.ballsFaced += 1;       // wides don't count as balls faced
        b.runs += batterRuns;
        if (batterRuns === 4 && !isWide) b.fours += 1;  // no-ball boundaries count
        if (batterRuns === 6)            b.sixes += 1;

        // ── Bowling stats ──────────────────────────────────────────────────
        const bl = bowl(bowler);
        bl.runsConceded += totalRuns;           // all runs (incl. extras) count against bowler
        if (!isWide) bl.ballsBowled += 1;       // wides are NOT legal deliveries
        if (isWide)  bl.wides  += 1;
        if (isNoBall) bl.noBalls += 1;
        if (!isWide && totalRuns === 0) bl.dotBalls += 1;  // dot = legal + no runs at all
        overLegalRuns += isWide ? 0 : totalRuns;
        if (isWide || isNoBall) overHasExtra = true;

        // ── Wickets ────────────────────────────────────────────────────────
        for (const wkt of (d.wickets || [])) {
          const kind     = (wkt.kind || '').toLowerCase();
          const fielders = wkt.fielders || [];
          const out      = wkt.player_out;
          allNames.add(out);

          // Batter is out
          bat(out).isDismissed = true;

          // Bowler gets the wicket (not for run outs, obstructing the field)
          if (!['run out', 'obstructing the field', 'retired hurt', 'retired out'].includes(kind)) {
            bl.wickets += 1;
            bl.wicketTypes.push(kind);
          }

          // Fielding credit
          if (kind === 'caught') {
            for (const f of fielders) {
              allNames.add(f.name);
              field(f.name).catches += 1;
            }
          } else if (kind === 'stumped') {
            for (const f of fielders) {
              allNames.add(f.name);
              field(f.name).stumpings += 1;
            }
          } else if (kind === 'run out') {
            // 1 fielder credited = direct hit; multiple = indirect for all
            if (fielders.length === 1) {
              allNames.add(fielders[0].name);
              field(fielders[0].name).runOutDirect += 1;
            } else {
              for (const f of fielders) {
                allNames.add(f.name);
                field(f.name).runOutIndirect += 1;
              }
            }
          }
        }
      }   // end deliveries loop

      // ── Maiden over ─────────────────────────────────────────────────────
      // A maiden: no legal runs scored in the over AND no extras.
      // (Extras of type wides/no-balls break a maiden; byes/leg-byes don't.)
      if (overLegalRuns === 0 && !overHasExtra && over.deliveries?.length > 0) {
        const overBowler = over.deliveries[0].bowler;
        bowl(overBowler).maidens += 1;
      }

    }   // end overs loop
  }     // end innings loop

  // ── Map Cricsheet names → local player IDs ─────────────────────────────────

  const unmatched = [];
  const rows      = [];

  for (const apiName of allNames) {
    if (!apiName) continue;
    const local = findPlayer(apiName, idx);

    if (!local) {
      unmatched.push(apiName);
      continue;
    }

    const batObj   = bats[apiName]   || null;
    const bowlObj  = bowls[apiName]  || null;
    const fieldObj = fields[apiName] || null;

    // Attach role to batting so duck penalty skips bowlers
    if (batObj) batObj.role = local.role;

    // Compute raw fantasy points (no captain/VC multiplier — that's applied later)
    let rawPoints = 0;
    if (batObj)   rawPoints += scoreBatting(batObj,   format, rules);
    if (bowlObj)  rawPoints += scoreBowling(bowlObj,  format, rules);
    if (fieldObj) rawPoints += scoreFielding(fieldObj, format, rules);

    rows.push({
      playerId  : local.id,
      batting   : batObj   ?? null,
      bowling   : bowlObj  ?? null,
      fielding  : fieldObj ?? null,
      rawPoints : Math.round(rawPoints * 10) / 10,
    });
  }

  // ── Extract match metadata ─────────────────────────────────────────────────

  const matchInfo = {
    teams      : match.info?.teams          ?? [],
    date       : match.info?.dates?.[0]     ?? null,
    venue      : match.info?.venue          ?? null,
    winner     : match.info?.outcome?.winner ?? null,
    matchNumber: match.info?.event?.match_number ?? null,
    format,
    playerLists: match.info?.players        ?? {},   // { 'KKR': [...], 'MI': [...] }
  };

  return { rows, unmatched, matchInfo };
}


// ═══════════════════════════════════════════════════════════════════════════════
// DOWNLOAD HELPER
// Routes through the local CORS proxy (proxy.js on localhost:8081).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Download a Cricsheet match JSON by Cricsheet match ID.
 *
 * How to find the Cricsheet ID:
 *   1. Go to https://cricsheet.org/matches/  (scroll to "Indian Premier League")
 *   2. Click JSON next to the match — the filename IS the Cricsheet match ID
 *      e.g.  1234567.json  →  ID is '1234567'
 *   3. Paste that ID into your app's "Finalize via Cricsheet" input.
 *
 * @param {string} cricsheetId   e.g. '1416498'
 * @param {string} [proxyBase]   default 'http://localhost:8081'
 * @returns {Promise<object>}    parsed Cricsheet JSON
 */
export async function downloadCricsheetMatch(cricsheetId, proxyBase = 'http://localhost:8081') {
  if (!cricsheetId) throw new Error('downloadCricsheetMatch: cricsheetId required');

  // Route through the local proxy (/cricsheet/* → https://cricsheet.org/*)
  // This avoids CORS issues when the app is served from a file:// or localhost origin.
  const url = `${proxyBase}/cricsheet/matches/${encodeURIComponent(cricsheetId)}.json`;

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Could not reach proxy at ${proxyBase}. Is proxy.js running? (node proxy.js)`);
  }

  if (res.status === 404) {
    throw new Error(
      `Match ${cricsheetId} not found on Cricsheet. ` +
      `Check the ID at cricsheet.org/matches — IPL matches may take 24–48 hrs to appear after completion.`
    );
  }
  if (!res.ok) {
    throw new Error(`Cricsheet download failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (!data.innings) {
    throw new Error('Response does not look like a Cricsheet match file (no innings field). Verify the ID is correct.');
  }
  return data;
}


// ═══════════════════════════════════════════════════════════════════════════════
// FORMAT INFERENCE
// ═══════════════════════════════════════════════════════════════════════════════

function inferFormat(match) {
  const t = (match.info?.match_type ?? 'T20').toUpperCase();
  if (t === 'ODI')  return 'ODI';
  if (t === 'TEST') return 'TEST';
  return 'T20';
}


// ═══════════════════════════════════════════════════════════════════════════════
// QUICK SUMMARY HELPER  (useful for debugging / toast messages)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Produce a human-readable summary string from a parseCricsheet() result.
 * e.g. "Parsed 22 players · 0 unmatched · KKR won vs MI (M65)"
 */
export function parseSummary({ rows, unmatched, matchInfo }) {
  const teams  = matchInfo.teams.join(' vs ');
  const winner = matchInfo.winner ? `${matchInfo.winner} won` : 'result unknown';
  const mn     = matchInfo.matchNumber ? `M${matchInfo.matchNumber}` : matchInfo.date ?? '';
  const parts  = [
    `Parsed ${rows.length} player${rows.length !== 1 ? 's' : ''}`,
    unmatched.length ? `${unmatched.length} unmatched` : '0 unmatched',
    `${winner} · ${teams}${mn ? ` (${mn})` : ''}`,
  ];
  return parts.join(' · ');
}
