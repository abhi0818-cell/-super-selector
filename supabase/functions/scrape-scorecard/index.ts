/**
 * scrape-scorecard — Supabase Edge Function
 *
 * Fetches a live match scorecard from CricketAddictor (primary) or
 * Business Standard (fallback), resolves player names against the
 * tournament roster, writes player_match_stats, then distributes
 * raw_points to user_match_xi_scores so users see near-live fantasy totals.
 *
 * Triggered by:
 *   - pg_cron every 15 min (body: {})               → scrapes all live matches
 *   - Admin "Scrape Now" button (body: {matchId})    → scrapes one match
 *
 * Required env vars (set in Supabase dashboard → Settings → Edge Functions):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Browser (admin "Scrape Now" button) calls this directly, so it needs CORS
// headers just like cricapi-proxy — otherwise the POST is blocked client-side
// before the response ever reaches the page ("Load failed" / "Failed to fetch").
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ─── Slug / URL helpers ───────────────────────────────────────────────────────

function toSlug(s: string): string {
  return s.toLowerCase().trim()
    .replace(/['']/g, '')                 // CricketAddictor drops apostrophes entirely ("Women's" → "womens")
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Strip a trailing women's-team marker ("-w" / "-women") so our slugs line up
 *  with CricketAddictor's convention of using the plain country/club code even
 *  inside a women's tournament (e.g. our "NZ-W" → their "nz"). */
function stripGenderSuffix(slug: string): string {
  return slug.replace(/-(?:women|w)$/i, '')
}

/** Map of short country codes (as stored in our `teams.name`, e.g. "NZ" in
 *  "NZ-W") to the full country slug CricketAddictor actually uses in its
 *  URLs. Needed because ICC-tournament URLs (e.g. the Women's T20 World Cup)
 *  use the full country name — optionally plus "-women" — rather than the
 *  bare 2-3 letter code our DB stores (our "NZ-W" → their
 *  "new-zealand-women", not "nz"). */
const COUNTRY_CODE_TO_SLUG: Record<string, string> = {
  nz: 'new-zealand', sl: 'sri-lanka', ind: 'india', aus: 'australia', eng: 'england',
  pak: 'pakistan', sa: 'south-africa', wi: 'west-indies', ban: 'bangladesh', ire: 'ireland',
  sco: 'scotland', afg: 'afghanistan', zim: 'zimbabwe', usa: 'united-states',
  uae: 'united-arab-emirates', ned: 'netherlands', nam: 'namibia', png: 'papua-new-guinea',
  can: 'canada', nep: 'nepal', oma: 'oman', qat: 'qatar', ken: 'kenya', hk: 'hong-kong',
  jer: 'jersey', ber: 'bermuda', tha: 'thailand', vct: 'vanuatu',
}

/** Expand a short team-code slug (e.g. "nz-w", "nz") into the full slug
 *  CricketAddictor uses (e.g. "new-zealand-women", "new-zealand"). Returns
 *  null when the slug isn't a recognized short code (e.g. it's already a
 *  full name), so callers can fall back to the existing candidates. */
function expandTeamSlug(slug: string): string | null {
  const isWomen = /-(?:women|w)$/i.test(slug)
  const bare    = stripGenderSuffix(slug)
  const full    = COUNTRY_CODE_TO_SLUG[bare]
  if (!full) return null
  return isWomen ? `${full}-women` : full
}

function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

/** Convert match_type DB value → CricketAddictor URL slug fragment(s) to try.
 *  Different series use different conventions for ordinary (non-knockout)
 *  matches — some use plain "match-7" (e.g. ICC World Cups), others use the
 *  ordinal form "7th-match" (e.g. several domestic First Class series) — so we
 *  try both rather than assuming one. */
function matchTypeSlugVariants(matchType: string | null, matchNumber: number): string[] {
  switch (matchType) {
    case 'final':       return ['final']
    case 'semi_final':  return ['semi-final']
    case 'qualifier_1': return ['qualifier-1']
    case 'qualifier_2': return ['qualifier-2']
    case 'eliminator':  return ['eliminator']
    default:            return [`match-${matchNumber}`, `${ordinal(matchNumber)}-match`]
  }
}

function cricketAddictorUrl(t1: string, t2: string, desc: string, series: string): string {
  return `https://cricketaddictor.com/livescore/${t1}-vs-${t2}-${desc}-${series}/scorecard/`
}

