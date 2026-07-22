#!/usr/bin/env node
/**
 * verify-scores.js
 *
 * Consistency check: recomputes fantasy points for every player in every MLC
 * match from the saved raw batting/bowling/fielding stats + the tournament's
 * locked scoring_rules, then compares against the raw_points already stored
 * in player_match_stats. Flags any player whose stored points don't match
 * what the scoring engine + locked rules would produce.
 *
 * Uses tests/web-scoring-engine.js — the verbatim extraction of index.html's
 * own calcBatting / calcBowling / calcFielding functions (the ones that
 * actually score live matches), including full support for a locked
 * per-tournament rulesOverride. Not a re-implementation, so it can't drift
 * from production logic.
 *
 * Setup (run once):
 *   npm install @supabase/supabase-js
 *
 * Usage (from the project root, next to tests/):
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_KEY=eyJ...           \
 *   node verify-scores.js [--tournament "MLC"] [--tolerance 0.05] [--fix]
 *
 * IMPORTANT: use the service_role key, not the anon key. RLS on
 * player_match_stats / tournaments will likely block the anon key from
 * reading rows outside the current user's own data. The service key is in
 * your Supabase dashboard under Project Settings → API → service_role —
 * treat it as a secret: never commit it or ship it to a client/app bundle.
 *
 * Flags:
 *   --tournament <name>   substring match against tournaments.name (default "MLC")
 *   --tolerance <n>       allowed float drift before flagging, in points (default 0.05)
 *   --fix                 also UPDATE player_match_stats.raw_points to the
 *                          recomputed value for every mismatch found (off by
 *                          default — run without --fix first and read the report)
 *   --verbose              print the full batting/bowling/fielding breakdown for
 *                          each mismatch, not just the total diff
 *   --save-baseline <file> write the mismatches found in this run to a JSON file,
 *                          marking them "known/accepted" (e.g. right after a
 *                          scoring-rule change you're deliberately NOT applying
 *                          retroactively) so future runs stop re-flagging them
 *   --baseline <file>      load a baseline written by --save-baseline and skip
 *                          any mismatch already recorded there — only genuinely
 *                          NEW mismatches (not explained by the known baseline)
 *                          are reported
 */

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const {
  DEFAULT_SCORING_RULES,
  calcBatting,
  calcBowling,
  calcFielding,
} = require('./tests/web-scoring-engine.js'); // path assumes this script sits at the project root

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flagValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
}
const TOURNAMENT_FILTER = flagValue('--tournament', 'MLC');
const TOLERANCE = parseFloat(flagValue('--tolerance', '0.05'));
const APPLY_FIX = args.includes('--fix');
const VERBOSE = args.includes('--verbose');
const SAVE_BASELINE_PATH = flagValue('--save-baseline', null);
const BASELINE_PATH = flagValue('--baseline', null);

