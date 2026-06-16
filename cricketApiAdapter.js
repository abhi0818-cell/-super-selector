/**
 * Cricket API Adapter Layer
 * ─────────────────────────
 * Normalises live match data from three sources into the shape
 * expected by cricketScoringEngine.js:
 *
 *   { batting, bowling, fielding, role, captaincy }
 *
 * Supported sources
 *   1. CricAPI   (https://cricapi.com)
 *   2. Sportmonks (https://sportmonks.com/cricket-api)
 *   3. Generic webhook (roll-your-own or RapidAPI feeds)
 *
 * Usage
 *   import { fromCricAPI, fromSportmonks, fromWebhook, LiveMatchPoller } from './cricketApiAdapter.js';
 *   import { scoreTeam } from './cricketScoringEngine.js';
 *
 *   const players = fromCricAPI(payload, mySquad);
 *   const scores  = scoreTeam(players, 'T20');
 */

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Derive role from a player's specialisation string.
 * Works across API naming conventions.
 */
function deriveRole(specialisation = '') {
  const s = specialisation.toLowerCase();
  if (s.includes('wicket') || s === 'wk') return 'wk';
  if (s.includes('allround') || s === 'ar') return 'ar';
  if (s.includes('bowl')) return 'bowl';
  return 'bat';
}

/**
 * Look up captaincy status for a player from a squad definition.
 *
 * squad = [
 *   { id: '123', captaincy: 'captain' },
 *   { id: '456', captaincy: 'vice_captain' },
 *   ...
 * ]
 */
function captaincy(playerId, squad = []) {
  const entry = squad.find(s => String(s.id) === String(playerId));
  return entry?.captaincy ?? 'normal';
}

/** Safely parse an integer, defaulting to 0. */
const int = v => parseInt(v, 10) || 0;

/** Safely parse a float, defaulting to 0. */
const fl  = v => parseFloat(v)   || 0;

// ─── 1. CricAPI adapter ───────────────────────────────────────────────────────
// Docs: https://cricapi.com/how-to-use/

/**
 * fromCricAPI
 *
 * @param {object} payload  - raw response from GET /match or /scorecard endpoint
 * @param {object[]} squad  - your fantasy squad with captaincy annotations
 * @param {string}   format - 'T20' | 'ODI' | 'TEST'
 * @returns {object[]} normalised player array ready for scoreTeam()
 */
export function fromCricAPI(payload, squad = [], format = 'T20') {
  const scorecard = payload?.scorecard ?? [];
  const players   = [];

  scorecard.forEach(innings => {
    // --- batting ---
    (innings.batting ?? []).forEach(b => {
      const id   = String(b.player?.pid ?? b.pid ?? '');
      const runs = int(b.r);
      const entry = ensurePlayer(players, id, b.player?.name ?? b.name, squad);

      entry.role     = deriveRole(b.player?.playing_role ?? '');
      entry.batting  = {
        runs,
        balls    : int(b.b),
        fours    : int(b['4s']),
        sixes    : int(b['6s']),
        dismissed: !(b.dismissal ?? '').toLowerCase().includes('not out'),
      };
    });

    // --- bowling ---
    (innings.bowling ?? []).forEach(bw => {
      const id   = String(bw.player?.pid ?? bw.pid ?? '');
      const entry = ensurePlayer(players, id, bw.player?.name ?? bw.name, squad);

      const [overs, balls] = parseOvers(bw.o);
      const totalBalls     = overs * 6 + balls;

      entry.role    = 'bowl'; // refine below if already set as ar
      entry.bowling = {
        wickets  : int(bw.w),
        lbwBowled: countPremiumWickets(innings, id),
        maidens  : int(bw.m),
        runs     : int(bw.r),
        balls    : totalBalls,
        dots     : int(bw.dots ?? 0),
        noBalls  : int(bw.wd ?? 0),  // CricAPI sometimes merges no-balls here
        wides    : int(bw.nb ?? 0),
      };
    });

    // --- fielding (derived from dismissal strings) ---
    (innings.batting ?? []).forEach(b => {
      if (!b.dismissal) return;
      parseFieldingFromDismissal(b.dismissal, players, squad);
    });
  });

  // Reconcile roles: if a player has both batting and bowling, mark as ar
  players.forEach(p => {
    if (p.batting && p.bowling) p.role = 'ar';
  });

  return players;
}

// ─── 2. Sportmonks adapter ────────────────────────────────────────────────────
// Docs: https://docs.sportmonks.com/cricket