// ─── Listing-page scan (team + start-time + tournament matching) ─────────────
// CricketAddictor's live / upcoming / recent listing pages already contain the
// real scorecard hrefs. Rather than only guessing a slug, we parse these
// listings and score each entry by: team-code containment (gender-suffix
// tolerant), proximity of the listed kickoff time to our match.start_time, and
// how many tournament-name keywords appear near the entry. This is far more
// robust than slug-guessing alone whenever a tournament's real slug doesn't
// exactly mirror our `teams.name` / `tournaments.name` values.

interface ListingMatch {
  baseUrl: string
  team1Slug: string
  team2Slug: string
  dateTimeText: string | null
  contextText: string
}

function parseListingMatches(html: string): ListingMatch[] {
  const out: ListingMatch[] = []
  const re = /href="(https:\/\/cricketaddictor\.com\/livescore\/([a-z0-9-]+)\/)scorecard\/"/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const baseUrl = m[1]
    const slug    = m[2]
    const vsIdx   = slug.indexOf('-vs-')
    if (vsIdx === -1) continue
    const team1Slug = slug.slice(0, vsIdx)
    const rest      = slug.slice(vsIdx + 4)
    // The team2 slug ends where the match-number / match-type segment begins.
    const cut = rest.match(/-(?:\d+(?:st|nd|rd|th)?-match|match-\d+|final|semi-final|qualifier-\d|eliminator)-/)
    const team2Slug = cut ? rest.slice(0, cut.index) : rest.split('-').slice(0, 3).join('-')

    const windowStart = Math.max(0, m.index - 600)
    const context      = html.slice(windowStart, m.index + 600)
    const dateM         = context.match(/([A-Za-z]+ \d{1,2}, \d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/)

    out.push({ baseUrl, team1Slug, team2Slug, dateTimeText: dateM ? dateM[1] : null, contextText: context })
  }
  return out
}

function teamSlugMatches(ourSlug: string, theirSlug: string): boolean {
  const a = stripGenderSuffix(ourSlug)
  const b = stripGenderSuffix(theirSlug)
  return a === b || a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a)
}

// Cache parsed listing pages for the lifetime of one Edge Function invocation —
// a single cron run processes every live match, so this avoids re-fetching the
// same listing page once per match.
const listingCache = new Map<string, ListingMatch[]>()

async function getListing(url: string): Promise<ListingMatch[]> {
  if (listingCache.has(url)) return listingCache.get(url)!
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperSelector/1.0)' } })
    if (!r.ok) { listingCache.set(url, []); return [] }
    const html   = await r.text()
    const parsed = parseListingMatches(html)
    listingCache.set(url, parsed)
    return parsed
  } catch {
    listingCache.set(url, [])
    return []
  }
}

async function scanListingsForMatch(
  homeSlug: string, awaySlug: string,
  startTime: string | null, tournamentName: string,
): Promise<string | null> {
  const pages = [
    'https://cricketaddictor.com/livescore/',
    'https://cricketaddictor.com/livescore/upcoming-matches/',
    'https://cricketaddictor.com/livescore/recent-matches/',
  ]
  const targetMs = startTime ? new Date(startTime).getTime() : NaN
  const tWords   = tournamentName.toLowerCase().split(/\W+/).filter(w => w.length > 3)

  let best: { url: string; score: number } | null = null

  for (const page of pages) {
    const listing = await getListing(page)
    for (const lm of listing) {
      const teamsMatch =
        (teamSlugMatches(homeSlug, lm.team1Slug) && teamSlugMatches(awaySlug, lm.team2Slug)) ||
        (teamSlugMatches(homeSlug, lm.team2Slug) && teamSlugMatches(awaySlug, lm.team1Slug))
      if (!teamsMatch) continue

      let score = 1
      if (lm.dateTimeText && !isNaN(targetMs)) {
        const parsed = Date.parse(lm.dateTimeText)
        if (!isNaN(parsed)) {
          const diffHrs = Math.abs(parsed - targetMs) / 36e5
          if (diffHrs <= 48) score += (48 - diffHrs) / 48   // closer kickoff time → higher score
        }
      }
      const ctxLower = lm.contextText.toLowerCase()
      score += tWords.filter(w => ctxLower.includes(w)).length * 0.5  // tournament-name keyword overlap

      if (!best || score > best.score) best = { url: lm.baseUrl + 'scorecard/', score }
    }
  }
  return best ? best.url : null
}