let baseline = null;
if (BASELINE_PATH) {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`Baseline file not found: ${BASELINE_PATH}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  baseline = new Set(raw.entries.map(e => `${e.matchId}|${e.playerId}`));
  console.log(`Loaded baseline: ${baseline.size} known mismatch(es) from ${BASELINE_PATH} (saved ${raw.savedAt}).`);
}

// ─── Supabase client ──────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars first.');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Looking up tournaments matching "${TOURNAMENT_FILTER}"...`);
  const { data: tournaments, error: tErr } = await sb
    .from('tournaments')
    .select('id, name, format, scoring_rules')
    .ilike('name', `%${TOURNAMENT_FILTER}%`);
  if (tErr) throw tErr;
  if (!tournaments?.length) {
    console.log('No matching tournaments found.');
    return;
  }

  let totalChecked = 0;
  let totalMismatches = 0;
  let totalKnown = 0;
  const baselineEntries = [];

  for (const t of tournaments) {
    console.log(`\n=== Tournament: ${t.name} (${t.id}) ===`);

    const { data: matches, error: mErr } = await sb
      .from('matches')
      .select('id, match_number, format, status')
      .eq('tournament_id', t.id)
      .order('match_number', { ascending: true });
    if (mErr) throw mErr;
    if (!matches?.length) { console.log('  No matches.'); continue; }

    const matchById = new Map(matches.map(m => [m.id, m]));
    const matchIds = matches.map(m => m.id);

    const { data: stats, error: sErr } = await sb
      .from('player_match_stats')
      .select('match_id, player_id, batting, bowling, fielding, raw_points')
      .in('match_id', matchIds);
    if (sErr) throw sErr;

    const missingScorecard = matches.filter(m =>
      m.status === 'completed' && !stats.some(s => s.match_id === m.id));
    if (missingScorecard.length) {
      console.log(`  ⚠ ${missingScorecard.length} completed match(es) with NO player_match_stats at all:`,
        missingScorecard.map(m => `M${m.match_number}`).join(', '));
    }
    if (!stats?.length) { console.log('  No player_match_stats rows to check.'); continue; }

    const playerIds = [...new Set(stats.map(s => s.player_id))];
    const { data: players, error: pErr } = await sb
      .from('players')
      .select('id, name, role')
      .in('id', playerIds);
    if (pErr) throw pErr;
    const playerById = new Map(players.map(p => [p.id, p]));

    const mismatches = [];

    for (const row of stats) {
      const match = matchById.get(row.match_id);
      const fmt = (match?.format || t.format || 'T20').toUpperCase();
      const player = playerById.get(row.player_id);
      const role = player?.role ?? 'bat';

      // Same merge the rest of the app uses (admin.js buildRulesGrid / index.html):
      // locked tournament overrides layered on top of the built-in defaults.
      const rules = { ...DEFAULT_SCORING_RULES[fmt], ...(t.scoring_rules?.[fmt] || {}) };

      let recomputed = 0;
      const detail = {};
      if (row.batting) {
        const r = calcBatting({ ...row.batting, role }, fmt, rules);
        recomputed += r.points; detail.batting = r.breakdown;
      }
      if (row.bowling) {
        const r = calcBowling(row.bowling, fmt, rules);
        recomputed += r.points; detail.bowling = r.breakdown;
      }
      if (row.fielding) {
        const r = calcFielding(row.fielding, fmt, rules);
        recomputed += r.points; detail.fielding = r.breakdown;
      }
      recomputed = Math.round(recomputed * 10) / 10;

      const stored = Number(row.raw_points ?? 0);
      totalChecked++;

      if (Math.abs(recomputed - stored) > TOLERANCE) {
        totalMismatches++;
        mismatches.push({
          match: `M${match?.match_number ?? '?'}`,
          matchId: row.match_id,
          playerId: row.player_id,
          playerName: player?.name ?? '(unknown player)',
          stored,
          recomputed,
          diff: Math.round((recomputed - stored) * 10) / 10,
          detail,
        });
      }
    }

    // Record every mismatch for a potential --save-baseline snapshot,
    // regardless of whether it's "known" under an existing --baseline.
    for (const m of mismatches) {
      baselineEntries.push({ matchId: m.matchId, playerId: m.playerId, stored: m.stored, recomputed: m.recomputed, diff: m.diff });
    }

    // Split into "known" (already in the loaded baseline — e.g. accepted
    // fallout from a rule change you deliberately didn't backfill) vs "new"
    // (not explained by the baseline — worth investigating).
    const known = baseline ? mismatches.filter(m => baseline.has(`${m.matchId}|${m.playerId}`)) : [];
    const fresh = baseline ? mismatches.filter(m => !baseline.has(`${m.matchId}|${m.playerId}`)) : mismatches;
    totalKnown += known.length;

    if (!mismatches.length) {
      console.log(`  ✓ ${stats.length} player-match rows checked — all match recomputed points.`);
    } else {
      if (baseline) {
        console.log(`  ${known.length} known (baseline) mismatch(es), ${fresh.length} NEW mismatch(es) out of ${stats.length} rows checked.`);
      } else {
        console.log(`  ✗ ${mismatches.length} / ${stats.length} rows mismatched:`);
      }
      for (const m of fresh) {
        console.log(`    ${m.match} — ${m.playerName} (${m.playerId}): stored=${m.stored} recomputed=${m.recomputed} (diff ${m.diff > 0 ? '+' : ''}${m.diff})`);
        if (VERBOSE) console.log('      breakdown:', JSON.stringify(m.detail, null, 2).split('\n').join('\n      '));
      }

      if (APPLY_FIX) {
        const toFix = fresh; // never auto-fix rows already accepted into the baseline
        console.log(`  Applying --fix: updating raw_points for ${toFix.length} row(s)...`);
        for (const m of toFix) {
          const { error } = await sb
            .from('player_match_stats')
            .update({ raw_points: m.recomputed })
            .eq('match_id', m.matchId)
            .eq('player_id', m.playerId);
          if (error) console.error(`    Failed to fix ${m.match}/${m.playerName}:`, error.message);
        }
        console.log('  Done. Re-run the app\'s XI/SL score recompute for these matches to propagate the fix to leaderboards.');
      }
    }
  }

  console.log(`\n=== Summary: ${totalChecked} rows checked, ${totalMismatches} mismatch(es)`
    + (baseline ? ` (${totalKnown} known / ${totalMismatches - totalKnown} new)` : '') + ' ===');
  if (totalMismatches && !APPLY_FIX && !baseline) {
    console.log('Re-run with --fix to write the recomputed values back to player_match_stats.');
  }

  if (SAVE_BASELINE_PATH) {
    fs.writeFileSync(SAVE_BASELINE_PATH, JSON.stringify({
      savedAt: new Date().toISOString(),
      tournamentFilter: TOURNAMENT_FILTER,
      entries: baselineEntries,
    }, null, 2));
    console.log(`\nSaved baseline with ${baselineEntries.length} known mismatch(es) to ${SAVE_BASELINE_PATH}.`);
    console.log(`Future runs: node verify-scores.js --tournament "${TOURNAMENT_FILTER}" --baseline ${SAVE_BASELINE_PATH}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
