/**
 * poll-cricapi — Supabase Edge Function
 *
 * Server-side counterpart to the browser's LiveMatchPoller. Polls CricAPI for
 * every in-play match belonging to a non-scraper-enabled tournament, parses
 * batting/bowling/fielding (fielding is new — the HTML scraper has no
 * fielder data), writes player_match_stats, then cascades to:
 *   - Daily XI scores      (user_team_match_scores)   — flat captain 2x / VC 1.5x
 *   - Season Long scores   (user_match_xi_scores)      — captain/VC mult + full
 *                                                         booster + per-contest
 *                                                         custom-scoring-rules
 *                                                         support (parity with
 *                                                         the client's manual
 *                                                         Finalize/Recalc path)
 *
 * On match completion it flips matches.status to 'completed' automatically —
 * no browser tab needs to be open for any of this. The only manual step left
 * is linking a CricAPI player name that doesn't match the local roster —
 * those rows land in the existing "Unmatched Players" admin panel
 * (scraper_unmatched, tagged source='cricapi') exactly like scraper misses do.
 *
 * Triggered by:
 *   - pg_cron, interval set in migration_v25_cricapi_cron.sql (body: {})
 *       → polls every live match whose tournament has scraper_enabled = false
 *         and has a CricAPI external_id
 *   - Admin "Poll Now" button (body: {matchId})
 *       → polls one match regardless of scraper_enabled (manual override)
 *
 * Required env vars (Supabase dashboard → Edge Functions → poll-cricapi → Secrets):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   CRICAPI_KEYS   — one or more CricAPI keys, comma-separated.
 *                    Automatically rotates to the next key when one is
 *                    rate-limited / invalid, same fallback behaviour as the
 *                    browser's fetchJsonWithFallback().
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRICAPI_KEYS = (Deno.env.get('CRICAPI_KEYS') ?? '')
  .split(',').map(k => k.trim()).filter(Boolean)

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Browser admin "Poll Now" button calls this directly, so it needs CORS.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring engine — ported from index.html. Keep these constants in sync with
// DEFAULT_SCORING_RULES / MULTIPLIERS in index.html if the client's defaults
// ever change; they are the canonical source of truth.
// ─────────────────────────────────────────────────────────────────────────────

interface Rules { [key: string]: number }

const DEFAULT_T20_RULES: Rules = {
  run: 1, boundary4: 1, boundary6: 2, half_century: 8, century: 16, duck: -2,
  sr_above_170: 6, sr_140_to_170: 4, sr_below_70: -6, sr_70_to_100: -2,
  wicket: 25, lbw_bowled_bonus: 8, maiden_over: 12, dot_ball: 1,
  economy_below_5: 6, economy_5_to_6: 4, economy_10_to_11: -4, economy_above_11: -6,
  catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
  no_ball: -1, wide: -1,
}
const DEFAULT_ODI_RULES: Rules = {
  run: 1, boundary4: 1, boundary6: 2, half_century: 4, century: 8, duck: -3,
  sr_above_140: 6, sr_120_to_140: 2, sr_below_50: -6, sr_50_to_75: -2,
  wicket: 25, lbw_bowled_bonus: 8, maiden_over: 4, dot_ball: 0.5, four_wicket_haul: 4, five_wicket_haul: 8,
  economy_below_2_5: 6, economy_2_5_to_3_5: 4, economy_7_to_8: -4, economy_above_9: -6,
  catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
  no_ball: -1, wide: -1,
}
const DEFAULT_TEST_RULES: Rules = {
  run: 1, boundary4: 0, boundary6: 0, half_century: 4, century: 8, duck: -4,
  wicket: 16, lbw_bowled_bonus: 8, maiden_over: 4, five_wicket_haul: 8,
  catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
  no_ball: -1, wide: -1,
}
const DEFAULT_RULES: Record<string, Rules> = { T20: DEFAULT_T20_RULES, ODI: DEFAULT_ODI_RULES, TEST: DEFAULT_TEST_RULES }

const MULTIPLIERS: Record<string, number> = { captain: 2, triple_captain: 3, vice_captain: 1.5, normal: 1 }

function strikeRate(r: number, b: number): number | null { return b === 0 ? null : (r / b) * 100 }
function economyRate(r: number, b: number): number | null { return b === 0 ? null : (r / b) * 6 }

function srBonus(sr: number | null, fmt: string, r: Rules): number {
  if (sr === null) return 0
  if (fmt === 'T20') {
    if (sr > 170) return r.sr_above_170 ?? 0
    if (sr >= 140) return r.sr_140_to_170 ?? 0
    if (sr < 70) return r.sr_below_70 ?? 0
    if (sr < 100) return r.sr_70_to_100 ?? 0
  }
  if (fmt === 'ODI') {
    if (sr > 140) return r.sr_above_140 ?? 0
    if (sr >= 120) return r.sr_120_to_140 ?? 0
    if (sr < 50) return r.sr_below_50 ?? 0
    if (sr < 75) return r.sr_50_to_75 ?? 0
  }
  return 0
}
function ecoBonus(e: number | null, fmt: string, r: Rules): number {
  if (e === null) return 0
  if (fmt === 'T20') {
    if (e < 5) return r.economy_below_5 ?? 0
    if (e < 6) return r.economy_5_to_6 ?? 0
    if (e >= 11) return r.economy_above_11 ?? 0
    if (e >= 10) return r.economy_10_to_11 ?? 0
  }
  if (fmt === 'ODI') {
    if (e < 2.5) return r.economy_below_2_5 ?? 0
    if (e < 3.5) return r.economy_2_5_to_3_5 ?? 0
    if (e >= 9) return r.economy_above_9 ?? 0
    if (e >= 7) return r.economy_7_to_8 ?? 0
  }
  return 0
}

interface BatRow { runs?: number; ballsFaced?: number; fours?: number; sixes?: number; isDismissed?: boolean }
interface BowlRow { wickets?: number; wicketTypes?: string[]; maidens?: number; runsConceded?: number; ballsBowled?: number; dotBalls?: number; noBalls?: number; wides?: number }
interface FieldRow { catches?: number; stumpings?: number; runOutDirect?: number; runOutIndirect?: number }

function calcBatting(bat: BatRow, role: string, fmt: string, r: Rules): number {
  const { runs = 0, ballsFaced = 0, fours = 0, sixes = 0, isDismissed = false } = bat
  let pts = runs * (r.run ?? 0) + fours * (r.boundary4 ?? 0) + sixes * (r.boundary6 ?? 0)
  if (runs >= 100) pts += r.century ?? 0
  else if (runs >= 50) pts += r.half_century ?? 0
  // Duck penalty does NOT apply to bowlers — only batters / AR / WK.
  if (isDismissed && runs === 0 && role !== 'bowl') pts += r.duck ?? 0
  if (r.sr_above_170 !== undefined && ballsFaced >= 10) pts += srBonus(strikeRate(runs, ballsFaced), fmt, r)
  return pts
}
function calcBowling(bowl: BowlRow, fmt: string, r: Rules): number {
  const { wickets = 0, wicketTypes = [], maidens = 0, runsConceded = 0, ballsBowled = 0, dotBalls = 0, noBalls = 0, wides = 0 } = bowl
  let pts = wickets * (r.wicket ?? 0)
  const prem = wicketTypes.filter(t => ['lbw', 'bowled'].includes(String(t).toLowerCase())).length
  pts += prem * (r.lbw_bowled_bonus ?? 0)
  if (wickets >= 5 && r.five_wicket_haul) pts += r.five_wicket_haul
  else if (wickets >= 4 && r.four_wicket_haul) pts += r.four_wicket_haul
  pts += maidens * (r.maiden_over ?? 0) + dotBalls * (r.dot_ball ?? 0)
  // Economy bonus only kicks in once a bowler has bowled more than 1 over.
  if (ballsBowled > 6) pts += ecoBonus(economyRate(runsConceded, ballsBowled), fmt, r)
  pts += noBalls * (r.no_ball ?? 0) + wides * (r.wide ?? 0)
  return pts
}
function calcFielding(f: FieldRow, r: Rules): number {
  const { catches = 0, stumpings = 0, runOutDirect = 0, runOutIndirect = 0 } = f
  return catches * (r.catch ?? 0) + stumpings * (r.stumping ?? 0)
    + runOutDirect * (r.run_out_direct ?? 0) + runOutIndirect * (r.run_out_indirect ?? 0)
}

/** Raw fantasy points (no captaincy/booster multiplier) for one player's match stats. */
function rawPoints(
  player: { role: string; batting?: BatRow | null; bowling?: BowlRow | null; fielding?: FieldRow | null },
  fmt: string,
  rules: Rules,
): number {
  let raw = 0
  if (player.batting) raw += calcBatting(player.batting, player.role, fmt, rules)
  if (player.bowling) raw += calcBowling(player.bowling, fmt, rules)
  if (player.fielding) raw += calcFielding(player.fielding, rules)
  return Math.round(raw * 10) / 10
}