/**
 * Try to discover the CricketAddictor scorecard URL for a match.
 * 1. Construct candidate URLs from slugs — both team orderings, both
 *    gender-suffix forms, and both match-number formats ("match-7" /
 *    "7th-match") — and HEAD-check each.
 * 2. Scan live / upcoming / recent listing pages, matching by team codes plus
 *    start-time and tournament-name proximity as tie-breakers.
 * 3. Last resort: regex-scan recent-matches for a link containing both
 *    (gender-suffix-stripped) team slugs.
 */
async function discoverUrl(
  homeTeam: string, awayTeam: string,
  matchType: string | null, matchNumber: number,
  tournamentName: string, startTime: string | null,
): Promise<string | null> {
  const t1     = toSlug(homeTeam)
  const t2     = toSlug(awayTeam)
  const t1Bare = stripGenderSuffix(t1)
  const t2Bare = stripGenderSuffix(t2)
  const t1Full = expandTeamSlug(t1)
  const t2Full = expandTeamSlug(t2)
  const series = toSlug(tournamentName)
  const descs  = matchTypeSlugVariants(matchType, matchNumber)

  // Try the full-country-name expansion first — it's the correct form for
  // ICC tournaments (and most others) when our team slug is a short code.
  const teamPairs: Array<[string, string]> = []
  if (t1Full && t2Full) teamPairs.push([t1Full, t2Full], [t2Full, t1Full])
  teamPairs.push([t1, t2], [t2, t1])
  if (t1Bare !== t1 || t2Bare !== t2) teamPairs.push([t1Bare, t2Bare], [t2Bare, t1Bare])

  const candidates: string[] = []
  for (const desc of descs) {
    for (const [a, b] of teamPairs) candidates.push(cricketAddictorUrl(a, b, desc, series))
  }

  for (const url of candidates) {
    try {
      const r = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperSelector/1.0)' },
      })
      if (r.ok) return url
    } catch { /* try next */ }
  }

  // Listing-page scan: match by team codes + start-time + tournament proximity.
  // Prefer the full-name expansion (e.g. "new-zealand") when available, since
  // listing pages spell out full country names, not our short codes.
  const scanned = await scanListingsForMatch(
    t1Full ? stripGenderSuffix(t1Full) : t1Bare,
    t2Full ? stripGenderSuffix(t2Full) : t2Bare,
    startTime, tournamentName,
  )
  if (scanned) return scanned

  // Last-resort fallback: substring scan using gender-stripped slugs (prefer
  // the full-name expansion when we have one, same reasoning as above)
  const t1Scan = t1Full ? stripGenderSuffix(t1Full) : t1Bare
  const t2Scan = t2Full ? stripGenderSuffix(t2Full) : t2Bare
  try {
    const r = await fetch('https://cricketaddictor.com/livescore/recent-matches/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperSelector/1.0)' },
    })
    if (r.ok) {
      const html = await r.text()
      const re = new RegExp(
        `href="(https://cricketaddictor\\.com/livescore/[^"]*(?:${t1Scan}[^"]*${t2Scan}|${t2Scan}[^"]*${t1Scan})[^"]*scorecard/)"`,
        'i',
      )
      const m = html.match(re)
      if (m) return m[1]
    }
  } catch { /* continue to null */ }

  return null
}

// ─── HTML parsers ─────────────────────────────────────────────────────────────

interface BatRow  { name: string; runs: number; balls: number; fours: number; sixes: number; dismissed: boolean }
interface BowlRow { name: string; overs: number; runs: number; wickets: number; maidens: number; dots: number }
interface Innings { teamName: string; batting: BatRow[]; bowling: BowlRow[] }

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function firstLinkText(html: string): string {
  const m = html.match(/<a[^>]*>([^<]+)<\/a>/)
  return m ? m[1].trim() : ''
}

function parseTables(html: string): string[] {
  const tables: string[] = []
  const re = /<table[\s\S]*?<\/table>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) tables.push(m[0])
  return tables
}

function parseRows(tableHtml: string): string[][] {
  const rows: string[][] = []
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let rowM: RegExpExecArray | null
  let first = true
  while ((rowM = rowRe.exec(tableHtml)) !== null) {
    if (first) { first = false; continue } // skip header
    const cells: string[] = []
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi
    let cellM: RegExpExecArray | null
    while ((cellM = cellRe.exec(rowM[1])) !== null) cells.push(cellM[1])
    if (cells.length) rows.push(cells)
  }
  return rows
}

