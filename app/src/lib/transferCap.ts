/**
 * Season-long transfer cap — enforcement + logging.
 *
 * Ports the transfer-counting core of db.js's saveMatchXI/lockMatchXI
 * (web) into mobile, adapted to mobile's existing "save IS the lock"
 * model — there's no separate squad_draft_xi table or time-based
 * auto-lock cron on mobile, so this is invoked directly from
 * teamStore.saveXI for sl/private contests, right before the XI is
 * written, instead of from a background lock job.
 *
 * One deliberate improvement over web's ordering: the cap check here
 * runs BEFORE any row is written, so a failed check leaves zero DB
 * writes behind. Web's lockMatchXI (only ever invoked from its
 * unattended auto-lock cron, swallowed by a try/catch) writes
 * user_match_xi first and only checks/throws afterward — harmless
 * there since nothing else observes the throw, but the wrong order to
 * copy for a path a user's Save button calls directly.
 *
 * Free Hit revert: rather than web's draft-snapshot-at-lock-time
 * approach (which snapshots the free-hit team itself, not the
 * pre-free-hit baseline — see getPreviousMatchXI below), this snapshots
 * the squad's pre-free-hit baseline (the team they'd have carried
 * forward had they not used the booster) onto the activation row at the
 * moment Free Hit is committed (see boosterStore.commitPending). Future
 * lookups of "previous XI" then prefer that snapshot over the literal
 * free-hit match's locked XI, so the free-hit pick never leaks forward
 * as the squad's new permanent baseline.
 */

import { supabase } from './supabase';

export interface MatchLite {
  id: string;
  match_number: number | null;
  status?: string | null;
}

export interface ContestTransferConfig {
  start_match_number:         number | null;
  playoff_start_match_number: number | null;
  total_transfers_allowed:    number | null;
  playoff_transfers_allowed:  number | null;
  free_transfers_per_match:   number | null;
  extra_transfer_point_cost:  number | null;
}

export interface PreviousXI {
  playerIds: string[];
  captainId: string | null;
  vcId:      string | null;
  matchId?:  string;
}

export type SeasonPhase = 'pre_season' | 'regular' | 'playoff';

// ─── Contest + match fetch helpers ─────────────────────────────────────────

/**
 * Fetch the season's transfer-rule config plus the contest's tournament_id
 * (needed to pull the full match list for phase/baseline detection).
 */
export async function fetchContestTransferConfig(
  contestId: string,
): Promise<{ config: ContestTransferConfig; tournamentId: string | null }> {
  const { data, error } = await supabase
    .from('contests')
    .select('tournament_id, start_match_number, playoff_start_match_number, total_transfers_allowed, playoff_transfers_allowed, free_transfers_per_match, extra_transfer_point_cost')
    .eq('id', contestId)
    .single();
  if (error) throw error;

  return {
    tournamentId: data?.tournament_id ?? null,
    config: {
      start_match_number:         data?.start_match_number         ?? null,
      playoff_start_match_number: data?.playoff_start_match_number ?? null,
      total_transfers_allowed:    data?.total_transfers_allowed    ?? null,
      playoff_transfers_allowed:  data?.playoff_transfers_allowed  ?? null,
      free_transfers_per_match:   data?.free_transfers_per_match   ?? null,
      extra_transfer_point_cost:  data?.extra_transfer_point_cost  ?? null,
    },
  };
}

/** All matches for a tournament (any status — needed for phase windows and baseline lookups). */
export async function fetchTournamentMatches(tournamentId: string): Promise<MatchLite[]> {
  const { data, error } = await supabase
    .from('matches')
    .select('id, match_number, status')
    .eq('tournament_id', tournamentId);
  if (error) throw error;
  return data ?? [];
}

// ─── Free Hit snapshot ──────────────────────────────────────────────────────

/** Pre-free-hit baseline stored on a squad's free_hit activation for a match, if any. */
export async function getFreeHitSnapshotForMatch(
  squadId: string,
  matchId: string,
): Promise<PreviousXI | null> {
  const { data, error } = await supabase
    .from('user_booster_activations')
    .select('snapshot')
    .eq('squad_id', squadId)
    .eq('match_id', matchId)
    .eq('booster', 'free_hit')
    .maybeSingle();
  if (error) throw error;
  const snap = data?.snapshot as { playerIds?: string[]; captainId?: string | null; vcId?: string | null } | null;
  if (!snap?.playerIds?.length) return null;
  return { playerIds: snap.playerIds, captainId: snap.captainId ?? null, vcId: snap.vcId ?? null };
}