function captaincyMultiplier(captaincy: 'captain' | 'vice_captain' | 'normal', booster: string | null): number {
  const key = (booster === 'triple_captain' && captaincy === 'captain') ? 'triple_captain'
    : (booster === 'dual_captain' && captaincy === 'vice_captain') ? 'captain'
      : captaincy
  return MULTIPLIERS[key] ?? 1
}
function boosterMultiplier(booster: string | null, isOverseas: boolean): number {
  if (booster === 'team_double') return 2
  if (booster === 'os_double' && isOverseas) return 2
  if (booster === 'indian_double' && !isOverseas) return 2
  return 1
}

// ─────────────────────────────────────────────────────────────────────────────
// CricAPI adapter — ported from fromCricAPI() / parseDismissalEntry() /
// matchBowlerName() / deriveRole() / matchLifecycle() in index.html.
// ─────────────────────────────────────────────────────────────────────────────

function int(v: unknown): number { return parseInt(String(v), 10) || 0 }

function deriveRole(s = ''): string {
  s = s.toLowerCase()
  if (s.includes('wicket') || s === 'wk') return 'wk'
  if (s.includes('allround') || s === 'ar') return 'ar'
  if (s.includes('bowl')) return 'bowl'
  return 'bat'
}

interface DismissalParse { type: string; bowler: string | null; fielder: string | null; fielder2?: string | null }