/** Parse CricketAddictor scorecard HTML */
function parseCricketAddictor(html: string): Innings[] {
  const innings: Innings[] = []
  // Innings sections are delimited by <h2> with "Inning" in text
  const sectionRe = /<h2[^>]*>([^<]*Inning[^<]*)<\/h2>([\s\S]*?)(?=<h2|<h3.*Match Info|$)/gi
  let sec: RegExpExecArray | null
  while ((sec = sectionRe.exec(html)) !== null) {
    const teamName = sec[1].replace(/\s+Inning.*$/i, '').trim()
    const body     = sec[2]
    const tables   = parseTables(body)

    // ── Batting (first table) ──
    const batting: BatRow[] = []
    if (tables[0]) {
      for (const cells of parseRows(tables[0])) {
        if (cells.length < 6) continue
        const nameHtml  = cells[0]
        const name      = firstLinkText(nameHtml) || stripTags(nameHtml).split(' ')[0]
        if (!name) continue
        const dismissed = !nameHtml.toLowerCase().includes('not out')
        batting.push({
          name,
          runs:      parseInt(stripTags(cells[1]), 10) || 0,
          balls:     parseInt(stripTags(cells[2]), 10) || 0,
          fours:     parseInt(stripTags(cells[3]), 10) || 0,
          sixes:     parseInt(stripTags(cells[4]), 10) || 0,
          dismissed,
        })
      }
    }

    // ── Bowling (second table) — columns: Bowling, O, R, W, ECO, Dots ──
    const bowling: BowlRow[] = []
    if (tables[1]) {
      for (const cells of parseRows(tables[1])) {
        if (cells.length < 4) continue
        const name = firstLinkText(cells[0]) || stripTags(cells[0])
        if (!name) continue
        bowling.push({
          name,
          overs:   parseFloat(stripTags(cells[1])) || 0,
          runs:    parseInt(stripTags(cells[2]), 10) || 0,
          wickets: parseInt(stripTags(cells[3]), 10) || 0,
          maidens: 0,  // CA doesn't show maidens
          dots:    parseInt(stripTags(cells[5] ?? ''), 10) || 0,
        })
      }
    }

    if (batting.length || bowling.length) innings.push({ teamName, batting, bowling })
  }
  return innings
}

/** Parse Business Standard scorecard HTML */
function parseBusinessStandard(html: string): Innings[] {
  const innings: Innings[] = []
  // BS uses <h4> with "Inning" in text
  const sectionRe = /<h4[^>]*>([^<]*(?:Inning|Innings)[^<]*)<\/h4>([\s\S]*?)(?=<h4|$)/gi
  let sec: RegExpExecArray | null
  while ((sec = sectionRe.exec(html)) !== null) {
    const teamName = sec[1].replace(/\s+Inning.*$/i, '').trim()
    const body     = sec[2]
    const tables   = parseTables(body)

    // ── Batting ──
    const batting: BatRow[] = []
    if (tables[0]) {
      for (const cells of parseRows(tables[0])) {
        if (cells.length < 6) continue
        const raw  = stripTags(cells[0])
        // BS puts name and dismissal in same cell separated by whitespace
        const name = raw.split(/\s{2,}/)[0].trim()
        if (!name || name === 'Extras' || name === 'Total' || name === 'Yet to Bat') continue
        batting.push({
          name,
          runs:      parseInt(stripTags(cells[1]), 10) || 0,
          balls:     parseInt(stripTags(cells[2]), 10) || 0,
          fours:     parseInt(stripTags(cells[3]), 10) || 0,
          sixes:     parseInt(stripTags(cells[4]), 10) || 0,
          dismissed: !raw.toLowerCase().includes('not out'),
        })
      }
    }

    // ── Bowling — columns: Bowler, O, M, R, W, NB, WD, ECO ──
    const bowling: BowlRow[] = []
    if (tables[1]) {
      for (const cells of parseRows(tables[1])) {
        if (cells.length < 5) continue
        const name = stripTags(cells[0]).trim()
        if (!name) continue
        bowling.push({
          name,
          overs:   parseFloat(stripTags(cells[1])) || 0,
          maidens: parseInt(stripTags(cells[2]), 10) || 0,
          runs:    parseInt(stripTags(cells[3]), 10) || 0,
          wickets: parseInt(stripTags(cells[4]), 10) || 0,
          dots:    0,
        })
      }
    }

    if (batting.length || bowling.length) innings.push({ teamName, batting, bowling })
  }
  return innings
}

// ─── Scoring formula (mirrors index.html calcBatting / calcBowling) ───────────
// Rules object shape: { run, boundary4, boundary6, half_century, century, duck,
//   sr_above_170, sr_140_to_170, sr_below_70, sr_70_to_100,
//   wicket, maiden_over, dot_ball, four_wicket_haul, five_wicket_haul,
//   economy_below_5, economy_5_to_6, economy_10_to_11, economy_above_11 }

