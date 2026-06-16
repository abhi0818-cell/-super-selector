/**
 * espncricinfo-parser.js — Super Selector
 * ──────────────────────────────────────────────────────────────────────────────
 * Fetches a match scorecard from ESPNcricinfo's internal API and converts it
 * into player_match_stats rows for db.bulkUpsertPlayerMatchStats().
 *
 * Data source:
 *   https://hs-consumer-api.espncricinfo.com/v1/pages/match/scorecard
 *     ?lang=en&seriesId=<seriesId>&matchId=<matchId>
 *
 * The seriesId and matchId are both already in your matches table:
 *   - matchId   = external_id  (e.g. 1529306 for M63)
 *   - seriesId  = found in the ESPNcricinfo URL for any IPL 2026 match
 *                 IPL 2026 series ID = 1510719
 *
 * Usage:
 *   import { downloadESPNScorecard, parseESPN } from './espncricinfo-parser.js';
 *
 *   const raw = await downloadESPNScorecard('1529306', '1510719');
 *   const { rows, unmatched, matchInfo } = parseESPN(raw, state.players, SCORING_RULES);
 *   await state.db.bulkUpsertPlayerMatchStats(matchId, rows);
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ESPN API batting shape (per player in innings[i].inningBatsmen):
 * {
 *   player: { name, longName, objectId },
 *   runs, balls, fours, sixes, strikerate,
 *   battedType: 'yes' | 'no' | 'sub',
 *   isOut: true | false,
 *   dismissalText: { short: 'c Rohit b Bumrah', long: 'caught Rohit Sharma b Jasprit Bumrah' }
 * }
 *
 * ESPN API bowling shape (per player in innings[i].inningBowlers):
 * {
 *   player: { name, longName, objectId },
 *   overs,      // e.g. 4.0 or 3.3
 *   maidens,
 *   conceded,   // runs conceded
 *   wickets,
 *   economy,
 *   wides,
 *   noballs,
 *   dots
 * }
 * ──────────────────────────────────────────────────────────────────────────────
 */