function parseDismissalEntry(b: any): DismissalParse | null {
  const dText = String(b?.['dismissal-text'] ?? b?.dismissal ?? '').toLowerCase().trim()
  const d     = String(b?.dismissal ?? '').toLowerCase().trim()
  if (!d && (!dText || dText.includes('not out'))) return null
  if (d.includes('not out') || dText.includes('not out')) return null

  const strOrName = (v: any) => v?.name ?? (typeof v === 'string' && v ? v : null)
  const fielderName = strOrName(b.catch) ?? strOrName(b.fielder) ?? strOrName(b.catcher) ?? null
  const bowlerName  = strOrName(b.bowler) ?? null

  if (bowlerName && ['catch', 'caught', 'bowled', 'lbw', 'stumped'].includes(d)) {
    const type = d === 'catch' ? 'caught' : d
    return { type, bowler: bowlerName, fielder: fielderName }
  }
  if (d === 'cb' && bowlerName) return { type: 'caught', bowler: bowlerName, fielder: bowlerName }
  if (/^hit.?wicket$/i.test(d)) return { type: 'hit_wicket', bowler: bowlerName, fielder: null }
  if (/^run\s*out/.test(d)) {
    const parenMatch = d.match(/run\s*out\s*\(([^)]+)\)/i)
    const parts = parenMatch
      ? parenMatch[1].split(/\s*[/\\&]\s*/).map((n: string) => n.trim()).filter(Boolean)
      : (fielderName ? [fielderName] : [])
    return { type: 'run_out', bowler: null, fielder: parts[0] || null, fielder2: parts[1] || null }
  }

  const str = dText || d
  let m: RegExpMatchArray | null
  if ((m = str.match(/^lbw(?:\s+b\s+(.+))?/)))        return { type: 'lbw',     bowler: (m[1] || bowlerName || '').trim() || null, fielder: fielderName }
  if ((m = str.match(/^c\s*&\s*b\s+(.+)/)))           return { type: 'caught',  bowler: m[1].trim(),                               fielder: m[1].trim() }
  if ((m = str.match(/^c(?:t)?\s+(.+?)\s+b\s+(.+)/))) return { type: 'caught',  bowler: m[2].trim(),                               fielder: m[1].trim() }
  if ((m = str.match(/^st\s+(.+?)\s+b\s+(.+)/)))      return { type: 'stumped', bowler: m[2].trim(),                               fielder: m[1].trim() }
  if ((m = str.match(/^b\s+(.+)/)))                   return { type: 'bowled',  bowler: m[1].trim(),                               fielder: null }
  return null
}

function matchBowlerName(dismissalRef: string | null, candidates: string[]): string | null {
  if (!dismissalRef) return null
  const t = dismissalRef.toLowerCase().trim()
  const exact = candidates.find(c => c.toLowerCase() === t)
  if (exact) return exact
  const refSurname = t.split(/\s+/).pop()
  if (refSurname) {
    const bySurname = candidates.filter(c => c.toLowerCase().split(/\s+/).pop() === refSurname)
    if (bySurname.length === 1) return bySurname[0]
  }
  return null
}