// ─── Previous-match baseline (mirrors db.js getPreviousMatchXI) ────────────

/**
 * The squad's most recent locked XI before currentMatchId, within the
 * season window (>= startMatchNumber if configured).
 *
 * If that previous match had Free Hit active, returns its stored
 * pre-free-hit snapshot instead of the literal (temporary) free-hit team —
 * this is what makes Free Hit's effect not carry forward permanently.
 */
export async function getPreviousMatchXI(
  squadId: string,
  currentMatchId: string,
  allMatches: MatchLite[],
  startMatchNumber: number | null = null,
): Promise<PreviousXI> {
  const current = allMatches.find(m => m.id === currentMatchId);
  if (!current) return { playerIds: [], captainId: null, vcId: null };

  const prevMatchIds = allMatches
    .filter(m => {
      const num = m.match_number ?? 0;
      if (num >= (current.match_number ?? Infinity)) return false;
      if (startMatchNumber !== null && num < startMatchNumber) return false;
      return true;
    })
    .map(m => m.id);
  if (!prevMatchIds.length) return { playerIds: [], captainId: null, vcId: null };

  const { data: prevXI, error } = await supabase
    .from('user_match_xi')
    .select('player_id, is_captain, is_vc, match_id')
    .eq('squad_id', squadId)
    .in('match_id', prevMatchIds);
  if (error) throw error;
  if (!prevXI?.length) return { playerIds: [], captainId: null, vcId: null };

  const matchNumOf = (id: string) => allMatches.find(m => m.id === id)?.match_number ?? 0;
  const seenMatchIds = [...new Set(prevXI.map(r => r.match_id as string))];
  const latestMatchId = seenMatchIds.reduce<string | null>(
    (best, id) => (!best || matchNumOf(id) > matchNumOf(best) ? id : best),
    null,
  );
  if (!latestMatchId) return { playerIds: [], captainId: null, vcId: null };

  // Free Hit revert: if the latest locked match had Free Hit active, its
  // snapshot (the pre-free-hit baseline) supersedes its literal locked XI.
  try {
    const snapshot = await getFreeHitSnapshotForMatch(squadId, latestMatchId);
    if (snapshot) return { ...snapshot, matchId: latestMatchId };
  } catch (e) {
    console.warn('[transferCap] free_hit snapshot lookup failed (non-fatal):', e);
  }

  const xi = prevXI.filter(r => r.match_id === latestMatchId);
  return {
    playerIds: xi.map(r => r.player_id as string),
    captainId: xi.find(r => r.is_captain)?.player_id ?? null,
    vcId:      xi.find(r => r.is_vc)?.player_id      ?? null,
    matchId:   latestMatchId,
  };
}

/**
 * Mirrors lockMatchXI's isFirstActiveLock detection: true if this squad has
 * no real transfer baseline — either it never locked anything before, or the
 * only prior lock on record was a retroactive one for an already-completed
 * match the squad never actually picked. False (real baseline) if any
 * earlier match has a recorded user_match_xi row for this squad.
 */
export async function computeIsFirstActiveLock(
  squadId: string,
  prev: PreviousXI,
  allMatches: MatchLite[],
): Promise<boolean> {
  if (!prev.playerIds.length) return true;

  const prevMatchStatus = prev.matchId
    ? (allMatches.find(m => m.id === prev.matchId)?.status ?? null)
    : null;
  if (prevMatchStatus !== 'completed') return false;

  const prevMatchNum = allMatches.find(m => m.id === prev.matchId)?.match_number ?? 0;
  const earlierMatchIds = allMatches
    .filter(m => (m.match_number ?? 0) < prevMatchNum)
    .map(m => m.id);
  if (!earlierMatchIds.length) return true; // prev is the earliest possible match

  const { count } = await supabase
    .from('user_match_xi')
    .select('id', { count: 'exact', head: true })
    .eq('squad_id', squadId)
    .in('match_id', earlierMatchIds);
  return !((count ?? 0) > 0);
}