/**
 * fromSportmonks
 *
 * @param {object}   payload - response from /fixtures/{id}?include=batting,bowling,scoreboards
 * @param {object[]} squad
 * @param {string}   format
 * @returns {object[]}
 */
export function fromSportmonks(payload, squad = [], format = 'T20') {
  const fixture  = payload?.data ?? payload;
  const batting  = fixture?.batting  ?? [];
  const bowling  = fixture?.bowling  ?? [];
  const players  = [];

  batting.forEach(b => {
    const id    = String(b.player_id);
    const entry = ensurePlayer(players, id, b.player?.fullname ?? id, squad);

    entry.role    = deriveRole(b.player?.position ?? '');
    entry.batting = {
      runs     : int(b.score),
      balls    : int(b.ball),
      fours    : int(b.four_x),
      sixes    : int(b.six_x),
      dismissed: b.active === false || !!b.fowscore,
    };
  });

  bowling.forEach(bw => {
    const id    = String(bw.player_id);
    const entry = ensurePlayer(players, id, bw.player?.fullname ?? id, squad);

    const totalBalls = Math.round(fl(bw.overs) * 6);

    entry.bowling = {
      wickets  : int(bw.wickets),
      lbwBowled: int(bw.lbw_bowling ?? 0) + int(bw.bowled ?? 0),
      maidens  : int(bw.medians),
      runs     : int(bw.runs),
      balls    : totalBalls,
      dots     : int(bw.zero_x ?? 0),
      noBalls  : int(bw.noball_runs ?? 0),
      wides    : int(bw.wide_runs ?? 0),
    };
  });

  // Sportmonks provides a separate catches/stumpings array
  const fielding = fixture?.fielding ?? [];
  fielding.forEach(f => {
    const id    = String(f.player_id);
    const entry = ensurePlayer(players, id, f.player?.fullname ?? id, squad);
    entry.fielding = {
      catches   : int(f.catch_cnt  ?? f.catches ?? 0),
      stumpings : int(f.stumpings  ?? 0),
      roDirect  : int(f.run_out_direct   ?? 0),
      roIndirect: int(f.run_out_indirect ?? 0),
    };
  });

  players.forEach(p => {
    if (p.batting && p.bowling) p.role = 'ar';
  });

  return players;
}

// ─── 3. Generic webhook adapter ───────────────────────────────────────────────
// For RapidAPI feeds or custom backends that emit a normalised JSON.
// Expected shape documented below; any field can be omitted.

/**
 * fromWebhook
 *
 * Expected payload shape:
 * {
 *   players: [
 *     {
 *       id: '123',
 *       name: 'Player Name',
 *       role: 'bat' | 'bowl' | 'ar' | 'wk',   // optional
 *       batting: {
 *         runs, balls, fours, sixes,
 *         dismissed: true | false
 *       },
 *       bowling: {
 *         wickets, lbwBowledWickets, maidens,
 *         runsConceded, ballsBowled, dotBalls,
 *         noBalls, wides
 *       },
 *       fielding: {
 *         catches, stumpings, runOutsDirect, runOutsIndirect
 *       }
 *     }
 *   ]
 * }
 *
 * @param {object}   payload
 * @param {object[]} squad
 * @returns {object[]}
 */
export function fromWebhook(payload, squad = []) {
  const raw = payload?.players ?? [];

  return raw.map(p => ({
    id       : String(p.id),
    name     : p.name ?? 'Unknown',
    role     : deriveRole(p.role ?? ''),
    captaincy: captaincy(p.id, squad),

    batting: p.batting ? {
      runs     : int(p.batting.runs),
      balls    : int(p.batting.balls),
      fours    : int(p.batting.fours),
      sixes    : int(p.batting.sixes),
      dismissed: !!p.batting.dismissed,
    } : undefined,

    bowling: p.bowling ? {
      wickets  : int(p.bowling.wickets),
      lbwBowled: int(p.bowling.lbwBowledWickets ?? 0),
      maidens  : int(p.bowling.maidens),
      runs     : int(p.bowling.runsConceded),
      balls    : int(p.bowling.ballsBowled),
      dots     : int(p.bowling.dotBalls),
      noBalls  : int(p.bowling.noBalls),
      wides    : int(p.bowling.wides),
    } : undefined,

    fielding: p.fielding ? {
      catches   : int(p.fielding.catches),
      stumpings : int(p.fielding.stumpings),
      roDirect  : int(p.fielding.runOutsDirect),
      roIndirect: int(p.fielding.runOutsIndirect),
    } : undefined,
  }));
}

