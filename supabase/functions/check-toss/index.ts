/**
 * check-toss — Supabase Edge Function
 *
 * Confirms the toss (winner + bat/bowl decision) for any match starting
 * within the next 20 minutes, from two independent sources — CricAPI and
 * CricketAddictor — so the admin has an early, corroborated signal well
 * before lock-matches freezes squads at start_time.
 *
 * Trigger conditions and what happens:
 *   1. Toss confirmed by either source → matches.toss_status = 'confirmed'.
 *      Admin gets a push too ("toss confirmed, no action needed") — this is
 *      the all-clear signal, not just a silent DB write, so a confirmation
 *      is only persisted once that push has actually gone out (see the
 *      "Case 1" comment below for why).
 *   2. No toss from either source, AND we're within 10 minutes of start_time
 *      (i.e. start_time minus 10 minutes has passed) → matches.toss_status =
 *      'delay_flagged', admin gets a push ('no toss yet, match looks delayed
 *      — review / push the start time'). If app_settings.toss_auto_push.enabled
 *      is true (off by default — see migration_v55), it ALSO auto-pushes
 *      lock_time forward and flips the match to 'delayed' instead of just
 *      notifying.
 *   3. No toss yet, and still more than 10 minutes to start_time →
 *      toss_status = 'pending', no action. Normal state for most of the
 *      20-minute window; toss usually happens close to (sometimes right at)
 *      start_time.
 *
 * Why the delay decision point is start_time MINUS 10 minutes, not
 * start_time itself: lock-matches runs on its own independent 1-minute cron
 * and locks squads the moment start_time passes, regardless of toss_status —
 * the two functions aren't coupled. Flagging (and, if auto-push is on,
 * pushing lock_time forward) only at start_time itself left no real buffer:
 * both crons could tick the same minute, so a delayed match could still get
 * locked before check-toss's own update lands. Deciding 10 minutes early
 * gives auto-push (or a human) a genuine head start over that race.
 *
 * Why "no toss by the decision point" is the delay signal (rather than
 * text-matching for words like "rain"/"delayed" in a source's status
 * string): every source phrases delays differently, and some never say the
 * word "delayed" at all — they just stay silent on the toss. Comparing our
 * own start_time against wall-clock time is a signal every source shares,
 * so it doesn't depend on guessing any one site's wording. Any delay/rain
 * language a source DOES surface is still captured and included in the
 * notification body as extra context, just not used as the trigger itself.
 *
 * CricketAddictor's toss line lives on the match's "Summary" page — a
 * DIFFERENT page than the one scrape-scorecard hits (its /scorecard/ page has
 * no toss text at all; confirmed live). We also can't rely on
 * matches.scorecard_url being populated yet: scrape-scorecard only starts
 * resolving that URL once start_time is 5+ minutes in the PAST (see its own
 * comment), i.e. never during this function's entire pre-match window. So
 * this function carries its own copy of scrape-scorecard's URL-discovery
 * logic (slug guessing + a listing-page scan) rather than depending on it.
 * When it does resolve a URL, it writes it back to matches.scorecard_url so
 * scrape-scorecard doesn't have to re-discover it later — a free side benefit,
 * not something either function depends on the other for.
 *
 * Triggered by:
 *   - pg_cron every 1 minute (migration_v56_check_toss_cron.sql), body: {}
 *
 * Required env vars (Supabase dashboard → Edge Functions → Secrets):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   CRICAPI_KEYS   — same comma-separated key list poll-cricapi uses. If unset
 *                    or exhausted, CricAPI is skipped for that pass (non-fatal)
 *                    and CricketAddictor is relied on alone.
 *
 * Deploy:
 *   supabase functions deploy check-toss --no-verify-jwt
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRICAPI_KEYS = (Deno.env.get('CRICAPI_KEYS') ?? '')
  .split(',').map(k => k.trim()).filter(Boolean)

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const UA = 'Mozilla/5.0 (compatible; SuperSelector/1.0)'

// Window opens this many minutes before start_time...
const CHECK_WINDOW_MINUTES = 20
// ...and "no toss yet" only counts as a delay signal once we're within this
// many minutes of start_time (i.e. start_time - DELAY_DECISION_BUFFER_MINUTES
// has passed) — see the file header for why this needs a real buffer before
// start_time itself, not just start_time.
const DELAY_DECISION_BUFFER_MINUTES = 10

// ─────────────────────────────────────────────────────────────────────────────
// ─── CricketAddictor slug / URL discovery ──────────────────────────────────────
// Ported from scrape-scorecard/index.ts (same file's discoverUrl chain) —
// trimmed to the pre-match-relevant listing pages only (no recent-matches/
// last-resort scan, since a match this function checks hasn't happened yet).
// Kept as a near-verbatim copy rather than a shared import, matching this
// project's existing per-function convention (see poll-cricapi's header notes
// on why scrape-scorecard/poll-cricapi each keep their own copies).
// ─────────────────────────────────────────────────────────────────────────────

function toSlug(s: string): string {
  return s.toLowerCase().trim()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function stripGenderSuffix(slug: string): string {
  return slug.replace(/-(?:women|w)$/i, '')
}

function stripConnectorWords(slug: string): string {
  return slug
    .split('-')
    .filter(tok => tok !== 'and' && tok !== 'of' && tok !== 'the')
    .join('-')
}

const COUNTRY_CODE_TO_SLUG: Record<string, string> = {
  nz: 'new-zealand', sl: 'sri-lanka', ind: 'india', aus: 'australia', eng: 'england',
  pak: 'pakistan', sa: 'south-africa', wi: 'west-indies', ban: 'bangladesh', ire: 'ireland',
  sco: 'scotland', afg: 'afghanistan', zim: 'zimbabwe', usa: 'united-states',
  uae: 'united-arab-emirates', ned: 'netherlands', nam: 'namibia', png: 'papua-new-guinea',
  can: 'canada', nep: 'nepal', oma: 'oman', qat: 'qatar', ken: 'kenya', hk: 'hong-kong',
  jer: 'jersey', ber: 'bermuda', tha: 'thailand', vct: 'vanuatu',
  lakr: 'los-angeles-knight-riders', tsk: 'texas-super-kings',
  sfu: 'san-francisco-unicorns', mny: 'mi-new-york',
  so: 'seattle-orcas', wf: 'washington-freedom',
}

function expandTeamSlug(slug: string): string | null {
  const isWomen = /-(?:women|w)$/i.test(slug)
  const bare    = stripGenderSuffix(slug)
  const full    = COUNTRY_CODE_TO_SLUG[bare]
  if (!full) return null
  return isWomen ? `${full}-women` : full
}

function teamSlugVariants(full: string | null, bare: string, nc: string): string[] {
  return [...new Set([full, bare, nc].filter((s): s is string => !!s))]
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

// One invocation checks every due match — cache listing pages across matches.
const listingCache = new Map<string, ListingMatch[]>()

async function getListing(url: string): Promise<ListingMatch[]> {
  if (listingCache.has(url)) return listingCache.get(url)!
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } })
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
  homeSlugs: string[], awaySlugs: string[],
  startTime: string | null, tournamentName: string,
): Promise<string | null> {
  // No recent-matches page here — this function only ever checks matches that
  // haven't started yet, so a "recent" listing can't help.
  const pages = [
    'https://cricketaddictor.com/livescore/',
    'https://cricketaddictor.com/livescore/upcoming-matches/',
  ]
  const targetMs = startTime ? new Date(startTime).getTime() : NaN
  const tWords   = tournamentName.toLowerCase().split(/\W+/).filter(w => w.length > 3)

  let best: { url: string; score: number } | null = null

  for (const page of pages) {
    const listing = await getListing(page)
    for (const lm of listing) {
      const teamsMatch =
        (homeSlugs.some(h => teamSlugMatches(h, lm.team1Slug)) && awaySlugs.some(a => teamSlugMatches(a, lm.team2Slug))) ||
        (homeSlugs.some(h => teamSlugMatches(h, lm.team2Slug)) && awaySlugs.some(a => teamSlugMatches(a, lm.team1Slug)))
      if (!teamsMatch) continue

      let score = 1
      if (lm.dateTimeText && !isNaN(targetMs)) {
        const parsed = Date.parse(lm.dateTimeText)
        if (!isNaN(parsed)) {
          const diffHrs = Math.abs(parsed - targetMs) / 36e5
          if (diffHrs <= 48) score += (48 - diffHrs) / 48
        }
      }
      const ctxLower = lm.contextText.toLowerCase()
      score += tWords.filter(w => ctxLower.includes(w)).length * 0.5

      if (!best || score > best.score) best = { url: lm.baseUrl + 'scorecard/', score }
    }
  }
  return best ? best.url : null
}

/** Same three-step strategy as scrape-scorecard's discoverUrl (candidate slug
 *  guesses → HEAD-check, then a listing-page scan as fallback), minus the
 *  final recent-matches last-resort step, which is meaningless pre-match. */
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
  const t1Nc   = stripConnectorWords(t1Bare)
  const t2Nc   = stripConnectorWords(t2Bare)
  const series = toSlug(tournamentName)
  const descs  = matchTypeSlugVariants(matchType, matchNumber)

  const teamPairs: Array<[string, string]> = []
  if (t1Full && t2Full) teamPairs.push([t1Full, t2Full], [t2Full, t1Full])
  teamPairs.push([t1, t2], [t2, t1])
  if (t1Bare !== t1 || t2Bare !== t2) teamPairs.push([t1Bare, t2Bare], [t2Bare, t1Bare])
  if (t1Nc !== t1Bare || t2Nc !== t2Bare) teamPairs.push([t1Nc, t2Nc], [t2Nc, t1Nc])

  const candidates: string[] = []
  for (const desc of descs) {
    for (const [a, b] of teamPairs) candidates.push(cricketAddictorUrl(a, b, desc, series))
  }

  for (const url of candidates) {
    try {
      const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } })
      if (r.ok) return url
    } catch { /* try next */ }
  }

  const t1Variants = teamSlugVariants(t1Full ? stripGenderSuffix(t1Full) : null, t1Bare, t1Nc)
  const t2Variants = teamSlugVariants(t2Full ? stripGenderSuffix(t2Full) : null, t2Bare, t2Nc)
  return await scanListingsForMatch(t1Variants, t2Variants, startTime, tournamentName)
}

