#!/usr/bin/env node
/**
 * show_mlc_final_scorecard.mjs
 *
 * Builds a polished HTML scorecard (opened in your browser) for a completed
 * match, pulling from the same Supabase project the app uses. Combines the
 * cached raw scorecard (match_scorecards) with dot-ball counts from
 * player_match_stats, since the scraper doesn't persist dots into the
 * scorecard cache itself (see the "Obus Pienaar" / dot-ball investigation).
 *
 * Usage:
 *   node show_mlc_final_scorecard.mjs                                   # MLC final (default)
 *   node show_mlc_final_scorecard.mjs --tournament "Major League Cricket" --match 12
 *   node show_mlc_final_scorecard.mjs -t "IPL" -m 5
 *   node show_mlc_final_scorecard.mjs -t "MLC"                          # match omitted -> falls back to "final" logic
 *   node show_mlc_final_scorecard.mjs -t "MLC" -m 12 --raw              # dump untouched JSON to console instead
 *   node show_mlc_final_scorecard.mjs -t "MLC" -m 12 --no-open          # write the HTML but don't auto-open it
 *
 * Run locally (needs network access to Supabase, which the sandbox doesn't have):
 *
 *   npm install @supabase/supabase-js
 *   node show_mlc_final_scorecard.mjs [flags]
 *
 * Uses the same public anon key already embedded in app/app.json — read-only,
 * governed by the app's existing RLS policies (match_scorecards is public-read
 * per migration_v17_rls.sql).
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = 'https://gepltclaeczgtruvekci.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdlcGx0Y2xhZWN6Z3RydXZla2NpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1MTc5NTUsImV4cCI6MjA5NDA5Mzk1NX0.DW2Fzfw-gaabIbns_CUydbvOwuoko-ACEAH_g1_5Sm8';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI args ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { tournament: 'MLC', match: null, raw: false, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tournament' || a === '-t') out.tournament = argv[++i];
    else if (a === '--match' || a === '-m') out.match = parseInt(argv[++i], 10);
    else if (a === '--raw') out.raw = true;
    else if (a === '--no-open') out.open = false;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

// Pull the real batter/bowler name + dismissal string out of whatever shape
// CricAPI (or the scraper mimicking it) gave us this time — inconsistently
// batter/batsman/player as the key, dismissal/dismissal-text for the text.
function battingName(b) {
  return (b.batter ?? b.batsman ?? b.player ?? {}).name ?? b.name ?? '?';
}
function dismissalText(b) {
  return String(b['dismissal-text'] ?? b.dismissal ?? '').trim() || 'not out';
}
function bowlingName(bw) {
  return (bw.bowler ?? bw.player ?? {}).name ?? bw.name ?? '?';
}
function fmtOvers(balls) {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function main() {
  // 1. Find the tournament (case-insensitive partial match on name)
  const { data: tournaments, error: tErr } = await sb
    .from('tournaments')
    .select('id, name, format')
    .ilike('name', `%${args.tournament}%`);
  if (tErr) throw tErr;
  if (!tournaments?.length) {
    console.error(`No tournament matching "%${args.tournament}%". Pass --tournament "<exact or partial name>".`);
    process.exit(1);
  }
  const tournament = tournaments[0];
  if (tournaments.length > 1) {
    console.log(`Multiple tournaments matched "${args.tournament}" — using "${tournament.name}".`);
  }

  // 2. Find completed matches for this tournament
  const { data: matches, error: mErr } = await sb
    .from('matches')
    .select('id, match_number, home_team_id, away_team_id, status, notes, played_on, external_id')
    .eq('tournament_id', tournament.id)
    .eq('status', 'completed')
    .order('match_number', { ascending: true });
  if (mErr) throw mErr;
  if (!matches?.length) {
    console.error('No completed matches found for this tournament.');
    process.exit(1);
  }

  // 3. Pick the match:
  //    - explicit --match N -> that match_number
  //    - otherwise -> notes mentioning "final", else highest match_number
  let targetMatch;
  let fallbackNote = '';
  if (args.match != null) {
    targetMatch = matches.find(m => m.match_number === args.match);
    if (!targetMatch) {
      console.error(`No completed match with match_number ${args.match} in "${tournament.name}". Completed match numbers: ${matches.map(m => m.match_number).join(', ')}`);
      process.exit(1);
    }
  } else {
    targetMatch = matches.find(m => /final/i.test(m.notes ?? ''));
    if (!targetMatch) {
      targetMatch = matches.reduce((a, b) => (b.match_number ?? 0) > (a.match_number ?? 0) ? b : a);
      fallbackNote = 'No --match given and no match with "final" in notes — showing the highest match_number as a best guess.';
      console.log(fallbackNote);
    }
  }

  console.log(`Match: M${targetMatch.match_number ?? '?'} — ${targetMatch.home_team_id} vs ${targetMatch.away_team_id} (${targetMatch.played_on})`);

  // 4. Pull the cached scorecard payload
  const { data: sc, error: scErr } = await sb
    .from('match_scorecards')
    .select('payload, fetched_at')
    .eq('match_id', targetMatch.id)
    .maybeSingle();
  if (scErr) throw scErr;

  if (args.raw) {
    console.log(JSON.stringify(sc?.payload ?? null, null, 2));
    return;
  }

  if (!sc) {
    console.log('⚠️  No cached scorecard found in match_scorecards for this match — finalize may not have run for it.');
    const { data: stats } = await sb
      .from('player_match_stats')
      .select('player_id, batting, bowling, fielding, raw_points')
      .eq('match_id', targetMatch.id);
    writeAndOpen(buildMissingScorecardHtml(tournament, targetMatch, stats ?? []), args.open);
    return;
  }

  // CricAPI-fetched matches store `payload.scorecard` directly.
  // Scraper-fetched matches (CricketAddictor/Business Standard, via the
  // scrape-scorecard Edge Function) nest it one level deeper under
  // `payload.data.scorecard` — mirroring CricAPI's own /match_scorecard
  // response shape. Check both.
  const scorecard = sc.payload?.scorecard ?? sc.payload?.data?.scorecard ?? [];
  const source = sc.payload?.scorecard ? 'cricapi' : (sc.payload?.data?.scorecard ? 'scraper' : 'unknown');

  if (!scorecard.length) {
    console.log('Payload has no `scorecard` array (checked both `payload.scorecard` and `payload.data.scorecard`).');
    writeAndOpen(buildRawPayloadHtml(tournament, targetMatch, sc), args.open);
    return;
  }

  // ── Dot balls ──────────────────────────────────────────────────────────
  // NOT in match_scorecards — the scraper drops `dots` when it builds the
  // rawScorecard snapshot it caches there, even though it scrapes and
  // scores dot balls correctly elsewhere. The only place dotBalls survives
  // is player_match_stats.bowling.dotBalls, keyed by resolved local
  // player_id, so pull that separately and merge it in.
  const { data: stats, error: statsErr } = await sb
    .from('player_match_stats')
    .select('player_id, bowling')
    .eq('match_id', targetMatch.id)
    .not('bowling', 'is', null);
  if (statsErr) throw statsErr;
  const bowlingStats = (stats ?? []).filter(s => s.bowling && (s.bowling.ballsBowled ?? 0) > 0);

  let nameById = new Map();
  if (bowlingStats.length) {
    const { data: players, error: pErr } = await sb
      .from('players')
      .select('id, name')
      .in('id', bowlingStats.map(s => s.player_id));
    if (pErr) throw pErr;
    nameById = new Map((players ?? []).map(p => [p.id, p.name]));
  }
  // Dot-ball lookup keyed by lowercased local player name, for matching
  // against the (possibly differently-spelled) scorecard bowler name below.
  const dotsByName = new Map(
    bowlingStats.map(s => [(nameById.get(s.player_id) ?? '').toLowerCase().trim(), s.bowling.dotBalls ?? 0])
  );

  const html = buildScorecardHtml({
    tournament, match: targetMatch, source, fetchedAt: sc.fetched_at,
    scorecard, dotsByName, bowlingStats, nameById, fallbackNote,
  });
  writeAndOpen(html, args.open);
}

function writeAndOpen(html, open) {
  const outPath = join(__dirname, 'scorecard_output.html');
  writeFileSync(outPath, html, 'utf8');
  console.log(`\nSaved: ${outPath}`);
  if (open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(cmd, [outPath], err => {
      if (err) console.log(`(Couldn't auto-open — open it manually: ${outPath})`);
    });
  }
}

// ─── HTML rendering ──────────────────────────────────────────────────────

const PAGE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 60px; background: #0f172a; color: #e2e8f0;
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; color: #f8fafc; }
  .sub { color: #94a3b8; font-size: 13px; margin-bottom: 24px; }
  .note { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px;
          font-size: 13px; color: #fbbf24; margin-bottom: 20px; }
  .innings { background: #161f33; border: 1px solid #263449; border-radius: 12px;
             padding: 18px 20px; margin-bottom: 20px; }
  .innings h2 { font-size: 16px; margin: 0 0 12px; color: #38bdf8; display: flex;
                justify-content: space-between; align-items: baseline; }
  .innings h2 .total { color: #f8fafc; font-weight: 700; font-size: 15px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 14px; }
  th { text-align: left; color: #64748b; font-weight: 600; font-size: 11px;
       text-transform: uppercase; letter-spacing: .04em; padding: 4px 8px; border-bottom: 1px solid #263449; }
  td { padding: 6px 8px; border-bottom: 1px solid #1e293b; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .name { font-weight: 600; color: #f1f5f9; }
  .dismissal { color: #94a3b8; font-size: 12px; }
  .section-label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
                    color: #64748b; margin: 4px 0 6px; font-weight: 700; }
  .dots-highlight { color: #facc15; font-weight: 700; }
  .missing { color: #64748b; font-style: italic; }
  .footer { color: #475569; font-size: 11px; margin-top: 28px; }
`;

function pageShell(title, sub, body, note) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${PAGE_STYLE}</style></head>
<body><div class="wrap">
<h1>${esc(title)}</h1>
<div class="sub">${esc(sub)}</div>
${note ? `<div class="note">⚠️ ${esc(note)}</div>` : ''}
${body}
<div class="footer">Generated locally by show_mlc_final_scorecard.mjs — data straight from Supabase, not cached anywhere.</div>
</div></body></html>`;
}

function buildScorecardHtml({ tournament, match, source, fetchedAt, scorecard, dotsByName }) {
  const title = `${match.home_team_id} vs ${match.away_team_id}`;
  const sub = `${tournament.name} · M${match.match_number ?? '?'} · ${match.played_on} · source: ${source} · cached ${new Date(fetchedAt).toLocaleString()}`;

  const inningsHtml = scorecard.map((innings, i) => {
    const teamName = innings.inning || innings.team || `Innings ${i + 1}`;
    const total = innings.total ? `${innings.total}` : (innings.r != null ? `${innings.r}/${innings.w ?? '?'} (${innings.o ?? '?'} ov)` : '');

    const battingRows = (innings.batting ?? []).map(b => {
      const dText = dismissalText(b);
      const isNotOut = dText.toLowerCase() === 'not out';
      return `<tr>
        <td class="name">${esc(battingName(b))}</td>
        <td class="num">${b.r ?? 0}</td>
        <td class="num">${b.b ?? 0}</td>
        <td class="num">${b['4s'] ?? 0}</td>
        <td class="num">${b['6s'] ?? 0}</td>
        <td class="dismissal">${isNotOut ? '<span class="missing">not out</span>' : esc(dText)}</td>
      </tr>`;
    }).join('');

    const bowlingRows = (innings.bowling ?? []).map(bw => {
      const name = bowlingName(bw);
      const dots = dotsByName.get(name.toLowerCase().trim());
      return `<tr>
        <td class="name">${esc(name)}</td>
        <td class="num">${bw.o ?? '0.0'}</td>
        <td class="num">${bw.m ?? 0}</td>
        <td class="num">${bw.r ?? 0}</td>
        <td class="num">${bw.w ?? 0}</td>
        <td class="num">${dots != null ? `<span class="dots-highlight">${dots}</span>` : '<span class="missing">—</span>'}</td>
      </tr>`;
    }).join('');

    return `<div class="innings">
      <h2><span>${esc(teamName)}</span>${total ? `<span class="total">${esc(total)}</span>` : ''}</h2>
      <div class="section-label">Batting</div>
      <table>
        <tr><th>Batter</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th><th>Dismissal</th></tr>
        ${battingRows || '<tr><td class="missing" colspan="6">No batting data</td></tr>'}
      </table>
      <div class="section-label">Bowling</div>
      <table>
        <tr><th>Bowler</th><th class="num">O</th><th class="num">M</th><th class="num">R</th><th class="num">W</th><th class="num">Dots</th></tr>
        ${bowlingRows || '<tr><td class="missing" colspan="6">No bowling data</td></tr>'}
      </table>
    </div>`;
  }).join('');

  const note = source === 'scraper'
    ? 'Dot-ball counts (yellow) are pulled in from player_match_stats — the scraper doesn\'t persist them into the cached scorecard itself. A "—" means no matching player_match_stats row was found for that bowler name.'
    : null;

  return pageShell(title, sub, inningsHtml, note);
}

function buildMissingScorecardHtml(tournament, match, stats) {
  const title = `${match.home_team_id} vs ${match.away_team_id}`;
  const sub = `${tournament.name} · M${match.match_number ?? '?'} · ${match.played_on}`;
  const body = stats.length
    ? `<div class="innings"><div class="section-label">player_match_stats (${stats.length} rows)</div>
       <pre style="white-space:pre-wrap;font-size:12px;color:#cbd5e1;">${esc(JSON.stringify(stats, null, 2))}</pre></div>`
    : '<div class="innings missing">No player_match_stats rows either — this match hasn\'t been finalized.</div>';
  return pageShell(title, sub, body, 'No cached scorecard found in match_scorecards for this match.');
}

function buildRawPayloadHtml(tournament, match, sc) {
  const title = `${match.home_team_id} vs ${match.away_team_id}`;
  const sub = `${tournament.name} · M${match.match_number ?? '?'} · ${match.played_on}`;
  const body = `<div class="innings"><div class="section-label">Raw payload</div>
    <pre style="white-space:pre-wrap;font-size:12px;color:#cbd5e1;">${esc(JSON.stringify(sc.payload, null, 2))}</pre></div>`;
  return pageShell(title, sub, body, 'Cached payload has no recognizable `scorecard` array.');
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
