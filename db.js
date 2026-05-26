/**
 * Super Selector — Supabase repository layer
 * ───────────────────────────────────────────
 * Thin wrapper around supabase-js. Single-user prototype — all rows are
 * implicitly owned by "you". To go multi-user later, add row-level security
 * policies and pass user_id through.
 *
 * Usage:
 *   import { createDb } from './db.js';
 *   const db = createDb({ url: '…', anonKey: '…' });
 *   const players = await db.getPlayers();
 *
 * Falls back gracefully: if url/anonKey are blank, every method throws a
 * NotConfiguredError so the UI can route around it (using in-memory mocks).
 */

export class NotConfiguredError extends Error {
  constructor() { super('Supabase not configured. Provide url + anonKey.'); this.name = 'NotConfiguredError'; }
}
export class SupabaseSdkMissingError extends Error {
  constructor() { super('Supabase SDK not loaded. Add the <script> tag to your page.'); this.name = 'SupabaseSdkMissingError'; }
}

/**
 * @param {{url?: string, anonKey?: string, client?: object}} cfg
 *   Pass a custom `client` (e.g. a stub for tests) to skip CDN loading.
 *
 * Requires `window.supabase` to be present (loaded via a <script> tag from
 * https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2 or similar) UNLESS you
 * pass a `client` directly.
 */