// ─────────────────────────────────────────────────────────────────────────────
// ─── Toss parsing ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

interface TossResult {
  winnerName: string
  decision: 'bat' | 'bowl'
  delayText: string | null   // any delay/rain language the source surfaced, for the notification body only
}

function normalizeDecision(raw: string): 'bat' | 'bowl' {
  return /bat/i.test(raw) ? 'bat' : 'bowl'   // covers "field" too — same meaning as "bowl" here
}

const DELAY_KEYWORDS = /\b(rain|wet outfield|covers? on|pitch inspection|delayed?|reduced overs|bad light|no toss yet)\b/i

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

// Team-name character class for toss regexes below. Started as
// [A-Za-z .'-] and missed "St Kitts & Nevis Patriots" (CricketAddictor
// spells it with an ampersand, not "and") — a real false-negative caught
// live on CPL 2026 M10, not a hypothetical. Widen this if another team name
// shape turns up a similar miss (numerals, other punctuation, etc.) rather
// than assuming this list is exhaustive.
const TEAM_NAME_CHARS = `A-Za-z .'&-`

function parseCricketAddictorToss(html: string): TossResult | null {
  const text = stripTags(html)
  const m = text.match(new RegExp(`Toss:\\s*([A-Za-z][${TEAM_NAME_CHARS}]+?)\\s+elected to\\s+(bat|bowl|field)`, 'i'))
  const delayM = text.match(DELAY_KEYWORDS)
  if (!m) return null
  return { winnerName: m[1].trim(), decision: normalizeDecision(m[2]), delayText: delayM ? delayM[0] : null }
}

