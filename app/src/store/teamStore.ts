/**
 * Team Store — Zustand
 * Central state: players list, selected XI, captain/VC, format, validation.
 *
 * Supabase integration (real schema):
 *   loadTournamentContext() — finds active tournament + upcoming match
 *   loadPlayers()           — queries tournament_players JOIN players
 *   saveXI()                — upserts user_squads, then writes user_match_xi rows
 */

import { create } from 'zustand';
import {
  Player,
  SelectedPlayer,
  MatchFormat,
  PlayerRole,
  CaptaincyRole,
  ValidationResult,
  SelectionRules,
} from '../types';
import { MOCK_PLAYERS } from '../data/mockPlayers';
import { supabase } from '../lib/supabase';

// ─── Rules (defaults; maxOverseas overridden per-tournament from DB) ──────────

const RULES: SelectionRules = {
  total:      11,
  budget:     100,
  role:       { wk: [1, 4], bat: [3, 6], ar: [1, 4], bowl: [3, 6] },
  maxPerTeam: 7,
  maxOverseas: { T20: 4, ODI: 11, TEST: 11 },
};

// ─── Validation ───────────────────────────────────────────────────────────────

function validate(selected: SelectedPlayer[], format: MatchFormat): ValidationResult {
  const errors: string[]   = [];
  const warnings: string[] = [];

  if (selected.length > RULES.total)
    errors.push(`Max ${RULES.total} players allowed`);

  const spent = selected.reduce((s, p) => s + p.credits, 0);
  if (spent > RULES.budget)
    errors.push(`Over budget by ${(spent - RULES.budget).toFixed(1)} credits`);

  for (const role of Object.keys(RULES.role) as PlayerRole[]) {
    const count      = selected.filter(p => p.role === role).length;
    const [min, max] = RULES.role[role];
    if (count > max) errors.push(`Too many ${role.toUpperCase()}s (max ${max})`);
    if (selected.length === RULES.total && count < min)
      errors.push(`Need at least ${min} ${role.toUpperCase()} (have ${count})`);
  }

  const teamCounts: Record<string, number> = {};
  selected.forEach(p => { teamCounts[p.team] = (teamCounts[p.team] ?? 0) + 1; });
  for (const [team, count] of Object.entries(teamCounts)) {
    if (count > RULES.maxPerTeam)
      errors.push(`Max ${RULES.maxPerTeam} players from one team (${team}: ${count})`);
  }

  const maxOS         = RULES.maxOverseas[format];
  const overseasCount = selected.filter(p => p.overseas).length;
  if (overseasCount > maxOS)
    errors.push(`Too many overseas players for ${format} (max ${maxOS})`);

  const hasCap = selected.some(p => p.captaincy === 'captain');
  const hasVC  = selected.some(p => p.captaincy === 'vice_captain');
  if (selected.length === RULES.total) {
    if (!hasCap) warnings.push('No captain set (2× multiplier not applied)');
    if (!hasVC)  warnings.push('No vice-captain set (1.5× multiplier not applied)');
  }

  return { valid: errors.length === 0 && selected.length === RULES.total, errors, warnings };
}

// ─── Derived stats ────────────────────────────────────────────────────────────

function deriveStats(selected: SelectedPlayer[], format: MatchFormat) {
  const creditsSpent = selected.reduce((s, p) => s + p.credits, 0);
  const roleCounts   = { wk: 0, bat: 0, ar: 0, bowl: 0 } as Record<PlayerRole, number>;
  const teamCounts: Record<string, number> = {};

  selected.forEach(p => {
    roleCounts[p.role]  = (roleCounts[p.role]  ?? 0) + 1;
    teamCounts[p.team]  = (teamCounts[p.team]  ?? 0) + 1;
  });

  return {
    creditsSpent,
    creditsLeft: RULES.budget - creditsSpent,
    roleCounts,
    teamCounts,
    validation: validate(selected, format),
  };
}

// ─── Store interface ──────────────────────────────────────────────────────────

interface TeamState {
  // Data
  players:        Player[];
  selected:       SelectedPlayer[];
  format:         MatchFormat;
  playersLoading: boolean;
  saveError:      string | null;