interface ApiPlayer { id: string; name: string; role: string; batting?: BatRow; bowling?: BowlRow; fielding?: FieldRow }

/** Parses a CricAPI match_scorecard payload into per-player batting/bowling/fielding rows. */
function fromCricAPI(payload: any): ApiPlayer[] {
  const sc = payload?.data?.scorecard ?? payload?.scorecard ?? []
  const players: ApiPlayer[] = []
  const ensure = (key: string, name: string) => {
    let p = players.find(x => x.id === key)
    if (!p) { p = { id: key, name, role: 'bat' }; players.push(p) }
    return p
  }

  const fieldingMap: Record<string, { catches: number; stumpings: number; runOutDirect: number; runOutIndirect: number; rawName: string }> = {}
  const addFielding = (rawName: string | null | undefined, field: 'catches' | 'stumpings' | 'runOutDirect' | 'runOutIndirect') => {
    if (!rawName) return
    const k = rawName.toLowerCase().trim()
    if (!fieldingMap[k]) fieldingMap[k] = { catches: 0, stumpings: 0, runOutDirect: 0, runOutIndirect: 0, rawName }
    fieldingMap[k][field]++
  }

  for (const inn of sc) {
    const bowlerArr = inn.bowling || inn.bowlers || inn.bowl || []
    const bowlerNames = bowlerArr.map((b: any) => b.bowler?.name ?? b.player?.name ?? b.name ?? '').filter(Boolean)
    const wicketsByBowler: Record<string, string[]> = {}
    const battingRows = (inn.batting || []).map((b: any) => (b.batter ? { ...b, batsman: b.batter } : b))

    for (const b of battingRows) {
      const parsed = parseDismissalEntry(b)
      if (!parsed) continue
      const fullName = matchBowlerName(parsed.bowler, bowlerNames) || parsed.bowler
      if (fullName) (wicketsByBowler[fullName] = wicketsByBowler[fullName] || []).push(parsed.type)
      if (parsed.type === 'caught')  addFielding(parsed.fielder, 'catches')
      if (parsed.type === 'stumped') addFielding(parsed.fielder, 'stumpings')
      if (parsed.type === 'run_out') { addFielding(parsed.fielder, 'runOutDirect'); addFielding(parsed.fielder2, 'runOutIndirect') }
    }

    for (const b of (inn.batting || [])) {
      const batterObj = b.batter ?? b.batsman ?? b.player ?? null
      const name = batterObj?.name ?? b.name ?? ''
      if (!name) continue
      const id = String(batterObj?.pid ?? b.pid ?? name)
      const e = ensure(id, name)
      e.role = deriveRole(batterObj?.playing_role ?? batterObj?.role ?? '')
      e.batting = {
        runs: int(b.r), ballsFaced: int(b.b), fours: int(b['4s']), sixes: int(b['6s']),
        isDismissed: !!b.dismissal && !String(b.dismissal ?? '').toLowerCase().includes('not out'),
      }
    }

    for (const bw of bowlerArr) {
      const name = bw.bowler?.name ?? bw.player?.name ?? bw.name ?? ''
      if (!name) continue
      const id = String(bw.bowler?.pid ?? bw.player?.pid ?? bw.pid ?? name)
      const e = ensure(id, name)
      const [o, bb] = String(bw.o ?? 0).split('.')
      const totalBalls = int(o) * 6 + int(bb || 0)
      e.role = 'bowl'
      e.bowling = {
        wickets: int(bw.w), wicketTypes: wicketsByBowler[name] || [], maidens: int(bw.m),
        runsConceded: int(bw.r), ballsBowled: totalBalls, dotBalls: int(bw.dots ?? 0),
        noBalls: int(bw.nb ?? 0), wides: int(bw.wd ?? 0),
      }
    }
  }

  // Assign fielding stats — match against players already seen, falling back
  // to a brand-new synthetic entry (e.g. a substitute fielder who never bats/bowls).
  for (const { rawName, catches, stumpings, runOutDirect, runOutIndirect } of Object.values(fieldingMap)) {
    const norm = rawName.toLowerCase().trim()
    let player = players.find(p => p.name.toLowerCase() === norm)
      || players.find(p => p.name.toLowerCase().endsWith(' ' + norm))
      || players.find(p => norm.endsWith(' ' + p.name.toLowerCase().split(' ').pop()))
    if (!player) player = ensure(rawName, rawName)
    player.fielding = { catches, stumpings, runOutDirect, runOutIndirect }
  }

  for (const p of players) { if (p.batting && p.bowling) p.role = 'ar' }
  return players
}