interface Rules { [key: string]: number }

function srBonus(sr: number, fmt: string, r: Rules): number {
  if (fmt === 'T20') {
    if (sr > 170) return r.sr_above_170 ?? 0
    if (sr >= 140) return r.sr_140_to_170 ?? 0
    if (sr < 70)  return r.sr_below_70 ?? 0
    if (sr < 100) return r.sr_70_to_100 ?? 0
  }
  if (fmt === 'ODI') {
    if (sr > 140) return r.sr_above_140 ?? 0
    if (sr >= 120) return r.sr_120_to_140 ?? 0
    if (sr < 50)  return r.sr_below_50 ?? 0
    if (sr < 75)  return r.sr_50_to_75 ?? 0
  }
  return 0
}

function ecoBonus(eco: number, fmt: string, r: Rules): number {
  if (fmt === 'T20') {
    if (eco < 5)  return r.economy_below_5 ?? 0
    if (eco < 6)  return r.economy_5_to_6 ?? 0
    if (eco >= 11) return r.economy_above_11 ?? 0
    if (eco >= 10) return r.economy_10_to_11 ?? 0
  }
  if (fmt === 'ODI') {
    if (eco < 2.5) return r.economy_below_2_5 ?? 0
    if (eco < 3.5) return r.economy_2_5_to_3_5 ?? 0
    if (eco >= 9)  return r.economy_above_9 ?? 0
    if (eco >= 7)  return r.economy_7_to_8 ?? 0
  }
  return 0
}

function calcBatting(bat: BatRow, role: string, fmt: string, r: Rules): number {
  let pts = 0
  pts += bat.runs  * (r.run ?? 1)
  pts += bat.fours * (r.boundary4 ?? 0)
  pts += bat.sixes * (r.boundary6 ?? 0)
  if (bat.runs >= 100) pts += (r.century ?? 0)
  else if (bat.runs >= 50) pts += (r.half_century ?? 0)
  if (bat.dismissed && bat.runs === 0 && role !== 'bowl') pts += (r.duck ?? 0)
  if (r.sr_above_170 !== undefined && bat.balls >= 10) {
    const sr = (bat.runs / bat.balls) * 100
    pts += srBonus(sr, fmt, r)
  }
  return pts
}

function calcBowling(bowl: BowlRow, fmt: string, r: Rules): number {
  let pts = 0
  pts += bowl.wickets * (r.wicket ?? 25)
  if (bowl.wickets >= 5 && r.five_wicket_haul) pts += r.five_wicket_haul
  else if (bowl.wickets >= 4 && r.four_wicket_haul) pts += r.four_wicket_haul
  pts += bowl.maidens * (r.maiden_over ?? 0)
  pts += bowl.dots    * (r.dot_ball ?? 0)
  const ballsBowled = Math.round(bowl.overs) * 6 + Math.round((bowl.overs % 1) * 10)
  if (ballsBowled > 6) {
    const eco = ballsBowled === 0 ? 0 : (bowl.runs / ballsBowled) * 6
    pts += ecoBonus(eco, fmt, r)
  }
  return pts
}

// ─── Default T20 scoring rules (fallback if tournament has none) ──────────────
const DEFAULT_T20_RULES: Rules = {
  run: 1, boundary4: 1, boundary6: 2,
  half_century: 8, century: 16, duck: -2,
  sr_above_170: 6, sr_140_to_170: 4, sr_below_70: -6, sr_70_to_100: -4,
  wicket: 25, maiden_over: 8, dot_ball: 0,
  four_wicket_haul: 8, five_wicket_haul: 16,
  economy_below_5: 6, economy_5_to_6: 4, economy_10_to_11: -4, economy_above_11: -6,
  catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
}

// ─── Name resolution ──────────────────────────────────────────────────────────

interface ResolveResult { playerId: string | null; method: 'exact' | 'alias' | 'fuzzy' | 'unmatched' }

