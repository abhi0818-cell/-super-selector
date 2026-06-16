// lock-matches — Supabase Edge Function
//
// Locks every SL squad's draft XI for any match whose lock gate has passed
// and whose status is still 'scheduled' or 'delayed'.
// Gate = lock_time if set, otherwise start_time.
// After locking all squads it updates the match status to 'live'.
//
// Deploy:
//   supabase functions deploy lock-matches --no-verify-jwt
//
// Then call it every minute from cron-job.org (free tier):
//   POST https://<project>.supabase.co/functions/v1/lock-matches
//   Header: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
//
// The function is idempotent — squads already locked for a match are skipped.

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
}

interface Squad {
  id: string;
  user_id: string;
}

interface Draft {
  player_ids: string[];
  captain_id: string | null;
  vc_id: string | null;
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
    errors           : [] as string[],
  };

  // ── 1. Find matches that need locking ──────────────────────────────────────
  // Covers two cases:
  //   a) Normal:  status = 'scheduled' and start_time <= now
  //   b) Delayed: status = 'delayed'   and lock_time  <= now (admin set a lock time)
  const { data: scheduled, error: mErr } = await sb
    .from('matches')
    .select('id, tournament_id, match_number, start_time, lock_time, status')
    .eq('status', 'scheduled')
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

    // Contests for this tournament
    const { data: contests } = await sb
      .from('contests')
      .select('id, contest_type, total_transfers_allowed, free_transfers_per_match, extra_transfer_point_cost, start_match_number, playoff_start_match_number, playoff_transfers_allowed')
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
          .select('player_ids, captain_id, vc_id')
          .eq('squad_id', squad.id)
          .maybeSingle() as { data: Draft | null };

        if (!draft?.player_ids?.length || draft.player_ids.length !== 11) {
          summary.errors.push(
            `Squad ${squad.id} M${match.match_number}: no valid draft (${draft?.player_ids?.length ?? 0} players) — skipped`
          );
          summary.squadsSkipped++;
          continue;
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

        // Free Hit: snapshot the draft now before locking (same as slLockForMatch does)
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
              snapshot  : { playerIds: draft.player_ids, captainId: draft.captain_id, vcId: draft.vc_id },
            });
          } catch (e: any) {
            console.warn(`[lock-matches] free_hit snapshot failed for squad ${squad.id}:`, e.message);
          }
        }

        // ── Find previous locked XI (transfer baseline) ──────────────────────
        const { data: prevXIRows } = await sb
          .from('user_match_xi')
          .select('player_id, match_id')
          .eq('squad_id', squad.id);

        let prevPlayerIds: string[] = [];
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
            prevPlayerIds  = prevXIRows
              .filter((r: any) => r.match_id === lastPrev.id)
              .map((r: any) => r.player_id);
          }
        }

        // If the previous locked match is already completed treat as no baseline
        // (user joined mid-season — first lock should not charge transfers)
        const prevMatchId     = prevXIRows?.find((r: any) => prevPlayerIds.includes(r.player_id))?.match_id;
        const prevMatchStatus = tournamentMatches.find(m => m.id === prevMatchId)?.status ?? null;
        const baselineIds     = prevMatchStatus === 'completed' ? [] : prevPlayerIds;

        // ── Lock: write user_match_xi ────────────────────────────────────────
        try {
          await sb.from('user_match_xi')
            .delete()
            .eq('squad_id', squad.id)
            .eq('match_id', match.id);

          const xiRows = draft.player_ids.map(pid => ({
            squad_id  : squad.id,
            match_id  : match.id,
            player_id : pid,
            is_captain: pid === draft.captain_id,
            is_vc     : pid === draft.vc_id,
            role      : 'bat',
          }));
          const { error: ie } = await sb.from('user_match_xi').insert(xiRows);
          if (ie) throw ie;

          // ── Transfer counting ──────────────────────────────────────────────
          if (!bypassTransfers && baselineIds.length > 0) {
            const prevSet = new Set(baselineIds);
            const currSet = new Set(draft.player_ids);
            const playersOut     = baselineIds.filter(id => !currSet.has(id));
            const playersIn      = draft.player_ids.filter(id => !prevSet.has(id));
            const transfersMade  = Math.min(playersOut.length, playersIn.length);

            if (transfersMade > 0) {
              const phase        = detectPhase(match.match_number, contest.start_match_number, contest.playoff_start_match_number);
              const freePerMatch = contest.free_transfers_per_match ?? null;
              const extraCost    = Number(contest.extra_transfer_point_cost ?? 4);

              await sb.from('user_transfers')
                .delete()
                .eq('squad_id', squad.id)
                .eq('match_id', match.id);

              const xferRows = playersOut.slice(0, transfersMade).map((outId, i) => {
                const isFree = freePerMatch === null || i < freePerMatch;
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
              captain_id      : draft.captain_id,
              vice_captain_id : draft.vc_id,
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
                captain_id      : draft.captain_id,
                vice_captain_id : draft.vc_id,
              })
              .select('id')
              .single();
            if (te) throw te;
            teamId = newTeam.id;
          }

          const playerRows = draft.player_ids.map(pid => ({
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

              const ssRows = draft.player_ids.map(pid => ({
                squad_id  : ss.id,
                match_id  : match.id,
                player_id : pid,
                is_captain: pid === draft.captain_id,
                is_vc     : pid === draft.vc_id,
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