export function createDb(cfg = {}) {
  const { url, anonKey } = cfg;
  let client = cfg.client ?? null;
  const configured = !!(client || (url && anonKey));

  async function getClient() {
    if (!configured) throw new NotConfiguredError();
    if (client) return client;
    const sb = (typeof window !== 'undefined' ? window.supabase : null);
    if (!sb || typeof sb.createClient !== 'function') throw new SupabaseSdkMissingError();
    client = sb.createClient(url, anonKey, {
      auth: {
        persistSession: true,
        detectSessionInUrl: true,
        flowType: 'implicit',   // no PKCE code-exchange fetch — token arrives in URL hash
      }
    });
    return client;
  }

  return {
    isConfigured() { return configured; },

    // ─── Auth ─────────────────────────────────────────────────────────────

    /**
     * Send a magic link to the given email address.
     * Supabase emails a one-time login link; clicking it returns the user
     * to the app and triggers onAuthStateChange with a valid session.
     * @param {string} email
     */
    async signInWithMagicLink(email) {
      const sb = await getClient();
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.href.split('?')[0] },
      });
      if (error) throw error;
    },

    /** Sign out the current user. */
    async signOut() {
      const sb = await getClient();
      const { error } = await sb.auth.signOut();
      if (error) throw error;
    },

    /** Returns the current user object (or null if not signed in). */
    async getUser() {
      const sb = await getClient();
      const { data: { user } } = await sb.auth.getUser();
      return user ?? null;
    },

    /**
     * Subscribe to auth state changes.
     * @param {(event: string, session: object|null) => void} cb
     * @returns {{ unsubscribe: () => void }}
     */
    async onAuthStateChange(cb) {
      const sb = await getClient();
      const { data: { subscription } } = sb.auth.onAuthStateChange(cb);
      return subscription;
    },

    // ─── Teams ────────────────────────────────────────────────────────────
    async getTeams() {
      const sb = await getClient();
      const { data, error } = await sb.from('teams').select('*').order('id');
      if (error) throw error;
      return data;
    },

    // ─── Team admin (CRUD) ────────────────────────────────────────────────

    /** Insert a new team. */
    async addTeam(input) {
      if (!input.id || !input.name) throw new Error('addTeam: id and name required');
      const sb = await getClient();
      const { data, error } = await sb.from('teams').insert({
        id: input.id.toUpperCase(),
        name: input.name,
        color: input.color ?? null,
      }).select().single();
      if (error) throw error;
      return data;
    },

    async updateTeam(id, patch) {
      const sb = await getClient();
      const row = {};
      if (patch.name  !== undefined) row.name  = patch.name;
      if (patch.color !== undefined) row.color = patch.color;
      const { data, error } = await sb.from('teams').update(row).eq('id', id).select().single();
      if (error) throw error;
      return data;
    },

    /** Delete a team. Fails if any player references it. */
    async deleteTeam(id) {
      const sb = await getClient();
      const { error } = await sb.from('teams').delete().eq('id', id);
      if (error) {
        if (error.code === '23503' || /violat/i.test(error.message)) {
          throw new Error('Cannot delete: a player belongs to this team. Reassign or delete those players first.');
        }
        throw error;
      }
    },

    // ─── Players ──────────────────────────────────────────────────────────

    /**
     * Returns the player pool for a specific tournament, using tournament-specific
     * team assignments and credit values from tournament_players.
     * Falls back to the global players table if tournament_players has no entries yet.
     * Return shape is identical to getPlayers() so the UI doesn't need to branch.
     */
    async getPlayersForTournament(tournamentId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('tournament_players')
        .select('team_id, credit_value, is_active, players(id, name, role, is_overseas)')
        .eq('tournament_id', tournamentId)
        .order('player_id');
      if (error) throw error;
      if (!data.length) return [];   // caller should fall back to getPlayers()
      return data.map(tp => ({
        id      : tp.players.id,
        name    : tp.players.name,
        team    : tp.team_id,                  // tournament-specific team
        role    : tp.players.role,
        credits : Number(tp.credit_value),     // tournament-specific credits
        overseas: !!tp.players.is_overseas,
        active  : !!tp.is_active,
      }));
    },

    /**
     * Clones the player pool (team assignments + credits) from one tournament to another.
     * Typically called right after creating a new tournament so the auction starting
     * point is pre-populated. Does not overwrite entries that already exist in the target.
     *
     * @param {string} fromTournamentId  Source tournament UUID
     * @param {string} toTournamentId    Target tournament UUID
     * @returns {Promise<number>}        Number of rows inserted
     */
    async clonePlayersToTournament(fromTournamentId, toTournamentId) {
      const sb = await getClient();
      // Fetch source rows
      const { data: source, error: fetchErr } = await sb
        .from('tournament_players')
        .select('player_id, team_id, credit_value, is_active')
        .eq('tournament_id', fromTournamentId);
      if (fetchErr) throw fetchErr;
      if (!source.length) return 0;

      // Map to target tournament, chunked to stay under PostgREST limits
      const rows = source.map(r => ({
        tournament_id: toTournamentId,
        player_id   : r.player_id,
        team_id     : r.team_id,
        credit_value: r.credit_value,
        is_active   : r.is_active,
      }));
      const CHUNK = 100;
      let inserted = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const { data, error } = await sb
          .from('tournament_players')
          .upsert(chunk, { onConflict: 'tournament_id,player_id', ignoreDuplicates: true })
          .select();
        if (error) throw error;
        inserted += data?.length ?? 0;
      }
      return inserted;
    },

    /**
     * Bulk upsert tournament-specific player attributes (team + credits).
     * Called by the CSV import flow when a tournament is active, so imported
     * data lands in tournament_players rather than overwriting global players.
     *
     * @param {string} tournamentId
     * @param {Array<{playerId, teamId, creditValue, isActive?}>} rows
     * @returns {Promise<number>} rows written
     */
    async bulkUpsertTournamentPlayers(tournamentId, rows) {
      if (!Array.isArray(rows) || rows.length === 0) return 0;
      const sb = await getClient();
      const payload = rows.map(r => ({
        tournament_id: tournamentId,
        player_id   : r.playerId,
        team_id     : r.teamId     ?? null,
        credit_value: r.creditValue,
        is_active   : r.isActive   ?? true,
        updated_at  : new Date().toISOString(),
      }));
      const CHUNK = 100;
      let written = 0;
      for (let i = 0; i < payload.length; i += CHUNK) {
        const chunk = payload.slice(i, i + CHUNK);
        const { data, error } = await sb
          .from('tournament_players')
          .upsert(chunk, { onConflict: 'tournament_id,player_id' })
          .select();
        if (error) throw error;
        written += data?.length ?? 0;
      }
      return written;
    },

    async getPlayers() {
      const sb = await getClient();
      const { data, error } = await sb.from('players').select('*').order('id');
      if (error) throw error;
      // Normalise team_id → team for the UI (it expects `team` short code)
      return data.map(p => ({
        id: p.id,
        name: p.name,
        team: p.team_id,
        role: p.role,
        credits: Number(p.credits),
        overseas: !!p.is_overseas,
      }));
    },

    // ─── Player admin (CRUD) ──────────────────────────────────────────────

    /**
     * Insert a new player row.
     * @param {{id?:string, name:string, team:string, role:string, credits:number, overseas?:boolean}} input
     *   If `id` is omitted, the caller is expected to generate one (e.g. `p31`).
     * @returns {Promise<object>} the inserted player (normalised)
     */
    async addPlayer(input) {
      if (!input.name || !input.team || !input.role) throw new Error('addPlayer: name, team, role required');
      if (!['wk','bat','ar','bowl'].includes(input.role)) throw new Error('addPlayer: invalid role');
      const sb = await getClient();
      const row = {
        id: input.id,
        name: input.name,
        team_id: input.team,
        role: input.role,
        credits: input.credits,
        is_overseas: !!input.overseas,
      };
      const { data, error } = await sb.from('players').insert(row).select().single();
      if (error) throw error;
      return { id: data.id, name: data.name, team: data.team_id, role: data.role, credits: Number(data.credits), overseas: !!data.is_overseas };
    },

    /**
     * Partial update.
     * @param {string} id
     * @param {{name?:string, team?:string, role?:string, credits?:number, overseas?:boolean}} patch
     */
    async updatePlayer(id, patch) {
      const sb = await getClient();
      const row = {};
      if (patch.name     !== undefined) row.name        = patch.name;
      if (patch.team     !== undefined) row.team_id     = patch.team;
      if (patch.role     !== undefined) {
        if (!['wk','bat','ar','bowl'].includes(patch.role)) throw new Error('updatePlayer: invalid role');
        row.role = patch.role;
      }
      if (patch.credits  !== undefined) row.credits     = patch.credits;
      if (patch.overseas !== undefined) row.is_overseas = !!patch.overseas;
      const { data, error } = await sb.from('players').update(row).eq('id', id).select().single();
      if (error) throw error;
      return { id: data.id, name: data.name, team: data.team_id, role: data.role, credits: Number(data.credits), overseas: !!data.is_overseas };
    },

    /**
     * Bulk upsert players. Existing rows (by id) are updated, new rows inserted.
     * Splits the payload into 50-row chunks so we never hit PostgREST's request-size
     * cap or its default max-rows return cap on the .select() that follows.
     *
     * @param {Array<{id:string, name:string, team:string, role:string, credits:number, overseas?:boolean}>} rows
     * @returns {Promise<number>} how many rows the database accepted across all chunks
     */
    async bulkUpsertPlayers(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return 0;
      const sb = await getClient();

      // Validate + normalise everything up front so we fail fast on bad data.
      const payload = rows.map(r => {
        if (!r.id || !r.name || !r.team || !r.role) throw new Error(`bulkUpsertPlayers: row missing required fields → ${JSON.stringify(r)}`);
        if (!['wk','bat','ar','bowl'].includes(r.role)) throw new Error(`bulkUpsertPlayers: bad role "${r.role}" on ${r.id}`);
        return {
          id: r.id,
          name: r.name,
          team_id: r.team,
          role: r.role,
          credits: r.credits,
          is_overseas: !!r.overseas,
        };
      });

      const CHUNK = 50;
      let written = 0;
      for (let i = 0; i < payload.length; i += CHUNK) {
        const slice = payload.slice(i, i + CHUNK);
        const { data, error } = await sb
          .from('players')
          .upsert(slice, { onConflict: 'id' })
          .select('id');
        if (error) {
          // Surface which chunk failed so the caller can act on it
          throw new Error(`Upsert failed on rows ${i+1}–${i+slice.length}: ${error.message}`);
        }
        written += Array.isArray(data) ? data.length : slice.length;
      }
      return written;
    },

    /**
     * Delete a player. Fails (FK restrict) if the player is in any saved XI.
     */
    async deletePlayer(id) {
      const sb = await getClient();
      const { error } = await sb.from('players').delete().eq('id', id);
      if (error) {
        if (error.code === '23503' || /violat/i.test(error.message)) {
          throw new Error('Cannot delete: this player is in a saved XI. Remove them from all saved teams first.');
        }
        throw error;
      }
    },

    // ─── User teams (drafted XIs) ─────────────────────────────────────────

    /**
     * @param {{name:string, format:string, playerIds:string[], captainId:string, viceCaptainId:string}} input
     * @returns {Promise<string>} new user_team uuid
     */
    async saveUserTeam(input) {
      const { name, format, playerIds, captainId, viceCaptainId, matchId = null } = input;
      if (!Array.isArray(playerIds) || playerIds.length !== 11) {
        throw new Error('saveUserTeam: need exactly 11 playerIds');
      }
      const sb = await getClient();

      // Always clear any existing daily team for this match before inserting.
      // This makes the method idempotent and avoids the unique constraint on
      // (match_id) for squad_id IS NULL rows, even if the caller skipped the
      // pre-delete step (e.g. after an SL save placed a row for the same match).
      if (matchId) {
        await sb.from('user_teams').delete().eq('match_id', matchId).is('squad_id', null);
      }

      const { data: ut, error: e1 } = await sb
        .from('user_teams')
        .insert({ name, format, captain_id: captainId, vice_captain_id: viceCaptainId, match_id: matchId, squad_id: null })
        .select('id')
        .single();
      if (e1) throw e1;

      const rows = playerIds.map(pid => ({ user_team_id: ut.id, player_id: pid }));
      const { error: e2 } = await sb.from('user_team_players').insert(rows);
      if (e2) {
        // Rollback the user_teams row to avoid orphans
        await sb.from('user_teams').delete().eq('id', ut.id);
        throw e2;
      }
      return ut.id;
    },

    /** Returns saved XIs newest-first, each with its 11 player_ids.
     *  Includes squadId so callers can distinguish SL teams from daily teams. */
    async listUserTeams() {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_teams')
        .select('id, name, format, captain_id, vice_captain_id, match_id, squad_id, created_at, user_team_players(player_id)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data.map(t => ({
        id: t.id,
        name: t.name,
        format: t.format,
        captainId: t.captain_id,
        viceCaptainId: t.vice_captain_id,
        matchId: t.match_id,
        squadId: t.squad_id ?? null,
        createdAt: t.created_at,
        playerIds: (t.user_team_players ?? []).map(x => x.player_id),
      }));
    },

    /** Get the daily XI drafted for a specific match (most recent if multiple).
     *  Excludes Season Long teams (squad_id IS NOT NULL) so auto-connect always
     *  uses the daily XI, not the SL XI saved for the same match. */
    async getUserTeamForMatch(matchId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_teams')
        .select('id, name, format, captain_id, vice_captain_id, match_id, created_at, user_team_players(player_id)')
        .eq('match_id', matchId)
        .is('squad_id', null)          // daily teams only
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const t = (data || [])[0];
      if (!t) return null;
      return {
        id: t.id,
        name: t.name,
        format: t.format,
        captainId: t.captain_id,
        viceCaptainId: t.vice_captain_id,
        matchId: t.match_id,
        createdAt: t.created_at,
        playerIds: (t.user_team_players ?? []).map(x => x.player_id),
      };
    },

    async deleteUserTeam(id) {
      const sb = await getClient();
      const { error } = await sb.from('user_teams').delete().eq('id', id);
      if (error) throw error;
    },

    /**
     * Upsert a Season Long XI into user_teams + user_team_players so that the
     * shared computeAndSaveXIScoresForMatch scoring pipeline can pick it up.
     * Identifies the row by (squad_id, match_id) — creates on first save,
     * replaces players on subsequent saves for the same match.
     *
     * @param {string}   squadId
     * @param {string}   matchId
     * @param {object}   opts
     * @param {string[]} opts.playerIds       11 player UUIDs
     * @param {string}   opts.captainId
     * @param {string}   opts.viceCaptainId
     * @param {string}   [opts.format]        e.g. 'T20'
     * @returns {Promise<string>}  user_team id
     */
    async upsertSlTeam(squadId, matchId, { playerIds, captainId, viceCaptainId, format = 'T20' }) {
      if (!playerIds || playerIds.length !== 11)
        throw new Error('upsertSlTeam: need exactly 11 playerIds');
      if (!playerIds.includes(captainId))
        throw new Error('Captain must be one of the 11 selected players.');
      if (!playerIds.includes(viceCaptainId))
        throw new Error('Vice-captain must be one of the 11 selected players.');

      const sb = await getClient();

      // Find existing user_teams row for this squad + match
      const { data: existing, error: fe } = await sb
        .from('user_teams')
        .select('id')
        .eq('squad_id', squadId)
        .eq('match_id', matchId)
        .limit(1);
      if (fe) throw fe;

      let teamId;
      if (existing?.length) {
        teamId = existing[0].id;
        // Update captain / vc in case they changed
        const { error: ue } = await sb
          .from('user_teams')
          .update({ captain_id: captainId, vice_captain_id: viceCaptainId })
          .eq('id', teamId);
        if (ue) throw ue;
        // Clear old player rows so we can re-insert fresh ones
        const { error: de } = await sb
          .from('user_team_players')
          .delete()
          .eq('user_team_id', teamId);
        if (de) throw de;
      } else {
        // First save for this squad + match — insert a new user_teams row
        const { data: ut, error: ie } = await sb
          .from('user_teams')
          .insert({
            squad_id       : squadId,
            match_id       : matchId,
            format,
            name           : 'SL XI',
            captain_id     : captainId,
            vice_captain_id: viceCaptainId,
          })
          .select('id')
          .single();
        if (ie) throw ie;
        teamId = ut.id;
      }

      // Insert the 11 player rows
      const rows = playerIds.map(pid => ({ user_team_id: teamId, player_id: pid }));
      const { error: pe } = await sb.from('user_team_players').insert(rows);
      if (pe) {
        // Rollback if first insert — avoid orphan team row
        if (!existing?.length) await sb.from('user_teams').delete().eq('id', teamId);
        throw pe;
      }

      return teamId;
    },

    // ─── Tournaments + Matches admin ──────────────────────────────────────

    async getTournaments() {
      const sb = await getClient();
      const { data, error } = await sb.from('tournaments').select('*').order('start_date', { ascending: false });
      if (error) throw error;
      return data;
    },

    async addTournament(input) {
      if (!input.name) throw new Error('addTournament: name is required');
      const sb = await getClient();
      const row = {
        name       : input.name.trim(),
        format     : input.format     ?? 'T20',
        start_date : input.startDate  ?? null,
        end_date   : input.endDate    ?? null,
      };
      const { data, error } = await sb.from('tournaments').insert(row).select().single();
      if (error) throw error;
      return data;
    },

    /** All matches, newest match_number first. Optional tournament filter. */
    async listMatches(tournamentId) {
      const sb = await getClient();
      let q = sb.from('matches').select('*').order('match_number', { ascending: true, nullsFirst: false });
      if (tournamentId) q = q.eq('tournament_id', tournamentId);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },

    async addMatch(input) {
      if (!input.format || !input.homeTeamId || !input.awayTeamId) throw new Error('addMatch: format, homeTeamId, awayTeamId required');
      const sb = await getClient();
      const row = {
        tournament_id: input.tournamentId ?? null,
        match_number : input.matchNumber ?? null,
        format       : input.format,
        home_team_id : input.homeTeamId,
        away_team_id : input.awayTeamId,
        played_on    : input.playedOn   ?? null,
        start_time   : input.startTime  ?? null,
        status       : input.status     ?? 'scheduled',
        notes        : input.notes      ?? null,
        external_id  : input.externalId ?? null,
      };
      const { data, error } = await sb.from('matches').insert(row).select().single();
      if (error) throw error;
      return data;
    },

    async updateMatch(id, patch) {
      const sb = await getClient();
      const row = {};
      if (patch.tournamentId !== undefined) row.tournament_id = patch.tournamentId;
      if (patch.matchNumber  !== undefined) row.match_number  = patch.matchNumber;
      if (patch.format       !== undefined) row.format        = patch.format;
      if (patch.homeTeamId   !== undefined) row.home_team_id  = patch.homeTeamId;
      if (patch.awayTeamId   !== undefined) row.away_team_id  = patch.awayTeamId;
      if (patch.playedOn     !== undefined) row.played_on     = patch.playedOn;
      if (patch.startTime    !== undefined) row.start_time    = patch.startTime;
      if (patch.status       !== undefined) row.status        = patch.status;
      if (patch.notes        !== undefined) row.notes         = patch.notes;
      if (patch.externalId   !== undefined) row.external_id   = patch.externalId;
      const { data, error } = await sb.from('matches').update(row).eq('id', id).select().single();
      if (error) throw error;
      return data;
    },

    /**
     * Returns completed matches that have an external_id (CricAPI link) but
     * zero player_match_stats rows yet — i.e. ready to be "finalized".
     *
     * Each returned match is annotated with `cachedScorecard: true/false` so
     * the caller can skip the CricAPI fetch when a saved payload already exists.
     */
    async listMatchesNeedingFinalization() {
      const sb = await getClient();
      const { data: completed, error: e1 } = await sb
        .from('matches')
        .select('id, match_number, format, home_team_id, away_team_id, external_id, played_on, status, notes')
        .eq('status', 'completed')
        .not('external_id', 'is', null);
      if (e1) throw e1;
      if (!completed?.length) return [];
      const ids = completed.map(m => m.id);
      // Check which matches already have player_match_stats
      const { data: stats, error: e2 } = await sb
        .from('player_match_stats')
        .select('match_id')
        .in('match_id', ids);
      if (e2) throw e2;
      const haveStats = new Set((stats || []).map(s => s.match_id));
      const pending = completed.filter(m => !haveStats.has(m.id));
      if (!pending.length) return [];
      // Check which pending matches already have a cached scorecard payload
      const pendingIds = pending.map(m => m.id);
      const { data: cached, error: e3 } = await sb
        .from('match_scorecards')
        .select('match_id')
        .in('match_id', pendingIds);
      if (e3) throw e3;
      const haveCached = new Set((cached || []).map(c => c.match_id));
      return pending.map(m => ({ ...m, cachedScorecard: haveCached.has(m.id) }));
    },

    // ─── Match scorecard cache ─────────────────────────────────────────────

    /**
     * Persist a raw CricAPI scorecard payload for a completed match.
     * Idempotent — calling again updates the payload and refreshes fetched_at.
     *
     * @param {string} matchId  uuid (matches.id, NOT the CricAPI external_id)
     * @param {object} payload  raw JSON from CricAPI match_scorecard endpoint
     */
    async saveMatchScorecard(matchId, payload) {
      if (!matchId) throw new Error('saveMatchScorecard: matchId required');
      const sb = await getClient();
      const { error } = await sb
        .from('match_scorecards')
        .upsert({ match_id: matchId, payload, fetched_at: new Date().toISOString() },
                 { onConflict: 'match_id' });
      if (error) throw error;
    },

    /**
     * Retrieve the cached raw scorecard for a match, or null if not yet saved.
     *
     * @param {string} matchId  uuid (matches.id)
     * @returns {Promise<object|null>} raw CricAPI payload, or null
     */
    async getMatchScorecard(matchId) {
      if (!matchId) return null;
      const sb = await getClient();
      const { data, error } = await sb
        .from('match_scorecards')
        .select('payload')
        .eq('match_id', matchId)
        .maybeSingle();
      if (error) throw error;
      return data?.payload ?? null;
    },

    async deleteMatch(id) {
      const sb = await getClient();
      const { error } = await sb.from('matches').delete().eq('id', id);
      if (error) throw error;
    },

    /**
     * Bulk upsert matches by external_id. Used for syncing schedules from
     * CricAPI. Rows missing an external_id are skipped (we can't dedupe them).
     * Returns { written, skipped }.
     */
    async bulkUpsertMatches(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return { written: 0, skipped: 0 };
      const sb = await getClient();
      const valid = [];
      let skipped = 0;
      for (const r of rows) {
        if (!r.externalId) { skipped++; continue; }
        if (!r.format || !['T20','ODI','TEST'].includes(r.format)) { skipped++; continue; }
        valid.push({
          tournament_id: r.tournamentId ?? null,
          match_number : r.matchNumber  ?? null,
          external_id  : r.externalId,
          format       : r.format,
          home_team_id : r.homeTeamId   ?? null,
          away_team_id : r.awayTeamId   ?? null,
          played_on    : r.playedOn     ?? null,
          start_time   : r.startTime    ?? null,
          status       : r.status       ?? null,
          notes        : r.notes        ?? null,
        });
      }
      const CHUNK = 50;
      let written = 0;
      for (let i = 0; i < valid.length; i += CHUNK) {
        const slice = valid.slice(i, i + CHUNK);
        const { data, error } = await sb
          .from('matches')
          .upsert(slice, { onConflict: 'external_id' })
          .select('id');
        if (error) throw new Error(`bulkUpsertMatches failed on rows ${i+1}–${i+slice.length}: ${error.message}`);
        written += Array.isArray(data) ? data.length : slice.length;
      }
      return { written, skipped };
    },

    // ─── Match results ────────────────────────────────────────────────────

    /**
     * Persist a finished match. Stores per-player stat blobs + raw points,
     * then computes & stores the user_team totals for any saved XIs.
     *
     * @param {object} input
     * @param {string} input.format                  'T20' | 'ODI' | 'TEST'
     * @param {string} [input.externalId]            CricAPI / Sportmonks id
     * @param {string} [input.homeTeamId]            'CSK' etc
     * @param {string} [input.awayTeamId]
     * @param {string} [input.notes]
     * @param {Array<{playerId, batting, bowling, fielding, rawPoints}>} input.playerStats
     * @param {Array<{userTeamId, totalPoints}>} [input.scores]
     * @returns {Promise<string>} new match uuid
     */
    async saveMatchResult(input) {
      const sb = await getClient();
      const { data: m, error: e1 } = await sb
        .from('matches')
        .insert({
          format: input.format,
          external_id: input.externalId ?? null,
          home_team_id: input.homeTeamId ?? null,
          away_team_id: input.awayTeamId ?? null,
          notes: input.notes ?? null,
        })
        .select('id')
        .single();
      if (e1) throw e1;

      if (input.playerStats?.length) {
        const rows = input.playerStats.map(s => ({
          match_id  : m.id,
          player_id : s.playerId,
          batting   : s.batting   ?? null,
          bowling   : s.bowling   ?? null,
          fielding  : s.fielding  ?? null,
          raw_points: s.rawPoints ?? 0,
        }));
        const { error: e2 } = await sb.from('player_match_stats').insert(rows);
        if (e2) throw e2;
      }

      if (input.scores?.length) {
        const rows = input.scores.map(s => ({
          user_team_id: s.userTeamId,
          match_id    : m.id,
          total_points: s.totalPoints,
        }));
        const { error: e3 } = await sb.from('user_team_match_scores').insert(rows);
        if (e3) throw e3;
      }
      return m.id;
    },

    /**
     * Save per-player fantasy points for a match. Idempotent — re-save overwrites.
     * @param {string} matchId  uuid (matches.id, NOT the CricAPI external_id)
     * @param {Array<{playerId:string, batting?:object, bowling?:object, fielding?:object, rawPoints:number}>} rows
     * @returns {Promise<number>} how many rows persisted
     */
    async bulkUpsertPlayerMatchStats(matchId, rows) {
      if (!matchId) throw new Error('bulkUpsertPlayerMatchStats: matchId required');
      const valid = (rows || []).filter(r => r.playerId);
      if (!valid.length) return 0;
      const sb = await getClient();
      const payload = valid.map(r => ({
        match_id  : matchId,
        player_id : r.playerId,
        batting   : r.batting   ?? null,
        bowling   : r.bowling   ?? null,
        fielding  : r.fielding  ?? null,
        raw_points: Number.isFinite(r.rawPoints) ? r.rawPoints : 0,
      }));
      const CHUNK = 50;
      let written = 0;
      for (let i = 0; i < payload.length; i += CHUNK) {
        const slice = payload.slice(i, i + CHUNK);
        const { data, error } = await sb
          .from('player_match_stats')
          .upsert(slice, { onConflict: 'match_id,player_id' })
          .select('player_id');
        if (error) throw new Error(`bulkUpsertPlayerMatchStats failed on rows ${i+1}–${i+slice.length}: ${error.message}`);
        written += Array.isArray(data) ? data.length : slice.length;
      }
      return written;
    },

    /** Player stats for one match — raw_points per player. */
    async getPlayerStatsForMatch(matchId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('player_match_stats')
        .select('player_id, raw_points')
        .eq('match_id', matchId);
      if (error) throw error;
      return data || [];
    },

    /**
     * Upsert per-XI total points for a match.
     * @param {string} matchId
     * @param {Array<{userTeamId: string, totalPoints: number}>} scores
     */
    async upsertUserTeamMatchScores(matchId, scores) {
      if (!matchId) throw new Error('upsertUserTeamMatchScores: matchId required');
      if (!Array.isArray(scores) || !scores.length) return 0;
      const sb = await getClient();
      const rows = scores.map(s => ({
        user_team_id: s.userTeamId,
        match_id    : matchId,
        total_points: Number.isFinite(s.totalPoints) ? s.totalPoints : 0,
        computed_at : new Date().toISOString(),
      }));
      const { data, error } = await sb
        .from('user_team_match_scores')
        .upsert(rows, { onConflict: 'user_team_id,match_id' })
        .select('user_team_id');
      if (error) throw error;
      return Array.isArray(data) ? data.length : rows.length;
    },

    /** All XI scores indexed by match_id — for the matches admin column. */
    // ─── Profiles ─────────────────────────────────────────────────────────

    /** Upsert the signed-in user's display name + email into profiles. */
    async upsertProfile({ userId, displayName, email }) {
      const sb = await getClient();
      const { error } = await sb.from('profiles').upsert({
        id: userId, display_name: displayName, email, updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      if (error) throw error;
    },

    /** Returns a map of userId → display_name (falls back to email). */
    async getProfiles() {
      const sb = await getClient();
      const { data, error } = await sb.from('profiles').select('id, display_name, email');
      if (error) throw error;
      const map = {};
      (data || []).forEach(p => { map[p.id] = p.display_name || p.email || p.id.slice(0, 8); });
      return map;
    },

    // ─── Leaderboard ──────────────────────────────────────────────────────

    /**
     * Daily leaderboard for a specific match.
     * Returns array sorted by points desc:
     *   [{ userId, teamName, totalPoints }]
     */
    async getLeaderboardDaily(matchId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_teams')
        .select('id, name, user_id, user_team_match_scores(total_points)')
        .eq('match_id', matchId)
        .is('squad_id', null);
      if (error) throw error;
      return (data || [])
        .map(t => ({
          userId      : t.user_id,
          teamName    : t.name,
          totalPoints : Number(t.user_team_match_scores?.[0]?.total_points ?? 0),
        }))
        .sort((a, b) => b.totalPoints - a.totalPoints);
    },

    /**
     * Season Long leaderboard for a contest.
     * Returns array sorted by cumulative points desc:
     *   [{ userId, squadName, totalPoints, matchCount }]
     */
    async getLeaderboardSL(contestId) {
      const sb = await getClient();
      // Get all SL teams (squad_id IS NOT NULL) for squads in this contest
      const { data: squads, error: sErr } = await sb
        .from('user_squads')
        .select('id, name, user_id')
        .eq('contest_id', contestId);
      if (sErr) throw sErr;
      if (!squads?.length) return [];

      const squadIds = squads.map(s => s.id);
      const { data: teams, error: tErr } = await sb
        .from('user_teams')
        .select('id, squad_id, user_team_match_scores(total_points)')
        .in('squad_id', squadIds);
      if (tErr) throw tErr;

      // Sum points per squad
      const pointsBySquad = {};
      const countBySquad  = {};
      (teams || []).forEach(t => {
        const pts = Number(t.user_team_match_scores?.[0]?.total_points ?? 0);
        pointsBySquad[t.squad_id] = (pointsBySquad[t.squad_id] || 0) + pts;
        if (pts > 0) countBySquad[t.squad_id] = (countBySquad[t.squad_id] || 0) + 1;
      });

      return squads
        .map(s => ({
          userId      : s.user_id,
          squadName   : s.name,
          totalPoints : pointsBySquad[s.id] || 0,
          matchCount  : countBySquad[s.id]  || 0,
        }))
        .sort((a, b) => b.totalPoints - a.totalPoints);
    },

    async getAllUserTeamMatchScores() {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_team_match_scores')
        .select('user_team_id, match_id, total_points');
      if (error) throw error;
      return data || [];
    },

    /** Match history for one saved XI — newest first. */
    async getMatchHistory(userTeamId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_team_history')
        .select('*')
        .eq('user_team_id', userTeamId);
      if (error) throw error;
      return data;
    },

    /**
     * Rich match history: for every finalized match this XI has a score for,
     * returns match info + per-player fantasy points from player_match_stats.
     * Covers ALL saved XIs (not just one) so the history section can show
     * a cross-team view grouped by match.
     *
     * Returns array sorted newest match first. Each element:
     * {
     *   match_id, match_number, home_team_id, away_team_id, played_on, format, status,
     *   teams: [ { user_team_id, team_name, captain_id, vice_captain_id, total_points,
     *              players: [ { player_id, name, team_id, role, raw_points, batting, bowling } ] } ]
     * }
     */
    async getMatchHistoryDetailed(userTeamIds) {
      if (!userTeamIds?.length) return [];
      const sb = await getClient();

      // 1. All match scores for these teams
      const { data: scores, error: e1 } = await sb
        .from('user_team_match_scores')
        .select('user_team_id, match_id, total_points')
        .in('user_team_id', userTeamIds);
      if (e1) throw e1;
      if (!scores?.length) return [];

      const matchIds   = [...new Set(scores.map(s => s.match_id))];
      const allTeamIds = [...new Set(scores.map(s => s.user_team_id))];

      // 2. Match info
      const { data: matches, error: e2 } = await sb
        .from('matches')
        .select('id, match_number, home_team_id, away_team_id, played_on, format, status')
        .in('id', matchIds);
      if (e2) throw e2;

      // 3. Team metadata (name, captain, vc)
      const { data: teams, error: e3 } = await sb
        .from('user_teams')
        .select('id, name, captain_id, vice_captain_id')
        .in('id', allTeamIds);
      if (e3) throw e3;

      // 4. Players in each team
      const { data: teamPlayers, error: e4 } = await sb
        .from('user_team_players')
        .select('user_team_id, player_id')
        .in('user_team_id', allTeamIds);
      if (e4) throw e4;

      // 5. All relevant player info
      const allPlayerIds = [...new Set((teamPlayers || []).map(tp => tp.player_id))];
      const { data: players, error: e5 } = await sb
        .from('players')
        .select('id, name, team_id, role')
        .in('id', allPlayerIds);
      if (e5) throw e5;

      // 6. Player match stats for all relevant combos
      const { data: stats, error: e6 } = await sb
        .from('player_match_stats')
        .select('match_id, player_id, raw_points, batting, bowling, fielding')
        .in('match_id', matchIds)
        .in('player_id', allPlayerIds);
      if (e6) throw e6;

      // ─── Join in JS ────────────────────────────────────────────────────────
      const matchMap   = Object.fromEntries((matches    || []).map(m  => [m.id,  m]));
      const teamMap    = Object.fromEntries((teams      || []).map(t  => [t.id,  t]));
      const playerMap  = Object.fromEntries((players    || []).map(p  => [p.id,  p]));

      // stats indexed by matchId → playerId
      const statIdx = {};
      (stats || []).forEach(s => {
        (statIdx[s.match_id] ??= {})[s.player_id] = s;
      });

      // players indexed by teamId
      const teamPlayerIdx = {};
      (teamPlayers || []).forEach(tp => {
        (teamPlayerIdx[tp.user_team_id] ??= []).push(tp.player_id);
      });

      // Group scores by match
      const byMatch = {};
      (scores || []).forEach(sc => {
        (byMatch[sc.match_id] ??= []).push(sc);
      });

      return Object.entries(byMatch).map(([matchId, matchScores]) => {
        const match = matchMap[matchId] || {};
        const teamRows = matchScores.map(sc => {
          const team    = teamMap[sc.user_team_id] || {};
          const pids    = teamPlayerIdx[sc.user_team_id] || [];
          const matchSt = statIdx[matchId] || {};
          const playerRows = pids.map(pid => {
            const p  = playerMap[pid] || {};
            const ps = matchSt[pid];
            return {
              player_id : pid,
              name      : p.name      || pid,
              team_id   : p.team_id   || '',
              role      : p.role      || '',
              raw_points: ps?.raw_points ?? null,
              batting   : ps?.batting   ?? null,
              bowling   : ps?.bowling   ?? null,
            };
          }).sort((a, b) => (b.raw_points ?? -Infinity) - (a.raw_points ?? -Infinity));

          return {
            user_team_id   : sc.user_team_id,
            team_name      : team.name           || 'My XI',
            captain_id     : team.captain_id     || null,
            vice_captain_id: team.vice_captain_id|| null,
            total_points   : sc.total_points,
            players        : playerRows,
          };
        });

        return {
          match_id    : matchId,
          match_number: match.match_number,
          home_team_id: match.home_team_id,
          away_team_id: match.away_team_id,
          played_on   : match.played_on,
          format      : match.format,
          status      : match.status,
          teams       : teamRows,
        };
      }).sort((a, b) => {
        // Primary: match_number descending (most reliable for IPL ordering)
        if (a.match_number != null && b.match_number != null)
          return b.match_number - a.match_number;
        if (a.match_number != null) return -1; // a has number, b doesn't → a first
        if (b.match_number != null) return  1;
        // Fallback: played_on descending (nulls sort last)
        const da = a.played_on ? new Date(a.played_on) : null;
        const db_ = b.played_on ? new Date(b.played_on) : null;
        if (da && db_) return db_ - da;
        if (da) return  1; // b has no date → b last
        if (db_) return -1;
        return 0;
      });
    },

    // ─── Scoring rules ────────────────────────────────────────────────────

    /**
     * @returns {Promise<Record<'T20'|'ODI'|'TEST', object>>}
     *   Returns whichever formats have been saved. Missing formats are absent
     *   from the result so callers can fall back to defaults per-format.
     */
    async getScoringRules() {
      const sb = await getClient();
      const { data, error } = await sb.from('scoring_rules').select('format, rules');
      if (error) throw error;
      const out = {};
      (data || []).forEach(r => { out[r.format] = r.rules; });
      return out;
    },

    /**
     * Upsert one format's rules.
     * @param {'T20'|'ODI'|'TEST'} format
     * @param {object} rules         the full rules object for that format
     */
    async saveScoringRules(format, rules) {
      if (!['T20', 'ODI', 'TEST'].includes(format)) throw new Error('saveScoringRules: bad format');
      const sb = await getClient();
      const { error } = await sb
        .from('scoring_rules')
        .upsert({ format, rules, updated_at: new Date().toISOString() }, { onConflict: 'format' });
      if (error) throw error;
    },

    /** Delete a format's overrides — reverts to in-code defaults on next load. */
    async resetScoringRules(format) {
      const sb = await getClient();
      const { error } = await sb.from('scoring_rules').delete().eq('format', format);
      if (error) throw error;
    },

    /** Aggregate stats for a single saved XI (totals + average). */
    async getUserTeamSummary(userTeamId) {
      const history = await this.getMatchHistory(userTeamId);
      const total = history.reduce((a, h) => a + Number(h.total_points), 0);
      return {
        matches: history.length,
        total,
        average: history.length ? total / history.length : 0,
        history,
      };
    },

    // ─── Season-Long Fantasy ─────────────────────────────────────────────────

    /**
     * All contests for a tournament, ordered by type (daily first).
     * @param {string} tournamentId
     * @returns {Promise<Array<{id, name, contest_type, description, is_active}>>}
     */
    async getContests(tournamentId) {
      const sb = await getClient();
      // Try with all phase-config columns (v3 + v5 migrations).
      // Falls back gracefully if columns don't exist yet.
      const { data, error } = await sb
        .from('contests')
        .select('id, name, contest_type, description, is_active, free_transfers_per_match, extra_transfer_point_cost, total_transfers_allowed, start_match_number, playoff_start_match_number, playoff_transfers_allowed')
        .eq('tournament_id', tournamentId)
        .eq('is_active', true)
        .order('contest_type');   // 'daily' < 'season_long' alphabetically

      if (error) {
        // Column-not-found errors from PostgREST contain "does not exist"
        if (String(error.message || '').includes('does not exist')) {
          console.warn('[db] getContests: some columns missing — run migration_v3 and/or migration_v5. Falling back to base columns.');
          const { data: d2, error: e2 } = await sb
            .from('contests')
            .select('id, name, contest_type, description, is_active')
            .eq('tournament_id', tournamentId)
            .eq('is_active', true)
            .order('contest_type');
          if (e2) throw e2;
          // Pad missing columns with safe defaults so callers never crash
          return (d2 || []).map(c => ({
            ...c,
            free_transfers_per_match    : null,
            extra_transfer_point_cost   : 0,
            total_transfers_allowed     : null,
            start_match_number          : null,
            playoff_start_match_number  : null,
            playoff_transfers_allowed   : null,
            _migrationNeeded            : true,   // flag for the UI to surface a warning
          }));
        }
        throw error;
      }
      return (data || []).map(c => ({
        ...c,
        start_match_number         : c.start_match_number         ?? null,
        playoff_start_match_number : c.playoff_start_match_number ?? null,
        playoff_transfers_allowed  : c.playoff_transfers_allowed  ?? null,
      }));
    },

    /**
     * Fetch the user's squad entry for a season-long contest, or null.
     * @param {string} contestId
     * @returns {Promise<object|null>}  squad row or null
     */
    async getOrCreateSquad(contestId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_squads')
        .select('*')
        .eq('contest_id', contestId)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },

    /**
     * Join a season-long contest — creates a lightweight user_squads entry.
     * No players, no budget — just a named entry for the season.
     * @param {string} contestId
     * @param {string} name      team name
     * @returns {Promise<object>}  the new squad row
     */
    async joinSeason(contestId, name) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_squads')
        .insert({ contest_id: contestId, name: name || 'My Team' })
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    /**
     * Return the match_id of the most recently saved XI for a squad.
     * Used on boot to auto-restore the SL XI when state.activeMatchId points
     * to a different (unsaved) match.
     * @param {string} squadId
     * @returns {Promise<string|null>}
     */
    /**
     * Returns the match_id of the SL squad's most recently saved XI,
     * determined by match_number (not UUID ordering which is meaningless).
     * @param {string}   squadId
     * @param {object[]} allMatches  [{id, match_number}] — used to rank by match_number
     */
    async getLatestSavedSlMatchId(squadId, allMatches = []) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_match_xi')
        .select('match_id')
        .eq('squad_id', squadId);
      if (error) throw error;
      if (!data?.length) return null;
      const matchNumOf = id => allMatches.find(m => m.id === id)?.match_number ?? 0;
      const seenIds = [...new Set(data.map(r => r.match_id))];
      return seenIds.reduce((best, id) =>
        !best || matchNumOf(id) > matchNumOf(best) ? id : best, null);
    },

    /**
     * Returns the full XI from the most recently locked match for a squad.
     * Used as the transfer baseline in the decoupled draft model — the SL tab
     * always diffs against this regardless of which match is selected in the pool.
     *
     * @param {string}   squadId
     * @param {object[]} allMatches  [{id, match_number}]
     * @returns {Promise<{playerIds, captainId, vcId, matchNumber, matchId} | null>}
     */
    async getLastLockedXI(squadId, allMatches = []) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_match_xi')
        .select('player_id, is_captain, is_vc, match_id')
        .eq('squad_id', squadId);
      if (error) throw error;
      if (!data?.length) return null;

      // Group rows by match_id, pick the one with the highest match_number.
      // IMPORTANT: only count a match as "locked" if it has actually started
      // (start_time <= now). A row written before start_time came from the old
      // save mechanism and must NOT be treated as a transfer baseline — doing so
      // would incorrectly charge transfers for the season opener.
      const now = Date.now();
      const byMatch = {};
      for (const row of data) {
        if (!byMatch[row.match_id]) byMatch[row.match_id] = [];
        byMatch[row.match_id].push(row);
      }
      const best = Object.keys(byMatch)
        .map(mid => {
          const match = allMatches.find(m => m.id === mid);
          const num     = match?.match_number ?? -1;
          const started = match?.start_time
            ? new Date(match.start_time).getTime() <= now
            : false;
          return { mid, num, started };
        })
        .filter(x => x.num >= 0 && x.started)
        .sort((a, b) => b.num - a.num)[0];
      if (!best) return null;

      const rows = byMatch[best.mid];
      return {
        playerIds  : rows.map(r => r.player_id),
        captainId  : rows.find(r => r.is_captain)?.player_id ?? null,
        vcId       : rows.find(r => r.is_vc)?.player_id     ?? null,
        matchNumber: best.num,
        matchId    : best.mid,
      };
    },

    /**
     * Find the XI played in the most recent match before currentMatchId.
     * Used to pre-populate the picker so changes are tracked as transfers.
     *
     * @param {string}      squadId
     * @param {string}      currentMatchId
     * @param {object[]}    allMatches        [{id, match_number}] sorted tournament matches
     * @param {number|null} startMatchNumber  If set, only look at matches with match_number >= this value.
     *                                        Matches before the season start are invisible as a baseline.
     * @returns {Promise<{playerIds: string[], captainId: string|null, vcId: string|null}>}
     */
    async getPreviousMatchXI(squadId, currentMatchId, allMatches, startMatchNumber = null) {
      const current = allMatches.find(m => m.id === currentMatchId);
      if (!current) return { playerIds: [], captainId: null, vcId: null };

      const prevMatchIds = allMatches
        .filter(m => {
          const num = m.match_number ?? 0;
          // Must be strictly before the current match
          if (num >= (current.match_number ?? Infinity)) return false;
          // Must be within the season window (if start is configured)
          if (startMatchNumber !== null && num < startMatchNumber) return false;
          return true;
        })
        .map(m => m.id);
      if (!prevMatchIds.length) return { playerIds: [], captainId: null, vcId: null };

      const sb = await getClient();

      // Fetch all saved XI rows for any prior match (no ordering — UUIDs don't sort by recency)
      const { data: prevXI, error } = await sb
        .from('user_match_xi')
        .select('player_id, is_captain, is_vc, match_id')
        .eq('squad_id', squadId)
        .in('match_id', prevMatchIds);
      if (error) throw error;
      if (!prevXI?.length) return { playerIds: [], captainId: null, vcId: null };

      // Pick the XI belonging to the match with the highest match_number
      // (match_id is a random UUID — lexicographic order is meaningless here)
      const matchNumOf = id => allMatches.find(m => m.id === id)?.match_number ?? 0;
      const seenMatchIds = [...new Set(prevXI.map(r => r.match_id))];
      const latestMatchId = seenMatchIds.reduce((best, id) =>
        !best || matchNumOf(id) > matchNumOf(best) ? id : best, null);
      const xi = prevXI.filter(r => r.match_id === latestMatchId);

      return {
        playerIds: xi.map(r => r.player_id),
        captainId: xi.find(r => r.is_captain)?.player_id ?? null,
        vcId     : xi.find(r => r.is_vc)?.player_id     ?? null,
      };
    },

    /**
     * Save (or replace) the 11-player XI for a squad + match.
     * Auto-diffs against previousPlayerIds, enforces the contest's transfer rules,
     * and logs each change to user_transfers.
     * Every change counts against the season's total_transfers_allowed budget.
     *
     * @param {string}   squadId
     * @param {string}   matchId
     * @param {string[]} playerIds          exactly 11 player IDs
     * @param {string}   captainId
     * @param {string}   vcId
     * @param {string[]} previousPlayerIds  XI from last match ([] = first match, no cap check)
     * @param {object}   contestConfig  {
     *   total_transfers_allowed, start_match_number?,
     *   playoff_start_match_number?, playoff_transfers_allowed?,
     *   allMatches?
     * }
     * @returns {Promise<{transfersMade, seasonXferCount, seasonCap, phase}>}
     *   phase: 'pre_season' | 'regular' | 'playoff'
     */
    async saveMatchXI(squadId, matchId, playerIds, captainId, vcId,
                      previousPlayerIds = [], contestConfig = {}) {
      if (playerIds.length !== 11)
        throw new Error('Match XI must have exactly 11 players.');
      if (!playerIds.includes(captainId))
        throw new Error('Captain must be one of the 11 selected players.');
      if (!playerIds.includes(vcId))
        throw new Error('Vice-captain must be one of the 11 selected players.');
      if (captainId === vcId)
        throw new Error('Captain and vice-captain must be different players.');

      const sb = await getClient();

      // Delete existing XI for this squad+match
      const { error: de } = await sb
        .from('user_match_xi')
        .delete()
        .eq('squad_id', squadId)
        .eq('match_id', matchId);
      if (de) throw de;

      // Insert fresh XI rows
      const rows = playerIds.map(pid => ({
        squad_id  : squadId,
        match_id  : matchId,
        player_id : pid,
        is_captain: pid === captainId,
        is_vc     : pid === vcId,
        role      : 'bat',
      }));
      const { error: ie } = await sb.from('user_match_xi').insert(rows);
      if (ie) throw ie;

      let transfersMade = 0, seasonXferCount = 0;
      const startMatchNumber  = contestConfig.start_match_number         ?? null;
      const playoffStartMN    = contestConfig.playoff_start_match_number ?? null;
      const seasonCap         = contestConfig.total_transfers_allowed    ?? null;
      const playoffCap        = contestConfig.playoff_transfers_allowed  ?? null;
      const allMatchesCfg     = contestConfig.allMatches                 ?? [];

      // ── Phase detection ────────────────────────────────────────────────────
      // Which budget window does this match fall into?
      const saveMatchNum = allMatchesCfg.find(m => m.id === matchId)?.match_number ?? null;
      const phase =
        (startMatchNumber === null || saveMatchNum === null || saveMatchNum < startMatchNumber)
          ? 'pre_season'
        : (playoffStartMN !== null && saveMatchNum >= playoffStartMN)
          ? 'playoff'
          : 'regular';

      // Active cap: null playoff cap = unlimited (no fallback to season cap — they're independent budgets)
      const activeCap = phase === 'playoff'  ? playoffCap   // null = unlimited
                      : phase === 'regular'  ? seasonCap
                      : null;   // pre-season: no cap

      // Match IDs that count toward the active budget window.
      // The season opener (mn === startMatchNumber) is excluded from the regular count —
      // it has no prior baseline, so any rows there are artifacts of pre-config saves.
      // The first playoff match (mn === playoffStartMN) IS counted — its transfers are
      // measured against the last regular-season XI which is a valid baseline.
      const phaseMatchIds = (() => {
        if (phase === 'pre_season' || !allMatchesCfg.length) return null;
        if (phase === 'playoff')
          return new Set(allMatchesCfg
            .filter(m => (m.match_number ?? 0) >= playoffStartMN)
            .map(m => m.id));
        // regular: (startMatchNumber, playoffStartMN − 1] — strictly greater than opener
        return new Set(allMatchesCfg
          .filter(m => {
            const mn = m.match_number ?? 0;
            return mn > startMatchNumber && (playoffStartMN === null || mn < playoffStartMN);
          })
          .map(m => m.id));
      })();

      if (previousPlayerIds.length > 0) {
        const prevSet = new Set(previousPlayerIds);
        const currSet = new Set(playerIds);
        const playersOut = previousPlayerIds.filter(id => !currSet.has(id));
        const playersIn  = playerIds.filter(id => !prevSet.has(id));
        transfersMade = Math.min(playersOut.length, playersIn.length);

        if (transfersMade > 0) {
          // Enforce phase budget
          if (activeCap !== null) {
            let usedQuery = sb
              .from('user_transfers')
              .select('id', { count: 'exact', head: true })
              .eq('squad_id', squadId)
              .neq('match_id', matchId);   // exclude current match (will be rewritten)
            if (phaseMatchIds) {
              const phaseIds = [...phaseMatchIds].filter(id => id !== matchId);
              usedQuery = usedQuery.in('match_id', phaseIds.length ? phaseIds : ['__none__']);
            }
            const { count: usedElsewhere } = await usedQuery;
            const used      = usedElsewhere ?? 0;
            const remaining = activeCap - used;
            const phaseLabel = phase === 'playoff' ? 'Playoff transfer' : 'Season transfer';
            if (remaining <= 0)
              throw new Error(`${phaseLabel} budget exhausted (${activeCap} total).`);
            if (transfersMade > remaining)
              throw new Error(
                `Only ${remaining} ${phaseLabel.toLowerCase()}${remaining !== 1 ? 's' : ''} left ` +
                `(budget: ${activeCap}). Reduce changes to ${remaining} or fewer.`
              );
          }

          // Clear prior transfer log for this match (re-save)
          await sb.from('user_transfers')
            .delete()
            .eq('squad_id', squadId)
            .eq('match_id', matchId);

          const xferRows = playersOut.slice(0, transfersMade).map((outId, i) => ({
            squad_id       : squadId,
            match_id       : matchId,
            player_out_id  : outId,
            player_in_id   : playersIn[i],
            is_free        : true,
            points_deducted: 0,
          }));

          const { error: xe } = await sb.from('user_transfers').insert(xferRows);
          if (xe) console.warn('Transfer log error (non-fatal):', xe.message);
        }
      }

      // Return updated transfer count scoped to the active phase window
      {
        let countQuery = sb
          .from('user_transfers')
          .select('id', { count: 'exact', head: true })
          .eq('squad_id', squadId);
        if (phaseMatchIds) {
          const ids = [...phaseMatchIds];
          countQuery = countQuery.in('match_id', ids.length ? ids : ['__none__']);
        }
        const { count: sc } = await countQuery;
        seasonXferCount = sc ?? 0;
      }

      return { transfersMade, seasonXferCount, seasonCap: activeCap, phase };
    },

    /**
     * Count transfers used by a squad for the phase that contains targetMatchNumber.
     * Returns { count, cap, phase }.
     *
     * @param {string}      squadId
     * @param {object[]}    allMatches              [{id, match_number}]
     * @param {number|null} startMatchNumber        Season start (inclusive)
     * @param {number|null} playoffStartMatchNumber Playoff start (inclusive); null = no playoffs
     * @param {number|null} targetMatchNumber       The match whose phase we want to count for.
     *                                              Defaults to the latest season match if null.
     * @param {object}      caps                    { season: number|null, playoff: number|null }
     * @returns {Promise<{ count: number, cap: number|null, phase: string }>}
     */
    async getSeasonTransferCount(squadId, allMatches = [], startMatchNumber = null,
                                  playoffStartMatchNumber = null, targetMatchNumber = null,
                                  caps = {}) {
      const sb = await getClient();

      // Determine phase for the target match
      const phase =
        (startMatchNumber === null || targetMatchNumber === null || targetMatchNumber < startMatchNumber)
          ? 'pre_season'
        : (playoffStartMatchNumber !== null && targetMatchNumber >= playoffStartMatchNumber)
          ? 'playoff'
          : 'regular';

      const activeCap = phase === 'playoff' ? (caps.playoff ?? null)   // null = unlimited
                      : phase === 'regular' ? (caps.season  ?? null)
                      : null;

      // Build phase match ID filter
      const phaseIds = (() => {
        if (phase === 'pre_season' || !allMatches.length) return null;
        if (phase === 'playoff')
          return allMatches
            .filter(m => (m.match_number ?? 0) >= playoffStartMatchNumber)
            .map(m => m.id);
        return allMatches
          .filter(m => {
            const mn = m.match_number ?? 0;
            // Strictly greater than opener: season opener has no baseline, any rows there are artifacts
            return mn > startMatchNumber && (playoffStartMatchNumber === null || mn < playoffStartMatchNumber);
          })
          .map(m => m.id);
      })();

      let q = sb
        .from('user_transfers')
        .select('id', { count: 'exact', head: true })
        .eq('squad_id', squadId);
      if (phaseIds) {
        q = q.in('match_id', phaseIds.length ? phaseIds : ['__none__']);
      }
      const { count, error } = await q;
      if (error) throw error;
      return { count: count ?? 0, cap: activeCap, phase };
    },

    /**
     * Update the transfer budget for a season-long contest.
     * @param {string}      contestId
     * @param {number|null} totalAllowed  null = unlimited
     */
    async updateContestTransferBudget(contestId, totalAllowed) {
      const sb = await getClient();
      const { error } = await sb
        .from('contests')
        .update({ total_transfers_allowed: totalAllowed ?? null })
        .eq('id', contestId);
      if (error) throw error;
    },

    /**
     * Update phase configuration for a season-long contest.
     * Accepts a partial object — only provided keys are written.
     * @param {string} contestId
     * @param {{ start_match_number?: number|null, playoff_start_match_number?: number|null, playoff_transfers_allowed?: number|null }} fields
     */
    async updateContestPhases(contestId, fields) {
      const sb = await getClient();
      const patch = {};
      if ('start_match_number'         in fields) patch.start_match_number         = fields.start_match_number         ?? null;
      if ('playoff_start_match_number' in fields) patch.playoff_start_match_number = fields.playoff_start_match_number ?? null;
      if ('playoff_transfers_allowed'  in fields) patch.playoff_transfers_allowed  = fields.playoff_transfers_allowed  ?? null;
      if (!Object.keys(patch).length) return;
      const { error } = await sb
        .from('contests')
        .update(patch)
        .eq('id', contestId);
      if (error) throw error;
    },

    // ─── Draft XI (carry-forward SL model) ───────────────────────────────────

    /**
     * Load the squad's current editable draft XI.
     * Returns null if no draft has been saved yet.
     */
    async getDraft(squadId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('squad_draft_xi')
        .select('player_ids, captain_id, vc_id')
        .eq('squad_id', squadId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        playerIds: data.player_ids ?? [],
        captainId: data.captain_id ?? null,
        vcId:      data.vc_id      ?? null,
      };
    },

    /**
     * Persist the squad's current editable draft XI.
     * No transfer counting — this is just a free save.
     */
    async saveDraft(squadId, { playerIds, captainId, vcId }) {
      const sb = await getClient();
      const { error } = await sb
        .from('squad_draft_xi')
        .upsert({
          squad_id  : squadId,
          player_ids: playerIds,
          captain_id: captainId ?? null,
          vc_id     : vcId      ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'squad_id' });
      if (error) throw error;
    },

    /**
     * Lock the draft XI for a specific match.
     * Called automatically when a match's start_time arrives.
     *  - Reads the current draft
     *  - Writes it to user_match_xi (with transfer counting vs previous locked XI)
     *  - Writes to user_teams + user_team_players for the scoring pipeline
     *
     * @param {string}   squadId
     * @param {string}   matchId        the match being locked
     * @param {object}   contestConfig  same shape as saveMatchXI expects
     * @returns {Promise<{transfersMade, seasonXferCount, phase}>}
     */
    async lockMatchXI(squadId, matchId, contestConfig = {}) {
      const draft = await this.getDraft(squadId);
      if (!draft || draft.playerIds.length !== 11)
        throw new Error('No valid draft XI to lock — save your team first.');

      const allMatches = contestConfig.allMatches ?? [];
      const sorted     = [...allMatches].sort((a, b) => (a.match_number ?? 0) - (b.match_number ?? 0));

      // Transfer baseline = last locked XI before this match
      const prev = await this.getPreviousMatchXI(
        squadId, matchId, sorted, contestConfig.start_match_number ?? null
      );

      // Write XI + transfers
      const result = await this.saveMatchXI(
        squadId, matchId,
        draft.playerIds, draft.captainId, draft.vcId,
        prev.playerIds,
        contestConfig
      );

      return result;
    },

    /**
     * Fetch the XI saved for a squad + match.
     * @param {string} squadId
     * @param {string} matchId
     * @returns {Promise<Array<{player_id, is_captain, is_vc, role}> | null>}
     */
    async getMatchXI(squadId, matchId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_match_xi')
        .select('player_id, is_captain, is_vc, role')
        .eq('squad_id', squadId)
        .eq('match_id', matchId);
      if (error) throw error;
      return data?.length ? data : null;
    },

    /**
     * All squads that have a locked XI for a given match.
     * Returns rows grouped as: { [squadId]: [{player_id, is_captain, is_vc}] }
     * Used by computeAndSaveSLScoresForMatch to score every squad at once.
     */
    async getAllSquadXIsForMatch(matchId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_match_xi')
        .select('squad_id, player_id, is_captain, is_vc')
        .eq('match_id', matchId);
      if (error) throw error;
      const grouped = {};
      for (const row of (data || [])) {
        if (!grouped[row.squad_id]) grouped[row.squad_id] = [];
        grouped[row.squad_id].push(row);
      }
      return grouped;
    },

    /**
     * Upsert per-player fantasy points for a squad's match XI.
     * Called by the Finalize flow after player_match_stats are written.
     *
     * @param {string} squadId
     * @param {string} matchId
     * @param {Array<{playerId, basePoints, multiplier, totalPoints}>} scores
     * @returns {Promise<number>} rows written
     */
    async upsertSquadMatchScores(squadId, matchId, scores) {
      if (!squadId) throw new Error('upsertSquadMatchScores: squadId required');
      if (!matchId) throw new Error('upsertSquadMatchScores: matchId required');
      if (!Array.isArray(scores) || !scores.length) return 0;
      const sb = await getClient();
      const rows = scores.map(s => ({
        squad_id    : squadId,
        match_id    : matchId,
        player_id   : s.playerId,
        base_points : Number.isFinite(s.basePoints)  ? s.basePoints  : 0,
        multiplier  : Number.isFinite(s.multiplier)  ? s.multiplier  : 1.0,
        total_points: Number.isFinite(s.totalPoints) ? s.totalPoints : 0,
        computed_at : new Date().toISOString(),
      }));
      const { data, error } = await sb
        .from('user_match_xi_scores')
        .upsert(rows, { onConflict: 'squad_id,match_id,player_id' })
        .select('player_id');
      if (error) throw error;
      return Array.isArray(data) ? data.length : rows.length;
    },

    /**
     * Full season history for a squad — one row per player per match.
     * Also returns the transfer log (player changes between matches).
     *
     * @param {string} squadId
     * @returns {Promise<{matches: object[], transfers: object[], seasonTotal: number}>}
     */
    async getSquadSeason(squadId) {
      const sb = await getClient();

      const [{ data: xiRows, error: e1 }, { data: xferRows, error: e2 }] = await Promise.all([
        sb.from('v_match_xi_with_scores').select('*').eq('squad_id', squadId).order('match_number'),
        sb.from('user_transfers').select('*').eq('squad_id', squadId).order('match_id'),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;

      // Group XI rows by match
      const byMatch = {};
      (xiRows || []).forEach(r => {
        if (!byMatch[r.match_id]) {
          byMatch[r.match_id] = {
            match_id    : r.match_id,
            match_number: r.match_number,
            played_on   : r.played_on,
            home_team_id: r.home_team_id,
            away_team_id: r.away_team_id,
            match_status: r.match_status,
            players     : [],
            xi_total    : 0,
          };
        }
        byMatch[r.match_id].players.push(r);
        byMatch[r.match_id].xi_total += Number(r.total_points ?? 0);
      });

      const matches = Object.values(byMatch)
        .sort((a, b) => (a.match_number ?? 0) - (b.match_number ?? 0));

      const seasonTotal = matches.reduce((sum, m) => sum + m.xi_total, 0);

      return {
        matches,
        transfers  : xferRows || [],
        seasonTotal: +seasonTotal.toFixed(1),
      };
    },
  };
}