// ─── Phase detection (mirrors db.js saveMatchXI) ───────────────────────────

function detectPhase(
  saveMatchNum: number | null,
  startMatchNumber: number | null,
  playoffStartMN: number | null,
): SeasonPhase {
  if (startMatchNumber === null || saveMatchNum === null || saveMatchNum < startMatchNumber) return 'pre_season';
  if (playoffStartMN !== null && saveMatchNum >= playoffStartMN) return 'playoff';
  return 'regular';
}

function phaseMatchIdSet(
  phase: SeasonPhase,
  allMatches: MatchLite[],
  startMatchNumber: number | null,
  playoffStartMN: number | null,
): Set<string> | null {
  if (phase === 'pre_season' || !allMatches.length) return null;
  if (phase === 'playoff') {
    return new Set(allMatches.filter(m => (m.match_number ?? 0) >= (playoffStartMN ?? 0)).map(m => m.id));
  }
  // regular: (startMatchNumber, playoffStartMN − 1] — strictly greater than the opener
  return new Set(
    allMatches
      .filter(m => {
        const mn = m.match_number ?? 0;
        return mn > (startMatchNumber ?? 0) && (playoffStartMN === null || mn < playoffStartMN);
      })
      .map(m => m.id),
  );
}

// ─── Transfer usage for display (mirrors the tail of checkAndLogTransfers) ─────

/**
 * "Transfers used / cap" for the info-strip pill on MyXIScreen. Counts actual
 * PLAYER SWAPS logged in `user_transfers` (phase-scoped), exactly like the
 * seasonXferCount tally at the end of checkAndLogTransfers — NOT rows in
 * user_match_xi, which has 11 rows per match (one per XI player) and so wildly
 * overcounts if used as a transfer tally.
 */
export async function getTransferUsage(
  squadId: string,
  currentMatchId: string,
  config: ContestTransferConfig,
  allMatches: MatchLite[],
): Promise<{ used: number; cap: number | null; phase: SeasonPhase }> {
  const startMatchNumber = config.start_match_number         ?? null;
  const playoffStartMN   = config.playoff_start_match_number ?? null;

  const saveMatchNum = allMatches.find(m => m.id === currentMatchId)?.match_number ?? null;
  const phase = detectPhase(saveMatchNum, startMatchNumber, playoffStartMN);
  const activeCap = phase === 'playoff'
    ? (config.playoff_transfers_allowed ?? null)
    : phase === 'regular'
      ? (config.total_transfers_allowed ?? null)
      : null;
  const phaseIds = phaseMatchIdSet(phase, allMatches, startMatchNumber, playoffStartMN);

  let countQuery = supabase
    .from('user_transfers')
    .select('id', { count: 'exact', head: true })
    .eq('squad_id', squadId);
  if (phaseIds) {
    const ids = [...phaseIds];
    countQuery = countQuery.in('match_id', ids.length ? ids : ['__none__']);
  }
  const { count } = await countQuery;

  return { used: count ?? 0, cap: activeCap, phase };
}

// ─── Cap check + transfer logging (mirrors db.js saveMatchXI's transfer block) ──

export interface CheckAndLogTransfersOpts {
  squadId:            string;
  matchId:            string;
  playerIds:          string[];   // the 11 about to be saved
  previousPlayerIds:  string[];   // baseline XI ([] = no real baseline yet)
  config:             ContestTransferConfig;
  allMatches:         MatchLite[];
  /** Wildcard or Free Hit active for this match — skips cap check + logging entirely. */
  bypassTransfers:    boolean;
}

export interface TransferResult {
  transfersMade:    number;
  seasonXferCount:  number;
  seasonCap:        number | null;
  phase:            SeasonPhase;
}

/**
 * Throws with a user-facing message if this save would exceed the active
 * phase's transfer budget. On success, logs the transfer (if any) to
 * user_transfers — the same table web's season view and getSquadSeason read,
 * so the transfer log stays consistent across platforms.
 *
 * Caller is responsible for actually writing user_match_xi — call this
 * BEFORE that write so a thrown cap error leaves no partial state behind.
 */