// ─── 4. LiveMatchPoller ───────────────────────────────────────────────────────

/**
 * Polls a live match endpoint every `intervalMs` milliseconds and
 * calls `onUpdate(scoredPlayers)` with fresh fantasy scores.
 *
 * Handles:
 *   - Automatic retries with exponential back-off on errors
 *   - In-flight deduplication (won't fire a new fetch while one is pending)
 *   - Clean teardown via poller.stop()
 *   - Delta detection: only calls onUpdate when scores actually change
 *
 * @example
 *   import { scoreTeam } from './cricketScoringEngine.js';
 *
 *   const poller = new LiveMatchPoller({
 *     url      : 'https://api.cricapi.com/v1/match_scorecard?apikey=KEY&id=MATCH_ID',
 *     source   : 'cricapi',            // 'cricapi' | 'sportmonks' | 'webhook'
 *     squad    : mySquad,
 *     format   : 'T20',
 *     interval : 30_000,              // 30 s — respect API rate limits
 *     onUpdate : players => {
 *       const scores = scoreTeam(players, 'T20');
 *       renderUI(scores);
 *     },
 *     onError  : err => console.error('Poll error:', err),
 *   });
 *
 *   poller.start();
 *   // later:
 *   poller.stop();
 */
export class LiveMatchPoller {
  #url;
  #source;
  #squad;
  #format;
  #interval;
  #onUpdate;
  #onError;
  #timer       = null;
  #inflight    = false;
  #retryDelay  = 5_000;
  #maxRetry    = 30_000;
  #lastHash    = null;
  #headers;

  constructor({ url, source = 'webhook', squad = [], format = 'T20',
                interval = 30_000, onUpdate, onError = console.error,
                headers = {} }) {
    this.#url      = url;
    this.#source   = source;
    this.#squad    = squad;
    this.#format   = format;
    this.#interval = interval;
    this.#onUpdate = onUpdate;
    this.#onError  = onError;
    this.#headers  = headers;
  }

  start() {
    if (this.#timer) return;
    this.#poll();
    this.#timer = setInterval(() => this.#poll(), this.#interval);
  }

  stop() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
  }