function resolvePlayerName(
  name: string,
  exactMap: Map<string, string>,  // normalised full name → player_id
  aliasMap: Map<string, string>,  // alias → player_id
): ResolveResult {
  const norm = name.toLowerCase().trim()

  if (exactMap.has(norm)) return { playerId: exactMap.get(norm)!, method: 'exact' }
  if (aliasMap.has(norm)) return { playerId: aliasMap.get(norm)!, method: 'alias' }

  // Fuzzy: last-name match
  const lastName = norm.split(' ').pop()!
  for (const [pName, pId] of exactMap) {
    if (pName.split(' ').pop() === lastName) return { playerId: pId, method: 'fuzzy' }
  }
  // Fuzzy: initials match, e.g. "V Kohli" vs "Virat Kohli"
  const parts = norm.split(' ')
  if (parts.length === 2 && parts[0].length === 1) {
    const initial  = parts[0]
    const lastName2 = parts[1]
    for (const [pName, pId] of exactMap) {
      const pParts = pName.split(' ')
      if (pParts.length >= 2 && pParts[0].startsWith(initial) && pParts.pop() === lastName2) {
        return { playerId: pId, method: 'fuzzy' }
      }
    }
  }

  return { playerId: null, method: 'unmatched' }
}

// ─── XI scoring distribution ─────────────────────────────────────────────────

async function scoreXIForMatch(matchId: string, pointsMap: Map<string, number>) {
  // Get all locked XIs for this match
  const { data: xiRows, error } = await sb
    .from('user_match_xi')
    .select('squad_id, player_id, is_captain, is_vc')
    .eq('match_id', matchId)

  if (error || !xiRows?.length) return

  const scoreRows = xiRows.map((xi: any) => {
    const raw   = pointsMap.get(xi.player_id) ?? 0
    const mult  = xi.is_captain ? 2 : xi.is_vc ? 1.5 : 1
    return {
      squad_id    : xi.squad_id,
      match_id    : matchId,
      player_id   : xi.player_id,
      base_points : Math.round(raw * 10) / 10,
      multiplier  : mult,
      total_points: Math.round(raw * mult * 10) / 10,
      computed_at : new Date().toISOString(),
    }
  })

  const CHUNK = 100
  for (let i = 0; i < scoreRows.length; i += CHUNK) {
    await sb.from('user_match_xi_scores').upsert(
      scoreRows.slice(i, i + CHUNK),
      { onConflict: 'squad_id,match_id,player_id' },
    )
  }
}

// ─── Daily XI (ad-hoc one-off teams) scoring distribution ───────────────────
//
// Daily teams live in user_teams (squad_id IS NULL) + user_team_players, and
// their totals are stored in user_team_match_scores. Previously this table was
// only ever updated by an admin-triggered client-side recompute; this mirrors
// that same captain/VC multiplier logic so the cron scraper keeps Daily XI
// leaderboards live, the same way it already does for Season Long squads.