export async function checkAndLogTransfers(opts: CheckAndLogTransfersOpts): Promise<TransferResult> {
  const { squadId, matchId, playerIds, previousPlayerIds, config, allMatches, bypassTransfers } = opts;

  const startMatchNumber = config.start_match_number         ?? null;
  const playoffStartMN   = config.playoff_start_match_number ?? null;
  const seasonCap        = config.total_transfers_allowed    ?? null;
  const playoffCap       = config.playoff_transfers_allowed  ?? null;

  const saveMatchNum = allMatches.find(m => m.id === matchId)?.match_number ?? null;
  const phase = detectPhase(saveMatchNum, startMatchNumber, playoffStartMN);
  const activeCap = phase === 'playoff' ? playoffCap : phase === 'regular' ? seasonCap : null;
  const phaseIds  = phaseMatchIdSet(phase, allMatches, startMatchNumber, playoffStartMN);

  let transfersMade = 0;

  // Clear this match's prior transfer log unconditionally, before the
  // bypass check below — a save always represents the current, complete
  // diff state. Previously this delete only ran inside the
  // !bypassTransfers branch, so activating Wildcard/Free Hit *after* an
  // earlier normal save left that save's rows sitting in user_transfers
  // indefinitely (until a future non-boosted save, or the match locking)
  // — inflating the "N pending"/"N free" badge and the season cap's
  // "used" count even though the booster makes those rows moot. This is
  // exactly what made "Revert to Locked" disappear after applying Free
  // Hit on a squad that already had a real (non-boosted) transfer saved.
  await supabase.from('user_transfers').delete().eq('squad_id', squadId).eq('match_id', matchId);

  if (!bypassTransfers && previousPlayerIds.length > 0) {
    const prevSet = new Set(previousPlayerIds);
    const currSet = new Set(playerIds);
    const playersOut = previousPlayerIds.filter(id => !currSet.has(id));
    const playersIn  = playerIds.filter(id => !prevSet.has(id));
    transfersMade = Math.min(playersOut.length, playersIn.length);

    if (transfersMade > 0) {
      if (activeCap !== null) {
        let usedQuery = supabase
          .from('user_transfers')
          .select('id', { count: 'exact', head: true })
          .eq('squad_id', squadId)
          .neq('match_id', matchId);
        if (phaseIds) {
          const ids = [...phaseIds].filter(id => id !== matchId);
          usedQuery = usedQuery.in('match_id', ids.length ? ids : ['__none__']);
        }
        const { count: usedElsewhere } = await usedQuery;
        const used      = usedElsewhere ?? 0;
        const remaining = activeCap - used;
        const phaseLabel = phase === 'playoff' ? 'Playoff transfer' : 'Season transfer';
        if (remaining <= 0) {
          throw new Error(`${phaseLabel} budget exhausted (${activeCap} total).`);
        }
        if (transfersMade > remaining) {
          throw new Error(
            `Only ${remaining} ${phaseLabel.toLowerCase()}${remaining !== 1 ? 's' : ''} left ` +
            `(budget: ${activeCap}). Reduce changes to ${remaining} or fewer.`,
          );
        }
      }

      const freePerMatch = config.free_transfers_per_match ?? null;
      const extraCost    = Number(config.extra_transfer_point_cost ?? 4);

      const xferRows = playersOut.slice(0, transfersMade).map((outId, i) => {
        const isFree = freePerMatch === null || i < freePerMatch;
        return {
          squad_id:        squadId,
          match_id:        matchId,
          player_out_id:   outId,
          player_in_id:    playersIn[i],
          is_free:         isFree,
          points_deducted: isFree ? 0 : extraCost,
        };
      });

      const { error: xe } = await supabase.from('user_transfers').insert(xferRows);
      if (xe) console.warn('[transferCap] transfer log insert failed (non-fatal):', xe.message);
    }
  }

  let seasonXferCount = 0;
  {
    let countQuery = supabase
      .from('user_transfers')
      .select('id', { count: 'exact', head: true })
      .eq('squad_id', squadId);
    if (phaseIds) {
      const ids = [...phaseIds];
      countQuery = countQuery.in('match_id', ids.length ? ids : ['__none__']);
    }
    const { count } = await countQuery;
    seasonXferCount = count ?? 0;
  }

  return { transfersMade, seasonXferCount, seasonCap: activeCap, phase };
}
