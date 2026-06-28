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
  // Major League Cricket franchise codes (our DB short codes, per MLC SQUAD.csv)
  // → CricketAddictor's full franchise-name slugs. Without these, discoverUrl()
  // guesses URLs like "mny-vs-lakr-..." which never exist — CricketAddictor uses
  // full franchise names (e.g. "mi-new-york-vs-los-angeles-knight-riders-...").
  // This is why MLC scorecard discovery has failed outright rather than being a
  // CricketAddictor coverage gap or outage; confirmed against live MLC 2026 URLs.
  lakr: 'los-angeles-knight-riders', tsk: 'texas-super-kings',
  sfu: 'san-francisco-unicorns', mny: 'mi-new-york',
  so: 'seattle-orcas', wf: 'washington-freedom',
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

interface BatRow  {
  name: string; runs: number; balls: number; fours: number; sixes: number; dismissed: boolean
  // Raw dismissal description as it appears next to the batter's name, e.g.
  // "c A Fletcher b A Russell", "runout (A Fletcher / M Tromp)", "b SC van Schalkwyk".
  // null when not out. This is the same text poll-cricapi gets handed already-split
  // out by CricAPI's JSON — here we have to lift it out of the HTML ourselves, see
  // parseCricketAddictor/parseBusinessStandard below. Used to auto-derive fielding
  // credit (catches/stumpings/run-outs) and bowler wicketTypes (for the lbw/bowled
  // bonus) instead of leaving fielding null and wicketTypes empty for every
  // scraper-sourced match, as before.
  dismissalText: string | null
}
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
  // Innings sections are delimited by <h2> headers containing "Inning" —
  // but the live markup wraps the score in nested tags (e.g. a <span>),
  // so we can't require the whole <h2> body to be plain text. Instead,
  // capture each <h2>...</h2> block in full (allowing nested markup) and
  // strip tags before testing for "Inning".
  const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi
  const headers: { teamName: string; start: number }[] = []
  let h2m: RegExpExecArray | null
  while ((h2m = h2Re.exec(html)) !== null) {
    const text = stripTags(h2m[1])
    if (!/Inning/i.test(text)) continue
    headers.push({ teamName: text.replace(/\s+Inning.*$/i, '').trim(), start: h2Re.lastIndex })
  }

  for (let i = 0; i < headers.length; i++) {
    const { teamName, start } = headers[i]
    let end = i + 1 < headers.length ? html.indexOf('<h2', start) : html.length
    if (end === -1) end = html.length
    // Stop early at a "Match Info" heading too, in case it follows the last
    // innings section before any further <h2> (there usually isn't one).
    const miMatch = html.slice(start, end).match(/<h3[^>]*>[\s\S]{0,60}?Match Info/i)
    if (miMatch) end = start + miMatch.index!

    const body   = html.slice(start, end)
    const tables = parseTables(body)

    // ── Batting (first table) ──
    const batting: BatRow[] = []
    if (tables[0]) {
      for (const cells of parseRows(tables[0])) {
        if (cells.length < 6) continue
        const nameHtml  = cells[0]
        const name      = firstLinkText(nameHtml) || stripTags(nameHtml).split(' ')[0]
        if (!name) continue
        // The dismissal text lives in the same cell, after the name and a small
        // arrow-icon <img> (e.g. "Lhuan-dre Pretorius [icon] c A Fletcher b A
        // Russell" or "Hammad Azam Not out"). Strip the whole cell to plain text,
        // then peel the name back off the front to leave just the dismissal part.
        const strippedCell = stripTags(nameHtml)
        const afterName = strippedCell.startsWith(name)
          ? strippedCell.slice(name.length).trim()
          : strippedCell.replace(name, '').trim()
        const notOut    = afterName === '' || /^not\s*out/i.test(afterName)
        const dismissed = !notOut
        batting.push({
          name,
          runs:      parseInt(stripTags(cells[1]), 10) || 0,
          balls:     parseInt(stripTags(cells[2]), 10) || 0,
          fours:     parseInt(stripTags(cells[3]), 10) || 0,
          sixes:     parseInt(stripTags(cells[4]), 10) || 0,
          dismissed,
          dismissalText: notOut ? null : afterName,
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
        const rawParts   = raw.split(/\s{2,}/)
        const name       = rawParts[0].trim()
        const dismissalRaw = (rawParts[1] ?? '').trim()
        if (!name || name === 'Extras' || name === 'Total' || name === 'Yet to Bat') continue
        const notOut = dismissalRaw === '' || /^not\s*out/i.test(dismissalRaw)
        batting.push({
          name,
          runs:      parseInt(stripTags(cells[1]), 10) || 0,
          balls:     parseInt(stripTags(cells[2]), 10) || 0,
          fours:     parseInt(stripTags(cells[3]), 10) || 0,
          sixes:     parseInt(stripTags(cells[4]), 10) || 0,
          dismissed: !notOut,
          dismissalText: notOut ? null : dismissalRaw,
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

// Format's regulation overs, for corroborating a weak completion signal
// against the last parsed innings (see lastInningsLooksDone() / detectCompletion()
// below). Test has no fixed cap, so it's intentionally absent here — only the
// all-out check applies for that format.
const FORMAT_MAX_OVERS: Record<string, number> = { T20: 20, ODI: 50 }

/** Does the last parsed innings actually look finished — all out, or overs
 *  exhausted for the format? Used to corroborate a weak ("bare badge", no
 *  result-sentence-yet) completion signal before trusting it. */
function lastInningsLooksDone(innings: Innings[], formatKey: string | null | undefined): boolean {
  if (!innings.length) return false
  const last = innings[innings.length - 1]
  const wkts = last.batting.filter(b => b.dismissed).length
  if (wkts >= 10) return true
  const maxOvers = FORMAT_MAX_OVERS[(formatKey ?? 'T20').toUpperCase()]
  if (maxOvers != null) {
    const balls = last.bowling.reduce(
      (sum, b) => sum + (Math.round(b.overs) * 6 + Math.round((b.overs % 1) * 10)),
      0,
    )
    if (balls >= maxOvers * 6 - 1) return true // tolerate the last legal ball
  }
  return false
}

// ─── Match-completion detection ───────────────────────────────────────────────
// Previously only poll-cricapi's matchLifecycle() (driven by CricAPI's
// matchEnded/status fields) could ever flip matches.status to 'completed' — a
// scraper-sourced match just sat at whatever status it already had until an
// admin clicked Finalize, or CricAPI later confirmed it. CricketAddictor's
// pages carry the same signal in plain text: a "LIVE / Match N /" vs
// "COMPLETED / Match N /" badge near the top, and a result line ("X won by Y
// wickets/runs", "Match Tied", "No Result", "Match Abandoned") that replaces
// the live "X need Y runs in Z balls" line once the match actually ends.
function detectCompletion(html: string): { completed: boolean; resultText: string | null; strong: boolean } {
  const text = stripTags(html)
  const badgeMatch = text.match(/\b(LIVE|COMPLETED|UPCOMING)\s*\/\s*Match\b/i)
  const badge = badgeMatch ? badgeMatch[1].toUpperCase() : null
  const resultMatch = text.match(
    /([A-Za-z][A-Za-z .'-]+ won by [\w\s]+?(?:wickets?|runs?)(?:\s*\(.*?\))?|Match Tied|Match Drawn|No Result|Match Abandoned)/i,
  )
  return {
    completed : badge === 'COMPLETED' || !!resultMatch,
    resultText: resultMatch ? resultMatch[1].trim() : null,
    // An explicit result sentence is a strong, definitive signal — the page
    // only prints one once the match actually has an outcome. The bare
    // "COMPLETED" badge with no result sentence yet is weaker: the badge and
    // the scorecard table below it are populated by separately-timed feeds,
    // and the badge has been seen to flip before the table actually finishes
    // updating (see lastInningsLooksDone() below for the corroboration this
    // feeds into).
    strong    : !!resultMatch,
  }
}

// ─── Dismissal-text parsing (mirrors poll-cricapi's parseDismissalEntry) ──────
// poll-cricapi gets dismissal type/bowler/fielder already split out as separate
// JSON fields by CricAPI. Scraped HTML only gives us one free-text blob per
// batter (e.g. "c A Fletcher b A Russell", "runout (A Fletcher / M Tromp)",
// "lbw b S Narine", "st U Chand b S Narine", "c & b A Russell", "b SC van
// Schalkwyk"). This is the scraper-side equivalent: same dismissal grammar,
// same regex shapes, just parsing it out of plain text instead of JSON fields.
interface DismissalParse { type: string; bowler: string | null; fielder: string | null; fielder2?: string | null }

function parseScrapedDismissal(raw: string | null): DismissalParse | null {
  if (!raw) return null
  const d = raw.toLowerCase().trim()
  if (!d || d.includes('not out') || d.includes('retired')) return null

  if (/^hit.?wicket/i.test(d)) return { type: 'hit_wicket', bowler: null, fielder: null }
  if (/^run\s*out/.test(d)) {
    const parenMatch = d.match(/run\s*out\s*\(([^)]+)\)/i)
    const parts = parenMatch
      ? parenMatch[1].split(/\s*[/\\&]\s*/).map(n => n.trim()).filter(Boolean)
      : []
    return { type: 'run_out', bowler: null, fielder: parts[0] || null, fielder2: parts[1] || null }
  }

  let m: RegExpMatchArray | null
  if ((m = d.match(/^lbw(?:\s+b\s+(.+))?/)))        return { type: 'lbw',     bowler: (m[1] || '').trim() || null, fielder: null }
  if ((m = d.match(/^c\s*&\s*b\s+(.+)/)))           return { type: 'caught',  bowler: m[1].trim(),                 fielder: m[1].trim() }
  if ((m = d.match(/^c(?:t)?\s+(.+?)\s+b\s+(.+)/))) return { type: 'caught',  bowler: m[2].trim(),                 fielder: m[1].trim() }
  if ((m = d.match(/^st\s+(.+?)\s+b\s+(.+)/)))      return { type: 'stumped', bowler: m[2].trim(),                 fielder: m[1].trim() }
  if ((m = d.match(/^b\s+(.+)/)))                   return { type: 'bowled',  bowler: m[1].trim(),                 fielder: null }
  return null
}

/** Match a dismissal's loosely-written bowler reference (e.g. "A Russell") against
 *  the full names actually listed in that innings's bowling table ("Andre Russell"),
 *  same exact/surname-fallback strategy as poll-cricapi's matchBowlerName. */
function matchBowlerNameInInnings(ref: string | null, candidates: string[]): string | null {
  if (!ref) return null
  const t = ref.toLowerCase().trim()
  const exact = candidates.find(c => c.toLowerCase() === t)
  if (exact) return exact
  const refSurname = t.split(/\s+/).pop()
  if (refSurname) {
    const bySurname = candidates.filter(c => c.toLowerCase().split(/\s+/).pop() === refSurname)
    if (bySurname.length === 1) return bySurname[0]
  }
  return null
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
  lbw_bowled_bonus: 8,
}

interface FieldRow { catches: number; stumpings: number; runOutDirect: number; runOutIndirect: number }

/** Mirrors index.html's calcFielding / poll-cricapi's calcFielding. */
function calcFielding(f: FieldRow, r: Rules): number {
  return f.catches * (r.catch ?? 0)
    + f.stumpings * (r.stumping ?? 0)
    + f.runOutDirect * (r.run_out_direct ?? 0)
    + f.runOutIndirect * (r.run_out_indirect ?? 0)
}

/** Mirrors poll-cricapi/cricketScoringEngine.js's lbw_bowled_bonus: a bonus to
 *  the BOWLER (not a fielder) per lbw/bowled wicket, since those dismissal
 *  types involve no fielder credit at all. */
function calcLbwBowledBonus(wicketTypes: string[], r: Rules): number {
  const premium = wicketTypes.filter(t => t === 'lbw' || t === 'bowled').length
  return premium * (r.lbw_bowled_bonus ?? 0)
}

// ─── Name resolution ──────────────────────────────────────────────────────────

interface ResolveResult { playerId: string | null; method: 'exact' | 'alias' | 'fuzzy' | 'unmatched' }

// A source (CricketAddictor / Business Standard) can send a literal
// placeholder instead of a real name when IT can't identify someone. The
// same literal string recurs for different actual players across different
// matches, so it can never be aliased to one specific local player — that's
// exactly how "Player Not Found" ended up permanently (and wrongly) aliased
// to a real player in player_name_aliases. Skip these entirely: never
// fuzzy-alias them, never queue them in scraper_unmatched (where an admin
// could "Map" them to a player by mistake).
const PLACEHOLDER_NAMES = new Set(['player not found'])
function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_NAMES.has(name.toLowerCase().trim())
}

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

interface FielderResolveResult { playerId: string | null; candidates: string[] | null }

/**
 * Resolve a raw fielder/bowler-credit name (e.g. "A Fletcher") to exactly one
 * player_id, checked against the FULL tournament roster (exactMap keys) — not
 * just whoever batted/bowled in this match — so that two squad members
 * sharing a surname (e.g. sisters) are correctly flagged as ambiguous instead
 * of one of them silently absorbing the other's fielding credit. Mirrors
 * index.html's resolveFielder, which was fixed for exactly this bug
 * (see migration history: "Bryce sisters" ambiguity fix).
 *
 * Tiers, in order: exact full-name match → roster name ends with " <norm>"
 * (raw is a surname or "Initial Surname") → norm ends with " <roster surname>"
 * (raw has a longer/different first name than the roster entry). Ambiguity is
 * checked within EACH tier before falling through to the next.
 */
function resolveFielderName(
  raw: string,
  exactMap: Map<string, string>,  // norm full name → player_id (full roster)
  aliasMap: Map<string, string>,  // norm alias → player_id
): FielderResolveResult {
  const norm = raw.toLowerCase().trim()
  if (aliasMap.has(norm)) return { playerId: aliasMap.get(norm)!, candidates: null }
  if (exactMap.has(norm)) return { playerId: exactMap.get(norm)!, candidates: null }

  const rosterNames = [...exactMap.keys()]
  const tiers = [
    rosterNames.filter(n => n === norm),
    rosterNames.filter(n => n.endsWith(' ' + norm)),
    rosterNames.filter(n => norm.endsWith(' ' + n.split(' ').pop())),
  ]
  for (const tier of tiers) {
    if (!tier.length) continue
    const distinct = [...new Set(tier)]
    if (distinct.length > 1) return { playerId: null, candidates: distinct }
    return { playerId: exactMap.get(distinct[0])!, candidates: null }
  }
  return { playerId: null, candidates: null }
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
    const nowDate = new Date()
    const now     = nowDate.toISOString()

    // Cron calls only consider matches whose start_time is at least 5 minutes
    // in the past — gives the official scorecard page a few minutes to
    // actually populate before the scraper's first attempt. Manual "Scrape
    // Now" (matchId provided) is unaffected — the admin is explicitly asking
    // right now, regardless of how recently the match started.
    const cutoff = matchId ? now : new Date(nowDate.getTime() - 5 * 60 * 1000).toISOString()

    let query = sb
      .from('matches')
      .select(`
        id, match_number, match_type, format, status, scorecard_url, tournament_id, start_time, data_source,
        progress_innings, progress_balls,
        home_team:teams!home_team_id(id, name),
        away_team:teams!away_team_id(id, name),
        tournament:tournaments!tournament_id(id, name, scraper_enabled, scoring_rules, dot_ball_enabled)
      `)
      .lte('start_time', cutoff)
      .not('status', 'in', '("completed","delayed")')

    if (matchId) query = query.eq('id', matchId)

    // No DB-level scraper_enabled filter here — mirrors poll-cricapi's
    // reasoning: eligibility also depends on matches.data_source (a per-match
    // override), which can't be expressed as one PostgREST filter alongside
    // the joined tournament flag. Filtered in JS below instead.
    const { data: matches, error: mErr } = await query
    if (mErr) throw mErr

    // Manual scrapes (matchId provided) bypass all source gating — the admin
    // is explicitly asking to scrape this match regardless of its tournament
    // default or its own data_source override.
    //
    // Otherwise (cron call): data_source='scraper' forces this match onto the
    // scraper even if its tournament defaults to CricAPI; data_source=
    // 'cricapi' forces it away from the scraper even if the tournament
    // defaults here (poll-cricapi's cron owns it instead); data_source='auto'
    // (or unset) falls back to the tournament-wide scraper_enabled flag, same
    // behaviour as before this override existed.
    const liveMatches = (matches ?? []).filter((m: any) => {
      if (matchId) return true
      const src = m.data_source || 'auto'
      if (src === 'cricapi') return false
      if (src === 'scraper') return true
      return m.tournament?.scraper_enabled === true
    })

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
        // Cache-bust: confirmed live that cricketaddictor's CDN serves a
        // frozen/stale edge copy of the bare scorecard URL (seen stuck on an
        // in-progress snapshot well after the real match had finished), while
        // the exact same URL with any query string appended returns the
        // current page. Without this, a match can get permanently stuck
        // mid-innings no matter how many times we re-fetch.
        const fetchUrl = url + (url.includes('?') ? '&' : '?') + '_cb=' + Date.now()
        const res = await fetch(fetchUrl, {
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
        // Deeper diagnostics: html.includes('Inning') being true doesn't mean
        // our <h2>...Inning...</h2> regex actually matches — the heading may
        // have nested markup (breaking the [^<]* class) or be a different
        // tag entirely. Extract every <h2> block in full (no length cap) and
        // report its stripped inner text, so we can see what the real
        // innings-heading markup/tag actually looks like.
        const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi
        const h2Texts: string[] = []
        let h2m: RegExpExecArray | null
        while ((h2m = h2Re.exec(html)) !== null) h2Texts.push(stripTags(h2m[1]).slice(0, 120))
        results.push({
          matchId: match.id, status: 'parse_failed', url,
          htmlLength: html.length,
          hasInningText: html.includes('Inning'),
          hasTableMarkup: html.includes('<table'),
          h2Count: (html.match(/<h2/gi) ?? []).length,
          tableCount: (html.match(/<table/gi) ?? []).length,
          h2StrippedTexts: h2Texts,
        })
        continue
      }

      // ── 3a. Completion detection ────────────────────────────────────────
      // Previously only poll-cricapi could ever flip matches.status to
      // 'completed' — see detectCompletion() above for why this same signal
      // is readable straight out of the scraped HTML.
      let completionInfo = detectCompletion(html)

      // Weak signal (bare "COMPLETED" badge, no result sentence yet) gets
      // corroborated against the innings we just parsed before being trusted
      // — same false-positive shape as poll-cricapi's matchEnded flag (see
      // that file's matchLifecycle() for the NZ Women vs Scotland Women case
      // this guards against): the badge can flip before the scorecard table
      // underneath has actually finished updating. If the last innings here
      // doesn't look done (not all out, overs not exhausted), treat the
      // match as still live regardless of what the badge says.
      if (completionInfo.completed && !completionInfo.strong && !lastInningsLooksDone(innings, (match as any).format)) {
        completionInfo = { ...completionInfo, completed: false }
      }

      // ── 3b. Staleness guard ─────────────────────────────────────────────
      // Compare this read's progress against the furthest progress seen so
      // far for this match (across either source — see poll-cricapi for the
      // CricAPI side of the same guard). If this read is BEHIND that, it's
      // almost certainly a stale/cached page — skip the write entirely
      // rather than regressing good data with a worse read.
      const lastInn = innings[innings.length - 1]
      const inningsBalls = lastInn.bowling.reduce(
        (sum, b) => sum + (Math.round(b.overs) * 6 + Math.round((b.overs % 1) * 10)),
        0,
      )
      const newProgress    = { innings: innings.length, balls: inningsBalls }
      const storedProgress = { innings: (match as any).progress_innings ?? 0, balls: (match as any).progress_balls ?? 0 }
      const isStale = newProgress.innings < storedProgress.innings
        || (newProgress.innings === storedProgress.innings && newProgress.balls < storedProgress.balls)

      if (isStale) {
        results.push({ matchId: match.id, status: 'stale_skipped', url, read: newProgress, stored: storedProgress })
        continue
      }

      // ── 3c. Cache the raw scraped scorecard for the admin "Live scorecard" panel ──
      // poll-cricapi caches CricAPI's raw payload into match_scorecards so the
      // browser's renderScorecard()/renderInnings()/renderBatRow() code (built
      // for CricAPI) can render it as-is. Scraper-driven matches never wrote
      // anything there, so the admin panel fell back to a lossy reconstruction
      // built later from player_match_stats — fantasy-squad players only, no
      // dismissal text, and any name the resolver couldn't match was silently
      // dropped from view (only visible as a bare string in scraper_unmatched).
      // Shaping `innings` (every batter/bowler exactly as scraped, BEFORE name
      // resolution runs) into the same CricAPI-ish payload shape and writing it
      // here gives scraper matches the identical rich view CricAPI matches get
      // — unmatched names included, with their real runs/balls/dismissal text —
      // which is what actually lets an admin spot and fix a gap at a glance.
      const SKIP_ROW_NAMES = new Set(['extras', 'total', 'yet to bat', 'did not bat'])
      const rawScorecard = innings.map(inn => {
        const bat  = inn.batting.filter(b => !SKIP_ROW_NAMES.has(b.name.toLowerCase().trim()))
        const bowl = inn.bowling.filter(b => !SKIP_ROW_NAMES.has(b.name.toLowerCase().trim()))
        const totalRuns  = bat.reduce((s, b) => s + b.runs, 0)
        const totalWkts  = bat.filter(b => b.dismissed).length
        const totalBalls = bowl.reduce((s, b) => s + (Math.round(b.overs) * 6 + Math.round((b.overs % 1) * 10)), 0)
        const overallOvers = Math.floor(totalBalls / 6) + (totalBalls % 6) / 10
        return {
          inning: `${inn.teamName} Innings`,
          r: totalRuns, w: totalWkts, o: totalBalls ? overallOvers.toFixed(1) : '0.0',
          batting: bat.map(b => ({
            batsman: { name: b.name }, r: b.runs, b: b.balls, '4s': b.fours, '6s': b.sixes,
            'dismissal-text': b.dismissed ? (b.dismissalText ?? 'out') : 'not out',
          })),
          bowling: bowl.map(b => ({
            bowler: { name: b.name }, o: b.overs, m: b.maidens, r: b.runs, w: b.wickets,
          })),
        }
      })
      await sb.from('match_scorecards').upsert(
        {
          match_id: match.id,
          payload: {
            data: {
              matchInfo: {
                name  : `${homeTeam} vs ${awayTeam}`,
                status: completionInfo.completed ? 'Completed' : 'Live',
              },
              scorecard: rawScorecard,
            },
          },
          fetched_at: new Date().toISOString(),
        },
        { onConflict: 'match_id' },
      )

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
      const rules: Rules = { ...(tournament.scoring_rules?.[fmtKey] ?? DEFAULT_T20_RULES) }
      // dot_ball is forced to 0 unless the tournament's "Dot ball scoring"
      // toggle is explicitly ON (migration_v30) — independent of whatever
      // numeric weight happens to be saved in scoring_rules. This used to be
      // hidden from the rules UI entirely on the assumption that no feed
      // would ever report per-bowler dot-ball counts; CricketAddictor-scraped
      // matches do report them, so without this gate dot_ball could silently
      // score with zero admin visibility or control.
      if (!tournament.dot_ball_enabled) rules.dot_ball = 0

      // ── 6. Process innings → stat rows ───────────────────────────────────
      // player_id → { batting?, bowling?, fielding?, rawPoints }
      const statAccum = new Map<string, { batting?: object; bowling?: object; fielding?: FieldRow; rawPoints: number }>()
      const unmatched: Array<{ name: string; context: 'batting' | 'bowling' }> = []
      const fuzzyAliases: Array<{ player_id: string; alias: string }> = []
      // Placeholder rows ("Player Not Found") are never aliased or queued in
      // scraper_unmatched (see isPlaceholderName), but their points shouldn't
      // just vanish — capture the raw numbers so an admin can later
      // force-credit this match/context to the right player. Keyed only by
      // context (one batting row, one bowling row per match/source): if the
      // same match has two different unidentified players in the same
      // discipline, the later one's numbers win — documented limitation, see
      // migration_v28_placeholder_stats.sql.
      const placeholderRows = new Map<'batting' | 'bowling', { batting: object | null; bowling: object | null; fielding: object | null; raw_points: number }>()

      // Fielding credit derived from dismissal text, and any raw fielder name
      // that couldn't be resolved (unmatched) or resolved to 2+ players
      // (ambiguous — e.g. two squad members sharing a surname). Surfaced to
      // the admin via scraper_fielding_issues instead of silently dropped.
      const fieldingByPlayer = new Map<string, FieldRow>()
      const fieldingIssues: Array<{
        rawName: string; candidates: string[] | null
        field: 'catches' | 'stumpings' | 'runOutDirect' | 'runOutIndirect'
        batterName: string; dismissalText: string
      }> = []
      const addFieldingCredit = (
        rawName: string | null | undefined,
        field: 'catches' | 'stumpings' | 'runOutDirect' | 'runOutIndirect',
        batterName: string, dismissalText: string,
      ) => {
        if (!rawName) return
        const { playerId, candidates } = resolveFielderName(rawName, exactMap, aliasMap)
        if (playerId) {
          const cur = fieldingByPlayer.get(playerId) ?? { catches: 0, stumpings: 0, runOutDirect: 0, runOutIndirect: 0 }
          cur[field]++
          fieldingByPlayer.set(playerId, cur)
        } else {
          fieldingIssues.push({ rawName, candidates, field, batterName, dismissalText })
        }
      }

      for (const inn of innings) {
        // Bowler wicketTypes (for the lbw/bowled bonus) keyed by the exact name
        // string as it appears in THIS innings's bowling table, so the lookup
        // below lines up 1:1 regardless of how a dismissal line abbreviates
        // the bowler's first name (e.g. "A Russell" dismissal vs "Andre
        // Russell" bowling-table entry — matched via matchBowlerNameInInnings).
        const bowlerNamesInInnings = inn.bowling.map(b => b.name)
        const wicketsByBowlerRaw: Record<string, string[]> = {}

        for (const bat of inn.batting) {
          // Fielding/wicket-type derivation runs independently of whether the
          // BATTER himself resolves to a local player_id — an unmatched
          // batter's dismissal still names a real fielder/bowler who should
          // get credit regardless.
          const parsed = parseScrapedDismissal(bat.dismissalText)
          if (parsed) {
            if (parsed.bowler) {
              const matchedBowlerName = matchBowlerNameInInnings(parsed.bowler, bowlerNamesInInnings) || parsed.bowler
              ;(wicketsByBowlerRaw[matchedBowlerName] ||= []).push(parsed.type)
            }
            if (parsed.type === 'caught')  addFieldingCredit(parsed.fielder, 'catches', bat.name, bat.dismissalText!)
            if (parsed.type === 'stumped') addFieldingCredit(parsed.fielder, 'stumpings', bat.name, bat.dismissalText!)
            if (parsed.type === 'run_out') {
              addFieldingCredit(parsed.fielder,  'runOutDirect',   bat.name, bat.dismissalText!)
              addFieldingCredit(parsed.fielder2, 'runOutIndirect', bat.name, bat.dismissalText!)
            }
          }

          if (isPlaceholderName(bat.name)) {
            const rawPts = calcBatting(bat, 'bat', fmtKey, rules)
            placeholderRows.set('batting', {
              batting: { runs: bat.runs, ballsFaced: bat.balls, fours: bat.fours, sixes: bat.sixes, isDismissed: bat.dismissed },
              bowling: null, fielding: null, raw_points: rawPts,
            })
            continue // never alias or queue the source's own "not found" placeholder
          }
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
          if (isPlaceholderName(bowl.name)) {
            const wicketTypes = wicketsByBowlerRaw[bowl.name] ?? []
            const ballsBowled = Math.round(bowl.overs) * 6 + Math.round((bowl.overs % 1) * 10)
            const rawPts = calcBowling(bowl, fmtKey, rules) + calcLbwBowledBonus(wicketTypes, rules)
            placeholderRows.set('bowling', {
              bowling: { wickets: bowl.wickets, wicketTypes, maidens: bowl.maidens, runsConceded: bowl.runs, ballsBowled, dotBalls: bowl.dots, noBalls: 0, wides: 0 },
              batting: null, fielding: null, raw_points: rawPts,
            })
            continue // never alias or queue the source's own "not found" placeholder
          }
          const { playerId, method } = resolvePlayerName(bowl.name, exactMap, aliasMap)
          if (!playerId) {
            if (!unmatched.some(u => u.name === bowl.name)) unmatched.push({ name: bowl.name, context: 'bowling' })
            continue
          }
          if (method === 'fuzzy') fuzzyAliases.push({ player_id: playerId, alias: bowl.name.toLowerCase().trim() })

          const wicketTypes  = wicketsByBowlerRaw[bowl.name] ?? []
          const rawPts       = calcBowling(bowl, fmtKey, rules) + calcLbwBowledBonus(wicketTypes, rules)
          const ballsBowled  = Math.round(bowl.overs) * 6 + Math.round((bowl.overs % 1) * 10)

          const existing = statAccum.get(playerId)
          if (existing) {
            existing.bowling  = { wickets: bowl.wickets, wicketTypes, maidens: bowl.maidens, runsConceded: bowl.runs, ballsBowled, dotBalls: bowl.dots, noBalls: 0, wides: 0 }
            existing.rawPoints += rawPts
          } else {
            statAccum.set(playerId, {
              bowling  : { wickets: bowl.wickets, wicketTypes, maidens: bowl.maidens, runsConceded: bowl.runs, ballsBowled, dotBalls: bowl.dots, noBalls: 0, wides: 0 },
              rawPoints: rawPts,
            })
          }
        }
      }

      // ── 6a. Apply resolved fielding credit to statAccum ───────────────────
      // A fielder might be credit-only (never batted/bowled themselves, e.g. a
      // specialist fielder low in the order who didn't get to bat) — ensure
      // they still get a statAccum entry rather than being silently dropped.
      for (const [playerId, fielding] of fieldingByPlayer) {
        const fieldingPts = calcFielding(fielding, rules)
        const existing = statAccum.get(playerId)
        if (existing) {
          existing.fielding = fielding
          existing.rawPoints += fieldingPts
        } else {
          statAccum.set(playerId, { fielding, rawPoints: fieldingPts })
        }
      }

      // ── 6b. Per-player regression guard ────────────────────────────────────
      // The innings-level watermark above only protects the LAST innings's
      // total progress — it says nothing about the first innings or about
      // any individual player. A read that's "fresh enough" on the chasing
      // team's overs can still carry a worse/cached snapshot of an earlier
      // innings (or of one player's row specifically), and the upsert below
      // is a blind overwrite — so without this guard that worse snapshot
      // would silently clobber already-good data. Cricket stats are
      // monotonic within a match (balls faced/bowled never decrease), so any
      // player whose new read has FEWER balls than what's already stored is
      // almost certainly a stale partial read for that player — skip them
      // and leave their existing row untouched.
      const { data: existingStatRows } = await sb
        .from('player_match_stats')
        .select('player_id, batting, bowling, fielding, raw_points, source')
        .eq('match_id', match.id)
      const existingByPlayer = new Map((existingStatRows ?? []).map(r => [r.player_id, r]))

      const regressedPlayers: string[] = []
      for (const [playerId, s] of statAccum) {
        const ex = existingByPlayer.get(playerId)
        if (!ex) continue
        // An admin who manually entered/corrected this player's fielding via
        // the Fielding Review panel (source='scraper_manual') always wins —
        // never let a later auto re-scrape silently overwrite their fielding
        // correction with whatever the (possibly still-imperfect) dismissal
        // parser re-derives from the page.
        if (ex.source === 'scraper_manual') { regressedPlayers.push(playerId); continue }
        const newBattingBalls = (s.batting as any)?.ballsFaced   ?? 0
        const oldBattingBalls = (ex.batting as any)?.ballsFaced  ?? 0
        const newBowlingBalls = (s.bowling as any)?.ballsBowled  ?? 0
        const oldBowlingBalls = (ex.bowling as any)?.ballsBowled ?? 0
        if (newBattingBalls < oldBattingBalls || newBowlingBalls < oldBowlingBalls) {
          regressedPlayers.push(playerId)
        }
      }

      // ── 7. Upsert player_match_stats ──────────────────────────────────────
      const statRows = Array.from(statAccum.entries())
        .filter(([playerId]) => !regressedPlayers.includes(playerId))
        .map(([playerId, s]) => ({
          match_id  : match.id,
          player_id : playerId,
          batting   : s.batting   ?? null,
          bowling   : s.bowling   ?? null,
          // Auto-derived from the dismissal text scraped alongside batting rows
          // (see parseScrapedDismissal / addFieldingCredit above). Any dismissal
          // that couldn't be resolved to exactly one squad player is NOT folded
          // in here — it's queued in `fieldingIssues` for admin review instead.
          fielding  : s.fielding  ?? null,
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

      // ── 9a. Persist recoverable placeholder stats ──────────────────────────
      // Keyed per match+context (not per tournament like scraper_unmatched
      // above) — every match's "Player Not Found" needs its own resolution,
      // never auto-resolved by a prior match's fix. Don't overwrite
      // resolved_at/resolved_by/credited_player_id on a re-scrape — only
      // raw_stats refreshes (the match may still be live).
      if (placeholderRows.size) {
        await sb.from('scraper_placeholder_stats').upsert(
          Array.from(placeholderRows.entries()).map(([context, stats]) => ({
            tournament_id: tournament.id,
            match_id     : match.id,
            source,
            context,
            raw_stats    : stats,
          })),
          { onConflict: 'match_id,source,context' },
        )
      }

      // ── 9b. Persist fielding events the scraper couldn't auto-resolve ─────
      // (unmatched fielder name, or ambiguous — matches 2+ squad players).
      // Mirrors the scraper_unmatched convention: ignoreDuplicates so a row
      // an admin already resolved doesn't get reset back to unresolved by a
      // later re-scrape that reproduces the same unresolved dismissal.
      if (fieldingIssues.length) {
        await sb.from('scraper_fielding_issues').upsert(
          fieldingIssues.map(fi => ({
            tournament_id : tournament.id,
            match_id      : match.id,
            raw_name      : fi.rawName,
            source,
            field         : fi.field,
            batter_name   : fi.batterName,
            dismissal_text: fi.dismissalText,
            candidates    : fi.candidates,
          })),
          { onConflict: 'match_id,raw_name,field,batter_name', ignoreDuplicates: true },
        )
      }

      // ── 9c. Let the scraper mark a match completed too ────────────────────
      // Previously only poll-cricapi (CricAPI-driven matches) could flip
      // matches.status to 'completed'. Scraper-only tournaments had no way to
      // ever leave 'live'/'in_progress', which meant locked XIs/squads never
      // got a final "this match is done" signal from this data source. Once
      // flipped, the cron query's `.not('status','in','("completed","delayed")')`
      // filter means this match is never re-scraped again — which is exactly
      // what protects any admin fielding corrections made afterwards (see the
      // scraper_manual regression-guard check above) from being clobbered.
      if (completionInfo.completed && match.status !== 'completed') {
        await sb.from('matches').update({ status: 'completed' }).eq('id', match.id)
      }

      // ── 10. Distribute raw_points to locked XI scores (SL squads + Daily teams) ──
      // Regressed players keep their existing (already-correct) raw_points
      // here too, so scoring stays consistent with what's actually persisted
      // above rather than re-applying points from the discarded worse read.
      const pointsMap = new Map<string, number>()
      for (const [pid, s] of statAccum) {
        if (regressedPlayers.includes(pid)) {
          pointsMap.set(pid, existingByPlayer.get(pid)?.raw_points ?? s.rawPoints)
        } else {
          pointsMap.set(pid, s.rawPoints)
        }
      }
      await scoreXIForMatch(match.id, pointsMap)
      const dailyTeamsScored = await scoreDailyTeamsForMatch(match.id, pointsMap)

      // ── 11. Bump the progress watermark now that this read has landed ─────
      if (newProgress.innings !== storedProgress.innings || newProgress.balls !== storedProgress.balls) {
        await sb.from('matches')
          .update({ progress_innings: newProgress.innings, progress_balls: newProgress.balls })
          .eq('id', match.id)
      }

      results.push({
        matchId : match.id,
        status  : 'ok',
        source,
        url,
        matched : statRows.length,
        unmatched: unmatched.map(u => u.name),
        regressedPlayersSkipped: regressedPlayers,
        fuzzyAliasesCreated: fuzzyAliases.length,
        dailyTeamsScored,
        completionDetected: completionInfo.completed,
        completionMarked: completionInfo.completed && match.status !== 'completed',
        fieldingCredited: fieldingByPlayer.size,
        fieldingIssues: fieldingIssues.length,
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
