// lock-matches — Supabase Edge Function
//
// Locks every SL squad's draft XI for any match whose lock gate has passed
// and whose status is still 'scheduled', 'in_progress', or 'delayed'.
// ('in_progress' is included so a poll-cricapi status flip can't race ahead
// of this function and starve a match from ever being locked — see the
// comment at the matches query below.)
// Gate = lock_time if set, otherwise start_time.
// After locking all squads it updates the match status to 'live'.
//
// Also stamps locked_at on any DAILY one-off teams (user_teams rows with
// squad_id IS NULL) for the same match, at the same gate — display/audit
// only (drives a "Locked" badge). The actual write-blocking for daily teams
// is enforced by RLS (migration_v27_daily_team_lock_rls.sql), which checks
// the same lock_time/start_time gate on every request with no cron lag;
// this stamp just keeps the UI in sync with that boundary.
//
// Deploy:
//   supabase functions deploy lock-matches --no-verify-jwt
//
// Scheduled via pg_cron + pg_net every minute (migration_v26_lock_matches_cron.sql),
// matching the scrape-scorecard / poll-cricapi pattern already used in this repo:
//   SELECT net.http_post(url := '.../functions/v1/lock-matches',
//     headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>'),
//     body := '{}'::jsonb)
//
// The function is idempotent — squads already locked for a match are skipped,
// and the locked_at stamp only ever moves from NULL to a value.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// ─── types ───────────────────────────────────────────────────────────────────

interface Match {
  id: string;
  tournament_id: string;
  match_number: number | null;
  start_time: string | null;
  lock_time: string | null;
  status: string;
}

interface Contest {
  id: string;
  contest_type: string;
  total_transfers_allowed: number | null;
  free_transfers_per_match: number | null;
  extra_transfer_point_cost: number | null;
  start_match_number: number | null;
  playoff_start_match_number: number | null;
  playoff_transfers_allowed: number | null;
  playoff_first_match_unlimited: boolean;
}

interface Squad {
  id: string;
  user_id: string;
}

interface Draft {
  player_ids: string[];
  captain_id: string | null;
  vc_id: string | null;
  target_match_id: string | null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function detectPhase(
  matchNum: number | null,
  startMatchNumber: number | null,
  playoffStartMN: number | null,
): 'pre_season' | 'regular' | 'playoff' {
  if (startMatchNumber === null || matchNum === null || matchNum < startMatchNumber)
    return 'pre_season';
  if (playoffStartMN !== null && matchNum >= playoffStartMN)
    return 'playoff';
  return 'regular';
}

// ─── main ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Only accept POST (cron-job.org sends POST)
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Verify the service role key is present in the Authorization header
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.includes(SERVICE_ROLE_KEY)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const nowISO = new Date().toISOString();
  const nowMs  = Date.now();

  const summary = {
    matchesProcessed : 0,
    squadsLocked     : 0,
    squadsSkipped    : 0,
    dailyTeamsStamped: 0,
    errors           : [] as string[],
  };

  // ── 1. Find matches that need locking ──────────────────────────────────────
  // Covers two cases:
  //   a) Normal:  status IN ('scheduled', 'in_progress') and start_time <= now
  //   b) Delayed: status = 'delayed'                     and lock_time  <= now (admin set a lock time)
  //
  // 'in_progress' is included alongside 'scheduled' to avoid a race with
  // poll-cricapi: that function independently flips a CricAPI-driven match's
  // status straight to 'in_progress' the moment it detects live data,
  // completely independent of this function. Both run on a 1-minute cron, so
  // on any given match start it's a coin flip which one's tick lands first.
  // If this query only matched 'scheduled', a poll-cricapi win would
  // permanently starve that match — it would never come back as 'scheduled'
  // again, so its SL squads/daily teams would never get locked. Matching
  // 'in_progress' too closes that gap. (Scraper-driven matches never see
  // this race — scrape-scorecard has no 'live'/'in_progress' transition of
  // its own; it leaves status at 'scheduled' until completion.) This is
  // still idempotent: once a match is processed here it's set to 'live',
  // which neither query matches, so it converges after one pass.
  const { data: scheduled, error: mErr } = await sb
    .from('matches')
    .select('id, tournament_id, match_number, start_time, lock_time, status')
    .in('status', ['scheduled', 'in_progress'])
    .lte('start_time', nowISO)
    .order('match_number', { ascending: true });