// IPL 2026 series ID — used when the caller doesn't specify one
export const IPL_2026_SERIES_ID = '1510719';

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT SCORING RULES (mirrors index.html)
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_RULES = {
  T20: {
    run: 1, boundary4: 1, boundary6: 2,
    half_century: 8, century: 16, duck: -2,
    sr_above_170: 6, sr_140_to_170: 4, sr_below_70: -6, sr_70_to_100: -2,
    wicket: 25, lbw_bowled_bonus: 8, maiden_over: 12, dot_ball: 1,
    economy_below_5: 6, economy_5_to_6: 4, economy_10_to_11: -4, economy_above_11: -6,
    catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
    no_ball: -1, wide: -1,
  },
  ODI: {
    run: 1, boundary4: 1, boundary6: 2,
    half_century: 4, century: 8, duck: -3,
    wicket: 20, lbw_bowled_bonus: 8, maiden_over: 4, five_wicket_haul: 8,
    economy_below_2_5: 6, economy_2_5_to_3_5: 4, economy_7_to_8: -4, economy_above_9: -6,
    catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
    no_ball: -1, wide: -1,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// NAME NORMALISATION + FUZZY MATCHING (same strategy as cricsheet-parser.js)
// ═══════════════════════════════════════════════════════════════════════════════

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

function buildIndex(localPlayers) {
  const exact    = new Map();
  const lastName = new Map();
  const tokens   = [];
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

function findPlayer(espnName, index) {
  if (!espnName) return null;
  const n = norm(espnName);
  if (!n) return null;
  if (index.exact.has(n))   return index.exact.get(n);
  const parts = n.split(' ');
  const last  = parts[parts.length - 1];
  if (index.lastName.has(last)) return index.lastName.get(last);
  for (const [ln, p] of index.exact) {
    if (ln.includes(n) || n.includes(ln)) return p;
  }
  const nWords = new Set(parts.filter(w => w.length > 1));
  let best = null, bestCount = 1;
  for (const { words, player } of index.tokens) {
    let shared = 0;
    for (const w of nWords) if (words.has(w)) shared++;
    if (shared > bestCount) { best = player; bestCount = shared; }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISMISSAL TEXT PARSER
// Extracts fielding credits and wicket type from ESPNcricinfo's dismissal string.
//
// Examples:
//   "c Rohit Sharma b Jasprit Bumrah"   → caught by Rohit Sharma, bowled by Bumrah
//   "c †Ishan Kishan b Yuzvendra Chahal" → keeper catch, bowled by Chahal
//   "lbw b Jasprit Bumrah"               → lbw, credited to Bumrah
//   "b Jasprit Bumrah"                   → bowled, credited to Bumrah
//   "st †Ishan Kishan b Yuzvendra Chahal" → stumped by Ishan Kishan
//   "run out (Rohit Sharma)"             → direct run out by Rohit Sharma
//   "run out (Rohit Sharma / Bumrah)"    → indirect run out by both
//   "not out"                            → not dismissed
//   "did not bat"                        → did not bat
// ═══════════════════════════════════════════════════════════════════════════════

function parseDismissal(text) {
  if (!text) return { kind: null, fielders: [], bowlerName: null };
  const t = text.trim().toLowerCase();

  if (t === 'not out' || t === 'did not bat' || t === 'absent hurt' || t === 'retired hurt') {
    return { kind: null, fielders: [], bowlerName: null };
  }

  // Run out
  const roMatch = t.match(/^run out\s*[\(\[](.*?)[\)\]]/i);
  if (roMatch) {
    const fielderStr = roMatch[1];
    const fielders   = fielderStr.split(/[\/,&]/).map(f => f.replace(/†/g, '').trim()).filter(Boolean);
    return {
      kind     : 'run out',
      fielders,
      bowlerName: null,
    };
  }

  // Stumped
  const stMatch = t.match(/^st\s+†?(.+?)\s+b\s+(.+)$/i);
  if (stMatch) {
    return {
      kind     : 'stumped',
      fielders : [stMatch[1].replace(/†/g, '').trim()],
      bowlerName: stMatch[2].trim(),
    };
  }

  // Caught
  const cMatch = t.match(/^c\s+†?(.+?)\s+b\s+(.+)$/i);
  if (cMatch) {
    return {
      kind     : 'caught',
      fielders : [cMatch[1].replace(/†/g, '').trim()],
      bowlerName: cMatch[2].trim(),
    };
  }

  // LBW
  const lbwMatch = t.match(/^lbw\s+b\s+(.+)$/i);
  if (lbwMatch) {
    return { kind: 'lbw', fielders: [], bowlerName: lbwMatch[1].trim() };
  }

  // Bowled
  const bMatch = t.match(/^b\s+(.+)$/i);
  if (bMatch) {
    return { kind: 'bowled', fielders: [], bowlerName: bMatch[1].trim() };
  }

  // Hit wicket
  const hwMatch = t.match(/^hit wicket\s+b\s+(.+)$/i);
  if (hwMatch) {
    return { kind: 'hit wicket', fielders: [], bowlerName: hwMatch[1].trim() };
  }

  return { kind: 'unknown', fielders: [], bowlerName: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING HELPERS (mirrors index.html)
// ═══════════════════════════════════════════════════════════════════════════════

function strikeRate(runs, balls) { return balls > 0 ? (runs / balls) * 100 : 0; }
function economy(runs, balls)    { return balls > 0 ? (runs / balls) * 6  : 0; }

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
  pts += catches        * (r.catch           || 0);
  pts += stumpings      * (r.stumping        || 0);
  pts += runOutDirect   * (r.run_out_direct  || 0);
  pts += runOutIndirect * (r.run_out_indirect || 0);
  return pts;
}

// Convert ESPN "overs" float (e.g. 3.3 = 3 overs 3 balls) to total balls
function oversToBalls(overs) {
  if (!overs && overs !== 0) return 0;
  const o = parseFloat(overs);
  return Math.floor(o) * 6 + Math.round((o % 1) * 10);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PARSER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse an ESPNcricinfo scorecard API response into player_match_stats rows.
 *
 * @param {object} data          - Raw JSON from the ESPNcricinfo scorecard API
 * @param {Array}  localPlayers  - db.getPlayers() result
 * @param {object} [rules]       - Scoring rules (pass live SCORING_RULES from index.html)
 * @param {string} [fmt]         - 'T20' | 'ODI' | 'TEST' — inferred from data if omitted
 *
 * @returns {{ rows, unmatched, matchInfo }}
 */
export function parseESPN(data, localPlayers, rules = DEFAULT_RULES, fmt = null) {
  // The scorecard data is under data.content.innings (array)
  const innings = data?.content?.innings ?? data?.innings ?? [];
  const format  = fmt ?? inferFormat(data);
  const idx     = buildIndex(localPlayers);

  // Accumulators keyed by ESPN player name
  const bats   = {};   // name → batting object
  const bowls  = {};   // name → bowling object
  const fields = {};   // name → fielding object

  // Track bowler name → wicket types (derived from batting dismissal texts)
  const bowlerWicketTypes = {};  // bowlerName → ['lbw', 'caught', ...]

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

  for (const inning of innings) {
    const batsmen = inning.inningBatsmen ?? [];
    const bowlers = inning.inningBowlers ?? [];

    // ── Batting ─────────────────────────────────────────────────────────────
    for (const b of batsmen) {
      const name    = b.player?.name || b.player?.longName;
      if (!name) continue;

      const batted  = b.battedType === 'yes';
      if (!batted) continue;   // did not bat

      const obj = bat(name);
      obj.runs        = Number(b.runs        ?? 0);
      obj.ballsFaced  = Number(b.balls       ?? 0);
      obj.fours       = Number(b.fours       ?? 0);
      obj.sixes       = Number(b.sixes       ?? 0);
      obj.isDismissed = !!b.isOut;

      // Parse dismissal for fielding credits + bowler wicket types
      const dismissalText = b.dismissalText?.long || b.dismissalText?.short || '';
      const { kind, fielders, bowlerName } = parseDismissal(dismissalText);

      if (kind === 'caught') {
        for (const f of fielders) { if (f) field(f).catches += 1; }
        if (bowlerName) (bowlerWicketTypes[norm(bowlerName)] ??= []).push('caught');
      } else if (kind === 'stumped') {
        for (const f of fielders) { if (f) field(f).stumpings += 1; }
        // stumping doesn't count as bowler wicket type for lbw/bowled bonus
        if (bowlerName) (bowlerWicketTypes[norm(bowlerName)] ??= []).push('stumped');
      } else if (kind === 'lbw') {
        if (bowlerName) (bowlerWicketTypes[norm(bowlerName)] ??= []).push('lbw');
      } else if (kind === 'bowled') {
        if (bowlerName) (bowlerWicketTypes[norm(bowlerName)] ??= []).push('bowled');
      } else if (kind === 'run out') {
        if (fielders.length === 1) {
          field(fielders[0]).runOutDirect += 1;
        } else {
          for (const f of fielders) { if (f) field(f).runOutIndirect += 1; }
        }
      } else if (kind === 'hit wicket') {
        if (bowlerName) (bowlerWicketTypes[norm(bowlerName)] ??= []).push('hit wicket');
      }
    }

    // ── Bowling ─────────────────────────────────────────────────────────────
    for (const b of bowlers) {
      const name = b.player?.name || b.player?.longName;
      if (!name) continue;

      const obj = bowl(name);
      obj.wickets      = Number(b.wickets  ?? 0);
      obj.maidens      = Number(b.maidens  ?? 0);
      obj.runsConceded = Number(b.conceded ?? 0);
      obj.ballsBowled  = oversToBalls(b.overs);
      obj.dotBalls     = Number(b.dots     ?? 0);
      obj.noBalls      = Number(b.noballs  ?? 0);
      obj.wides        = Number(b.wides    ?? 0);

      // Attach wicket types derived from batting dismissal parsing
      const normName = norm(name);
      obj.wicketTypes  = bowlerWicketTypes[normName] ?? [];
    }
  }

  // ── Map names → local players ─────────────────────────────────────────────
  const allNames  = new Set([...Object.keys(bats), ...Object.keys(bowls), ...Object.keys(fields)]);
  const unmatched = [];
  const rows      = [];

  for (const espnName of allNames) {
    if (!espnName) continue;
    const local = findPlayer(espnName, idx);
    if (!local) { unmatched.push(espnName); continue; }

    const batObj   = bats[espnName]   || null;
    const bowlObj  = bowls[espnName]  || null;
    const fieldObj = fields[espnName] || null;

    if (batObj) batObj.role = local.role;  // for duck penalty check

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

  // ── Match metadata ────────────────────────────────────────────────────────
  const matchData = data?.match ?? data?.content?.match ?? {};
  const teams     = (matchData.teams ?? []).map(t => t.team?.abbreviation ?? t.team?.name ?? '');
  const matchInfo = {
    teams,
    venue  : matchData.ground?.longName ?? null,
    date   : (matchData.startDate ?? '').slice(0, 10) || null,
    winner : null,   // ESPN scorecard API doesn't always include winner directly
    format,
  };

  return { rows, unmatched, matchInfo };
}

function inferFormat(data) {
  const fmt = (data?.match?.format ?? data?.content?.match?.format ?? 'T20').toUpperCase();
  if (fmt.includes('ODI'))  return 'ODI';
  if (fmt.includes('TEST')) return 'TEST';
  return 'T20';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOWNLOAD HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch the scorecard from ESPNcricinfo via the local proxy.
 *
 * @param {string} matchId    ESPNcricinfo match ID (= external_id in your DB, e.g. '1529306')
 * @param {string} seriesId   ESPNcricinfo series ID (IPL 2026 = '1510719')
 * @param {string} [proxyBase] default 'http://localhost:8081'
 */
export async function downloadESPNScorecard(matchId, seriesId = IPL_2026_SERIES_ID, proxyBase = 'http://localhost:8081') {
  if (!matchId)  throw new Error('downloadESPNScorecard: matchId required');
  if (!seriesId) throw new Error('downloadESPNScorecard: seriesId required');

  const params = new URLSearchParams({ lang: 'en', seriesId, matchId });
  const url    = `${proxyBase}/espncricinfo/v1/pages/match/scorecard?${params}`;

  const MAX_RETRIES = 3;
  const RETRY_DELAY = 2500; // ms — increases per attempt

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(`Could not reach proxy at ${proxyBase}. Is proxy.js running? (node proxy.js)`);
    }

    // Read body unconditionally — helps diagnose proxy-vs-ESPN errors
    let body;
    try { body = await res.json(); } catch (_) { body = null; }

    if (res.status === 403) {
      // Akamai block — retry after a short pause
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY * attempt));
        continue;
      }
      throw new Error(
        'ESPNcricinfo is blocking the proxy (403 after 3 attempts). ' +
        'Restart proxy.js and wait a minute before trying again — Akamai rate-limits Node.js proxies.'
      );
    }

    if (res.status === 404) {
      if (body?.error?.includes('Routes:')) {
        throw new Error(
          'Proxy does not recognise the /espncricinfo/ route. ' +
          'Restart proxy.js (Ctrl+C → node proxy.js) to pick up the latest code.'
        );
      }
      throw new Error(
        `Match ${matchId} not found on ESPNcricinfo (404). ` +
        'If the match just finished, the scorecard API can take 30–60 min to publish — try again shortly.'
      );
    }

    if (!res.ok) {
      throw new Error(`ESPNcricinfo download failed: ${res.status} ${res.statusText}`);
    }

    const data = body ?? {};

    // Sanity check — the response should have innings data
    const innings = data?.content?.innings ?? data?.innings;
    if (!innings?.length) {
      throw new Error('ESPNcricinfo response has no innings data. The match may not be complete yet, or the API structure may have changed.');
    }

    return data;
  }
}

/**
 * Summary string for toast messages.
 */
export function espnParseSummary({ rows, unmatched, matchInfo }) {
  const teams  = matchInfo.teams.join(' vs ') || 'unknown teams';
  const parts  = [
    `Parsed ${rows.length} player${rows.length !== 1 ? 's' : ''}`,
    unmatched.length ? `${unmatched.length} unmatched` : '0 unmatched',
    teams,
  ];
  return parts.join(' · ');
}