  // Tournament / match context (loaded on sign-in)
  tournamentId:    string | null;
  currentMatchId:  string | null;
  nextMatchTime:   string | null;   // ISO start_time of next match (for countdown)
  isFirstMatch:    boolean;         // true until the first match of the season locks

  // Derived
  creditsSpent: number;
  creditsLeft:  number;
  roleCounts:   Record<PlayerRole, number>;
  teamCounts:   Record<string, number>;
  validation:   ValidationResult;

  // Actions
  loadTournamentContext: () => Promise<void>;
  loadPlayers:   () => Promise<void>;
  setPlayers:    (players: Player[]) => void;
  setFormat:     (format: MatchFormat) => void;
  togglePlayer:  (player: Player) => void;
  setCaptaincy:  (playerId: string, role: CaptaincyRole) => void;
  removePlayer:  (playerId: string) => void;
  resetXI:       () => void;
  loadSavedXI:   (matchId: string, contestId: string) => Promise<string | null>;
  saveXI:        (opts: SaveXIOpts) => Promise<string | null>;
}

interface SaveXIOpts {
  matchId:     string;  // matches.id UUID
  contestId:   string;  // contests.id UUID
  contestType: 'daily' | 'sl' | 'private';
}

// ── Mirror a saved XI into user_teams + user_team_players ─────────────────
// Web's display/scoring reads (db.js getUserTeamForMatch, getAllDailyTeamsForMatch,
// listUserTeams) read user_teams FIRST and only fall back to user_match_xi if no
// complete (11-player) user_teams row exists. Without this mirror, a save made on
// mobile (which only writes user_squads/user_match_xi) is invisible to those reads —
// web keeps showing whatever team was last saved there ("old team"). This mirrors,
// in the opposite direction, the same dual-write web already does for itself
// (saveUserTeam's user_match_xi mirror; the SL lock flow's upsertSlTeam call).
// Best-effort: a failure here must not fail the primary save.
async function mirrorToUserTeams(opts: {
  contestType:   'daily' | 'sl' | 'private';
  squadId:       string;
  matchId:       string;
  userId:        string;
  playerIds:     string[];
  captainId:     string;
  viceCaptainId: string;
  format:        MatchFormat;
}) {
  const { contestType, squadId, matchId, userId, playerIds, captainId, viceCaptainId, format } = opts;
  const isDaily = contestType === 'daily';
  let teamId: string | null = null;

  if (isDaily) {
    // One daily team per (user, match) — squad_id IS NULL distinguishes it from
    // SL rows (see migration_v6's partial unique indexes). Clear any existing
    // row first so re-saves don't collide with that constraint.
    await supabase.from('user_teams').delete()
      .eq('match_id', matchId).eq('user_id', userId).is('squad_id', null);

    const { data: ut, error } = await supabase.from('user_teams').insert({
      name: 'My XI', format,
      captain_id: captainId, vice_captain_id: viceCaptainId,
      match_id: matchId, squad_id: null, user_id: userId,
    }).select('id').single();
    if (error) throw error;
    teamId = ut?.id ?? null;
  } else {
    // One SL team per (squad, match) — update in place if it already exists
    // (mirrors db.js's upsertSlTeam exactly).
    const { data: existing } = await supabase.from('user_teams')
      .select('id').eq('squad_id', squadId).eq('match_id', matchId).limit(1);

    if (existing?.length) {
      teamId = existing[0].id;
      const { error: updErr } = await supabase.from('user_teams')
        .update({ captain_id: captainId, vice_captain_id: viceCaptainId })
        .eq('id', teamId);
      if (updErr) throw updErr;
      const { error: delErr } = await supabase.from('user_team_players')
        .delete().eq('user_team_id', teamId);
      if (delErr) throw delErr;
    } else {
      const { data: ut, error } = await supabase.from('user_teams').insert({
        name: 'SL XI', format,
        captain_id: captainId, vice_captain_id: viceCaptainId,
        match_id: matchId, squad_id: squadId, user_id: userId,
      }).select('id').single();
      if (error) throw error;
      teamId = ut?.id ?? null;
    }
  }

  if (!teamId) return;
  const rows = playerIds.map(pid => ({ user_team_id: teamId as string, player_id: pid }));
  const { error: insErr } = await supabase.from('user_team_players').insert(rows);
  if (insErr) throw insErr;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useTeamStore = create<TeamState>((set, get) => ({
  players:        MOCK_PLAYERS,
  selected:       [],
  format:         'T20',
  playersLoading: false,
  saveError:      null,
  tournamentId:   null,
  currentMatchId: null,
  nextMatchTime:  null,
  isFirstMatch:   true,
  creditsSpent:   0,
  creditsLeft:    RULES.budget,
  roleCounts:     { wk: 0, bat: 0, ar: 0, bowl: 0 },
  teamCounts:     {},
  validation:     { valid: false, errors: [], warnings: [] },

  // ── 1. Load context for the user-selected tournament ─────────────────────
  // Reads selectedTournamentId from tournamentStore (persisted in AsyncStorage)
  // rather than auto-detecting by date — supports multiple simultaneous tournaments.
  loadTournamentContext: async () => {
    try {
      const { useTournamentStore } = require('./tournamentStore');
      const tournamentId: string | null =
        useTournamentStore.getState().selectedTournamentId;

      if (!tournamentId) {
        console.warn('[teamStore] loadTournamentContext: no tournament selected');
        return;
      }

      // Load tournament config: format + overseas cap
      const { data: tData } = await supabase
        .from('tournaments')
        .select('format, max_overseas_in_xi')
        .eq('id', tournamentId)
        .single();

      if (tData) {
        const fmt = (tData.format ?? 'T20') as MatchFormat;
        // Apply tournament-specific overseas cap (overrides the static default)
        const cap = tData.max_overseas_in_xi;
        if (typeof cap === 'number') {
          RULES.maxOverseas[fmt] = cap;
        }
      }

      // Next upcoming/live match (not completed)
      const { data: matches } = await supabase
        .from('matches')
        .select('id, start_time, match_number')
        .eq('tournament_id', tournamentId)
        .neq('status', 'completed')
        .order('match_number', { ascending: true })
        .limit(1);

      const nextMatch = matches?.[0] ?? null;
      const currentMatchId: string | null = nextMatch?.id ?? null;
      const nextMatchTime:  string | null = nextMatch?.start_time ?? null;

      // Determine if any match has already locked (first match played = not isFirstMatch)
      const { count } = await supabase
        .from('matches')
        .select('id', { count: 'exact', head: true })
        .eq('tournament_id', tournamentId)
        .in('status', ['live', 'in_progress', 'completed']);

      const isFirstMatch = (count ?? 0) === 0;

      // Clear the selected XI when switching to a different tournament so
      // the previous tournament's picks don't bleed into the new context.
      const prevTournamentId = get().tournamentId;
      const tournamentChanged = prevTournamentId !== null && prevTournamentId !== tournamentId;

      set({
        tournamentId,
        currentMatchId,
        nextMatchTime,
        isFirstMatch,
        // Clear the picked XI when switching tournaments so the previous
        // tournament's selection doesn't bleed into the new context.
        ...(tournamentChanged ? {
          selected:    [],
          validation:  { valid: false, errors: [], warnings: [] },
          creditsSpent: 0,
          creditsLeft:  RULES.budget,
          roleCounts:   { wk: 0, bat: 0, ar: 0, bowl: 0 },
          teamCounts:   {},
        } : {}),
      });

      // Auto-load players for this tournament
      get().loadPlayers();
    } catch (err) {
      console.warn('[teamStore] loadTournamentContext failed:', err);
    }
  },

  // ── 2. Load players via tournament_players JOIN players ───────────────────
  loadPlayers: async () => {
    set({ playersLoading: true });
    try {
      const { tournamentId } = get();
      if (!tournamentId) {
        console.warn('[teamStore] loadPlayers: tournamentId not set, using mock');
        return;
      }

      const { data, error } = await supabase
        .from('tournament_players')
        .select(`
          player_id,
          team_id,
          credit_value,
          is_active,
          players!inner (
            id,
            name,
            role,
            is_overseas
          ),
          teams (
            id,
            color
          )
        `)
        .eq('tournament_id', tournamentId)
        .eq('is_active', true)
        .order('credit_value', { ascending: false });

      if (error) throw error;

      if (data && data.length > 0) {
        const players: Player[] = data.map((tp: any) => ({
          id:        tp.players.id,
          name:      tp.players.name,
          team:      tp.team_id,             // teams.id is the text short-code (e.g. 'CSK')
          role:      tp.players.role as PlayerRole,
          credits:   Number(tp.credit_value),
          overseas:  Boolean(tp.players.is_overseas),
          teamColor: tp.teams?.color ?? null,
        }));
        set({ players });
      }
      // If empty, keep MOCK_PLAYERS as fallback
    } catch (err) {
      console.warn('[teamStore] loadPlayers failed, using mock data:', err);
    } finally {
      set({ playersLoading: false });
    }
  },

  setPlayers: (players) => set({ players }),

  setFormat: (format) => {
    const { selected } = get();
    set({ format, ...deriveStats(selected, format) });
  },

  togglePlayer: (player) => {
    const { selected, format } = get();
    const alreadyIn = selected.some(p => p.id === player.id);

    if (alreadyIn) {
      const next = selected.filter(p => p.id !== player.id);
      set({ selected: next, ...deriveStats(next, format) });
      return;
    }

    if (selected.length >= RULES.total) return;

    const next: SelectedPlayer[] = [...selected, { ...player, captaincy: 'normal' }];
    set({ selected: next, ...deriveStats(next, format) });
  },

  setCaptaincy: (playerId, role) => {
    const { selected, format } = get();
    const next = selected.map(p => {
      if (p.captaincy === role && p.id !== playerId) return { ...p, captaincy: 'normal' as CaptaincyRole };
      if (p.id === playerId) return { ...p, captaincy: p.captaincy === role ? 'normal' as CaptaincyRole : role };
      return p;
    });
    set({ selected: next, ...deriveStats(next, format) });
  },

  removePlayer: (playerId) => {
    const { selected, format } = get();
    const next = selected.filter(p => p.id !== playerId);
    set({ selected: next, ...deriveStats(next, format) });
  },

  resetXI: () => {
    const { format } = get();
    set({ selected: [], ...deriveStats([], format) });
  },

  // ── 3. Load last saved XI (user_match_xi primary, user_teams fallback) ────────
  //  user_match_xi  = mobile saves + web-mirrored saves (v116+)
  //  user_teams     = web daily saves made before the mirror was added
  loadSavedXI: async (matchId, contestId) => {
    const { players, format } = get();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return 'Not signed in';

    try {
      // ── Path A: user_match_xi (mobile / web-mirrored) ──────────────────────
      const { data: squad } = await supabase
        .from('user_squads')
        .select('id')
        .eq('contest_id', contestId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (squad?.id) {
        const { data: xiRows, error: xiErr } = await supabase
          .from('user_match_xi')
          .select('player_id, is_captain, is_vc, role')
          .eq('squad_id', squad.id)
          .eq('match_id', matchId);

        if (xiErr) throw xiErr;

        if (xiRows && xiRows.length > 0) {
          const restored: SelectedPlayer[] = xiRows
            .map((row: any) => {
              const player = players.find(p => p.id === row.player_id);
              if (!player) return null;
              const captaincy: CaptaincyRole =
                row.is_captain ? 'captain' : row.is_vc ? 'vice_captain' : 'normal';
              return { ...player, captaincy };
            })
            .filter(Boolean) as SelectedPlayer[];

          if (restored.length > 0) {
            set({ selected: restored, ...deriveStats(restored, format) });
            console.log(`[teamStore] loadSavedXI: restored ${restored.length} players from user_match_xi`);
            return null; // success
          }
        }
      }

      // ── Path B: user_teams fallback (web daily saves pre-mirror) ───────────
      const { data: teamRows, error: teamErr } = await supabase
        .from('user_teams')
        .select('id, captain_id, vice_captain_id, user_team_players(player_id)')
        .eq('match_id', matchId)
        .eq('user_id', user.id)
        .is('squad_id', null)
        .order('created_at', { ascending: false })
        .limit(1);

      if (teamErr) throw teamErr;

      const team = (teamRows ?? [])[0];
      if (team) {
        const playerIds: string[] = (team.user_team_players ?? []).map((r: any) => r.player_id);
        const restored: SelectedPlayer[] = playerIds
          .map(pid => {
            const player = players.find(p => p.id === pid);
            if (!player) return null;
            const captaincy: CaptaincyRole =
              pid === team.captain_id ? 'captain'
              : pid === team.vice_captain_id ? 'vice_captain'
              : 'normal';
            return { ...player, captaincy };
          })
          .filter(Boolean) as SelectedPlayer[];

        if (restored.length > 0) {
          set({ selected: restored, ...deriveStats(restored, format) });
          console.log(`[teamStore] loadSavedXI: restored ${restored.length} players from user_teams (web fallback)`);
          return null; // success
        }
      }

      return 'No saved XI found for this match';
    } catch (err: any) {
      console.error('[teamStore] loadSavedXI error:', err);
      return err?.message ?? 'Failed to load saved XI';
    }
  },

  // ── 4. Save XI → user_squads + user_match_xi (one row per player) ─────────
  saveXI: async ({ matchId, contestId, contestType }) => {
    const { selected } = get();
    set({ saveError: null });

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return 'Not signed in';

    try {
      // 3a. Get or create the user's squad for this contest
      let squadId: string | null = null;

      const { data: existing } = await supabase
        .from('user_squads')
        .select('id')
        .eq('contest_id', contestId)
        .eq('user_id',    user.id)
        .maybeSingle();

      if (existing?.id) {
        squadId = existing.id;
      } else {
        const { data: newSquad, error: insertErr } = await supabase
          .from('user_squads')
          .insert({
            contest_id:              contestId,
            user_id:                 user.id,
            name:                    'My Squad',
            budget_remaining:        RULES.budget,
            free_transfers_available: 1,
          })
          .select('id')
          .single();

        if (insertErr) throw insertErr;
        squadId = newSquad?.id ?? null;
      }

      if (!squadId) return 'Could not create squad';

      // 3b. Delete this match's existing XI rows then re-insert
      const { error: delErr } = await supabase
        .from('user_match_xi')
        .delete()
        .eq('squad_id', squadId)
        .eq('match_id', matchId);

      if (delErr) throw delErr;

      // 3c. Insert one row per selected player
      const rows = selected.map(p => ({
        squad_id:   squadId as string,
        match_id:   matchId,
        player_id:  p.id,
        is_captain: p.captaincy === 'captain',
        is_vc:      p.captaincy === 'vice_captain',
        role:       p.role,
        user_id:    user.id,
      }));

      const { error: insertErr } = await supabase
        .from('user_match_xi')
        .insert(rows);

      if (insertErr) throw insertErr;

      // 3d. Mirror into user_teams + user_team_players. Web's "my team" reads
      // (db.js getUserTeamForMatch/getAllDailyTeamsForMatch/listUserTeams) check
      // user_teams FIRST and only fall back to user_match_xi if no complete row
      // exists there — without this, a mobile-only save is invisible to web and
      // it keeps showing the last team saved there. Best-effort: a failure here
      // must not fail the save the user actually asked for.
      const captainId     = selected.find(p => p.captaincy === 'captain')?.id;
      const viceCaptainId = selected.find(p => p.captaincy === 'vice_captain')?.id;

      if (selected.length === 11 && captainId && viceCaptainId) {
        try {
          await mirrorToUserTeams({
            contestType, squadId, matchId, userId: user.id,
            playerIds: selected.map(p => p.id),
            captainId, viceCaptainId,
            format: get().format,
          });
        } catch (mirrorErr) {
          console.warn('[teamStore] user_teams mirror failed (non-fatal, web may show a stale team):', mirrorErr);
        }
      } else {
        console.warn('[teamStore] saveXI: skipped user_teams mirror (XI incomplete or missing C/VC)');
      }

      return null; // success
    } catch (err: any) {
      const msg = err?.message ?? 'Save failed';
      console.error('[teamStore] saveXI error:', err);
      set({ saveError: msg });
      return msg;
    }
  },
}));

export { RULES };