  const { data: delayed, error: dErr } = await sb
    .from('matches')
    .select('id, tournament_id, match_number, start_time, lock_time, status')
    .eq('status', 'delayed')
    .not('lock_time', 'is', null)
    .lte('lock_time', nowISO)
    .order('match_number', { ascending: true });

  if (mErr || dErr) {
    const msg = mErr?.message ?? dErr?.message;
    console.error('[lock-matches] Failed to query matches:', msg);
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }

  const matches = [...(scheduled ?? []), ...(delayed ?? [])];

  if (!matches?.length) {
    return new Response(
      JSON.stringify({ message: 'No matches to lock', ...summary }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── 2. Process each match ─────────────────────────────────────────────────
  for (const match of (matches as Match[])) {
    summary.matchesProcessed++;
    console.log(`[lock-matches] Processing M${match.match_number} (${match.id})`);

    // All matches in this tournament — needed for phase detection + prev XI lookup
    const { data: allTournamentMatches } = await sb
      .from('matches')
      .select('id, match_number, start_time, lock_time, status')
      .eq('tournament_id', match.tournament_id)
      .order('match_number', { ascending: true });

    const tournamentMatches = (allTournamentMatches ?? []) as Match[];

    // ── 2b. Stamp locked_at on daily one-off teams for this match ───────────
    // Display/audit only — see header comment. Runs regardless of whether
    // this tournament has any active SL contests, and is itself idempotent
    // (locked_at only ever moves NULL → now(), never overwritten again).
    try {
      const { error: dailyErr, count } = await sb
        .from('user_teams')
        .update({ locked_at: nowISO }, { count: 'exact' })
        .eq('match_id', match.id)
        .is('squad_id', null)
        .is('locked_at', null);
      if (dailyErr) {
        summary.errors.push(`Daily lock stamp M${match.match_number}: ${dailyErr.message}`);
      } else if (count) {
        summary.dailyTeamsStamped += count;
        console.log(`[lock-matches] Stamped locked_at on ${count} daily team(s) for M${match.match_number}`);
      }
    } catch (e: any) {
      summary.errors.push(`Daily lock stamp M${match.match_number}: ${e.message}`);
    }

    // Contests for this tournament
    const { data: contests } = await sb
      .from('contests')
      .select('id, contest_type, total_transfers_allowed, free_transfers_per_match, extra_transfer_point_cost, start_match_number, playoff_start_match_number, playoff_transfers_allowed, playoff_first_match_unlimited')
      .eq('tournament_id', match.tournament_id)
      .eq('is_active', true);

    if (!contests?.length) {
      console.log(`[lock-matches] No active contests for tournament ${match.tournament_id} — skipping`);
      // Still mark live so we don't re-process
      await sb.from('matches').update({ status: 'live' }).eq('id', match.id);
      continue;
    }

    // ── 3. Lock every SL squad in every contest ──────────────────────────────
    for (const contest of (contests as Contest[])) {
      if (contest.contest_type !== 'season_long') continue;

      const { data: squads } = await sb
        .from('user_squads')
        .select('id, user_id')
        .eq('contest_id', contest.id);

      if (!squads?.length) continue;

      for (const squad of (squads as Squad[])) {
        // ── Already locked? Skip ─────────────────────────────────────────────
        const { data: existing } = await sb
          .from('user_match_xi')
          .select('squad_id')
          .eq('squad_id', squad.id)
          .eq('match_id', match.id)
          .limit(1);

        if (existing?.length) {
          summary.squadsSkipped++;
          continue;
        }

        // ── Read draft ───────────────────────────────────────────────────────
        const { data: draft } = await sb
          .from('squad_draft_xi')
          .select('player_ids, captain_id, vc_id, target_match_id')
          .eq('squad_id', squad.id)
          .maybeSingle() as { data: Draft | null };

        if (!draft?.player_ids?.length || draft.player_ids.length !== 11) {
          summary.errors.push(
            `Squad ${squad.id} M${match.match_number}: no valid draft (${draft?.player_ids?.length ?? 0} players) — skipped`
          );
          summary.squadsSkipped++;
          continue;
        }

        // ── Find previous locked XI (transfer baseline) ──────────────────────
        const { data: prevXIRows } = await sb
          .from('user_match_xi')
          .select('player_id, match_id, is_captain, is_vc')
          .eq('squad_id', squad.id);

        let prevPlayerIds: string[] = [];
        let prevCaptainId: string | null = null;
        let prevVcId: string | null = null;
        let prevMatchId: string | null = null;
        if (prevXIRows?.length) {
          const lockedMatchIds = new Set(prevXIRows.map((r: any) => r.match_id));
          const validPrevMatches = tournamentMatches.filter(m =>
            m.id !== match.id &&
            lockedMatchIds.has(m.id) &&
            (m.match_number ?? 0) < (match.match_number ?? 0) &&
            (m.lock_time ?? m.start_time) && new Date((m.lock_time ?? m.start_time)!).getTime() <= nowMs,
          );
          if (validPrevMatches.length) {
            const lastPrev = validPrevMatches[validPrevMatches.length - 1];
            prevMatchId    = lastPrev.id;
            const lastPrevRows = prevXIRows.filter((r: any) => r.match_id === lastPrev.id);
            prevPlayerIds  = lastPrevRows.map((r: any) => r.player_id);
            prevCaptainId  = lastPrevRows.find((r: any) => r.is_captain)?.player_id ?? null;
            prevVcId       = lastPrevRows.find((r: any) => r.is_vc)?.player_id ?? null;
          }
        }

        // ── GUARANTEE: only ever lock in a draft that was explicitly Saved for
        // THIS match (mirrors db.js's lockMatchXI — see migration_v35). squad_draft_xi
        // is one shared row per squad with no inherent match association beyond
        // target_match_id — without this check, whichever match's lock happens to
        // run next just grabs "whatever's currently in the draft" (e.g. a web edit
        // saved for a LATER match, or one that raced a mobile save) and locks it
        // in, producing an XI the user never actually confirmed for this match —
        // the "stray transfers" bug. If the draft doesn't match, don't guess: carry
        // the previous locked XI forward unchanged (0 transfers). Only skip the
        // squad entirely if there's also no previous locked XI to fall back on.
        let xiPlayerIds = draft.player_ids;
        let xiCaptainId = draft.captain_id;
        let xiVcId      = draft.vc_id;
        if (draft.target_match_id !== match.id) {
          if (prevPlayerIds.length === 11) {
            xiPlayerIds = prevPlayerIds;
            xiCaptainId = prevCaptainId;
            xiVcId      = prevVcId;
            console.warn(
              `[lock-matches] Squad ${squad.id} M${match.match_number}: draft.target_match_id ` +
              `(${draft.target_match_id}) does not match the match being locked (${match.id}) — ` +
              `carrying forward the previous locked XI (match ${prevMatchId}) instead of trusting ` +
              `an unconfirmed draft.`
            );
          } else {
            summary.errors.push(
              `Squad ${squad.id} M${match.match_number}: no XI explicitly saved for this match, and ` +
              `no previous locked XI to carry forward — skipped`
            );
            summary.squadsSkipped++;
            continue;
          }
        }

        // ── Check active booster ────────────────────────────────────────────
        const { data: boosterRow } = await sb
          .from('user_booster_activations')
          .select('booster')
          .eq('squad_id', squad.id)
          .eq('match_id', match.id)
          .maybeSingle();

        const activeBooster   = boosterRow?.booster ?? null;
        const bypassTransfers = activeBooster === 'wildcard' || activeBooster === 'free_hit';

        // Free Hit: snapshot the XI actually being locked (post-guarantee-check),
        // not the raw draft — if the draft got overridden by the carry-forward
        // fallback above, the snapshot must match what's really locked in.
        if (activeBooster === 'free_hit') {
          try {
            await sb.from('user_booster_activations')
              .delete()
              .eq('squad_id', squad.id)
              .eq('match_id', match.id)
              .eq('booster', 'free_hit');

            await sb.from('user_booster_activations').insert({
              squad_id  : squad.id,
              match_id  : match.id,
              booster   : 'free_hit',
              snapshot  : { playerIds: xiPlayerIds, captainId: xiCaptainId, vcId: xiVcId },
            });
          } catch (e: any) {
            console.warn(`[lock-matches] free_hit snapshot failed for squad ${squad.id}:`, e.message);
          }
        }

        // "First active lock" = this squad has no real transfer baseline — either
        // it never locked anything before, or the only prior lock on record was a
        // retroactive auto-lock for a match that was ALREADY completed by the time
        // the squad joined (so that XI was never actually picked by the user).
        // We distinguish that from the normal, common case of an actively-playing
        // squad whose previous match simply finished before this one locked —
        // checked by looking for ANY earlier locked match for this squad. If one
        // exists, they've been actively playing and the real baseline must be
        // honored regardless of the previous match's status. (Mirrors the fix
        // applied to lockMatchXI in db.js.)
        //
        // NOTE: prevMatchId must come from lastPrev (the actual previous match we
        // just identified above) — NOT re-derived by searching prevXIRows for a
        // row whose player_id happens to appear in prevPlayerIds. Squads usually
        // keep most of their XI from match to match, so that player_id will also
        // appear in OLDER locked matches; .find() would latch onto whichever row
        // happens to come first in the (unordered) query result, frequently an
        // earlier match than the real baseline. That misidentified match's status
        // then drove "first active lock" detection, intermittently zeroing
        // baselineIds and silently skipping transfer logging for squads that had
        // genuinely made transfers — the bug reported as "transfers made but not
        // registered at lock".
        const prevMatchStatus = tournamentMatches.find(m => m.id === prevMatchId)?.status ?? null;

        let baselineIds = prevPlayerIds;
        if (prevPlayerIds.length === 0) {
          baselineIds = [];
        } else if (prevMatchStatus === 'completed') {
          const prevMatchNum    = tournamentMatches.find(m => m.id === prevMatchId)?.match_number ?? 0;
          const lockedMatchIds  = new Set((prevXIRows ?? []).map((r: any) => r.match_id));
          const hasEarlierLock  = tournamentMatches.some(m =>
            (m.match_number ?? 0) < prevMatchNum && lockedMatchIds.has(m.id),
          );
          baselineIds = hasEarlierLock ? prevPlayerIds : [];
        }

        // ── Lock: write user_match_xi ────────────────────────────────────────
        try {
          await sb.from('user_match_xi')
            .delete()
            .eq('squad_id', squad.id)
            .eq('match_id', match.id);

          const xiRows = xiPlayerIds.map(pid => ({
            squad_id  : squad.id,
            match_id  : match.id,
            player_id : pid,
            is_captain: pid === xiCaptainId,
            is_vc     : pid === xiVcId,
            role      : 'bat',
          }));
          const { error: ie } = await sb.from('user_match_xi').insert(xiRows);
          if (ie) throw ie;

          // ── Transfer counting ──────────────────────────────────────────────
          if (!bypassTransfers && baselineIds.length > 0) {
            const prevSet = new Set(baselineIds);
            const currSet = new Set(xiPlayerIds);
            const playersOut     = baselineIds.filter(id => !currSet.has(id));
            const playersIn      = xiPlayerIds.filter(id => !prevSet.has(id));
            const transfersMade  = Math.min(playersOut.length, playersIn.length);

            if (transfersMade > 0) {
              const phase = detectPhase(match.match_number, contest.start_match_number, contest.playoff_start_match_number);
              // Unlimited first playoff match: every swap is free, regardless
              // of free_transfers_per_match — a full reset, not just an
              // uncapped count. Mirrors db.js saveMatchXI / transferCap.ts
              // checkAndLogTransfers, which the client already enforces before
              // save — this cron path just needs to log the same result
              // consistently in case a squad's draft reaches lock without
              // ever having gone through the client-side check.
              const isUnlimitedFirstPlayoffMatch =
                phase === 'playoff' &&
                !!contest.playoff_first_match_unlimited &&
                match.match_number === contest.playoff_start_match_number;
              const freePerMatch = contest.free_transfers_per_match ?? null;
              const extraCost    = Number(contest.extra_transfer_point_cost ?? 4);

              await sb.from('user_transfers')
                .delete()
                .eq('squad_id', squad.id)
                .eq('match_id', match.id);

              const xferRows = playersOut.slice(0, transfersMade).map((outId, i) => {
                const isFree = isUnlimitedFirstPlayoffMatch || freePerMatch === null || i < freePerMatch;
                return {
                  squad_id       : squad.id,
                  match_id       : match.id,
                  player_out_id  : outId,
                  player_in_id   : playersIn[i],
                  is_free        : isFree,
                  points_deducted: isFree ? 0 : extraCost,
                };
              });

              const { error: xe } = await sb.from('user_transfers').insert(xferRows);
              if (xe) console.warn(`[lock-matches] Transfer log error (non-fatal):`, xe.message);
            }
          }

          // ── Write to user_teams for the scoring pipeline ───────────────────
          // Find or create the user_teams row for this squad + match
          const { data: teamRows } = await sb
            .from('user_teams')
            .select('id')
            .eq('squad_id', squad.id)
            .eq('match_id', match.id)
            .limit(1);

          let teamId: string;
          if (teamRows?.length) {
            teamId = teamRows[0].id;
            await sb.from('user_teams').update({
              captain_id      : xiCaptainId,
              vice_captain_id : xiVcId,
            }).eq('id', teamId);
            await sb.from('user_team_players').delete().eq('user_team_id', teamId);
          } else {
            const { data: newTeam, error: te } = await sb
              .from('user_teams')
              .insert({
                squad_id        : squad.id,
                match_id        : match.id,
                user_id         : squad.user_id,
                name            : 'SL Team',
                format          : 'T20',
                captain_id      : xiCaptainId,
                vice_captain_id : xiVcId,
              })
              .select('id')
              .single();
            if (te) throw te;
            teamId = newTeam.id;
          }

          const playerRows = xiPlayerIds.map(pid => ({
            user_team_id: teamId,
            player_id   : pid,
          }));
          const { error: pe } = await sb.from('user_team_players').insert(playerRows);
          if (pe) console.warn(`[lock-matches] user_team_players insert failed (non-fatal):`, pe.message);

          // ── Propagate to shared (private-league mirror) squads ─────────────
          const { data: sharedSquads } = await sb
            .from('user_squads')
            .select('id, user_id')
            .eq('primary_squad_id', squad.id);

          if (sharedSquads?.length) {
            for (const ss of sharedSquads) {
              const { data: ssExisting } = await sb
                .from('user_match_xi')
                .select('squad_id')
                .eq('squad_id', ss.id)
                .eq('match_id', match.id)
                .limit(1);
              if (ssExisting?.length) continue;

              await sb.from('user_match_xi').delete()
                .eq('squad_id', ss.id).eq('match_id', match.id);

              const ssRows = xiPlayerIds.map(pid => ({
                squad_id  : ss.id,
                match_id  : match.id,
                player_id : pid,
                is_captain: pid === xiCaptainId,
                is_vc     : pid === xiVcId,
                role      : 'bat',
              }));
              await sb.from('user_match_xi').insert(ssRows);
            }
          }

          summary.squadsLocked++;
          console.log(`[lock-matches] Squad ${squad.id} locked for M${match.match_number}`);

        } catch (e: any) {
          summary.errors.push(`Squad ${squad.id} M${match.match_number}: ${e.message}`);
          console.error(`[lock-matches] Lock failed for squad ${squad.id}:`, e.message);
        }
      }
    }

    // ── 4. Mark match as live ─────────────────────────────────────────────────
    const { error: statusErr } = await sb
      .from('matches')
      .update({ status: 'live' })
      .eq('id', match.id);

    if (statusErr) {
      console.error(`[lock-matches] Failed to set M${match.match_number} to live:`, statusErr.message);
    } else {
      console.log(`[lock-matches] M${match.match_number} → live`);
    }
  }

  console.log('[lock-matches] Done:', summary);
  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