function parseCricApiToss(payload: any): TossResult | null {
  const data = payload?.data ?? payload ?? {}
  const status = String(data.status || '')
  const m = status.match(new RegExp(`([A-Za-z][${TEAM_NAME_CHARS}]+?)\\s+won the toss.*?(?:elected|opted)\\s+to\\s+(bat|bowl|field)`, 'i'))
  const delayM = status.match(DELAY_KEYWORDS)
  if (!m) return null
  return { winnerName: m[1].trim(), decision: normalizeDecision(m[2]), delayText: delayM ? delayM[0] : null }
}

async function fetchCricApiScorecard(externalId: string): Promise<any> {
  if (!CRICAPI_KEYS.length) throw new Error('No CRICAPI_KEYS configured')
  let lastErr: Error | null = null
  for (const key of CRICAPI_KEYS) {
    try {
      const res = await fetch(
        `https://api.cricapi.com/v1/match_scorecard?apikey=${encodeURIComponent(key)}&id=${encodeURIComponent(externalId)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'application/json, text/plain, */*' } },
      )
      const json = await res.json().catch(() => null)
      const exhausted = (msg: string) => /invalid.*key|quota|limit|not.*found.*key/i.test(msg)
      if (!res.ok) {
        const msg = json?.message || `HTTP ${res.status}`
        if (exhausted(msg)) { lastErr = new Error(msg); continue }
        throw new Error(msg)
      }
      if (json?.status === 'failure') {
        const msg = json?.message || 'CricAPI request failed'
        if (exhausted(msg)) { lastErr = new Error(msg); continue }
        throw new Error(msg)
      }
      return json
    } catch (e) {
      lastErr = e as Error
      continue
    }
  }
  throw lastErr ?? new Error('All CricAPI keys exhausted')
}

// ─────────────────────────────────────────────────────────────────────────────
// ─── Admin notification ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

async function notifyAdmin(title: string, body: string, data: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push-notification`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ title, body, target: 'admin', data }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`send-push-notification failed: HTTP ${res.status} ${text}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ─── Main ────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

interface Match {
  id: string
  tournament_id: string
  match_number: number
  match_type: string | null
  format: string | null
  start_time: string | null
  lock_time: string | null
  status: string
  external_id: string | null
  scorecard_url: string | null
  toss_status: string
  toss_delay_notified_at: string | null
  home_team: { id: string; name: string } | null
  away_team: { id: string; name: string } | null
  tournament: { id: string; name: string } | null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.includes(SUPABASE_SERVICE_ROLE_KEY)) {
    // Diagnostic only — lengths and a short prefix, never the actual secret
    // values, so this is safe to leave in the logs. Delete once the 401
    // mismatch this is chasing is understood.
    console.error(
      '[check-toss] Auth rejected.',
      'authHeaderLen:', auth.length,
      'authPrefix:', auth.slice(0, 12),
      'envKeyLen:', SUPABASE_SERVICE_ROLE_KEY.length,
      'envKeyPrefix:', SUPABASE_SERVICE_ROLE_KEY.slice(0, 12),
    )
    return new Response('Unauthorized', { status: 401 })
  }

  const nowMs  = Date.now()
  const nowISO = new Date(nowMs).toISOString()
  const windowStartISO = new Date(nowMs + CHECK_WINDOW_MINUTES * 60 * 1000).toISOString()
  // We give up looking at a match 6 hours after its start_time, so a match
  // that never got a toss recorded (abandoned without a ball, data gap,
  // whatever) doesn't sit in this query forever.
  const giveUpISO = new Date(nowMs - 6 * 60 * 60 * 1000).toISOString()

  const { data: matches, error: mErr } = await sb
    .from('matches')
    .select(`
      id, tournament_id, match_number, match_type, format, start_time, lock_time, status,
      external_id, scorecard_url, toss_status, toss_delay_notified_at,
      home_team:teams!home_team_id(id, name),
      away_team:teams!away_team_id(id, name),
      tournament:tournaments!tournament_id(id, name)
    `)
    .in('status', ['scheduled', 'delayed'])
    .neq('toss_status', 'confirmed')
    .lte('start_time', windowStartISO)
    .gte('start_time', giveUpISO)
    .order('start_time', { ascending: true })

  if (mErr) {
    console.error('[check-toss] Failed to query matches:', mErr.message)
    return new Response(JSON.stringify({ error: mErr.message }), { status: 500 })
  }

  const summary = {
    matchesChecked: 0,
    tossConfirmed  : 0,
    delayFlagged   : 0,
    notified       : 0,
    errors         : [] as string[],
  }

  if (!matches?.length) {
    return new Response(JSON.stringify({ message: 'No matches due for a toss check', ...summary }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }

  // Load the auto-push setting once per run.
  let autoPush = { enabled: false, push_minutes: 30, renotify_minutes: 15 }
  try {
    const { data: settingRow } = await sb.from('app_settings').select('value').eq('key', 'toss_auto_push').maybeSingle()
    if (settingRow?.value) autoPush = { ...autoPush, ...settingRow.value }
  } catch (e: any) {
    console.warn('[check-toss] Could not load toss_auto_push setting, defaulting to disabled:', e.message)
  }

  for (const match of (matches as unknown as Match[])) {
    summary.matchesChecked++
    try {
      const homeTeam = match.home_team?.name ?? ''
      const awayTeam = match.away_team?.name ?? ''
      const tournamentName = match.tournament?.name ?? ''

      // ── Source 1: CricAPI ────────────────────────────────────────────────
      let cricApiToss: TossResult | null = null
      if (match.external_id) {
        try {
          const payload = await fetchCricApiScorecard(match.external_id)
          cricApiToss = parseCricApiToss(payload)
        } catch (e: any) {
          console.warn(`[check-toss] CricAPI check failed for M${match.match_number}:`, e.message)
        }
      }

      // ── Source 2: CricketAddictor ────────────────────────────────────────
      let addictorToss: TossResult | null = null
      try {
        let scorecardUrl = match.scorecard_url
        if (!scorecardUrl && homeTeam && awayTeam) {
          scorecardUrl = await discoverUrl(
            homeTeam, awayTeam, match.match_type, match.match_number, tournamentName, match.start_time,
          )
          // Free side benefit for scrape-scorecard, once this match starts —
          // never overwrites a URL another process already found.
          if (scorecardUrl) {
            await sb.from('matches')
              .update({ scorecard_url: scorecardUrl })
              .eq('id', match.id)
              .is('scorecard_url', null)
          }
        }
        if (scorecardUrl) {
          const summaryUrl = scorecardUrl.replace(/scorecard\/?$/, '')
          const r = await fetch(summaryUrl, { headers: { 'User-Agent': UA } })
          if (r.ok) {
            const html = await r.text()
            addictorToss = parseCricketAddictorToss(html)
          }
        }
      } catch (e: any) {
        console.warn(`[check-toss] CricketAddictor check failed for M${match.match_number}:`, e.message)
      }

      const toss   = cricApiToss ?? addictorToss
      const source = cricApiToss ? 'cricapi' : addictorToss ? 'cricketaddictor' : null
      const delayText = cricApiToss?.delayText ?? addictorToss?.delayText ?? null
      const teamsLabel = homeTeam && awayTeam ? `${homeTeam} vs ${awayTeam}` : `Match ${match.match_number}`

      // ── Case 1: toss confirmed ───────────────────────────────────────────
      // The push here IS the deliverable ("toss confirmed, no action needed")
      // — you explicitly want to hear this even when nothing's wrong. So the
      // notify call goes first, and toss_status only flips to 'confirmed'
      // once it actually succeeds; a failed push just leaves the match
      // 'pending'/'delay_flagged' so the next tick retries both the source
      // check and the notification, instead of silently going quiet.
      if (toss && source) {
        const wasFlaggedDelayed = match.toss_status === 'delay_flagged'
        const resultLabel = `${toss.winnerName} won the toss, elected to ${toss.decision}`
        try {
          await notifyAdmin(
            `✅ ${teamsLabel} (M${match.match_number}) — toss confirmed`,
            wasFlaggedDelayed
              ? `Delay resolved — ${resultLabel}. No action needed.`
              : `${resultLabel}. No action needed — match will lock at the scheduled time.`,
            { matchId: match.id, kind: 'toss_confirmed' },
          )
          await sb.from('matches').update({
            toss_status     : 'confirmed',
            toss_winner_name: toss.winnerName,
            toss_decision   : toss.decision,
            toss_source     : source,
            toss_checked_at : nowISO,
          }).eq('id', match.id)
          summary.tossConfirmed++
        } catch (e: any) {
          summary.errors.push(`Confirm-notify failed M${match.match_number}: ${e.message}`)
          await sb.from('matches').update({ toss_checked_at: nowISO }).eq('id', match.id)
        }
        continue
      }

      // ── Case 2/3: no toss yet — past the delay decision point, or still pending ──
      const startMs = match.start_time ? new Date(match.start_time).getTime() : NaN
      const decisionDeadlineMs = startMs - DELAY_DECISION_BUFFER_MINUTES * 60 * 1000
      const pastDecisionPoint = !isNaN(startMs) && nowMs >= decisionDeadlineMs

      if (!pastDecisionPoint) {
        await sb.from('matches').update({
          toss_status: 'pending', toss_checked_at: nowISO,
        }).eq('id', match.id)
        continue
      }

      summary.delayFlagged++
      const lastNotifiedMs = match.toss_delay_notified_at ? new Date(match.toss_delay_notified_at).getTime() : null
      const shouldNotify = lastNotifiedMs === null || (nowMs - lastNotifiedMs) >= autoPush.renotify_minutes * 60 * 1000

      const update: Record<string, unknown> = { toss_status: 'delay_flagged', toss_checked_at: nowISO }

      if (shouldNotify) {
        // Positive = still before start_time (we're inside the 10-minute
        // decision buffer); negative = start_time has also passed.
        const minutesToStart = Math.round((startMs - nowMs) / 60000)
        const timingText = minutesToStart >= 0
          ? `starts in ${minutesToStart}m`
          : `started ${Math.abs(minutesToStart)}m ago`
        const reasonText = delayText ? ` (source reports: "${delayText}")` : ''

        let body: string
        if (autoPush.enabled && !match.lock_time) {
          const newLockTime = new Date(startMs + autoPush.push_minutes * 60 * 1000).toISOString()
          update.status     = 'delayed'
          update.lock_time  = newLockTime
          body = `No toss confirmed, match ${timingText}${reasonText}. Auto-pushed lock time to ${newLockTime}. Confirm toss when known.`
        } else {
          body = `No toss confirmed, match ${timingText}${reasonText}. Review and push the start time if needed.`
        }

        try {
          await notifyAdmin(
            `⚠️ ${teamsLabel} (M${match.match_number}) — possible delay`,
            body,
            { matchId: match.id, kind: 'toss_delay' },
          )
          update.toss_delay_notified_at = nowISO
          summary.notified++
        } catch (e: any) {
          summary.errors.push(`Notify failed M${match.match_number}: ${e.message}`)
        }
      }

      await sb.from('matches').update(update).eq('id', match.id)
    } catch (e: any) {
      summary.errors.push(`M${match.match_number}: ${e.message}`)
      console.error(`[check-toss] Failed for M${match.match_number}:`, e.message)
    }
  }

  console.log('[check-toss] Done:', summary)
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } })
})