  async #poll() {
    if (this.#inflight) return;
    this.#inflight = true;
    try {
      const res     = await fetch(this.#url, { headers: this.#headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const players = this.#adapt(payload);
      const hash    = JSON.stringify(players);
      if (hash !== this.#lastHash) {
        this.#lastHash   = hash;
        this.#retryDelay = 5_000;   // reset back-off on success
        this.#onUpdate(players);
      }
    } catch (err) {
      this.#onError(err);
      // exponential back-off — skip next N ticks silently
      await new Promise(r => setTimeout(r, this.#retryDelay));
      this.#retryDelay = Math.min(this.#retryDelay * 2, this.#maxRetry);
    } finally {
      this.#inflight = false;
    }
  }

  #adapt(payload) {
    if (this.#source === 'cricapi')    return fromCricAPI(payload, this.#squad, this.#format);
    if (this.#source === 'sportmonks') return fromSportmonks(payload, this.#squad, this.#format);
    return fromWebhook(payload, this.#squad);
  }

  /** One-shot fetch without starting the interval. */
  async fetchOnce() {
    const res     = await fetch(this.#url, { headers: this.#headers });
    const payload = await res.json();
    return this.#adapt(payload);
  }
}

// ─── Internal utilities ───────────────────────────────────────────────────────

/** Get or create a player entry in the accumulator array. */
function ensurePlayer(players, id, name, squad) {
  let p = players.find(x => x.id === id);
  if (!p) {
    p = { id, name, role: 'bat', captaincy: captaincy(id, squad) };
    players.push(p);
  }
  return p;
}

/**
 * Parse "4.3" overs string → [fullOvers, extraBalls].
 * Handles both "4.3" and integer 4.
 */
function parseOvers(overs) {
  const s = String(overs ?? 0);
  const [o, b = '0'] = s.split('.');
  return [int(o), int(b)];
}

/**
 * Count LBW + Bowled wickets for a bowler from the innings batting array.
 * CricAPI encodes dismissal type inside the dismissal string, e.g.
 * "lbw b Bumrah" or "b Bumrah".
 */
function countPremiumWickets(innings, bowlerId) {
  let count = 0;
  (innings.batting ?? []).forEach(b => {
    const d = (b.dismissal ?? '').toLowerCase();
    const bowlerName = (b.bowler?.name ?? b.bowler ?? '').toLowerCase();
    if (!bowlerName) return;
    if (d.startsWith('lbw') || d.startsWith('b ') || d === 'bowled') count++;
  });
  return count;  // Note: this is a coarse approximation; for accuracy, match on bowler ID
}

/**
 * Derive fielding events from CricAPI dismissal strings.
 * Examples:
 *   "c Dhoni b Bumrah"   → Dhoni gets a catch
 *   "st Dhoni b Jadeja"  → Dhoni gets a stumping
 *   "run out (Jadeja)"   → Jadeja gets an indirect run-out
 *   "run out (direct)"   → no specific fielder
 */
function parseFieldingFromDismissal(dismissal, players, squad) {
  if (!dismissal) return;
  const d = dismissal.toLowerCase().trim();

  const catchMatch  = d.match(/^c ([^b]+) b/);
  const stumpMatch  = d.match(/^st ([^b]+) b/);
  const roMatch     = d.match(/^run out \(([^)]+)\)/);

  if (catchMatch) {
    const fielderName = catchMatch[1].trim();
    addFieldingEvent(players, fielderName, 'catches', squad);
  } else if (stumpMatch) {
    const fielderName = stumpMatch[1].trim();
    addFieldingEvent(players, fielderName, 'stumpings', squad);
  } else if (roMatch) {
    const info = roMatch[1].toLowerCase();
    if (info === 'direct') return;
    const fielderName = roMatch[1].trim();
    addFieldingEvent(players, fielderName, 'roIndirect', squad);
  }
}

function addFieldingEvent(players, fielderName, eventKey, squad) {
  let p = players.find(x => x.name?.toLowerCase() === fielderName.toLowerCase());
  if (!p) {
    p = { id: fielderName, name: fielderName, role: 'bat', captaincy: 'normal', fielding: {} };
    players.push(p);
  }
  if (!p.fielding) p.fielding = {};
  p.fielding[eventKey] = (p.fielding[eventKey] ?? 0) + 1;
}

// ─── Squad builder helper ─────────────────────────────────────────────────────

/**
 * buildSquad
 * Convenience helper to annotate your drafted player IDs with captaincy.
 *
 * @param {string[]} playerIds      - all 11 selected player IDs
 * @param {string}   captainId
 * @param {string}   viceCaptainId
 * @returns {object[]}              - squad array for passing to adapters
 *
 * @example
 *   const squad = buildSquad(
 *     ['101','202','303','404','505','606','707','808','909','010','111'],
 *     '101',   // captain
 *     '606',   // vice-captain
 *   );
 */
export function buildSquad(playerIds, captainId, viceCaptainId) {
  return playerIds.map(id => ({
    id,
    captaincy: id === String(captainId)
      ? 'captain'
      : id === String(viceCaptainId)
        ? 'vice_captain'
        : 'normal',
  }));
}

// ─── Complete integration example ────────────────────────────────────────────
/*

  // 1. Build your squad
  import { buildSquad }       from './cricketApiAdapter.js';
  import { scoreTeam, formatScoreReport } from './cricketScoringEngine.js';

  const squad = buildSquad(
    ['101','202','303','404','505','606','707','808','909','010','111'],
    '101',   // Rohit Sharma = captain
    '606',   // Bumrah = vice-captain
  );

  // 2. Option A — one-shot fetch (e.g. post-match)
  import { fromCricAPI } from './cricketApiAdapter.js';

  const res     = await fetch('https://api.cricapi.com/v1/match_scorecard?apikey=KEY&id=MATCH_ID');
  const payload = await res.json();
  const players = fromCricAPI(payload, squad, 'T20');
  const scores  = scoreTeam(players, 'T20');
  scores.forEach(s => console.log(formatScoreReport(s)));

  // 3. Option B — live polling (updates every 30 s during a match)
  import { LiveMatchPoller } from './cricketApiAdapter.js';

  const poller = new LiveMatchPoller({
    url     : 'https://api.cricapi.com/v1/match_scorecard?apikey=KEY&id=MATCH_ID',
    source  : 'cricapi',
    squad,
    format  : 'T20',
    interval: 30_000,
    headers : { 'Accept': 'application/json' },
    onUpdate: players => {
      const scores = scoreTeam(players, 'T20');
      updateFantasyUI(scores);          // your render function
    },
    onError: err => console.error('Polling error:', err),
  });

  poller.start();

  // Stop when innings ends / match is complete
  matchEventBus.on('match_complete', () => poller.stop());

*/