function matchLifecycle(payload: any): 'completed' | 'live' | 'upcoming' | 'unknown' {
  const data = payload?.data ?? payload ?? {}
  if (data.matchEnded === true) return 'completed'
  if (data.matchStarted === true) return 'live'
  const status = String(data.status || payload?.status || '').toLowerCase()
  if (/won by|tied|no result|abandoned|match (ended|completed|drawn)|result|drawn/i.test(status)) return 'completed'
  if (/match started|in progress|innings break|live|stumps|tea|lunch|drinks|day [123456789]/i.test(status)) return 'live'
  if (/toss/i.test(status)) return 'live'
  const innings = data.scorecard ?? data.innings ?? data.scores ?? null
  if (Array.isArray(innings) && innings.length > 0) return 'live'
  if (/innings|over|wicket/i.test(status)) return 'live'
  if (/match not started|scheduled|fixture|upcoming/i.test(status)) return 'upcoming'
  if (!status) return 'unknown'
  return 'unknown'
}

// ─────────────────────────────────────────────────────────────────────────────
// Name resolution — identical algorithm to scrape-scorecard's resolvePlayerName,
// reused here against a CricAPI-scoped (source='cricapi') alias table so the
// two pipelines don't collide on the same alias row.
// ─────────────────────────────────────────────────────────────────────────────

interface ResolveResult { playerId: string | null; method: 'exact' | 'alias' | 'fuzzy' | 'unmatched' }

function resolvePlayerName(name: string, exactMap: Map<string, string>, aliasMap: Map<string, string>): ResolveResult {
  const norm = name.toLowerCase().trim()
  if (exactMap.has(norm)) return { playerId: exactMap.get(norm)!, method: 'exact' }
  if (aliasMap.has(norm)) return { playerId: aliasMap.get(norm)!, method: 'alias' }

  const lastName = norm.split(' ').pop()!
  for (const [pName, pId] of exactMap) {
    if (pName.split(' ').pop() === lastName) return { playerId: pId, method: 'fuzzy' }
  }
  const parts = norm.split(' ')
  if (parts.length === 2 && parts[0].length === 1) {
    const initial = parts[0]
    const lastName2 = parts[1]
    for (const [pName, pId] of exactMap) {
      const pParts = pName.split(' ')
      if (pParts.length >= 2 && pParts[0].startsWith(initial) && pParts[pParts.length - 1] === lastName2) {
        return { playerId: pId, method: 'fuzzy' }
      }
    }
  }
  return { playerId: null, method: 'unmatched' }
}

// ─────────────────────────────────────────────────────────────────────────────
// CricAPI fetch with multi-key rotation (server-side equivalent of the
// browser's fetchJsonWithFallback / getApiKeys / isKeyExhaustedError).
// ─────────────────────────────────────────────────────────────────────────────

function isKeyExhaustedError(msg: string): boolean {
  // Some CricAPI quota/auth failures don't come back as a clean HTTP error —
  // a key that's hit its daily cap can get its connection reset at the LB
  // before a JSON error is ever produced. Treat connection-level failures
  // the same as a recognized quota error so rotation still kicks in and
  // tries the next configured key instead of giving up on the first one.
  return /blocked|daily.limit|quota|too.many|429|invalid.*key|unauthori[sz]|connection reset|econnreset|client error \(connect\)|timed? ?out/i.test(String(msg))
}