async function scoreDailyTeamsForMatch(matchId: string, pointsMap: Map<string, number>) {
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
    return {
      user_team_id: t.id,
      match_id    : matchId,
      total_points: Math.round(total * 10) / 10,
      computed_at : new Date().toISOString(),
    }
  })

  const CHUNK = 100
  for (let i = 0; i < scoreRows.length; i += CHUNK) {
    await sb.from('user_team_match_scores').upsert(
      scoreRows.slice(i, i + CHUNK),
      { onConflict: 'user_team_id,match_id' },
    )
  }
  return scoreRows.length
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS })
  }
  try {
    const body     = await req.json().catch(() => ({})) as { matchId?: string }
    const matchId  = body.matchId ?? null

    // A match is considered "in play" when its start_time has passed and it is
    // neither completed nor delayed.  Admin does NOT need to manually flip status
    // to 'live' — the scraper treats past-start-time as implicitly live.
    const now = new Date().toISOString()

    let query = sb
      .from('matches')
      .select(`
        id, match_number, match_type, format, status, scorecard_url, tournament_id, start_time,
        home_team:teams!home_team_id(id, name),
        away_team:teams!away_team_id(id, name),
        tournament:tournaments!tournament_id(id, name, scraper_enabled, scoring_rules)
      `)
      .lte('start_time', now)
      .not('status', 'in', '("completed","delayed")')

    if (matchId) {
      query = query.eq('id', matchId)
    } else {
      // When called by cron, only process scraper-enabled tournaments
      query = query.eq('tournaments.scraper_enabled', true)
    }

    const { data: matches, error: mErr } = await query
    if (mErr) throw mErr

    // Manual scrapes (matchId provided) bypass the scraper_enabled gate —
    // the admin is explicitly asking to scrape this match.
    const liveMatches = (matches ?? []).filter(
      (m: any) => matchId ? true : m.tournament?.scraper_enabled === true,
    )

    if (!liveMatches.length) {
      return new Response(
        JSON.stringify({ ok: true, message: 'No live matches with scraper enabled' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const results = []

    for (const match of liveMatches) {
      const tournament = match.tournament as any
      const homeTeam   = (match.home_team as any)?.name ?? ''
      const awayTeam   = (match.away_team as any)?.name ?? ''
      const fmt        = match.format ?? 'T20'

      // ── 1. Discover / use cached URL ──────────────────────────────────────
      // A manual "Scrape Now" (matchId provided) always re-discovers — the
      // admin is explicitly retrying, often *because* a previously cached
      // URL was wrong, so reusing that same cached URL here would silently
      // repeat the same failure forever.
      let url: string | null = matchId ? null : (match.scorecard_url ?? null)

      if (!url) {
        url = await discoverUrl(
          homeTeam, awayTeam, match.match_type, match.match_number,
          tournament.name, (match as any).start_time ?? null,
        )
        if (url) {
          await sb.from('matches').update({ scorecard_url: url }).eq('id', match.id)
        }
      }

      if (!url) {
        results.push({ matchId: match.id, status: 'url_not_found', fallback: 'cricapi' })
        continue
      }

      // ── 2. Fetch HTML ──────────────────────────────────────────────────────
      let html: string
      let source: 'cricketaddictor' | 'business_standard'

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperSelector/1.0)' },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        html   = await res.text()
        source = url.includes('cricketaddictor') ? 'cricketaddictor' : 'business_standard'
      } catch (e) {
        // Clear the cached URL — it may be stale/wrong, so the next attempt
        // (cron or manual) re-runs discovery instead of retrying the same dead link.
        await sb.from('matches').update({ scorecard_url: null }).eq('id', match.id)
        results.push({ matchId: match.id, status: 'fetch_failed', url, error: (e as Error).message })
        continue
      }

      // ── 3. Parse innings ──────────────────────────────────────────────────
      const innings = source === 'cricketaddictor'
        ? parseCricketAddictor(html)
        : parseBusinessStandard(html)

      if (!innings.length) {
        // Same reasoning: a cached URL that fetches OK but never parses
        // (wrong page / wrong match) shouldn't be reused on the next attempt.
        await sb.from('matches').update({ scorecard_url: null }).eq('id', match.id)
        // Diagnostics: tell us *why* nothing parsed — wrong page entirely
        // (no "Inning" text at all), or right page but no <table> markup
        // (e.g. anti-bot challenge page / JS-only content / blocked fetch).
        results.push({
          matchId: match.id, status: 'parse_failed', url,
          htmlLength: html.length,
          hasInningText: html.includes('Inning'),
          hasTableMarkup: html.includes('<table'),
          htmlSnippet: html.slice(0, 300),
        })
        continue
      }

      // ── 4. Build name resolution maps ─────────────────────────────────────
      const { data: tPlayers } = await sb
        .from('tournament_players')
        .select('player_id, players(id, name, role)')
        .eq('tournament_id', tournament.id)

      const { data: aliases } = await sb
        .from('player_name_aliases')
        .select('alias, player_id')
        .eq('tournament_id', tournament.id)
        .eq('source', source)

      // id → role map (needed for duck penalty logic)
      const roleMap = new Map<string, string>()
      const exactMap = new Map<string, string>()  // norm name → player_id
      for (const tp of tPlayers ?? []) {
        const p = (tp as any).players
        if (!p) continue
        exactMap.set(p.name.toLowerCase().trim(), tp.player_id)
        roleMap.set(tp.player_id, p.role ?? 'bat')
      }

      const aliasMap = new Map<string, string>()
      for (const a of aliases ?? []) {
        aliasMap.set(a.alias.toLowerCase().trim(), a.player_id)
      }

      // ── 5. Scoring rules ──────────────────────────────────────────────────
      const fmtKey   = fmt.toUpperCase() === 'ODI' ? 'ODI' : 'T20'
      const rules: Rules = tournament.scoring_rules?.[fmtKey] ?? DEFAULT_T20_RULES

      // ── 6. Process innings → stat rows ───────────────────────────────────
      // player_id → { batting?, bowling?, rawPoints }
      const statAccum = new Map<string, { batting?: object; bowling?: object; rawPoints: number }>()
      const unmatched: Array<{ name: string; context: 'batting' | 'bowling' }> = []
      const fuzzyAliases: Array<{ player_id: string; alias: string }> = []

      for (const inn of innings) {
        for (const bat of inn.batting) {
          const { playerId, method } = resolvePlayerName(bat.name, exactMap, aliasMap)
          if (!playerId) {
            if (!unmatched.some(u => u.name === bat.name)) unmatched.push({ name: bat.name, context: 'batting' })
            continue
          }
          if (method === 'fuzzy') fuzzyAliases.push({ player_id: playerId, alias: bat.name.toLowerCase().trim() })

          const role = roleMap.get(playerId) ?? 'bat'
          const rawPts = calcBatting(bat, role, fmtKey, rules)

          const existing = statAccum.get(playerId)
          if (existing) {
            existing.batting = { runs: bat.runs, ballsFaced: bat.balls, fours: bat.fours, sixes: bat.sixes, isDismissed: bat.dismissed }
            existing.rawPoints += rawPts
          } else {
            statAccum.set(playerId, {
              batting  : { runs: bat.runs, ballsFaced: bat.balls, fours: bat.fours, sixes: bat.sixes, isDismissed: bat.dismissed },
              rawPoints: rawPts,
            })
          }
        }

        for (const bowl of inn.bowling) {
          const { playerId, method } = resolvePlayerName(bowl.name, exactMap, aliasMap)
          if (!playerId) {
            if (!unmatched.some(u => u.name === bowl.name)) unmatched.push({ name: bowl.name, context: 'bowling' })
            continue
          }
          if (method === 'fuzzy') fuzzyAliases.push({ player_id: playerId, alias: bowl.name.toLowerCase().trim() })

          const rawPts   = calcBowling(bowl, fmtKey, rules)
          const ballsBowled = Math.round(bowl.overs) * 6 + Math.round((bowl.overs % 1) * 10)

          const existing = statAccum.get(playerId)
          if (existing) {
            existing.bowling  = { wickets: bowl.wickets, wicketTypes: [], maidens: bowl.maidens, runsConceded: bowl.runs, ballsBowled, dotBalls: bowl.dots, noBalls: 0, wides: 0 }
            existing.rawPoints += rawPts
          } else {
            statAccum.set(playerId, {
              bowling  : { wickets: bowl.wickets, wicketTypes: [], maidens: bowl.maidens, runsConceded: bowl.runs, ballsBowled, dotBalls: bowl.dots, noBalls: 0, wides: 0 },
              rawPoints: rawPts,
            })
          }
        }
      }

      // ── 7. Upsert player_match_stats ──────────────────────────────────────
      const statRows = Array.from(statAccum.entries()).map(([playerId, s]) => ({
        match_id  : match.id,
        player_id : playerId,
        batting   : s.batting   ?? null,
        bowling   : s.bowling   ?? null,
        fielding  : null,   // not available from scrapers
        raw_points: Math.round(s.rawPoints * 10) / 10,
        source    : 'scraper',
      }))

      if (statRows.length) {
        const CHUNK = 50
        for (let i = 0; i < statRows.length; i += CHUNK) {
          const { error: uErr } = await sb
            .from('player_match_stats')
            .upsert(statRows.slice(i, i + CHUNK), { onConflict: 'match_id,player_id' })
          if (uErr) throw uErr
        }
      }

      // ── 8. Persist fuzzy aliases so next run auto-resolves them ───────────
      if (fuzzyAliases.length) {
        await sb.from('player_name_aliases').upsert(
          fuzzyAliases.map(a => ({
            player_id    : a.player_id,
            tournament_id: tournament.id,
            alias        : a.alias,
            source,
          })),
          { onConflict: 'alias,source,tournament_id', ignoreDuplicates: true },
        )
      }

      // ── 9. Persist unmatched names so admin can reconcile ─────────────────
      if (unmatched.length) {
        await sb.from('scraper_unmatched').upsert(
          unmatched.map(u => ({
            tournament_id: tournament.id,
            match_id     : match.id,
            raw_name     : u.name,
            source,
            context      : u.context,
          })),
          { onConflict: 'tournament_id,raw_name,source', ignoreDuplicates: true },
        )
      }

      // ── 10. Distribute raw_points to locked XI scores (SL squads + Daily teams) ──
      const pointsMap = new Map<string, number>()
      for (const [pid, s] of statAccum) pointsMap.set(pid, s.rawPoints)
      await scoreXIForMatch(match.id, pointsMap)
      const dailyTeamsScored = await scoreDailyTeamsForMatch(match.id, pointsMap)

      results.push({
        matchId : match.id,
        status  : 'ok',
        source,
        url,
        matched : statRows.length,
        unmatched: unmatched.map(u => u.name),
        fuzzyAliasesCreated: fuzzyAliases.length,
        dailyTeamsScored,
      })
    }

    return new Response(
      JSON.stringify({ ok: true, results }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error('[scrape-scorecard]', err)
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }
})