async function fetchScorecard(externalId: string): Promise<any> {
  if (!CRICAPI_KEYS.length) throw new Error('No CRICAPI_KEYS configured (set the Edge Function secret)')
  let lastErr: Error | null = null
  for (const key of CRICAPI_KEYS) {
    try {
      // CricAPI (or a WAF in front of it) appears to reset bare server-to-server
      // requests with no User-Agent/Accept headers — confirmed the same key/id
      // works fine from a regular browser but gets "Connection reset by peer"
      // from this Edge Function. Send browser-like headers to rule that out
      // before assuming it's a hard IP-range block on Supabase's egress.
      const res = await fetch(`https://api.cricapi.com/v1/match_scorecard?apikey=${encodeURIComponent(key)}&id=${encodeURIComponent(externalId)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
        },
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        const msg = json?.message || `HTTP ${res.status}`
        if (isKeyExhaustedError(msg)) { lastErr = new Error(msg); continue }
        throw new Error(msg)
      }
      // CricAPI returns HTTP 200 with status:'failure' for quota/auth errors.
      if (json?.status === 'failure') {
        const msg = json?.message || 'CricAPI request failed'
        if (isKeyExhaustedError(msg)) { lastErr = new Error(msg); continue }
        throw new Error(msg)
      }
      return json
    } catch (e) {
      lastErr = e as Error
      if (!isKeyExhaustedError((e as Error).message)) throw e
    }
  }
  throw lastErr ?? new Error('All CricAPI keys exhausted')
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily XI (ad-hoc one-off teams) scoring — identical to scrape-scorecard's
// scoreDailyTeamsForMatch. No booster/custom-rules concept exists for Daily.
// ─────────────────────────────────────────────────────────────────────────────

async function scoreDailyTeamsForMatch(matchId: string, pointsMap: Map<string, number>): Promise<number> {
  const { data: teams, error } = await sb
    .from('user_teams')
    .select('id, captain_id, vice_captain_id, user_team_players(player_id)')
    .eq('match_id', matchId)
    .is('squad_id', null)
  if (error || !teams?.length) return 0

  const scoreRows = teams.map((t: any) => {
    const playerIds = (t.user_team_players ?? []).map((p: any) => p.player_id)
    let total = 0
    for (const pid of playerIds) {
      const raw  = pointsMap.get(pid) ?? 0
      const mult = pid === t.captain_id ? 2 : pid === t.vice_captain_id ? 1.5 : 1
      total += raw * mult
    }
    return { user_team_id: t.id, match_id: matchId, total_points: Math.round(total * 10) / 10, computed_at: new Date().toISOString() }
  })

  const CHUNK = 100
  for (let i = 0; i < scoreRows.length; i += CHUNK) {
    await sb.from('user_team_match_scores').upsert(scoreRows.slice(i, i + CHUNK), { onConflict: 'user_team_id,match_id' })
  }
  return scoreRows.length
}

// ─────────────────────────────────────────────────────────────────────────────
// Season Long XI scoring — full parity with the client's
// computeAndSaveSLScoresForMatch(): captain/VC multiplier, booster
// multiplier (team_double / os_double / indian_double / triple_captain /
// dual_captain), and per-contest custom scoring_rules re-scoring.
// ─────────────────────────────────────────────────────────────────────────────

interface PlayerStat { batting?: BatRow | null; bowling?: BowlRow | null; fielding?: FieldRow | null; raw_points: number }
interface PlayerMeta { role: string; is_overseas: boolean }

async function scoreSLForMatch(
  matchId: string,
  fmt: string,
  statsByPlayer: Map<string, PlayerStat>,
  metaByPlayer: Map<string, PlayerMeta>,
): Promise<number> {
  const { data: xiRows, error } = await sb
    .from('user_match_xi')
    .select('squad_id, player_id, is_captain, is_vc')
    .eq('match_id', matchId)
  if (error || !xiRows?.length) return 0

  const grouped = new Map<string, any[]>()
  for (const row of xiRows) {
    if (!grouped.has(row.squad_id)) grouped.set(row.squad_id, [])
    grouped.get(row.squad_id)!.push(row)
  }
  const squadIds = Array.from(grouped.keys())

  // Boosters for every squad in this match — one query (avoids RLS issues
  // scoring other users' squads, mirrors getAllBoostersForMatch).
  const { data: boosterRows } = await sb
    .from('user_booster_activations')
    .select('squad_id, booster')
    .eq('match_id', matchId)
  const boosterMap = new Map<string, string>()
  for (const b of boosterRows ?? []) boosterMap.set(b.squad_id, b.booster)

  // Contest → custom scoring rules, resolved per squad.
  const { data: squadRows } = await sb.from('user_squads').select('id, contest_id').in('id', squadIds)
  const contestIdBySquad = new Map<string, string>()
  for (const s of squadRows ?? []) if (s.contest_id) contestIdBySquad.set(s.id, s.contest_id)

  const contestIds = Array.from(new Set(contestIdBySquad.values()))
  const customRulesByContest = new Map<string, Rules | null>()
  if (contestIds.length) {
    const { data: contests } = await sb.from('contests').select('id, scoring_rules').in('id', contestIds)
    for (const c of contests ?? []) {
      const custom = c.scoring_rules?.[fmt]
      customRulesByContest.set(c.id, custom ? { ...DEFAULT_RULES[fmt], ...custom } : null)
    }
  }

  let totalSaved = 0
  for (const [squadId, rows] of grouped) {
    const booster     = boosterMap.get(squadId) ?? null
    const contestId    = contestIdBySquad.get(squadId)
    const customRules = contestId ? (customRulesByContest.get(contestId) ?? null) : null

    const scoreRows = rows.map((r: any) => {
      const s    = statsByPlayer.get(r.player_id)
      const meta = metaByPlayer.get(r.player_id)
      const isOverseas = meta?.is_overseas ?? false

      const raw = (customRules && s)
        ? rawPoints({ role: meta?.role ?? 'bat', batting: s.batting, bowling: s.bowling, fielding: s.fielding }, fmt, customRules)
        : Number(s?.raw_points ?? 0)

      const captaincy: 'captain' | 'vice_captain' | 'normal' = r.is_captain ? 'captain' : r.is_vc ? 'vice_captain' : 'normal'
      const mult = captaincyMultiplier(captaincy, booster) * boosterMultiplier(booster, isOverseas)

      return {
        squad_id: squadId, match_id: matchId, player_id: r.player_id,
        base_points: raw, multiplier: mult, total_points: Math.round(raw * mult * 10) / 10,
        computed_at: new Date().toISOString(),
      }
    })

    const { error: upErr } = await sb.from('user_match_xi_scores')
      .upsert(scoreRows, { onConflict: 'squad_id,match_id,player_id' })
    if (!upErr) totalSaved += scoreRows.length
  }
  return totalSaved
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  try {
    const body    = await req.json().catch(() => ({})) as { matchId?: string }
    const matchId = body.matchId ?? null
    const now     = new Date().toISOString()

    let query = sb
      .from('matches')
      .select(`
        id, match_number, format, status, external_id, tournament_id, start_time,
        tournament:tournaments!tournament_id(id, name, scraper_enabled, scoring_rules)
      `)
      .lte('start_time', now)
      .not('status', 'in', '("completed","delayed")')
      .not('external_id', 'is', null)

    if (matchId) {
      query = query.eq('id', matchId)
    } else {
      // Cron call — only process CricAPI-driven tournaments. Scraper-enabled
      // tournaments are owned by scrape-scorecard's own cron job.
      query = query.eq('tournaments.scraper_enabled', false)
    }

    const { data: matches, error: mErr } = await query
    if (mErr) throw mErr

    // Manual poll (matchId provided) bypasses the scraper_enabled gate — the
    // admin is explicitly asking to poll this match via CricAPI.
    const liveMatches = (matches ?? []).filter((m: any) => matchId ? true : m.tournament?.scraper_enabled === false)

    if (!liveMatches.length) {
      return new Response(
        JSON.stringify({ ok: true, message: 'No live CricAPI matches to poll' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const results = []

    for (const match of liveMatches as any[]) {
      const tournament = match.tournament
      const fmtKey      = (match.format ?? 'T20').toUpperCase()
      const rules: Rules = tournament?.scoring_rules?.[fmtKey] ?? DEFAULT_RULES[fmtKey] ?? DEFAULT_T20_RULES

      // ── 1. Fetch from CricAPI ────────────────────────────────────────────
      let payload: any
      try {
        payload = await fetchScorecard(match.external_id)
      } catch (e) {
        results.push({ matchId: match.id, status: 'fetch_failed', error: (e as Error).message })
        continue
      }

      // Cache the raw payload — survives even if this run fails downstream,
      // and lets an admin re-finalize from cache later without re-fetching.
      await sb.from('match_scorecards').upsert(
        { match_id: match.id, payload, fetched_at: new Date().toISOString() },
        { onConflict: 'match_id' },
      )

      const stage = matchLifecycle(payload)

      if (stage === 'upcoming') {
        results.push({ matchId: match.id, status: 'upcoming' })
        continue
      }

      // ── 2. Build name-resolution maps from the tournament roster ─────────
      const { data: tPlayers } = await sb
        .from('tournament_players')
        .select('player_id, players(id, name, role, is_overseas)')
        .eq('tournament_id', match.tournament_id)

      const { data: aliasRows } = await sb
        .from('player_name_aliases')
        .select('alias, player_id')
        .eq('tournament_id', match.tournament_id)
        .eq('source', 'cricapi')

      const exactMap = new Map<string, string>()
      const metaByPlayer = new Map<string, PlayerMeta>()
      for (const tp of tPlayers ?? []) {
        const p = (tp as any).players
        if (!p) continue
        exactMap.set(p.name.toLowerCase().trim(), tp.player_id)
        metaByPlayer.set(tp.player_id, { role: p.role ?? 'bat', is_overseas: !!p.is_overseas })
      }
      const aliasMap = new Map<string, string>()
      for (const a of aliasRows ?? []) aliasMap.set(a.alias.toLowerCase().trim(), a.player_id)

      // ── 3. Parse CricAPI scorecard ─────────────────────────────────────
      const apiPlayers = fromCricAPI(payload)
      if (!apiPlayers.length) {
        results.push({ matchId: match.id, status: 'no_player_rows', stage })
        continue
      }

      // ── 4. Resolve names → score → dedupe by local player id ───────────
      const statsByPlayer = new Map<string, PlayerStat>()
      const unmatched: Array<{ name: string; context: 'batting' | 'bowling' }> = []
      const fuzzyAliases: Array<{ player_id: string; alias: string }> = []

      for (const pl of apiPlayers) {
        const { playerId, method } = resolvePlayerName(pl.name, exactMap, aliasMap)
        if (!playerId) {
          unmatched.push({ name: pl.name, context: pl.bowling ? 'bowling' : 'batting' })
          continue
        }
        if (method === 'fuzzy') fuzzyAliases.push({ player_id: playerId, alias: pl.name.toLowerCase().trim() })
        if (statsByPlayer.has(playerId)) continue // dedupe — two API names resolved to the same local player

        const meta = metaByPlayer.get(playerId)
        const localRole = meta?.role ?? pl.role // local DB role is authoritative for the duck-penalty exemption
        const raw = rawPoints({ role: localRole, batting: pl.batting, bowling: pl.bowling, fielding: pl.fielding }, fmtKey, rules)

        statsByPlayer.set(playerId, {
          batting: pl.batting ?? null, bowling: pl.bowling ?? null, fielding: pl.fielding ?? null,
          raw_points: raw,
        })
      }

      // ── 5. Upsert player_match_stats ────────────────────────────────────
      const statRows = Array.from(statsByPlayer.entries()).map(([playerId, s]) => ({
        match_id: match.id, player_id: playerId,
        batting: s.batting, bowling: s.bowling, fielding: s.fielding,
        raw_points: s.raw_points, source: 'cricapi',
      }))
      if (statRows.length) {
        const CHUNK = 50
        for (let i = 0; i < statRows.length; i += CHUNK) {
          const { error: uErr } = await sb.from('player_match_stats')
            .upsert(statRows.slice(i, i + CHUNK), { onConflict: 'match_id,player_id' })
          if (uErr) throw uErr
        }
      }

      // ── 6. Persist fuzzy aliases + unmatched names (source='cricapi') ──
      if (fuzzyAliases.length) {
        await sb.from('player_name_aliases').upsert(
          fuzzyAliases.map(a => ({ player_id: a.player_id, tournament_id: match.tournament_id, alias: a.alias, source: 'cricapi' })),
          { onConflict: 'alias,source,tournament_id', ignoreDuplicates: true },
        )
      }
      if (unmatched.length) {
        await sb.from('scraper_unmatched').upsert(
          unmatched.map(u => ({ tournament_id: match.tournament_id, match_id: match.id, raw_name: u.name, source: 'cricapi', context: u.context })),
          { onConflict: 'tournament_id,raw_name,source', ignoreDuplicates: true },
        )
      }

      // ── 7. Cascade to Daily + Season Long scores ────────────────────────
      const pointsMap = new Map<string, number>()
      for (const [pid, s] of statsByPlayer) pointsMap.set(pid, s.raw_points)
      const dailyTeamsScored = await scoreDailyTeamsForMatch(match.id, pointsMap)
      const slScored         = await scoreSLForMatch(match.id, fmtKey, statsByPlayer, metaByPlayer)

      // ── 8. Update match status (mirrors the browser poller's apiStatus logic) ──
      const apiStatus = stage === 'completed' ? 'completed' : stage === 'live' ? 'in_progress' : null
      if (apiStatus && match.status !== apiStatus) {
        await sb.from('matches').update({ status: apiStatus }).eq('id', match.id)
      }

      results.push({
        matchId: match.id, status: 'ok', stage,
        matched: statRows.length, unmatched: unmatched.map(u => u.name),
        fuzzyAliasesCreated: fuzzyAliases.length,
        dailyTeamsScored, slScored,
        matchCompleted: stage === 'completed',
      })
    }

    return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('[poll-cricapi]', err)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
