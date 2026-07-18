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
 * Resolve the leaderboard display name for a profile row.
 * Priority: team_name → display_name → email → first 8 chars of id.
 * Mirrors the same fallback chain used in the mobile app (profileUtils.ts).
 * @param {{ team_name?: string|null, display_name?: string|null, email?: string|null, id?: string|null }} p
 * @returns {string}
 */
function resolveDisplayName(p) {
  return p.team_name || p.display_name || p.email || (p.id || '').slice(0, 8);
}

/**
 * Resolve the ACTUAL PERSON's name for a profile row — deliberately skips
 * team_name, unlike resolveDisplayName above. Used anywhere a squad/team
 * name is already shown as its own separate label (SL leaderboard: squad
 * name is the bold primary line, this is the small "owned by" sub-line).
 * Squads are typically created using the same team_name the account set at
 * signup, so using resolveDisplayName there showed the team name twice —
 * once as the squad name, once as this "who owns it" line underneath.
 * Priority: first + last name → display_name (but only if it isn't just an
 * old alias of team_name) → email → first 8 chars of id.
 * @param {{ first_name?: string|null, last_name?: string|null, display_name?: string|null, team_name?: string|null, email?: string|null, id?: string|null }} p
 * @returns {string}
 */
function resolvePersonName(p) {
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (p.display_name && p.display_name !== p.team_name) return p.display_name;
  return p.email || (p.id || '').slice(0, 8);
}

/**
 * PostgREST/Supabase caps a single .select() at 1000 rows by default. Any
 * query whose result set can plausibly exceed that (e.g. every score row for
 * every player in every match for every squad in a season-long contest) must
 * paginate explicitly, or it silently truncates — no error, just missing
 * rows past the cutoff. This was the actual cause of a real incident: the SL
 * leaderboard undercounted a squad's total points once the contest's
 * user_match_xi_scores rows crossed 1000 — whichever squad's rows happened
 * to land past the cap just vanished from the client-side sum, while the
 * per-squad detail view (a much smaller, squad-scoped query) stayed correct.
 *
 * @param {(from: number, to: number) => Promise<{data: any[]|null, error: any}>} pageFn
 *   Called with successive .range(from, to) windows; must return the same
 *   shape a Supabase query builder's await does.
 * @returns {Promise<any[]>}
 */
async function fetchAllRows(pageFn, pageSize = 1000) {
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await pageFn(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/**
 * Picks the "current" match_number for a tournament, mirroring index.html's
 * findNextMatch(): prefer a currently-live match (effective lock time passed,
 * not completed), else the nearest upcoming match, else — if the whole
 * season is done — the last match by match_number, so a fully-finished
 * season still reports a sensible final phase instead of nothing.
 * @param {{match_number: number|null, status: string, start_time: string|null, lock_time: string|null}[]} matches
 * @returns {number|null}
 */
function pickCurrentMatchNumber(matches) {
  const now = Date.now();
  const effTime = m => m.lock_time ?? m.start_time ?? null;
  const withTime = (matches || [])
    .map(m => ({ m, t: effTime(m) ? new Date(effTime(m)).getTime() : null }))
    .filter(x => x.t !== null)
    .sort((a, b) => a.t - b.t);
  const live = withTime.find(x => x.m.status !== 'completed' && x.t <= now);
  if (live) return live.m.match_number ?? null;
  const upcoming = withTime.find(x => x.t > now && x.m.status !== 'completed');
  if (upcoming) return upcoming.m.match_number ?? null;
  let maxMn = null;
  (matches || []).forEach(m => {
    if (m.match_number !== null && m.match_number !== undefined && (maxMn === null || m.match_number > maxMn)) {
      maxMn = m.match_number;
    }
  });
  return maxMn;
}

/**
 * Resolves the active transfer-budget window for a given target match_number:
 * which phase it's in, what cap applies (null = unlimited), and which match
 * IDs count toward that cap. Mirrors mobile's transferCap.ts resolveBudgetWindow
 * and saveMatchXI's inline phase logic — kept as one shared helper here so
 * getSeasonTransferCount, saveMatchXI, and getLeaderboardSL can't drift apart
 * on what "the current phase" means.
 *
 * Playoff carve-out: when playoffFirstMatchUnlimited is set, the first
 * playoff match (mn === playoffStartMatchNumber) is pulled into its own
 * isolated, uncapped window — excluded from the pooled budget the rest of
 * the playoff matches share.
 *
 * @returns {{ phase: 'pre_season'|'regular'|'playoff', activeCap: number|null, phaseIds: Set<string>|null, isUnlimitedFirstPlayoffMatch: boolean }}
 */
function resolvePhaseWindow(targetMatchNumber, allMatches, startMatchNumber, playoffStartMatchNumber,
                             seasonCap, playoffCap, playoffFirstMatchUnlimited) {
  const phase =
    (startMatchNumber === null || targetMatchNumber === null || targetMatchNumber < startMatchNumber)
      ? 'pre_season'
    : (playoffStartMatchNumber !== null && targetMatchNumber >= playoffStartMatchNumber)
      ? 'playoff'
      : 'regular';

  const isUnlimitedFirstPlayoffMatch =
    phase === 'playoff' && !!playoffFirstMatchUnlimited && targetMatchNumber === playoffStartMatchNumber;

  const activeCap = isUnlimitedFirstPlayoffMatch ? null
                   : phase === 'playoff' ? playoffCap
                   : phase === 'regular' ? seasonCap
                   : null;

  const phaseIds = (() => {
    if (phase === 'pre_season' || !allMatches.length) return null;
    if (phase === 'playoff') {
      if (isUnlimitedFirstPlayoffMatch) {
        return new Set(allMatches.filter(m => m.match_number === playoffStartMatchNumber).map(m => m.id));
      }
      return new Set(allMatches
        .filter(m => (m.match_number ?? 0) >= playoffStartMatchNumber
          && !(playoffFirstMatchUnlimited && m.match_number === playoffStartMatchNumber))
        .map(m => m.id));
    }
    return new Set(allMatches
      .filter(m => {
        const mn = m.match_number ?? 0;
        return mn > startMatchNumber && (playoffStartMatchNumber === null || mn < playoffStartMatchNumber);
      })
      .map(m => m.id));
  })();

  return { phase, activeCap, phaseIds, isUnlimitedFirstPlayoffMatch };
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

  /**
   * Postgres's generic RLS-violation error — raised when a write's WITH CHECK
   * (or implicit USING-as-WITH-CHECK, for UPDATE) evaluates false. Code 42501.
   */
  function isRlsViolation(err) {
    return !!err && (err.code === '42501' || /row-level security/i.test(err.message || ''));
  }

  /**
   * Runs a Supabase write, and if it fails with an RLS violation, refreshes
   * the session and retries ONCE before giving up.
   *
   * Why: the most common real-world trigger for "new row violates row-level
   * security policy" on an otherwise-correct, ownership-scoped policy (like
   * squad_draft_xi's "squad belongs to auth.uid()" check) isn't a genuine
   * ownership mismatch — it's a stale access token. supabase-js's background
   * auto-refresh timer is throttled while a tab sits inactive (e.g. the user
   * spends a few minutes deciding on a booster before hitting Save), so by
   * the time a write actually fires, the token backing it has quietly gone
   * stale even though the user never signed out. A silent refresh + retry
   * fixes that case with no user-visible error at all.
   *
   * Throws on any error still present after the retry — RLS violations get
   * the friendlier diagnostic message above; every other error (e.g. a
   * unique-constraint violation) is re-thrown AS-IS (same `.code`/`.message`)
   * so callers can keep their own special-case handling (see activateBooster's
   * 23505 check) without withRlsRetry swallowing it.
   *
   * Resolves to `result.data` on success, for callers that need it.
   *
   * @param {object} sb           the supabase client
   * @param {() => Promise<{error: any, data?: any}>} run   the write to attempt (and retry)
   * @param {string} actionLabel  human label for the diagnostic error if it still fails
   */
  async function withRlsRetry(sb, run, actionLabel) {
    let result = await run();

    if (result.error && isRlsViolation(result.error)) {
      console.warn(`[db] ${actionLabel} hit an RLS violation — refreshing session and retrying once:`, result.error.message);
      const { error: refreshErr } = await sb.auth.refreshSession();
      if (!refreshErr) {
        result = await run();
      }
    }

    if (result.error) {
      if (isRlsViolation(result.error)) {
        // Still failing after a fresh token — distinguish "not signed in"
        // from "genuinely not yours" so the message actually points at a
        // fix, instead of surfacing Postgres's raw internal wording.
        const { data: userData } = await sb.auth.getUser();
        const detail = !userData?.user
          ? 'Your session has expired — please sign in again.'
          : 'Your session is out of sync — please refresh the page and try again.';
        throw new Error(`Could not complete ${actionLabel}. ${detail}`);
      }
      throw result.error;
    }

    return result.data;
  }

  return {
    isConfigured() { return configured; },

    /** Expose project URL + anonKey so the admin panel can construct Edge Function URLs. */
    _supabaseUrl()  { return url ?? '' },
    _anonKey()      { return anonKey ?? '' },

    /** Expose the raw Supabase client for one-off calls (e.g. verifyOtp). */
    async _getRawClient() { return getClient(); },

    // ─── Auth ─────────────────────────────────────────────────────────────

    /**
     * Send a magic link to the given email address.
     * Supabase emails a one-time login link; clicking it returns the user
     * to the app and triggers onAuthStateChange with a valid session.
     * @param {string} email
     */
    async signInWithMagicLink(email) {
      const sb = await getClient();
      const { error } = await sb.auth.signInWithOtp({ email });
      if (error) throw error;
    },

    /** Sign in with email + password. */
    async signInWithPassword(email, password) {
      const sb = await getClient();
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },

    /** Create a new account with email + password + optional metadata (e.g. { full_name }). */
    async signUpWithPassword(email, password, metadata = {}) {
      const sb = await getClient();
      const opts = Object.keys(metadata).length ? { data: metadata } : undefined;
      const { data, error } = await sb.auth.signUp({ email, password, options: opts });
      if (error) throw error;
      return data;
    },

    /** Sign out the current user. */
    async signOut() {
      const sb = await getClient();
      const { error } = await sb.auth.signOut();
      if (error) throw error;
    },

    /** Send a password-reset email. redirectTo should be the app's current URL. */
    async resetPasswordForEmail(email, redirectTo) {
      const sb = await getClient();
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
    },

    /** Update the signed-in user's password (called after PASSWORD_RECOVERY session). */
    async updatePassword(newPassword) {
      const sb = await getClient();
      const { error } = await sb.auth.updateUser({ password: newPassword });
      if (error) throw error;
    },

    /** Returns the current user object (or null if not signed in). */
    async getUser() {
      const sb = await getClient();
      // Use getSession() — reads localStorage, no network call, won't hang in Safari.
      // getUser() would make a /auth/v1/user request which can hang.
      const { data: { session } } = await sb.auth.getSession();
      return session?.user ?? null;
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
        color2: input.color2 ?? null,
      }).select().single();
      if (error) throw error;
      return data;
    },

    async updateTeam(id, patch) {
      const sb = await getClient();
      const row = {};
      if (patch.name   !== undefined) row.name   = patch.name;
      if (patch.color  !== undefined) row.color  = patch.color;
      if (patch.color2 !== undefined) row.color2 = patch.color2;
      const { data, error } = await sb.from('teams').update(row).eq('id', id).select().single();
      if (error) throw error;
      return data;
    },

    /**
     * Upsert a batch of teams from API data.
     * Inserts new teams; updates `name` for existing ones (leaves `color` untouched).
     * @param {Array<{id:string, name:string}>} teams
     * @returns {number} number of rows processed
     */
    async bulkUpsertTeams(teams) {
      if (!teams.length) return 0;
      const sb = await getClient();
      const rows = teams.map(t => ({ id: t.id.toUpperCase(), name: t.name }));
      const { error } = await sb
        .from('teams')
        .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });
      if (error) throw error;
      return rows.length;
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
     * Returns every player id in the GLOBAL players table (not scoped to any
     * tournament). players.id is a global text PK ('p01', 'p02', ...) shared
     * across all tournaments, so anything that needs to mint a fresh, guaranteed-
     * unused id (see index.html's nextPlayerId()) must check against this full
     * set — not just whatever subset happens to be loaded into the admin UI's
     * PLAYERS array, which is often tournament-scoped via getPlayersForTournament
     * and can easily omit ids that are still taken globally.
     * @returns {Promise<string[]>}
     */
    async getAllPlayerIds() {
      const sb = await getClient();
      const { data, error } = await sb.from('players').select('id');
      if (error) throw error;
      return data.map(r => r.id);
    },

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
        id           : tp.players.id,
        name         : tp.players.name,
        team         : tp.team_id,                  // tournament-specific team
        role         : tp.players.role,
        credits      : Number(tp.credit_value),     // tournament-specific credits
        overseas     : !!tp.players.is_overseas,
        active       : !!tp.is_active,
        tournamentId : tournamentId,  // firm tag: which tournament this row's stats/team/credits came from,
                                       // independent of whatever the UI's "active tournament" toggle says later.
                                       // Lets stat lookups (match history, recent form) filter by the tournament
                                       // this specific player record actually belongs to, not a shared global flag —
                                       // important since two tournaments can legitimately be active at once.
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
     * @param {string} [tournamentId] - if given, also attach this player to that
     *   tournament's pool (a `tournament_players` row), so the new player shows
     *   up immediately without a manual SQL insert. Only happens when the
     *   tournament has ALREADY switched to a tournament-specific pool (i.e. it
     *   has at least one tournament_players row). If the tournament is still on
     *   the global-players fallback (no rows yet), we deliberately skip this —
     *   inserting a row for just ONE player would flip the whole tournament
     *   into "tournament mode" and hide every other player who hasn't been
     *   explicitly imported yet (see loadPlayersForActiveTournament in
     *   index.html, which switches sources based on whether tournament_players
     *   has ANY rows at all).
     * @returns {Promise<object>} the inserted player (normalised)
     */
    async addPlayer(input, tournamentId) {
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
      const player = { id: data.id, name: data.name, team: data.team_id, role: data.role, credits: Number(data.credits), overseas: !!data.is_overseas };

      if (tournamentId) {
        const { count, error: ce } = await sb
          .from('tournament_players')
          .select('player_id', { count: 'exact', head: true })
          .eq('tournament_id', tournamentId);
        if (ce) throw ce;
        if (count > 0) {
          const { error: te } = await sb.from('tournament_players').upsert({
            tournament_id: tournamentId,
            player_id    : player.id,
            team_id      : player.team,
            credit_value : player.credits,
            is_active    : true,
          }, { onConflict: 'tournament_id,player_id' });
          if (te) throw te;
        }
      }

      return player;
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

    // ─── Duplicate player detection/merge (Review tab) ─────────────────────
    // Mirrors sql-diagnostics/classify_duplicate_players.sql exactly, so the
    // in-app queue and the SQL diagnostics always agree on a verdict:
    //   SAFE_DELETE  — zero usage anywhere, a pure orphan (delete outright)
    //   NEEDS_REVIEW — has real usage on at least one sibling row
    //   KEEP         — rostered but not yet used (leave alone)

    /**
     * Finds every group of players sharing a normalized name (same name,
     * case/whitespace-insensitive) and classifies each row's usage across
     * every table that can reference a player id.
     * @returns {Promise<Array<{normName:string, rows:Array<{id,name,teamId,
     *   rosters,xiRows,scored,teamRows,xferRows,draftRows,verdict}>}>>}
     */
    async getDuplicatePlayerCandidates() {
      const sb = await getClient();

      const { data: players, error } = await sb.from('players').select('id, name, team_id');
      if (error) throw error;

      const normName = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const groups = new Map();
      for (const p of players) {
        const key = normName(p.name);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      const dupGroups = [...groups.entries()].filter(([, rows]) => rows.length > 1);
      if (!dupGroups.length) return [];

      const allIds = dupGroups.flatMap(([, rows]) => rows.map(r => r.id));

      // Batch-count usage in a single-column table — one query for every
      // duplicate id at once, instead of one query per id.
      const countBy = async (table, column) => {
        const { data, error } = await sb.from(table).select(column).in(column, allIds);
        if (error) throw error;
        const counts = {};
        for (const row of data) counts[row[column]] = (counts[row[column]] || 0) + 1;
        return counts;
      };
      const countTransfers = async () => {
        const idList = allIds.map(id => `"${id}"`).join(',');
        const { data, error } = await sb
          .from('user_transfers')
          .select('player_out_id, player_in_id')
          .or(`player_out_id.in.(${idList}),player_in_id.in.(${idList})`);
        if (error) throw error;
        const counts = {};
        const idSet = new Set(allIds);
        for (const row of data) {
          if (idSet.has(row.player_out_id)) counts[row.player_out_id] = (counts[row.player_out_id] || 0) + 1;
          if (idSet.has(row.player_in_id))  counts[row.player_in_id]  = (counts[row.player_in_id]  || 0) + 1;
        }
        return counts;
      };
      const countDraft = async () => {
        const idList = allIds.map(id => `"${id}"`).join(',');
        const idSet = new Set(allIds);
        const counts = {};
        const { data: cv, error: e1 } = await sb
          .from('squad_draft_xi')
          .select('captain_id, vc_id')
          .or(`captain_id.in.(${idList}),vc_id.in.(${idList})`);
        if (e1) throw e1;
        for (const row of cv) {
          if (idSet.has(row.captain_id)) counts[row.captain_id] = (counts[row.captain_id] || 0) + 1;
          if (idSet.has(row.vc_id))      counts[row.vc_id]      = (counts[row.vc_id]      || 0) + 1;
        }
        const { data: pidRows, error: e2 } = await sb
          .from('squad_draft_xi')
          .select('player_ids')
          .overlaps('player_ids', allIds);
        if (e2) throw e2;
        for (const row of pidRows) {
          for (const id of (row.player_ids || [])) {
            if (idSet.has(id)) counts[id] = (counts[id] || 0) + 1;
          }
        }
        return counts;
      };

      const [rosters, xi, scored, team, xfer, draft] = await Promise.all([
        countBy('tournament_players', 'player_id'),
        countBy('user_match_xi', 'player_id'),
        countBy('player_match_stats', 'player_id'),
        countBy('user_team_players', 'player_id'),
        countTransfers(),
        countDraft(),
      ]);

      const verdictFor = id => {
        const r = rosters[id] || 0, x = xi[id] || 0, s = scored[id] || 0,
              t = team[id] || 0, xf = xfer[id] || 0, d = draft[id] || 0;
        if (r === 0 && x === 0 && s === 0 && t === 0 && xf === 0 && d === 0) return 'SAFE_DELETE';
        if (x > 0 || s > 0 || t > 0 || xf > 0 || d > 0) return 'NEEDS_REVIEW';
        return 'KEEP';
      };

      return dupGroups.map(([key, rows]) => ({
        normName: key,
        rows: rows.map(p => ({
          id: p.id, name: p.name, teamId: p.team_id,
          rosters: rosters[p.id] || 0, xiRows: xi[p.id] || 0, scored: scored[p.id] || 0,
          teamRows: team[p.id] || 0, xferRows: xfer[p.id] || 0, draftRows: draft[p.id] || 0,
          verdict: verdictFor(p.id),
        })),
      }));
    },

    /**
     * Checks whether keepId/dropId can be safely auto-merged: no overlapping
     * scored match, no overlapping XI selection, and no live squad-draft
     * reference to dropId (draft state is transient — any hit there routes
     * to manual review rather than risking a live in-progress pick).
     * Mirrors the manual collision check done by hand for the 3 clean merges
     * in sql-diagnostics/fix_merge_clean_duplicate_players.sql.
     * @returns {Promise<{safe:boolean, reason:string|null}>}
     */
    async checkMergeSafety(keepId, dropId) {
      const sb = await getClient();

      const { data: keepStats, error: e1 } = await sb
        .from('player_match_stats').select('match_id').eq('player_id', keepId);
      if (e1) throw e1;
      const { data: dropStats, error: e2 } = await sb
        .from('player_match_stats').select('match_id').eq('player_id', dropId);
      if (e2) throw e2;
      const keepMatchIds = new Set((keepStats || []).map(r => r.match_id));
      if ((dropStats || []).some(r => keepMatchIds.has(r.match_id))) {
        return { safe: false, reason: 'Both players have scored stats for the same match — can\'t auto-merge.' };
      }

      const { data: keepXi, error: e3 } = await sb
        .from('user_match_xi').select('squad_id, match_id').eq('player_id', keepId);
      if (e3) throw e3;
      const { data: dropXi, error: e4 } = await sb
        .from('user_match_xi').select('squad_id, match_id').eq('player_id', dropId);
      if (e4) throw e4;
      const keepXiKeys = new Set((keepXi || []).map(r => `${r.squad_id}::${r.match_id}`));
      if ((dropXi || []).some(r => keepXiKeys.has(`${r.squad_id}::${r.match_id}`))) {
        return { safe: false, reason: 'Both players are in the same squad\'s XI for the same match — can\'t auto-merge.' };
      }

      const { data: draftCv, error: e5 } = await sb
        .from('squad_draft_xi').select('id').or(`captain_id.eq.${dropId},vc_id.eq.${dropId}`);
      if (e5) throw e5;
      const { data: draftPid, error: e6 } = await sb
        .from('squad_draft_xi').select('id').overlaps('player_ids', [dropId]);
      if (e6) throw e6;
      if ((draftCv && draftCv.length) || (draftPid && draftPid.length)) {
        return { safe: false, reason: 'The duplicate is part of a live (unlocked) squad draft — resolve that pick manually first.' };
      }

      return { safe: true, reason: null };
    },

    /**
     * Merges dropId into keepId: repoints every historical reference
     * (scored stats, saved XIs, team-player rows, transfers) to keepId, then
     * removes dropId's tournament roster row (or repoints it, if keepId
     * wasn't rostered to that same tournament) and deletes the dropId player
     * row itself. Re-checks safety server-side first — never trusts stale
     * UI state for a destructive multi-table operation.
     * @returns {Promise<{merged:true}>}
     */
    async mergeDuplicatePlayers(keepId, dropId) {
      if (!keepId || !dropId || keepId === dropId) throw new Error('mergeDuplicatePlayers: two distinct player ids required');
      const sb = await getClient();

      const safety = await this.checkMergeSafety(keepId, dropId);
      if (!safety.safe) throw new Error(safety.reason);

      const { error: e1 } = await sb.from('player_match_stats').update({ player_id: keepId }).eq('player_id', dropId);
      if (e1) throw e1;

      const { error: e2 } = await sb.from('user_match_xi').update({ player_id: keepId }).eq('player_id', dropId);
      if (e2) throw e2;

      const { error: e3 } = await sb.from('user_team_players').update({ player_id: keepId }).eq('player_id', dropId);
      if (e3) throw e3;

      const { error: e4 } = await sb.from('user_transfers').update({ player_out_id: keepId }).eq('player_out_id', dropId);
      if (e4) throw e4;
      const { error: e5 } = await sb.from('user_transfers').update({ player_in_id: keepId }).eq('player_in_id', dropId);
      if (e5) throw e5;

      // tournament_players: redundant rows (keepId already rostered there)
      // get deleted; rows for a tournament only dropId was rostered to get
      // repointed instead, so that roster spot isn't silently lost.
      const { data: keepRosters, error: e6 } = await sb
        .from('tournament_players').select('tournament_id').eq('player_id', keepId);
      if (e6) throw e6;
      const keepTournamentIds = new Set((keepRosters || []).map(r => r.tournament_id));
      const { data: dropRosters, error: e7 } = await sb
        .from('tournament_players').select('tournament_id').eq('player_id', dropId);
      if (e7) throw e7;
      for (const row of (dropRosters || [])) {
        if (keepTournamentIds.has(row.tournament_id)) {
          const { error } = await sb.from('tournament_players').delete()
            .eq('player_id', dropId).eq('tournament_id', row.tournament_id);
          if (error) throw error;
        } else {
          const { error } = await sb.from('tournament_players').update({ player_id: keepId })
            .eq('player_id', dropId).eq('tournament_id', row.tournament_id);
          if (error) throw error;
        }
      }

      // Final delete — FK RESTRICT is the last safety net for anything this
      // function didn't already know to repoint; player_name_aliases cascades.
      const { error: e8 } = await sb.from('players').delete().eq('id', dropId);
      if (e8) throw e8;

      return { merged: true };
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
      const { data: { user } } = await sb.auth.getUser();
      const uid = user?.id ?? null;

      // Always clear any existing daily team for this match before inserting.
      // This makes the method idempotent and avoids the unique constraint on
      // (match_id) for squad_id IS NULL rows, even if the caller skipped the
      // pre-delete step (e.g. after an SL save placed a row for the same match).
      if (matchId) {
        const delQ = sb.from('user_teams').delete().eq('match_id', matchId).is('squad_id', null);
        if (uid) delQ.eq('user_id', uid);
        await delQ;
      }

      const { data: ut, error: e1 } = await sb
        .from('user_teams')
        .insert({ name, format, captain_id: captainId, vice_captain_id: viceCaptainId, match_id: matchId, squad_id: null, user_id: uid })
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

      // ── Mirror XI into user_match_xi so mobile apps can read it ────────────
      // Mobile reads from user_squads + user_match_xi (not user_teams).
      // When we have a matchId and a signed-in user, find (or create) the user's
      // squad for the daily contest of this match's tournament, then upsert the
      // XI rows so the mobile app sees the same selection.
      if (matchId && uid) {
        try {
          // 1. Get the tournament_id for this match
          const { data: matchRow } = await sb
            .from('matches')
            .select('tournament_id')
            .eq('id', matchId)
            .maybeSingle();
          const tournamentId = matchRow?.tournament_id;

          if (tournamentId) {
            // 2. Find the public daily contest for this tournament
            const { data: contestRow } = await sb
              .from('contests')
              .select('id')
              .eq('tournament_id', tournamentId)
              .eq('contest_type', 'daily')
              .eq('is_private', false)
              .maybeSingle();
            const contestId = contestRow?.id;

            if (contestId) {
              // 3. Get or create a user_squad for this contest
              let squadId = null;
              const { data: existingSquad } = await sb
                .from('user_squads')
                .select('id')
                .eq('contest_id', contestId)
                .eq('user_id', uid)
                .maybeSingle();

              if (existingSquad?.id) {
                squadId = existingSquad.id;
              } else {
                const { data: newSquad } = await sb
                  .from('user_squads')
                  .insert({
                    contest_id: contestId,
                    user_id: uid,
                    name: 'My Squad',
                    budget_remaining: 100,
                    free_transfers_available: 1,
                  })
                  .select('id')
                  .single();
                squadId = newSquad?.id ?? null;
              }

              if (squadId) {
                // 4. Delete existing user_match_xi rows for this squad+match, then insert fresh
                await sb.from('user_match_xi').delete()
                  .eq('squad_id', squadId)
                  .eq('match_id', matchId);

                // user_match_xi.role is NOT NULL with a check constraint
                // (wk/bat/ar/bowl) — look up each player's real role instead
                // of inserting null, which would violate that constraint and
                // make this insert fail silently every time (caught below).
                const { data: roleRows } = await sb
                  .from('players')
                  .select('id, role')
                  .in('id', playerIds);
                const roleById = {};
                (roleRows || []).forEach(p => { roleById[p.id] = p.role; });

                const xiRows = playerIds.map(pid => ({
                  squad_id:   squadId,
                  match_id:   matchId,
                  player_id:  pid,
                  is_captain: pid === captainId,
                  is_vc:      pid === viceCaptainId,
                  role:       roleById[pid] || 'bat',
                  user_id:    uid,
                }));
                const { error: xiErr } = await sb.from('user_match_xi').insert(xiRows);
                if (xiErr) throw xiErr;
                console.log(`[saveUserTeam] Mirrored ${xiRows.length} rows to user_match_xi for mobile sync.`);
              }
            }
          }
        } catch (mirrorErr) {
          // Mirror failure is non-fatal — the primary user_teams save already succeeded
          console.warn('[saveUserTeam] user_match_xi mirror failed (non-fatal):', mirrorErr);
        }
      }

      return ut.id;
    },

    /** Returns saved XIs newest-first, each with its 11 player_ids.
     *  Includes squadId so callers can distinguish SL teams from daily teams. */
    async listUserTeams() {
      const sb = await getClient();
      const { data: { user } } = await sb.auth.getUser();
      const uid = user?.id;
      const q = sb
        .from('user_teams')
        .select('id, name, format, captain_id, vice_captain_id, match_id, squad_id, created_at, user_team_players(player_id)')
        .order('created_at', { ascending: false });
      if (uid) q.eq('user_id', uid);
      const { data, error } = await q;
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
      const { data: { user } } = await sb.auth.getUser();
      const uid = user?.id;
      const q = sb
        .from('user_teams')
        .select('id, name, format, captain_id, vice_captain_id, match_id, created_at, user_team_players(player_id)')
        .eq('match_id', matchId)
        .is('squad_id', null)          // daily teams only
        .order('created_at', { ascending: false })
        .limit(1);
      if (uid) q.eq('user_id', uid);
      const { data, error } = await q;
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
     * Read a mobile-saved XI from user_match_xi (the table the React Native app
     * writes to via teamStore.saveXI).  Returns a lightweight object matching the
     * shape of getUserTeamForMatch() so callers can treat both identically.
     *
     * Strategy:
     *   1. Find the user's squad(s) for any contest tied to this match's tournament.
     *   2. Read user_match_xi rows for the given matchId across those squads.
     *   3. Return the first / most-recently-saved set, or null if none.
     *
     * @param {string} matchId  - matches.id UUID
     * @returns {Promise<{playerIds, captainId, viceCaptainId, matchId, name} | null>}
     */
    async getUserMatchXI(matchId) {
      if (!matchId) return null;
      const sb = await getClient();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return null;

      // 1. Get all squads belonging to this user (across any contest)
      const { data: squads } = await sb
        .from('user_squads')
        .select('id')
        .eq('user_id', user.id);

      if (!squads || squads.length === 0) return null;
      const squadIds = squads.map(s => s.id);

      // 2. Read XI rows for this match across all the user's squads
      const { data: rows, error } = await sb
        .from('user_match_xi')
        .select('player_id, is_captain, is_vc, role, squad_id')
        .eq('match_id', matchId)
        .in('squad_id', squadIds);

      if (error) throw error;
      if (!rows || rows.length === 0) return null;

      // 3. Map to the same shape as getUserTeamForMatch
      const captainRow = rows.find(r => r.is_captain);
      const vcRow      = rows.find(r => r.is_vc);
      return {
        id           : null,                              // no user_teams row
        name         : 'My XI (mobile)',
        format       : null,
        captainId    : captainRow?.player_id ?? null,
        viceCaptainId: vcRow?.player_id      ?? null,
        matchId,
        createdAt    : null,
        playerIds    : rows.map(r => r.player_id),
        _source      : 'user_match_xi',                  // internal tag
      };
    },

    /**
     * Find the most recent complete XI (11 players) saved by the current user
     * for any match belonging to a given tournament.
     *
     * Search order:
     *   1. user_match_xi  — mobile / SL saves across all the user's squads
     *   2. user_teams     — web daily saves
     *
     * Prefers the row set with the highest match_number so the user sees their
     * most recent pick.
     *
     * @param {string} tournamentId
     * @returns {Promise<{playerIds, captainId, viceCaptainId, matchId, name} | null>}
     */
    async getLatestUserXIForTournament(tournamentId) {
      if (!tournamentId) return null;
      const sb = await getClient();
      const { data: { user }, error: userErr } = await sb.auth.getUser();
      console.log(`[getLatestUserXIForTournament] user=${user?.id ?? 'NULL'} err=${userErr?.message ?? 'none'}`);
      if (!user) return null;

      // All match IDs for this tournament
      const { data: matchRows } = await sb
        .from('matches')
        .select('id, match_number')
        .eq('tournament_id', tournamentId);
      console.log(`[getLatestUserXIForTournament] tournament=${tournamentId} matchRows=${matchRows?.length ?? 0}`);
      if (!matchRows?.length) return null;
      const matchIds  = matchRows.map(m => m.id);
      const matchNumById = Object.fromEntries(matchRows.map(m => [m.id, m.match_number ?? 0]));

      // ── 1. user_match_xi (mobile / SL) ─────────────────────────────────────
      const { data: squads } = await sb
        .from('user_squads')
        .select('id')
        .eq('user_id', user.id);
      console.log(`[getLatestUserXIForTournament] squads=${squads?.length ?? 0}`);

      if (squads?.length) {
        const squadIds = squads.map(s => s.id);
        const { data: xiRows } = await sb
          .from('user_match_xi')
          .select('player_id, is_captain, is_vc, match_id')
          .in('squad_id', squadIds)
          .in('match_id', matchIds);
        console.log(`[getLatestUserXIForTournament] user_match_xi rows=${xiRows?.length ?? 0}`);

        if (xiRows?.length) {
          // Group by match_id, keep groups with exactly 11 rows
          const byMatch = {};
          for (const row of xiRows) {
            (byMatch[row.match_id] = byMatch[row.match_id] || []).push(row);
          }
          const groupSizes = Object.entries(byMatch).map(([mid, rows]) => `${matchNumById[mid] ?? mid.slice(0,8)}:${rows.length}`);
          console.log(`[getLatestUserXIForTournament] groups=${groupSizes.join(', ')}`);
          const best = Object.entries(byMatch)
            .filter(([, rows]) => rows.length === 11)
            .sort((a, b) => (matchNumById[b[0]] ?? 0) - (matchNumById[a[0]] ?? 0))[0];

          if (best) {
            const [mid, rows] = best;
            const capRow = rows.find(r => r.is_captain);
            const vcRow  = rows.find(r => r.is_vc);
            console.log(`[getLatestUserXIForTournament] Found mobile XI for match ${matchNumById[mid]} (${mid})`);
            return {
              id:            null,
              name:          'My XI',
              format:        null,
              captainId:     capRow?.player_id    ?? null,
              viceCaptainId: vcRow?.player_id     ?? null,
              matchId:       mid,
              createdAt:     null,
              playerIds:     rows.map(r => r.player_id),
              _source:       'user_match_xi',
            };
          }
        }
      }

      // ── 2. user_teams (web daily saves) ────────────────────────────────────
      const { data: teams } = await sb
        .from('user_teams')
        .select('id, name, format, captain_id, vice_captain_id, match_id, created_at, user_team_players(player_id)')
        .eq('user_id', user.id)
        .in('match_id', matchIds)
        .is('squad_id', null)
        .order('created_at', { ascending: false })
        .limit(5);

      for (const t of (teams ?? [])) {
        const playerIds = (t.user_team_players ?? []).map(x => x.player_id);
        if (playerIds.length === 11) {
          console.log(`[getLatestUserXIForTournament] Found web daily XI for match ${matchNumById[t.match_id]}`);
          return {
            id:            t.id,
            name:          t.name,
            format:        t.format,
            captainId:     t.captain_id,
            viceCaptainId: t.vice_captain_id,
            matchId:       t.match_id,
            createdAt:     t.created_at,
            playerIds,
            _source:       'user_teams',
          };
        }
      }

      console.log(`[getLatestUserXIForTournament] No saved XI found for tournament ${tournamentId}`);
      return null;
    },

    /**
     * Returns ALL daily teams (squad_id IS NULL) saved for a specific match,
     * across every user. Used by the scoring pipeline so admin recalculation
     * covers every participant's team, not just the currently signed-in user's.
     *
     * @param {string} matchId
     * @returns {Promise<Array<{id, name, captainId, viceCaptainId, matchId, playerIds}>>}
     */
    async getAllDailyTeamsForMatch(matchId) {
      if (!matchId) return [];
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_teams')
        .select('id, name, captain_id, vice_captain_id, match_id, created_at, user_team_players(player_id)')
        .eq('match_id', matchId)
        .is('squad_id', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(t => ({
        id           : t.id,
        name         : t.name,
        captainId    : t.captain_id,
        viceCaptainId: t.vice_captain_id,
        matchId      : t.match_id,
        createdAt    : t.created_at,
        playerIds    : (t.user_team_players ?? []).map(x => x.player_id),
      }));
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

    /**
     * Set the is_active flag on a tournament (controls mobile lobby visibility).
     * @param {string} id          Tournament UUID
     * @param {boolean} isActive   New active state
     */
    async setTournamentActive(id, isActive) {
      const sb = await getClient();
      const { error } = await sb
        .from('tournaments')
        .update({ is_active: isActive })
        .eq('id', id);
      if (error) throw error;
    },

    /**
     * Delete a tournament row. Will fail if child rows (matches, contests,
     * tournament_players, etc.) still reference it — caller should inform the user.
     * @param {string} id  Tournament UUID
     */
    async deleteTournament(id) {
      const sb = await getClient();
      const { error } = await sb
        .from('tournaments')
        .delete()
        .eq('id', id);
      if (error) throw error;
    },

    /**
     * Save the CricAPI series ID for a tournament so it auto-fills on future syncs.
     * @param {string} id        Tournament UUID
     * @param {string} seriesId  CricAPI series ID (e.g. '1510719')
     */
    async updateTournamentSeriesId(id, seriesId) {
      const sb = await getClient();
      const { error } = await sb
        .from('tournaments')
        .update({ cricapi_series_id: seriesId || null })
        .eq('id', id);
      if (error) throw error;
    },

    async addTournament(input) {
      if (!input.name) throw new Error('addTournament: name is required');
      const sb = await getClient();
      const row = {
        name                : input.name.trim(),
        format              : input.format          ?? 'T20',
        start_date          : input.startDate        ?? null,
        end_date            : input.endDate          ?? null,
        max_overseas_in_xi  : input.maxOverseasInXi  ?? null,
        domestic_label      : input.domesticLabel    ?? null,
      };
      const { data, error } = await sb.from('tournaments').insert(row).select().single();
      if (error) throw error;
      return data;
    },

    /**
     * Update the overseas player cap for a tournament.
     * @param {string}      id   Tournament UUID
     * @param {number|null} cap  Max overseas in XI (null = use format default)
     */
    async updateTournamentOverseasCap(id, cap) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('tournaments')
        .update({ max_overseas_in_xi: cap ?? null })
        .eq('id', id)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('No rows updated — check RLS policies.');
    },

    /**
     * Update the display label for this tournament's "non-overseas" bucket
     * (e.g. 'US' for MLC, 'Indian' for IPL). Purely cosmetic — the underlying
     * is_overseas boolean and overseas-cap enforcement are unaffected.
     * @param {string}      id     Tournament UUID
     * @param {string|null} label  Display label, or null to fall back to "Domestic"
     */
    async updateTournamentDomesticLabel(id, label) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('tournaments')
        .update({ domestic_label: label || null })
        .eq('id', id)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('No rows updated — check RLS policies.');
    },

    /** Toggle the scraper on/off for a tournament. */
    async updateTournamentScraper(id, enabled) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('tournaments')
        .update({ scraper_enabled: !!enabled })
        .eq('id', id)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('No rows updated — check RLS policies.');
    },

    /**
     * Toggle dot-ball scoring on/off for a tournament (migration_v30).
     * OFF hides the dot_ball rule from both rules UIs AND forces it to 0 at
     * actual scoring time server-side — see migration_v30_dot_ball_toggle.sql.
     */
    async updateTournamentDotBall(id, enabled) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('tournaments')
        .update({ dot_ball_enabled: !!enabled })
        .eq('id', id)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('No rows updated — check RLS policies.');
    },

    // ── Scraper unmatched player reconciliation ──────────────────────────────

    /**
     * Lightweight count of unresolved unmatched player names, per tournament.
     * Used to populate the "⚠️ Unmatched Players" badge eagerly (on page load,
     * for every tournament at once) without paying for the full match-join
     * payload that getUnmatchedPlayers() fetches — that one is only called
     * when the admin actually expands a tournament's panel.
     */
    async getUnmatchedPlayersCounts(tournamentIds) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('scraper_unmatched')
        .select('tournament_id')
        .in('tournament_id', tournamentIds)
        .is('resolved_at', null);
      if (error) throw error;
      const counts = new Map();
      for (const id of tournamentIds) counts.set(id, 0);
      for (const row of data ?? []) {
        counts.set(row.tournament_id, (counts.get(row.tournament_id) ?? 0) + 1);
      }
      return counts;
    },

    /**
     * Names that a source (CricAPI, CricketAddictor, Business Standard) sends
     * when IT failed to identify a player — not a real name. These can never
     * be aliased to one specific local player: the same literal string shows
     * up for different actual players across different matches, so a static
     * alias just silently mis-credits stats to whoever was picked the first
     * time (this is exactly how "player not found" → Abayanga Khaka happened).
     * Add more known placeholder strings here if other sources surface them.
     */
    isPlaceholderName(rawName) {
      const PLACEHOLDER_NAMES = new Set(['player not found']);
      const norm = String(rawName ?? '').toLowerCase().trim();
      // "empty" is a broader/prefix check (not an exact-set entry) because
      // this source sends variants like "empty &" rather than one fixed
      // literal. Mirrors poll-cricapi's/scrape-scorecard's isPlaceholderName.
      return PLACEHOLDER_NAMES.has(norm) || norm.startsWith('empty');
    },

    /**
     * Returns all unresolved unmatched player names for a tournament.
     * Each row includes match info (number + team names) for context.
     */
    async getUnmatchedPlayers(tournamentId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('scraper_unmatched')
        .select(`
          id, raw_name, source, context, created_at,
          match_id,
          match:matches!match_id(
            match_number,
            home_team:teams!home_team_id(name),
            away_team:teams!away_team_id(name)
          )
        `)
        .eq('tournament_id', tournamentId)
        .is('resolved_at', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(u => ({
        id       : u.id,
        rawName  : u.raw_name,
        source   : u.source,
        context  : u.context,
        createdAt: u.created_at,
        matchId  : u.match_id,
        matchLabel: u.match
          ? `M${u.match.match_number} · ${u.match.home_team?.name ?? '?'} vs ${u.match.away_team?.name ?? '?'}`
          : u.match_id,
      }));
    },

    /**
     * Resolve an unmatched name by mapping it to an existing player.
     * Creates a player_name_alias so future scraper runs auto-resolve the name.
     */
    async resolveUnmatchedAsAlias(id, playerId, tournamentId, rawName, source) {
      if (this.isPlaceholderName(rawName)) {
        throw new Error(`"${rawName}" is a generic "not found" placeholder from the source feed, not a real name — it can't be mapped to one player. Use Ignore instead.`);
      }
      const sb = await getClient();
      const { error: ae } = await sb.from('player_name_aliases').upsert({
        player_id    : playerId,
        tournament_id: tournamentId,
        alias        : rawName.toLowerCase().trim(),
        source,
      }, { onConflict: 'alias,source,tournament_id', ignoreDuplicates: true });
      if (ae) throw ae;
      const { error } = await sb
        .from('scraper_unmatched')
        .update({ resolved_at: new Date().toISOString(), resolved_by: 'alias' })
        .eq('id', id);
      if (error) throw error;
    },

    /**
     * Standalone alias upsert — no scraper_unmatched row required. Used by the
     * browser's inline "Link" flow on the live/fantasy scorecard (linkPlayerAndRescore
     * in index.html), so a name fixed there is visible to the server-side
     * poll-cricapi/scrape-scorecard cron jobs too, not just this browser tab.
     */
    async upsertNameAlias(playerId, tournamentId, alias, source = 'cricapi') {
      if (this.isPlaceholderName(alias)) {
        throw new Error(`"${alias}" is a generic "not found" placeholder from the source feed, not a real name — it can't be mapped to one player.`);
      }
      const sb = await getClient();
      const { error } = await sb.from('player_name_aliases').upsert({
        player_id    : playerId,
        tournament_id: tournamentId,
        alias        : alias.toLowerCase().trim(),
        source,
      }, { onConflict: 'alias,source,tournament_id', ignoreDuplicates: true });
      if (error) throw error;
    },

    /**
     * Resolve an unmatched name by adding the player to the global pool + tournament roster.
     * Also creates an alias for future auto-resolution.
     *
     * @param {string} id             - scraper_unmatched row id
     * @param {{name, teamId, role, overseas, credits, playerId?}} playerData
     * @param {string} tournamentId
     * @param {string} rawName        - original scraper name (for alias)
     * @param {string} source         - 'cricketaddictor' | 'business_standard'
     */
    async resolveUnmatchedAsNewPlayer(id, playerData, tournamentId, rawName, source) {
      if (this.isPlaceholderName(rawName)) {
        throw new Error(`"${rawName}" is a generic "not found" placeholder from the source feed, not a real name — adding a player for it would alias every future occurrence to them. Use Ignore instead.`);
      }
      const sb = await getClient();
      const playerId = playerData.playerId || `scr_${Date.now()}`;

      // Guard against creating a duplicate player row: if a player with this
      // same normalized name already exists on this tournament's roster,
      // "Add new player" is almost certainly the wrong button — the raw
      // scorecard name is just a spelling/format variant of someone already
      // rostered, and it should be mapped (aliased) to them instead. This is
      // exactly how "Mukhtar Ahmed", "Obus Pienaar", "Ali Sheikh" and
      // "Anirudh Immanuel" ended up duplicated, splitting their stats across
      // two ids.
      const normName = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
      const { data: roster, error: rosterErr } = await sb
        .from('tournament_players')
        .select('player_id, players(id, name)')
        .eq('tournament_id', tournamentId);
      if (rosterErr) throw rosterErr;
      const existing = (roster || []).find(r =>
        r.players && normName(r.players.name) === normName(playerData.name) && r.players.id !== playerId
      );
      if (existing) {
        throw new Error(`"${playerData.name}" already exists on this tournament's roster as ${existing.players.name} (${existing.players.id}). Use "Map to existing player" instead — pick ${existing.players.id} from the dropdown.`);
      }

      // 1. Insert into global players pool
      const { error: pe } = await sb.from('players').insert({
        id         : playerId,
        name       : playerData.name,
        team_id    : playerData.teamId,
        role       : playerData.role,
        credits    : playerData.credits ?? 8,
        is_overseas: !!playerData.overseas,
      });
      if (pe) throw pe;
      // 2. Add to tournament_players
      const { error: te } = await sb.from('tournament_players').insert({
        tournament_id: tournamentId,
        player_id    : playerId,
        team_id      : playerData.teamId,
        credit_value : playerData.credits ?? 8,
        is_active    : true,
      });
      if (te) throw te;
      // 3. Create alias
      await sb.from('player_name_aliases').upsert({
        player_id    : playerId,
        tournament_id: tournamentId,
        alias        : rawName.toLowerCase().trim(),
        source,
      }, { onConflict: 'alias,source,tournament_id', ignoreDuplicates: true });
      // 4. Mark resolved
      const { error: re } = await sb
        .from('scraper_unmatched')
        .update({ resolved_at: new Date().toISOString(), resolved_by: 'new_player' })
        .eq('id', id);
      if (re) throw re;
      return playerId;
    },

    /** Dismiss an unmatched name without creating an alias (e.g. extras, sub fielder). */
    async ignoreUnmatched(id) {
      const sb = await getClient();
      const { error } = await sb
        .from('scraper_unmatched')
        .update({ resolved_at: new Date().toISOString(), resolved_by: 'ignored' })
        .eq('id', id);
      if (error) throw error;
    },

    // ── Placeholder ("Player Not Found") stat recovery ───────────────────────
    // poll-cricapi/scrape-scorecard capture the raw box-score numbers for a
    // source's own "couldn't identify this player" placeholder instead of
    // dropping them (see migration_v28_placeholder_stats.sql). These can NEVER
    // be resolved via an alias — the same literal string is a different real
    // player every time — so the only resolution path is a one-time manual
    // "credit this match's numbers to player X" action.

    /** Lightweight unresolved-count per tournament, for a "🧩 Recoverable Stats" badge. */
    async getPlaceholderStatsCounts(tournamentIds) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('scraper_placeholder_stats')
        .select('tournament_id')
        .in('tournament_id', tournamentIds)
        .is('resolved_at', null);
      if (error) throw error;
      const counts = new Map();
      for (const id of tournamentIds) counts.set(id, 0);
      for (const row of data ?? []) {
        counts.set(row.tournament_id, (counts.get(row.tournament_id) ?? 0) + 1);
      }
      return counts;
    },

    /** All unresolved placeholder-stat rows for a tournament, with match context. */
    async getPlaceholderStats(tournamentId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('scraper_placeholder_stats')
        .select(`
          id, match_id, source, context, raw_stats, created_at,
          match:matches!match_id(
            match_number,
            home_team:teams!home_team_id(name),
            away_team:teams!away_team_id(name)
          )
        `)
        .eq('tournament_id', tournamentId)
        .is('resolved_at', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(r => ({
        id        : r.id,
        matchId   : r.match_id,
        source    : r.source,
        context   : r.context,
        rawStats  : r.raw_stats, // { batting, bowling, fielding, raw_points }
        createdAt : r.created_at,
        matchLabel: r.match
          ? `M${r.match.match_number} · ${r.match.home_team?.name ?? '?'} vs ${r.match.away_team?.name ?? '?'}`
          : r.match_id,
      }));
    },

    /**
     * Force-credit one placeholder row's captured numbers to a chosen player,
     * for that one match only — no alias is ever created, so the next
     * occurrence of the same placeholder string (almost certainly a different
     * real player) is completely unaffected.
     *
     * Merges into player_match_stats rather than blindly overwriting: if the
     * target player already has real stats for the OTHER discipline in this
     * match (e.g. they bowled normally but the scraper also produced a
     * placeholder batting row that's actually them), both are kept. If they
     * already have real stats for the SAME discipline this row is trying to
     * credit, that's a genuine conflict (crediting would silently overwrite
     * real data) — this throws instead of guessing, same as the regression
     * guard in scrape-scorecard's per-player merge.
     *
     * Tags the row source='scraper_manual' (same value applyManualFieldingCredit
     * uses) so a later auto re-scrape/re-poll of this match can't silently
     * clobber the correction.
     */
    async creditPlaceholderStat(placeholderId, matchId, context, rawStats, playerId) {
      const sb = await getClient();
      const { data: existing, error: fe } = await sb
        .from('player_match_stats')
        .select('batting, bowling, fielding, raw_points')
        .eq('match_id', matchId).eq('player_id', playerId)
        .maybeSingle();
      if (fe) throw fe;

      if (context === 'batting' && existing?.batting) {
        throw new Error('This player already has batting stats for this match — crediting would overwrite real data. Resolve manually.');
      }
      if (context === 'bowling' && existing?.bowling) {
        throw new Error('This player already has bowling stats for this match — crediting would overwrite real data. Resolve manually.');
      }

      const patch = {
        match_id  : matchId,
        player_id : playerId,
        batting   : context === 'batting' ? (rawStats.batting ?? null) : (existing?.batting ?? null),
        bowling   : context === 'bowling' ? (rawStats.bowling ?? null) : (existing?.bowling ?? null),
        fielding  : existing?.fielding ?? rawStats.fielding ?? null,
        raw_points: (Number(existing?.raw_points) || 0) + (Number(rawStats.raw_points) || 0),
        source    : 'scraper_manual',
      };
      const { error } = await sb
        .from('player_match_stats')
        .upsert(patch, { onConflict: 'match_id,player_id' });
      if (error) throw error;

      const { error: re } = await sb
        .from('scraper_placeholder_stats')
        .update({ resolved_at: new Date().toISOString(), resolved_by: 'forced_stat', credited_player_id: playerId })
        .eq('id', placeholderId);
      if (re) throw re;
    },

    /** Dismiss a placeholder-stat row without crediting anyone (e.g. clearly a tail-end sub/extras artifact). */
    async ignorePlaceholderStat(id) {
      const sb = await getClient();
      const { error } = await sb
        .from('scraper_placeholder_stats')
        .update({ resolved_at: new Date().toISOString(), resolved_by: 'ignored' })
        .eq('id', id);
      if (error) throw error;
    },

    // ── Scraper fielding-issue reconciliation ────────────────────────────────
    // scrape-scorecard auto-derives fielding credit (catches/stumpings/run-outs)
    // and the bowler LBW/bowled bonus from each dismissal's scraped text. When a
    // named fielder can't be resolved to exactly one squad player it lands here
    // instead of being silently dropped — mirrors the scraper_unmatched pattern.

    /** Lightweight unresolved-count per tournament, for the "⚠️ Fielding Issues" badge. */
    async getFieldingIssuesCounts(tournamentIds) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('scraper_fielding_issues')
        .select('tournament_id')
        .in('tournament_id', tournamentIds)
        .is('resolved_at', null);
      if (error) throw error;
      const counts = new Map();
      for (const id of tournamentIds) counts.set(id, 0);
      for (const row of data ?? []) {
        counts.set(row.tournament_id, (counts.get(row.tournament_id) ?? 0) + 1);
      }
      return counts;
    },

    /** All unresolved fielding issues for a tournament, with match context. */
    async getFieldingIssues(tournamentId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('scraper_fielding_issues')
        .select(`
          id, tournament_id, raw_name, source, field, batter_name, dismissal_text, candidates, created_at,
          match_id,
          match:matches!match_id(
            match_number, format,
            home_team:teams!home_team_id(name),
            away_team:teams!away_team_id(name)
          )
        `)
        .eq('tournament_id', tournamentId)
        .is('resolved_at', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fi => ({
        id           : fi.id,
        tournamentId : fi.tournament_id,
        rawName      : fi.raw_name,
        source       : fi.source,
        field        : fi.field,
        batterName   : fi.batter_name,
        dismissalText: fi.dismissal_text,
        candidates   : fi.candidates,       // null = unmatched, array = ambiguous
        createdAt    : fi.created_at,
        matchId      : fi.match_id,
        matchFormat  : fi.match?.format || 'T20',
        matchLabel: fi.match
          ? `M${fi.match.match_number} · ${fi.match.home_team?.name ?? '?'} vs ${fi.match.away_team?.name ?? '?'}`
          : fi.match_id,
      }));
    },

    /**
     * Resolve a fielding issue by crediting it to a specific player, then
     * marking the row resolved.
     *
     * @param {boolean} createAlias - only pass true for the "unmatched" case
     *   (candidates === null). For an "ambiguous" issue (candidates is a real
     *   name list), DON'T create a tournament-wide alias — the raw text itself
     *   is genuinely ambiguous (e.g. two squad members sharing a surname), so
     *   aliasing it to whichever one was picked this time would silently
     *   mis-credit the OTHER one on a future match. Ambiguous issues are
     *   credited for this match only every time.
     */
    async resolveFieldingIssueAsCredit(issue, playerId, fieldingPoints, createAlias) {
      const sb = await getClient();
      // A placeholder raw name (e.g. "empty &") is a different real fielder
      // every time it shows up — same reasoning as isPlaceholderName above.
      // Never let it become a static alias, even if the caller asked for one
      // (unmatched case defaults createAlias to true); always fall back to
      // crediting this one match only.
      if (createAlias && this.isPlaceholderName(issue.rawName)) createAlias = false;
      if (createAlias) {
        const { error: ae } = await sb.from('player_name_aliases').upsert({
          player_id    : playerId,
          tournament_id: issue.tournamentId,
          alias        : issue.rawName.toLowerCase().trim(),
          source       : issue.source,
        }, { onConflict: 'alias,source,tournament_id', ignoreDuplicates: true });
        if (ae) throw ae;
      }
      await this.applyManualFieldingCredit(issue.matchId, playerId, issue.field, 1, fieldingPoints);
      const { error } = await sb
        .from('scraper_fielding_issues')
        .update({ resolved_at: new Date().toISOString(), resolved_by: createAlias ? 'alias' : 'credit_only' })
        .eq('id', issue.id);
      if (error) throw error;
      // Callers use this to report accurately whether an alias was actually
      // saved — it may differ from the requested createAlias if the raw name
      // turned out to be a placeholder (see override above).
      return { aliasCreated: createAlias };
    },

    /** Dismiss a fielding issue without crediting anyone (e.g. a sub fielder, or a mis-scraped dismissal line). */
    async ignoreFieldingIssue(id) {
      const sb = await getClient();
      const { error } = await sb
        .from('scraper_fielding_issues')
        .update({ resolved_at: new Date().toISOString(), resolved_by: 'ignored' })
        .eq('id', id);
      if (error) throw error;
    },

    /**
     * Apply a manual fielding/wicket-bonus credit directly to a player's
     * player_match_stats row for one match — the fallback the admin reaches for
     * when auto-derivation can't resolve a dismissal, AND the generic "add
     * fielding points for this player" entry point for scraper-completed
     * matches in general (catch/stumping/run-out-direct/run-out-indirect credit
     * a FIELDER; bowled/lbw credit the BOWLER's wicket-type bonus).
     *
     * Always tags the row source='scraper_manual' so a later auto re-scrape of
     * the same match (e.g. if completion-detection initially missed and the
     * cron runs again) never silently overwrites this correction — see the
     * per-player regression guard in scrape-scorecard/index.ts.
     *
     * `count` is the number of additional events to credit (usually 1).
     * `pointsDelta` is the points value of those `count` events — computed by
     * the caller via calcFielding()/SCORING_RULES so tournament-specific
     * scoring overrides are respected (this function does no scoring math
     * itself, matching the rest of this file's client-computes-points convention).
     *
     * @param {string} matchId
     * @param {string} playerId
     * @param {'catches'|'stumpings'|'runOutDirect'|'runOutIndirect'|'bowled'|'lbw'} field
     * @param {number} count
     * @param {number} pointsDelta
     */
    async applyManualFieldingCredit(matchId, playerId, field, count, pointsDelta) {
      const sb = await getClient();
      const { data: existing, error: fe } = await sb
        .from('player_match_stats')
        .select('batting, bowling, fielding, raw_points')
        .eq('match_id', matchId).eq('player_id', playerId)
        .maybeSingle();
      if (fe) throw fe;

      const patch = {
        match_id  : matchId,
        player_id : playerId,
        batting   : existing?.batting ?? null,
        bowling   : existing?.bowling ?? null,
        fielding  : existing?.fielding ?? null,
        raw_points: (Number(existing?.raw_points) || 0) + (Number(pointsDelta) || 0),
        source    : 'scraper_manual',
      };

      if (field === 'bowled' || field === 'lbw') {
        const bowling = { wickets: 0, wicketTypes: [], maidens: 0, runsConceded: 0, ballsBowled: 0, dotBalls: 0, noBalls: 0, wides: 0, ...patch.bowling };
        bowling.wicketTypes = [...(bowling.wicketTypes || []), ...Array(count).fill(field)];
        patch.bowling = bowling;
      } else {
        const fielding = { catches: 0, stumpings: 0, runOutDirect: 0, runOutIndirect: 0, ...patch.fielding };
        fielding[field] = (fielding[field] || 0) + count;
        patch.fielding = fielding;
      }

      const { error } = await sb
        .from('player_match_stats')
        .upsert(patch, { onConflict: 'match_id,player_id' });
      if (error) throw error;
    },

    // ────────────────────────────────────────────────────────────────────────

    /** Matches for a single tournament, newest match_number first. tournamentId is required —
     *  without it we'd silently return every tournament's matches, which has caused
     *  cross-tournament leaks (e.g. other tournaments' saved teams showing up together). */
    async listMatches(tournamentId) {
      if (!tournamentId) { console.warn('[listMatches] called without tournamentId — returning [] to avoid a cross-tournament leak.'); return []; }
      const sb = await getClient();
      const { data, error } = await sb.from('matches').select('*')
        .eq('tournament_id', tournamentId)
        .order('match_number', { ascending: true, nullsFirst: false });
      if (error) throw error;
      return data;
    },

    /** Lightweight status read for one match — used by the scraper-backed live poller
     *  to detect completion without re-fetching the whole matches table. */
    async getMatchStatus(matchId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('matches').select('status').eq('id', matchId).maybeSingle();
      if (error) throw error;
      return data?.status ?? null;
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
        lock_time    : input.lockTime   ?? null,
        status       : input.status     ?? 'scheduled',
        match_type   : input.matchType  ?? null,
        notes        : input.notes      ?? null,
        external_id  : input.externalId ?? null,
        data_source  : input.dataSource ?? 'auto',
      };
      const { data, error } = await sb.from('matches').insert(row).select().single();
      if (error) throw error;
      return data;
    },

    /**
     * Bulk-insert matches (used by the Schedule tab's CSV importer). Unlike
     * bulkUpsertPlayers this is insert-only — CSV-uploaded matches have no
     * external_id to key an upsert on, so re-uploading the same CSV creates
     * duplicates rather than updating existing rows (same as adding the same
     * match twice by hand via addMatch).
     *
     * Splits into 50-row chunks for the same reason bulkUpsertPlayers does.
     *
     * @param {Array<{tournamentId, matchNumber, format, homeTeamId, awayTeamId, playedOn, startTime}>} rows
     * @returns {Promise<Array<object>>} the inserted match rows
     */
    async bulkAddMatches(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return [];
      const sb = await getClient();

      const payload = rows.map(r => {
        if (!r.format || !r.homeTeamId || !r.awayTeamId || !r.playedOn || !r.startTime) {
          throw new Error(`bulkAddMatches: row missing required fields → ${JSON.stringify(r)}`);
        }
        return {
          tournament_id: r.tournamentId ?? null,
          match_number : r.matchNumber  ?? null,
          format       : r.format,
          home_team_id : r.homeTeamId,
          away_team_id : r.awayTeamId,
          played_on    : r.playedOn,
          start_time   : r.startTime,
          status       : 'scheduled',
          data_source  : 'auto',
        };
      });

      const CHUNK = 50;
      let inserted = [];
      for (let i = 0; i < payload.length; i += CHUNK) {
        const slice = payload.slice(i, i + CHUNK);
        const { data, error } = await sb.from('matches').insert(slice).select();
        if (error) {
          throw new Error(`Insert failed on rows ${i+1}–${i+slice.length}: ${error.message}`);
        }
        inserted = inserted.concat(data || []);
      }
      return inserted;
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
      if (patch.lockTime     !== undefined) row.lock_time     = patch.lockTime;
      if (patch.status       !== undefined) row.status        = patch.status;
      if (patch.matchType    !== undefined) row.match_type    = patch.matchType ?? null;
      if (patch.notes        !== undefined) row.notes         = patch.notes;
      if (patch.externalId   !== undefined) row.external_id   = patch.externalId;
      if (patch.dataSource   !== undefined) row.data_source   = patch.dataSource ?? 'auto';
      // Used by the admin "Revert to Live" button — resets the staleness-guard
      // watermark (migration_v27) when un-completing a match whose completion
      // signal turned out to be wrong, so the next genuine Poll/Scrape isn't
      // rejected as a regression against the bad reading that caused this.
      if (patch.progressInnings !== undefined) row.progress_innings = patch.progressInnings;
      if (patch.progressBalls   !== undefined) row.progress_balls   = patch.progressBalls;
      const { data, error } = await sb.from('matches').update(row).eq('id', id).select().single();
      if (error) throw error;
      return data;
    },

    /**
     * Revert a match lock — deletes all user_match_xi rows for a given match.
     *
     * Use this when a match is delayed AFTER its lock time has already fired.
     * Deleting the locked XI rows lets users re-pick from their squad_draft_xi
     * until the rescheduled lock_time arrives.
     *
     * Requires the "user_match_xi_admin_delete" policy from migration_v20.
     *
     * Returns the count of deleted rows.
     */
    async revertMatchLock(matchId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_match_xi')
        .delete()
        .eq('match_id', matchId)
        .select('id');
      if (error) throw error;
      return data?.length ?? 0;
    },

    /**
     * Revert a DAILY team lock — clears locked_at on every daily user_teams
     * row (squad_id IS NULL) for a given match.
     *
     * Daily teams are gated entirely by RLS (migration_v27_daily_team_lock_rls.sql):
     * once a match's lock gate (lock_time, falling back to start_time) has
     * passed, INSERT/UPDATE on user_teams and INSERT/DELETE on
     * user_team_players are denied for that match. So if a match is delayed
     * AFTER its lock time already fired, just clearing locked_at here is
     * cosmetic — the real unlock requires the match's lock_time to be moved
     * forward (admin reschedules it), which is what actually re-opens the
     * RLS gate. Call this alongside that reschedule so the "Locked" badge in
     * the UI clears too.
     *
     * Requires the "user_teams_admin_unlock" policy from migration_v27.
     *
     * Returns the count of updated rows.
     */
    async revertDailyTeamLock(matchId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_teams')
        .update({ locked_at: null })
        .eq('match_id', matchId)
        .is('squad_id', null)
        .select('id');
      if (error) throw error;
      return data?.length ?? 0;
    },

    /**
     * Returns completed matches that have an external_id (CricAPI link) but
     * zero player_match_stats rows yet — i.e. ready to be "finalized".
     *
     * Each returned match is annotated with `cachedScorecard: true/false` so
     * the caller can skip the CricAPI fetch when a saved payload already exists.
     */
    async listMatchesNeedingFinalization(tournamentId) {
      const sb = await getClient();
      let mq = sb
        .from('matches')
        .select('id, match_number, format, home_team_id, away_team_id, external_id, played_on, status, notes')
        .eq('status', 'completed')
        .not('external_id', 'is', null);
      if (tournamentId) mq = mq.eq('tournament_id', tournamentId);
      const { data: completed, error: e1 } = await mq;
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
          lock_time    : r.lockTime     ?? null,
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

    /**
     * Remap team codes on all matches for a tournament.
     * Useful after a CricAPI sync creates new team IDs that don't match
     * the codes already used for players (e.g. "IND-W" vs "INDW").
     *
     * @param {string} tournamentId
     * @param {Array<{from: string, to: string}>} mapping  e.g. [{from:'IND-W', to:'INDW'}]
     */
    async remapMatchTeams(tournamentId, mapping) {
      if (!mapping.length) return;
      const sb = await getClient();
      for (const { from, to } of mapping) {
        const { error: e1 } = await sb
          .from('matches')
          .update({ home_team_id: to })
          .eq('tournament_id', tournamentId)
          .eq('home_team_id', from);
        if (e1) throw new Error(`remapMatchTeams home ${from}→${to}: ${e1.message}`);
        const { error: e2 } = await sb
          .from('matches')
          .update({ away_team_id: to })
          .eq('tournament_id', tournamentId)
          .eq('away_team_id', from);
        if (e2) throw new Error(`remapMatchTeams away ${from}→${to}: ${e2.message}`);
      }
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

    /** Player stats for one match — raw_points per player (pre-computed using tournament rules). */
    async getPlayerStatsForMatch(matchId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('player_match_stats')
        .select('player_id, raw_points, source')
        .eq('match_id', matchId);
      if (error) throw error;
      return data || [];
    },

    /**
     * Full player stats for one match — includes batting/bowling/fielding objects
     * so callers can re-score with custom rules.
     */
    async getPlayerStatsForMatchFull(matchId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('player_match_stats')
        .select('player_id, raw_points, batting, bowling, fielding')
        .eq('match_id', matchId);
      if (error) throw error;
      return data || [];
    },

    /**
     * Batched "recent form" lookup for many players at once — last `matchLimit`
     * fantasy-point totals per player, newest match first. Used by the XI picker
     * grid so showing a form strip on every card costs one round trip instead of
     * one query per player.
     *
     * @param {string[]} playerIds
     * @param {number} [matchLimit=3]
     * @param {string} [tournamentId] - when given, only matches from this tournament count.
     *   Without this, a player who has stats rows from another tournament (e.g. the same
     *   global player_id reused/shared across competitions) would leak those into the form
     *   strip. Always pass the active tournament's id from the caller.
     * @returns {Promise<Object<string, number[]>>} playerId → [pts most-recent..older]
     */
    async getRecentFormForPlayers(playerIds, matchLimit = 3, tournamentId = null) {
      if (!playerIds?.length) return {};
      const sb = await getClient();

      // Fetch the candidate matches FIRST and scope the stats query to just
      // those match ids. Querying player_match_stats by player_id alone (no
      // match/tournament bound) pulls every stats row those players have ever
      // had across every tournament they've ever played — with dozens of
      // players that can be thousands of rows, and PostgREST silently caps
      // unbounded results at 1000. Rows can get truncated before the most
      // recent match's row even appears, so a player's latest points can
      // vanish from this batched form-strip lookup while still showing up
      // fine in the single-player getPlayerMatchHistory() (which only ever
      // queries one player_id, so it never gets near the cap). Scoping by
      // tournament's matches up front keeps the result set small and bounded
      // instead of "all history for all players".
      let matchQuery = sb.from('matches').select('id, match_number');
      matchQuery = tournamentId
        ? matchQuery.eq('tournament_id', tournamentId)
        : matchQuery; // no tournament given: fall back to old (unbounded) behavior below
      const { data: tMatches, error: tMatchErr } = await matchQuery;
      if (tMatchErr) throw tMatchErr;

      let stats, matches;
      if (tournamentId) {
        const matchIds = (tMatches || []).map(m => m.id);
        if (!matchIds.length) return {};
        const { data, error: statsErr } = await sb
          .from('player_match_stats')
          .select('player_id, match_id, raw_points')
          .in('player_id', playerIds)
          .in('match_id', matchIds);
        if (statsErr) throw statsErr;
        stats   = data;
        matches = tMatches;
      } else {
        // No tournament given — keep prior (unbounded) behavior as a fallback.
        const { data, error: statsErr } = await sb
          .from('player_match_stats')
          .select('player_id, match_id, raw_points')
          .in('player_id', playerIds);
        if (statsErr) throw statsErr;
        stats = data;
        if (!stats?.length) return {};
        const matchIds = [...new Set(stats.map(s => s.match_id))];
        const { data: mData, error: matchErr } = await sb
          .from('matches').select('id, match_number').in('id', matchIds);
        if (matchErr) throw matchErr;
        matches = mData;
      }
      if (!stats?.length) return {};

      const matchNumMap = Object.fromEntries((matches || []).map(m => [m.id, m.match_number || 0]));
      const validMatchIds = new Set((matches || []).map(m => m.id));

      const byPlayer = {};
      stats.filter(s => validMatchIds.has(s.match_id)).forEach(s => {
        (byPlayer[s.player_id] = byPlayer[s.player_id] || []).push({
          matchNumber: matchNumMap[s.match_id] ?? 0,
          points: s.raw_points != null ? Number(s.raw_points) : null,
        });
      });
      const out = {};
      Object.entries(byPlayer).forEach(([pid, rows]) => {
        out[pid] = rows
          .sort((a, b) => b.matchNumber - a.matchNumber)
          .slice(0, matchLimit)
          .map(r => r.points);
      });
      return out;
    },

    /**
     * Match-by-match fantasy history for one player — powers the picker's
     * "stats" popup so users can see exactly how a player has performed
     * (opponent, batting/bowling/fielding line, fantasy points) before
     * adding them to their XI. Returns rows newest-match first.
     *
     * @param {string} playerId
     * @param {number} [limit=8]
     * @param {string} [tournamentId] - when given, only matches from this tournament are
     *   returned. Without this, a player whose global id has stats rows from another
     *   tournament would show unrelated matches (e.g. a women's-tournament player showing
     *   up with IPL points). Always pass the active tournament's id from the caller.
     */
    async getPlayerMatchHistory(playerId, limit = 8, tournamentId = null) {
      const sb = await getClient();
      const { data: stats, error: statsErr } = await sb
        .from('player_match_stats')
        .select('match_id, raw_points, batting, bowling, fielding')
        .eq('player_id', playerId);
      if (statsErr) throw statsErr;
      if (!stats?.length) return [];

      const matchIds = stats.map(s => s.match_id);
      let matchQuery = sb
        .from('matches')
        .select('id, match_number, home_team_id, away_team_id, start_time, status, tournament_id')
        .in('id', matchIds);
      if (tournamentId) matchQuery = matchQuery.eq('tournament_id', tournamentId);
      const { data: matches, error: matchErr } = await matchQuery;
      if (matchErr) throw matchErr;
      const matchMap = Object.fromEntries((matches || []).map(m => [m.id, m]));

      return stats
        .map(s => ({ ...s, match: matchMap[s.match_id] || null }))
        .filter(s => s.match)
        .sort((a, b) => (b.match.match_number || 0) - (a.match.match_number || 0))
        .slice(0, limit)
        .map(s => ({
          matchId    : s.match_id,
          matchNumber: s.match.match_number,
          homeTeam   : s.match.home_team_id,
          awayTeam   : s.match.away_team_id,
          startTime  : s.match.start_time,
          status     : s.match.status,
          rawPoints  : s.raw_points != null ? Number(s.raw_points) : null,
          batting    : s.batting  ?? null,
          bowling    : s.bowling  ?? null,
          fielding   : s.fielding ?? null,
        }));
    },

    /**
     * Return the contest_id for a squad.
     * Used by the scoring pipeline to resolve per-contest rules.
     *
     * @param {string} squadId
     * @returns {Promise<string|null>}
     */
    async getContestIdForSquad(squadId) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_squads').select('contest_id').eq('id', squadId).maybeSingle();
      if (error) throw error;
      return data?.contest_id ?? null;
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

    /**
     * Upsert the signed-in user's profile fields. Two different "don't
     * clobber" rules apply here:
     *  - display_name / team_name are "first write wins" — once set they're
     *    never overwritten by a later call, even if a new value is passed.
     *    This is called on every login/DB reconnect with a metadata-derived
     *    fallback name (usually the email), so routine logins must not
     *    stomp a name the user set manually. team_name specifically is a
     *    one-time setup field (set at signup, shown read-only afterwards),
     *    so locking it here is what actually enforces that.
     *  - first_name / last_name are overwritten whenever explicitly passed
     *    (e.g. from the profile-edit screen) — pass `undefined` to leave
     *    them untouched instead of clearing them.
     */
    async upsertProfile({ userId, displayName, email, firstName, lastName, teamName }) {
      const sb = await getClient();
      const { data: existing } = await sb.from('profiles')
        .select('display_name, team_name, first_name, last_name').eq('id', userId).maybeSingle();
      const finalDisplayName = existing?.display_name || displayName || null;
      const finalTeamName    = existing?.team_name || teamName || null;
      const finalFirstName   = firstName !== undefined ? firstName : (existing?.first_name ?? null);
      const finalLastName    = lastName  !== undefined ? lastName  : (existing?.last_name ?? null);
      const { error } = await sb.from('profiles').upsert({
        id: userId,
        display_name: finalDisplayName,
        email,
        team_name: finalTeamName,
        first_name: finalFirstName,
        last_name: finalLastName,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      if (error) throw error;
    },

    /** Fetch the signed-in user's profile row, including the structured
     *  first/last/team name fields added in migration_v33. */
    async getMyProfile(userId) {
      const sb = await getClient();
      const { data, error } = await sb.from('profiles')
        .select('display_name, email, first_name, last_name, team_name').eq('id', userId).single();
      if (error) return null;
      return data;
    },

    /** Returns a map of userId → leaderboard name. Prefers team_name (the
     *  user's persistent leaderboard identity) and falls back to
     *  display_name, then email, then a truncated id for legacy rows that
     *  predate migration_v33. */
    async getProfiles() {
      const sb = await getClient();
      const { data, error } = await sb.from('profiles').select('id, display_name, email, team_name');
      if (error) throw error;
      const map = {};
      (data || []).forEach(p => { map[p.id] = resolveDisplayName(p); });
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
          teamId      : t.id,
          teamName    : t.name,
          totalPoints : Number(t.user_team_match_scores?.[0]?.total_points ?? 0),
        }))
        .sort((a, b) => b.totalPoints - a.totalPoints);
    },

    /**
     * Fetch all daily teams for a match with their full player rosters.
     * Used for live leaderboard computation (scoring done client-side from state.stats).
     * Returns [{teamId, teamName, userId, captainId, vcId, playerIds:[...]}]
     */
    async getAllTeamPlayersForMatch(matchId) {
      const sb = await getClient();
      const { data: teams, error: tErr } = await sb
        .from('user_teams')
        .select('id, name, user_id, captain_id, vice_captain_id')
        .eq('match_id', matchId)
        .is('squad_id', null);
      if (tErr) throw tErr;
      if (!teams?.length) return [];

      const teamIds = teams.map(t => t.id);
      const { data: tp, error: pErr } = await sb
        .from('user_team_players')
        .select('user_team_id, player_id')
        .in('user_team_id', teamIds);
      if (pErr) throw pErr;

      const byTeam = {};
      (tp || []).forEach(r => {
        if (!byTeam[r.user_team_id]) byTeam[r.user_team_id] = [];
        byTeam[r.user_team_id].push(r.player_id);
      });

      return teams.map(t => ({
        teamId    : t.id,
        teamName  : t.name,
        userId    : t.user_id,
        captainId : t.captain_id,
        vcId      : t.vice_captain_id,
        playerIds : byTeam[t.id] || [],
      }));
    },

    /**
     * Fetch full XI + live stats for one daily team in one match — powers the
     * "Full view" expand row on the Contest tab leaderboard.
     * Returns {
     *   teamId, teamName, captainId, viceCaptainId, totalPoints,
     *   players: [{ player_id, name, role, team_id, raw_points, batting, bowling,
     *               fielding, is_captain, is_vc, multiplier, total_points }]
     * }
     * total_points already has the captain (x2) / vice-captain (x1.5) multiplier
     * applied, matching the scoring logic used by computeAndSaveXIScoresForMatch
     * (client) and scoreDailyTeamsForMatch (cron Edge Function).
     */
    async getTeamMatchPlayers(teamId, matchId) {
      const sb = await getClient();
      const [{ data: team }, { data: tp }] = await Promise.all([
        sb.from('user_teams').select('name, captain_id, vice_captain_id, squad_id').eq('id', teamId).single(),
        sb.from('user_team_players').select('player_id').eq('user_team_id', teamId),
      ]);
      const pids = (tp || []).map(r => r.player_id);
      const base = {
        teamId       : teamId,
        teamName     : team?.name ?? '',
        captainId    : team?.captain_id     ?? null,
        viceCaptainId: team?.vice_captain_id ?? null,
      };
      if (!pids.length) return { ...base, totalPoints: 0, players: [] };
      const [{ data: players }, { data: stats }] = await Promise.all([
        sb.from('players').select('id, name, role, team_id').in('id', pids),
        sb.from('player_match_stats').select('player_id, raw_points, batting, bowling, fielding')
          .eq('match_id', matchId).in('player_id', pids),
      ]);
      const playerMap = Object.fromEntries((players || []).map(p => [p.id, p]));
      const statsMap  = Object.fromEntries((stats  || []).map(s => [s.player_id, s]));

      // Teams linked to a squad (Season Long XIs — squad_id is set per
      // migration_v4) are the ones eligible for boosters (triple_captain,
      // dual_captain, etc. — see user_booster_activations). The authoritative
      // per-player base/multiplier/total for those already live in
      // user_match_xi_scores, computed by the scoring cron with full booster
      // awareness. Recomputing from scratch here with a hardcoded
      // captain=2x/vc=1.5x (as this used to do) silently ignored any active
      // booster, so e.g. triple_captain (3x) would still display as 2X.
      // Ad-hoc daily teams (squad_id IS NULL) have no booster support at all,
      // so they keep the simple hardcoded multiplier.
      let xiScoreMap = {};
      if (team?.squad_id) {
        const { data: xiScores } = await sb
          .from('user_match_xi_scores')
          .select('player_id, base_points, multiplier, total_points')
          .eq('squad_id', team.squad_id)
          .eq('match_id', matchId)
          .in('player_id', pids);
        xiScoreMap = Object.fromEntries((xiScores || []).map(s => [s.player_id, s]));
      }

      let totalPoints = 0;
      const playerRows = pids.map(pid => {
        const p = playerMap[pid] || {};
        const s = statsMap[pid]  || {};
        const isCaptain = pid === base.captainId;
        const isVc      = pid === base.viceCaptainId;
        const xiScore   = xiScoreMap[pid];
        const raw        = xiScore ? Number(xiScore.base_points)
          : (s.raw_points != null ? Number(s.raw_points) : null);
        const multiplier = xiScore ? Number(xiScore.multiplier) : (isCaptain ? 2 : isVc ? 1.5 : 1);
        const totalPts   = xiScore ? Number(xiScore.total_points)
          : (raw != null ? Math.round(raw * multiplier * 10) / 10 : null);
        if (totalPts != null) totalPoints += totalPts;
        return {
          player_id   : pid,
          name        : p.name || pid,
          role        : p.role || '',
          team_id     : p.team_id ?? null,
          raw_points  : raw,
          batting     : s.batting   ?? null,
          bowling     : s.bowling   ?? null,
          fielding    : s.fielding  ?? null,
          is_captain  : isCaptain,
          is_vc       : isVc,
          multiplier,
          total_points: totalPts,
        };
      });
      return { ...base, totalPoints: Math.round(totalPoints * 10) / 10, players: playerRows };
    },

    /**
     * Season Long leaderboard for a contest.
     * Returns array sorted by cumulative points desc:
     *   [{ userId, squadName, totalPoints, matchCount }]
     */
    async getLeaderboardSL(contestId) {
      const sb = await getClient();
      // Get all squads in this contest
      const { data: squads, error: sErr } = await sb
        .from('user_squads')
        .select('id, name, user_id')
        .eq('contest_id', contestId);
      if (sErr) throw sErr;
      if (!squads?.length) return [];

      const squadIds = squads.map(s => s.id);

      // Fetch the actual person's name for all users in this contest — NOT
      // resolveDisplayName/team_name, since the squad's own name (shown as
      // its own bold line below) is itself usually just the account's
      // team_name. Using resolveDisplayName here showed the same team name
      // twice, once as the squad name and once as this "owned by" sub-line.
      const userIds = [...new Set(squads.map(s => s.user_id).filter(Boolean))];
      const profileMap = {};
      if (userIds.length) {
        const { data: profiles } = await sb
          .from('profiles')
          .select('id, display_name, email, team_name, first_name, last_name')
          .in('id', userIds);
        (profiles || []).forEach(p => {
          profileMap[p.id] = resolvePersonName(p);
        });
      }

      // SL scores live in user_match_xi_scores (one row per player per squad per match) —
      // squads × matches × 11 players routinely exceeds PostgREST's 1000-row
      // default cap for a season-long contest, so this MUST paginate (see
      // fetchAllRows) or it silently truncates and undercounts whichever
      // squads' rows land past the cutoff.
      // user_team_match_scores is the daily pipeline and never receives SL data.
      const scores = await fetchAllRows((from, to) => sb
        .from('user_match_xi_scores')
        .select('squad_id, match_id, total_points')
        .in('squad_id', squadIds)
        .range(from, to));

      // Fetch transfer penalties for all squads in this contest. match_id is
      // needed below to gate the "Xfers used" COUNT on lock status (points
      // penalty itself is left as-is — not what was reported). Paginated for
      // the same reason as scores above — smaller in practice, but a large
      // contest could still cross the cap over a full season.
      const xferRows = await fetchAllRows((from, to) => sb
        .from('user_transfers')
        .select('squad_id, match_id, points_deducted')
        .in('squad_id', squadIds)
        .range(from, to));

      const penaltyBySquad = {};
      (xferRows || []).forEach(t => {
        penaltyBySquad[t.squad_id] = (penaltyBySquad[t.squad_id] || 0) + Number(t.points_deducted ?? 0);
      });

      // Contest-level caps for the Booster / Xfers "used / allowed" leaderboard
      // columns. available_boosters is a JSONB map of booster_key -> uses
      // allowed per squad (see migration_v12) — sum its values for the total
      // booster budget.
      //
      // Xfers cap is PHASE-AWARE, not a flat total_transfers_allowed: once
      // the playoff phase starts, the relevant cap is playoff_transfers_allowed
      // (pooled across the playoff matches), and if playoff_first_match_unlimited
      // is set, the current phase can resolve to fully unlimited (null) on the
      // first playoff match — same rules Pick XI's "Xfers" pill already uses,
      // via resolvePhaseWindow. Previously this leaderboard column always used
      // the flat season total, so it kept counting down from the league-stage
      // figure straight through the playoff opener instead of resetting.
      const { data: contestRow } = await sb
        .from('contests')
        .select('tournament_id, available_boosters, total_transfers_allowed, start_match_number, playoff_start_match_number, playoff_transfers_allowed, playoff_first_match_unlimited')
        .eq('id', contestId)
        .maybeSingle();
      const boosterAllowed = contestRow?.available_boosters
        ? Object.values(contestRow.available_boosters).reduce((sum, n) => sum + Number(n || 0), 0)
        : 0;

      let transfersAllowed = contestRow?.total_transfers_allowed ?? null;
      let phaseIds = null; // null = no phase filter (count everything, legacy behavior)
      if (contestRow?.tournament_id) {
        const { data: tournamentMatches } = await sb
          .from('matches')
          .select('id, match_number, status, start_time, lock_time')
          .eq('tournament_id', contestRow.tournament_id);
        const targetMatchNumber = pickCurrentMatchNumber(tournamentMatches || []);
        const window = resolvePhaseWindow(
          targetMatchNumber,
          tournamentMatches || [],
          contestRow.start_match_number         ?? null,
          contestRow.playoff_start_match_number ?? null,
          contestRow.total_transfers_allowed     ?? null,
          contestRow.playoff_transfers_allowed   ?? null,
          contestRow.playoff_first_match_unlimited ?? false,
        );
        transfersAllowed = window.activeCap;
        phaseIds = window.phaseIds;
      }

      // Fetch booster activation counts for all squads in this contest.
      // Requires the "booster_activations_read_all" policy (migration_v31) —
      // without it this silently returns only the viewer's own squad's rows,
      // same RLS pitfall migration_v30 fixed for user_transfers. Paginated
      // for the same 1000-row cap reason as scores/xferRows above.
      const boosterRows = await fetchAllRows((from, to) => sb
        .from('user_booster_activations')
        .select('squad_id, match_id, booster')
        .in('squad_id', squadIds)
        .range(from, to));

      // Both a booster activation AND a transfer are committed to the DB as
      // soon as a squad hits Save — which can be well before the match they
      // apply to actually starts. Showing either on this PUBLIC leaderboard
      // before that match locks leaks strategy to opponents (e.g. "they've
      // already burned Triple Captain for next week" or "they just made 3
      // transfers"), so both only count once their match has actually locked
      // (coalesce(lock_time, start_time) <= now()).
      const candidateMatchIds = [
        ...(boosterRows || []).map(b => b.match_id),
        ...(xferRows    || []).map(t => t.match_id),
      ].filter(Boolean);
      const lockedMatchIds = new Set();
      if (candidateMatchIds.length) {
        const { data: matchRows } = await sb
          .from('matches')
          .select('id, lock_time, start_time')
          .in('id', [...new Set(candidateMatchIds)]);
        const now = Date.now();
        (matchRows || []).forEach(m => {
          const lockAt = m.lock_time ?? m.start_time ?? null;
          if (lockAt && new Date(lockAt).getTime() <= now) lockedMatchIds.add(m.id);
        });
      }

      const boosterCountBySquad = {};
      // (squad_id, match_id) pairs where Wildcard/Free Hit was active — those
      // matches' transfers were free of cost and never actually charged
      // against the season cap (lock-matches bypasses transfer-count
      // logging entirely for either booster), so transferCount below must
      // exclude them too. Same class of fix already applied to the Pick XI
      // info bar/stat box and the two match-history views — this summary
      // row was the one place left still showing them as if they counted.
      const bypassedSquadMatch = new Set();
      (boosterRows || []).forEach(b => {
        if (!lockedMatchIds.has(b.match_id)) return; // match hasn't locked yet — don't count
        boosterCountBySquad[b.squad_id] = (boosterCountBySquad[b.squad_id] || 0) + 1;
        if (b.booster === 'wildcard' || b.booster === 'free_hit') {
          bypassedSquadMatch.add(b.squad_id + '::' + b.match_id);
        }
      });

      // Sum all player points per squad; count distinct matches where squad scored > 0
      const pointsBySquad = {};
      const matchesBySquad = {};
      (scores || []).forEach(s => {
        const pts = Number(s.total_points ?? 0);
        pointsBySquad[s.squad_id]  = (pointsBySquad[s.squad_id]  || 0) + pts;
        if (pts > 0) {
          if (!matchesBySquad[s.squad_id]) matchesBySquad[s.squad_id] = new Set();
          matchesBySquad[s.squad_id].add(s.match_id);
        }
      });

      return squads
        .map(s => ({
          userId      : s.user_id,
          squadId     : s.id,
          squadName   : s.name,
          displayName : s.user_id ? (profileMap[s.user_id] ?? null) : null,
          // Net points = raw fantasy points minus transfer penalties
          totalPoints : (pointsBySquad[s.id] || 0) - (penaltyBySquad[s.id] || 0),
          matchCount  : matchesBySquad[s.id]?.size  || 0,
          // Only counts transfers whose match has actually locked (see
          // lockedMatchIds comment above), whose match wasn't under
          // Wildcard/Free Hit (see bypassedSquadMatch comment above) — a
          // free transfer was never actually charged, so it shouldn't show
          // as having spent part of the season budget — AND whose match
          // falls within the CURRENT phase window (phaseIds above) — a
          // league-stage transfer shouldn't keep counting against the
          // playoff budget once playoffs start, and vice versa.
          transferCount   : (xferRows || []).filter(t =>
            t.squad_id === s.id && lockedMatchIds.has(t.match_id) &&
            !bypassedSquadMatch.has(s.id + '::' + t.match_id) &&
            (phaseIds === null || phaseIds.has(t.match_id))
          ).length,
          transfersAllowed,
          boosterCount    : boosterCountBySquad[s.id] || 0,
          boosterAllowed,
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
              fielding  : ps?.fielding  ?? null,
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
    /**
     * Load scoring-rule overrides for a tournament.
     * Primary source: tournaments.scoring_rules JSONB column (tournament-scoped).
     * Fallback: legacy global scoring_rules table (pre-v10 data).
     *
     * @param {string} [tournamentId]
     * @returns {Promise<{T20?:object, ODI?:object, TEST?:object}>}
     */
    async getScoringRules(tournamentId) {
      const sb = await getClient();
      if (tournamentId) {
        const { data, error } = await sb
          .from('tournaments')
          .select('scoring_rules')
          .eq('id', tournamentId)
          .single();
        if (!error && data?.scoring_rules) return data.scoring_rules;
      }
      // Legacy fallback: global scoring_rules table (kept for backward compat)
      const { data, error } = await sb.from('scoring_rules').select('format, rules');
      if (error) throw error;
      const out = {};
      (data || []).forEach(r => { out[r.format] = r.rules; });
      return out;
    },

    /**
     * Save one format's rules into the tournament row (tournaments.scoring_rules JSONB).
     * Merges — other formats are preserved.
     *
     * @param {string} tournamentId
     * @param {'T20'|'ODI'|'TEST'} format
     * @param {object} rules
     */
    async saveScoringRules(tournamentId, format, rules) {
      if (!['T20', 'ODI', 'TEST'].includes(format)) throw new Error('saveScoringRules: bad format');
      if (!tournamentId) throw new Error('saveScoringRules: tournamentId required');
      const sb = await getClient();
      // Read current JSONB so we can merge rather than overwrite other formats
      const { data: t, error: tErr } = await sb
        .from('tournaments').select('scoring_rules').eq('id', tournamentId).single();
      if (tErr) throw tErr;
      const merged = { ...(t?.scoring_rules || {}), [format]: rules };
      const { error } = await sb
        .from('tournaments').update({ scoring_rules: merged }).eq('id', tournamentId);
      if (error) throw error;
    },

    /**
     * Remove one format's overrides from the tournament row — reverts to in-code defaults.
     *
     * @param {string} tournamentId
     * @param {'T20'|'ODI'|'TEST'} format
     */
    async resetScoringRules(tournamentId, format) {
      if (!tournamentId) throw new Error('resetScoringRules: tournamentId required');
      const sb = await getClient();
      const { data: t, error: tErr } = await sb
        .from('tournaments').select('scoring_rules').eq('id', tournamentId).single();
      if (tErr) throw tErr;
      const merged = { ...(t?.scoring_rules || {}) };
      delete merged[format];
      const { error } = await sb
        .from('tournaments')
        .update({ scoring_rules: Object.keys(merged).length ? merged : null })
        .eq('id', tournamentId);
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
      // Try with all phase-config columns (v3 + v5 + v11 migrations).
      // Falls back gracefully if columns don't exist yet.
      const { data, error } = await sb
        .from('contests')
        .select('id, name, contest_type, description, is_active, free_transfers_per_match, extra_transfer_point_cost, total_transfers_allowed, start_match_number, playoff_start_match_number, playoff_transfers_allowed, playoff_first_match_unlimited, is_private, invite_code, scoring_rules, max_members, available_boosters')
        .eq('tournament_id', tournamentId)
        .eq('is_active', true)
        .order('contest_type');   // 'daily' < 'season_long' alphabetically

      if (error) {
        // Column-not-found errors from PostgREST contain "does not exist"
        if (String(error.message || '').includes('does not exist')) {
          console.warn('[db] getContests: some columns missing — run migration_v3, _v5 and/or _v11. Falling back to base columns.');
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
            playoff_first_match_unlimited: false,
            is_private                  : false,
            invite_code                 : null,
            scoring_rules               : null,
            max_members                 : null,
            _migrationNeeded            : true,   // flag for the UI to surface a warning
          }));
        }
        throw error;
      }
      const mapped = (data || []).map(c => ({
        ...c,
        start_match_number         : c.start_match_number         ?? null,
        playoff_start_match_number : c.playoff_start_match_number ?? null,
        playoff_transfers_allowed  : c.playoff_transfers_allowed  ?? null,
        playoff_first_match_unlimited: c.playoff_first_match_unlimited ?? false,
        is_private                 : c.is_private                 ?? false,
        invite_code                : c.invite_code                ?? null,
        scoring_rules              : c.scoring_rules              ?? null,
        max_members                : c.max_members                ?? null,
        available_boosters         : c.available_boosters         ?? null,
      }));
      return mapped;
    },

    /**
     * Resolve the effective scoring rules for a contest.
     * Priority: contest.scoring_rules → tournament.scoring_rules → null (caller falls back to defaults).
     *
     * @param {object} contest       contest row (must include scoring_rules)
     * @param {string} tournamentId  parent tournament UUID
     * @returns {Promise<object>}    merged { T20, ODI, TEST } overrides (may be empty)
     */
    async resolveContestScoringRules(contest, tournamentId) {
      if (contest?.scoring_rules && Object.keys(contest.scoring_rules).length) {
        return contest.scoring_rules;
      }
      // Fall back to tournament-level rules
      return this.getScoringRules(tournamentId);
    },

    /**
     * Create a new public contest (daily or season_long).
     * @param {string} tournamentId
     * @param {object} opts  { name, contestType }
     *   contestType: 'daily' | 'season_long'
     * @returns {Promise<object>}  the new contest row
     */
    async createContest(tournamentId, opts = {}) {
      if (!tournamentId)       throw new Error('createContest: tournamentId required');
      if (!opts.name?.trim())  throw new Error('createContest: name required');
      if (!opts.contestType)   throw new Error('createContest: contestType required');
      const sb = await getClient();
      const row = {
        tournament_id               : tournamentId,
        name                        : opts.name.trim(),
        contest_type                : opts.contestType,
        is_active                   : true,
        is_private                  : false,
        extra_transfer_point_cost   : opts.extraTransferPointCost   ?? 4,
        total_transfers_allowed     : opts.totalTransfersAllowed     ?? null,
        free_transfers_per_match    : opts.freeTransfersPerMatch     ?? null,
        start_match_number          : opts.startMatchNumber          ?? null,
        playoff_start_match_number  : opts.playoffStartMatchNumber   ?? null,
        playoff_transfers_allowed   : opts.playoffTransfersAllowed   ?? null,
        // Defaults to true — the first playoff match is unlimited-and-free
        // unless admin deliberately opts out for this contest (exception case).
        playoff_first_match_unlimited: opts.playoffFirstMatchUnlimited ?? true,
        available_boosters          : opts.availableBoosters         ?? null,
      };
      const { data, error } = await sb.from('contests').insert(row).select().single();
      if (error) throw error;
      return data;
    },

    /**
     * Create a new private league (season_long contest with is_private=true).
     * Generates a short, unique invite code automatically.
     *
     * @param {string} tournamentId
     * @param {object} opts  { name, scoringRules?, maxMembers?, startMatchNumber?, playoffStartMatchNumber?, totalTransfersAllowed?, freeTransfersPerMatch?, extraTransferPointCost? }
     * @returns {Promise<object>}  the new contest row
     */
    async createPrivateLeague(tournamentId, opts = {}) {
      if (!tournamentId) throw new Error('createPrivateLeague: tournamentId required');
      if (!opts.name?.trim()) throw new Error('createPrivateLeague: name required');
      const sb = await getClient();

      // Generate a short invite code — retry up to 5× on collision
      const genCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
      let code, attempts = 0;
      while (attempts++ < 5) {
        const candidate = genCode();
        const { data: existing } = await sb
          .from('contests').select('id').eq('invite_code', candidate).maybeSingle();
        if (!existing) { code = candidate; break; }
      }
      if (!code) throw new Error('createPrivateLeague: could not generate unique invite code — try again');

      const row = {
        tournament_id               : tournamentId,
        name                        : opts.name.trim(),
        contest_type                : 'season_long',
        is_active                   : true,
        is_private                  : true,
        invite_code                 : code,
        scoring_rules               : opts.scoringRules              ?? null,
        max_members                 : opts.maxMembers                ?? null,
        available_boosters          : opts.availableBoosters         ?? null,
        total_transfers_allowed     : opts.totalTransfersAllowed     ?? null,
        free_transfers_per_match    : opts.freeTransfersPerMatch     ?? null,
        extra_transfer_point_cost   : opts.extraTransferPointCost    ?? 4,
        start_match_number          : opts.startMatchNumber          ?? null,
        playoff_start_match_number  : opts.playoffStartMatchNumber   ?? null,
        playoff_transfers_allowed   : opts.playoffTransfersAllowed   ?? null,
        playoff_first_match_unlimited: opts.playoffFirstMatchUnlimited ?? true,
      };
      const { data, error } = await sb.from('contests').insert(row).select().single();
      if (error) throw error;
      return data;
    },

    /**
     * Preview a private league by invite code without joining.
     * Returns the contest row, or throws if the code is invalid.
     *
     * @param {string} inviteCode  6-char invite code
     * @returns {Promise<object>}  the contest row
     */
    async getContestByInviteCode(inviteCode) {
      if (!inviteCode?.trim()) throw new Error('getContestByInviteCode: invite code required');
      const sb = await getClient();
      const { data, error } = await sb
        .from('contests')
        .select('*')
        .eq('invite_code', inviteCode.trim().toUpperCase())
        .eq('is_private', true)
        .eq('is_active', true)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Invalid invite code — no active league found.');
      return data;
    },

    /**
     * Look up a private league by invite code and join it (creates a squad).
     * Returns the contest + new squad, or throws if code is invalid / already a member / full.
     *
     * @param {string}      inviteCode      6-char code shared by the league creator
     * @param {string}      squadName       the joining user's team name
     * @param {string|null} primarySquadId  if set, marks this as a shared squad that mirrors
     *                                      the primary squad's XI automatically at lock time.
     *                                      Pass the user's main SL squad id for shared leagues,
     *                                      or null for independent leagues.
     * @returns {Promise<{contest: object, squad: object, isShared: boolean}>}
     */
    async joinLeagueByCode(inviteCode, squadName, primarySquadId = null) {
      if (!inviteCode?.trim()) throw new Error('joinLeagueByCode: invite code required');
      const sb = await getClient();
      const { data: { user } } = await sb.auth.getUser();
      const uid = user?.id;
      if (!uid) throw new Error('joinLeagueByCode: must be signed in');

      // Find the contest
      const { data: contest, error: cErr } = await sb
        .from('contests')
        .select('*')
        .eq('invite_code', inviteCode.trim().toUpperCase())
        .eq('is_private', true)
        .eq('is_active', true)
        .maybeSingle();
      if (cErr) throw cErr;
      if (!contest) throw new Error('Invalid invite code — no active league found.');

      // Check already a member
      const { data: existing } = await sb
        .from('user_squads')
        .select('id')
        .eq('contest_id', contest.id)
        .eq('user_id', uid)
        .maybeSingle();
      if (existing) throw new Error('You are already a member of this league.');

      // Check member cap
      if (contest.max_members) {
        const { count } = await sb
          .from('user_squads')
          .select('id', { count: 'exact', head: true })
          .eq('contest_id', contest.id);
        if (count >= contest.max_members) throw new Error('This league is full.');
      }

      // Create squad — shared leagues store primary_squad_id so the lock propagation
      // pipeline can copy the XI automatically.
      // If migration_v13 hasn't been run yet the column won't exist; we fall back to
      // inserting without it so the join still succeeds (just as an independent squad).
      const insertRow = {
        contest_id      : contest.id,
        name            : squadName?.trim() || 'My Team',
        user_id         : uid,
        primary_squad_id: primarySquadId ?? null,
      };
      let squad, sErr;
      ({ data: squad, error: sErr } = await sb
        .from('user_squads')
        .insert(insertRow)
        .select().single());

      // Graceful degradation: if the column doesn't exist yet (migration pending),
      // retry without primary_squad_id so the join still works.
      if (sErr && /primary_squad_id/.test(sErr.message)) {
        console.warn('[joinLeagueByCode] primary_squad_id column missing — run migration_v13. Falling back to independent squad.');
        const { primary_squad_id: _omit, ...rowWithoutShared } = insertRow;
        ({ data: squad, error: sErr } = await sb
          .from('user_squads')
          .insert(rowWithoutShared)
          .select().single());
        primarySquadId = null; // treat as independent since column is absent
      }
      if (sErr) throw sErr;

      return { contest, squad, isShared: !!primarySquadId };
    },

    /**
     * Save custom scoring rules for a private league contest.
     * Same merge pattern as tournament-level rules.
     *
     * @param {string} contestId
     * @param {'T20'|'ODI'|'TEST'} format
     * @param {object} rules
     */
    async saveContestScoringRules(contestId, format, rules) {
      if (!['T20', 'ODI', 'TEST'].includes(format)) throw new Error('saveContestScoringRules: bad format');
      if (!contestId) throw new Error('saveContestScoringRules: contestId required');
      const sb = await getClient();
      const { data: c, error: cErr } = await sb
        .from('contests').select('scoring_rules').eq('id', contestId).single();
      if (cErr) throw cErr;
      const merged = { ...(c?.scoring_rules || {}), [format]: rules };
      const { error } = await sb
        .from('contests').update({ scoring_rules: merged }).eq('id', contestId);
      if (error) throw error;
    },

    /**
     * Remove a format's scoring override from a private league contest.
     *
     * @param {string} contestId
     * @param {'T20'|'ODI'|'TEST'} format
     */
    async resetContestScoringRules(contestId, format) {
      if (!contestId) throw new Error('resetContestScoringRules: contestId required');
      const sb = await getClient();
      const { data: c, error: cErr } = await sb
        .from('contests').select('scoring_rules').eq('id', contestId).single();
      if (cErr) throw cErr;
      const merged = { ...(c?.scoring_rules || {}) };
      delete merged[format];
      const { error } = await sb
        .from('contests')
        .update({ scoring_rules: Object.keys(merged).length ? merged : null })
        .eq('id', contestId);
      if (error) throw error;
    },

    /**
     * Fetch the user's squad entry for a season-long contest, or null.
     * @param {string} contestId
     * @returns {Promise<object|null>}  squad row or null
     */
    async getOrCreateSquad(contestId) {
      const sb = await getClient();
      const { data: { user } } = await sb.auth.getUser();
      const uid = user?.id;
      // IMPORTANT: query builder is immutable — must chain or reassign.
      // Also always filter by user_id: the leaderboard RLS policy allows all
      // authenticated users to read all squads, so without this filter
      // maybeSingle() returns the first squad in the contest (wrong user).
      const q = sb
        .from('user_squads')
        .select('*')
        .eq('contest_id', contestId);
      const finalQ = uid ? q.eq('user_id', uid) : q;
      const { data, error } = await finalQ.maybeSingle();
      if (error) throw error;
      return data ?? null;
    },

    /**
     * Return all squads (+ their contests) that the signed-in user belongs to
     * for a given tournament.  Used by the Leagues tab to list every league the
     * user is a member of.
     *
     * @param {string} tournamentId
     * @returns {Promise<Array<{squad: object, contest: object}>>}
     */
    async getUserSquads(tournamentId) {
      if (!tournamentId) throw new Error('getUserSquads: tournamentId required');
      const sb = await getClient();
      const { data: { user } } = await sb.auth.getUser();
      const uid = user?.id;
      if (!uid) return [];

      // 1. All squads owned by this user (include primary_squad_id for shared-league detection)
      const { data: squads, error: sErr } = await sb
        .from('user_squads')
        .select('*, primary_squad_id')
        .eq('user_id', uid);
      if (sErr) throw sErr;
      if (!squads?.length) return [];

      // 2. Fetch the contests for those squads that belong to this tournament
      const contestIds = [...new Set(squads.map(s => s.contest_id))];
      const { data: contests, error: cErr } = await sb
        .from('contests')
        .select('id, name, contest_type, is_active, is_private, invite_code, scoring_rules, max_members, available_boosters, total_transfers_allowed, free_transfers_per_match, extra_transfer_point_cost, start_match_number, playoff_start_match_number, playoff_transfers_allowed, playoff_first_match_unlimited')
        .in('id', contestIds)
        .eq('tournament_id', tournamentId)
        .eq('is_active', true);
      if (cErr) throw cErr;
      const contestMap = Object.fromEntries((contests || []).map(c => [c.id, c]));

      return squads
        .filter(s => contestMap[s.contest_id])
        .map(s => ({ squad: s, contest: contestMap[s.contest_id] }));
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
          // lock_time overrides start_time when set.
          // A 'delayed' match with no lock_time has no lock gate — never fires.
          const lockAt  = match?.lock_time ?? match?.start_time;
          const started = match?.status === 'delayed' && !match?.lock_time
            ? false
            : lockAt
              ? new Date(lockAt).getTime() <= now
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

      // Free Hit revert: if the latest locked match had Free Hit active, its
      // snapshot (the pre-free-hit baseline) supersedes its literal locked XI —
      // otherwise the temporary free-hit team leaks forward as the squad's new
      // permanent baseline for every match after it. Mirrors transferCap.ts's
      // getPreviousMatchXI (mobile port), which had this check but this — the
      // original web version it was ported from — never did. That gap is what
      // let a squad's free-hit match keep showing/locking as the "current" team
      // indefinitely instead of reverting once the free-hit match completed.
      try {
        const snapshot = await this.getFreeHitSnapshot(squadId, latestMatchId);
        if (snapshot?.playerIds?.length === 11) {
          return {
            playerIds: snapshot.playerIds,
            captainId: snapshot.captainId ?? null,
            vcId     : snapshot.vcId      ?? null,
            matchId  : latestMatchId,
          };
        }
      } catch (e) {
        console.warn('[getPreviousMatchXI] free_hit snapshot lookup failed (non-fatal):', e.message);
      }

      const xi = prevXI.filter(r => r.match_id === latestMatchId);

      return {
        playerIds: xi.map(r => r.player_id),
        captainId: xi.find(r => r.is_captain)?.player_id ?? null,
        vcId     : xi.find(r => r.is_vc)?.player_id     ?? null,
        matchId  : latestMatchId,
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

      // Look up each player's real role (wk/bat/ar/bowl) — previously this was
      // hardcoded to 'bat' for everyone, which made the pitch view dump the
      // entire XI into the BAT row (WK/AR/BOWL always rendered empty).
      const { data: roleRows, error: re } = await sb
        .from('players')
        .select('id, role')
        .in('id', playerIds);
      if (re) throw re;
      const roleById = {};
      (roleRows || []).forEach(p => { roleById[p.id] = p.role; });

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
        role      : roleById[pid] || 'bat',
      }));
      const { error: ie } = await sb.from('user_match_xi').insert(rows);
      if (ie) throw ie;

      let transfersMade = 0, seasonXferCount = 0;
      const startMatchNumber  = contestConfig.start_match_number             ?? null;
      const playoffStartMN    = contestConfig.playoff_start_match_number     ?? null;
      const seasonCap         = contestConfig.total_transfers_allowed        ?? null;
      const playoffCap        = contestConfig.playoff_transfers_allowed      ?? null;
      const playoffFirstUnlim = contestConfig.playoff_first_match_unlimited  ?? false;
      const allMatchesCfg     = contestConfig.allMatches                     ?? [];

      // ── Phase detection ────────────────────────────────────────────────────
      // Which budget window does this match fall into?
      const saveMatchNum = allMatchesCfg.find(m => m.id === matchId)?.match_number ?? null;
      const phase =
        (startMatchNumber === null || saveMatchNum === null || saveMatchNum < startMatchNumber)
          ? 'pre_season'
        : (playoffStartMN !== null && saveMatchNum >= playoffStartMN)
          ? 'playoff'
          : 'regular';

      // Is this the first playoff match, carved out as its own unlimited window?
      // (mn === playoffStartMN). When on, its transfers are excluded from the
      // pooled playoff budget the rest of the playoff matches share.
      const isUnlimitedFirstPlayoffMatch =
        phase === 'playoff' && playoffFirstUnlim && saveMatchNum === playoffStartMN;

      // Active cap: null playoff cap = unlimited (no fallback to season cap — they're independent budgets)
      const activeCap = isUnlimitedFirstPlayoffMatch ? null
                      : phase === 'playoff'  ? playoffCap   // null = unlimited
                      : phase === 'regular'  ? seasonCap
                      : null;   // pre-season: no cap

      // Match IDs that count toward the active budget window.
      // The season opener (mn === startMatchNumber) is excluded from the regular count —
      // it has no prior baseline, so any rows there are artifacts of pre-config saves.
      // The first playoff match (mn === playoffStartMN) IS counted in the pooled playoff
      // window — its transfers are measured against the last regular-season XI which is
      // a valid baseline — UNLESS playoff_first_match_unlimited carves it out into its
      // own isolated, unlimited window (see isUnlimitedFirstPlayoffMatch above).
      const phaseMatchIds = (() => {
        if (phase === 'pre_season' || !allMatchesCfg.length) return null;
        if (phase === 'playoff') {
          if (isUnlimitedFirstPlayoffMatch)
            return new Set(allMatchesCfg.filter(m => m.match_number === playoffStartMN).map(m => m.id));
          return new Set(allMatchesCfg
            .filter(m => (m.match_number ?? 0) >= playoffStartMN
              && !(playoffFirstUnlim && m.match_number === playoffStartMN))
            .map(m => m.id));
        }
        // regular: (startMatchNumber, playoffStartMN − 1] — strictly greater than opener
        return new Set(allMatchesCfg
          .filter(m => {
            const mn = m.match_number ?? 0;
            return mn > startMatchNumber && (playoffStartMN === null || mn < playoffStartMN);
          })
          .map(m => m.id));
      })();

      // bypassTransfers: set by wildcard / free_hit booster — XI is saved but no
      // transfers are counted, logged, or deducted for this match.
      const bypassTransfers = !!(contestConfig.bypassTransfers);

      // Clear this match's prior transfer log unconditionally, before the
      // bypass check — a save always represents the current, complete diff
      // state. Previously this delete only ran inside the !bypassTransfers
      // branch below, so activating Wildcard/Free Hit *after* an earlier
      // normal save left that save's rows sitting in user_transfers
      // indefinitely (until a future non-boosted save, or the match
      // locking) — inflating "pending transfers" displays and the season
      // cap's "used" count even though the booster makes those rows moot.
      await sb.from('user_transfers')
        .delete()
        .eq('squad_id', squadId)
        .eq('match_id', matchId);

      if (!bypassTransfers && previousPlayerIds.length > 0) {
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
              .neq('match_id', matchId);   // exclude current match (already cleared above)
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

          // Determine which transfers are free vs. paid.
          // free_transfers_per_match = how many changes are free per match window.
          // null = unlimited free (no deduction ever).
          // extra_transfer_point_cost = penalty per paid transfer (default 4).
          // The unlimited first playoff match bypasses this entirely — every
          // swap is free, regardless of free_transfers_per_match — it's a
          // full reset, not just an uncapped count.
          const freePerMatch = contestConfig.free_transfers_per_match ?? null;
          const extraCost    = Number(contestConfig.extra_transfer_point_cost ?? 4);

          const xferRows = playersOut.slice(0, transfersMade).map((outId, i) => {
            const isFree = isUnlimitedFirstPlayoffMatch || freePerMatch === null || i < freePerMatch;
            return {
              squad_id       : squadId,
              match_id       : matchId,
              player_out_id  : outId,
              player_in_id   : playersIn[i],
              is_free        : isFree,
              points_deducted: isFree ? 0 : extraCost,
            };
          });

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
     * @param {object}      caps                    { season: number|null, playoff: number|null, playoffFirstMatchUnlimited?: boolean }
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

      // First playoff match carved out as its own unlimited window (see
      // playoff_first_match_unlimited on the contest) — excluded from the
      // pooled playoff budget the rest of the playoff matches share.
      const playoffFirstUnlim = caps.playoffFirstMatchUnlimited ?? false;
      const isUnlimitedFirstPlayoffMatch =
        phase === 'playoff' && playoffFirstUnlim && targetMatchNumber === playoffStartMatchNumber;

      const activeCap = isUnlimitedFirstPlayoffMatch ? null
                      : phase === 'playoff' ? (caps.playoff ?? null)   // null = unlimited
                      : phase === 'regular' ? (caps.season  ?? null)
                      : null;

      // Build phase match ID filter
      const phaseIds = (() => {
        if (phase === 'pre_season' || !allMatches.length) return null;
        if (phase === 'playoff') {
          if (isUnlimitedFirstPlayoffMatch)
            return allMatches.filter(m => m.match_number === playoffStartMatchNumber).map(m => m.id);
          return allMatches
            .filter(m => (m.match_number ?? 0) >= playoffStartMatchNumber
              && !(playoffFirstUnlim && m.match_number === playoffStartMatchNumber))
            .map(m => m.id);
        }
        return allMatches
          .filter(m => {
            const mn = m.match_number ?? 0;
            // Strictly greater than opener: season opener has no baseline, any rows there are artifacts
            return mn > startMatchNumber && (playoffStartMatchNumber === null || mn < playoffStartMatchNumber);
          })
          .map(m => m.id);
      })();

      // Exclude the target match's own id — its rows (if any) are that
      // match's OWN already-saved-but-unlocked draft, which the caller
      // (renderSlXferInfoBar) already shows separately as "pending changes"
      // via slTransferCount(). Without this exclusion, re-opening a match you
      // already saved once this session double-counts: once here (as "used")
      // and again as "pending" — making a fully legitimate save (e.g. using
      // exactly your remaining 6 transfers) look like it's already over
      // budget, when it's actually fine. Mirrors the same exclusion
      // saveMatchXI's own cap-check query already applies (`.neq('match_id',
      // matchId)`) — this just brings the read-only display query in line
      // with the enforcement query it's supposed to reflect.
      const targetMatchId = allMatches.find(m => m.match_number === targetMatchNumber)?.id ?? null;

      let q = sb
        .from('user_transfers')
        .select('id', { count: 'exact', head: true })
        .eq('squad_id', squadId);
      if (phaseIds) {
        const ids = targetMatchId ? phaseIds.filter(id => id !== targetMatchId) : phaseIds;
        q = q.in('match_id', ids.length ? ids : ['__none__']);
      } else if (targetMatchId) {
        q = q.neq('match_id', targetMatchId);
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
    /**
     * Return member counts for a list of contest IDs.
     * { [contestId]: number }
     *
     * @param {string[]} contestIds
     * @returns {Promise<Record<string, number>>}
     */
    async getMemberCountsForContests(contestIds) {
      if (!contestIds?.length) return {};
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_squads')
        .select('contest_id')
        .in('contest_id', contestIds);
      if (error) throw error;
      const counts = {};
      (data || []).forEach(r => {
        counts[r.contest_id] = (counts[r.contest_id] || 0) + 1;
      });
      return counts;
    },

    /**
     * Update the member cap for a private league.
     * Pass null to remove the cap entirely.
     * @param {string} contestId
     * @param {number|null} maxMembers
     */
    async updateContestMaxMembers(contestId, maxMembers) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('contests')
        .update({ max_members: maxMembers ?? null })
        .eq('id', contestId)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('No rows updated — check RLS policies on the contests table.');
    },

    async updateContestTransferBudget(contestId, totalAllowed) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('contests')
        .update({ total_transfers_allowed: totalAllowed ?? null })
        .eq('id', contestId)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('No rows updated — check RLS policies on the contests table.');
    },

    /**
     * Update phase configuration for a season-long contest.
     * Accepts a partial object — only provided keys are written.
     * @param {string} contestId
     * @param {{ start_match_number?: number|null, playoff_start_match_number?: number|null, playoff_transfers_allowed?: number|null, playoff_first_match_unlimited?: boolean }} fields
     */
    async updateContestPhases(contestId, fields) {
      const sb = await getClient();
      const patch = {};
      if ('start_match_number'          in fields) patch.start_match_number          = fields.start_match_number          ?? null;
      if ('playoff_start_match_number'  in fields) patch.playoff_start_match_number  = fields.playoff_start_match_number  ?? null;
      if ('playoff_transfers_allowed'   in fields) patch.playoff_transfers_allowed   = fields.playoff_transfers_allowed   ?? null;
      if ('playoff_first_match_unlimited' in fields) patch.playoff_first_match_unlimited = !!fields.playoff_first_match_unlimited;
      if (!Object.keys(patch).length) return;
      const { data, error } = await sb
        .from('contests')
        .update(patch)
        .eq('id', contestId)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('No rows updated — check RLS policies on the contests table.');
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
        .select('player_ids, captain_id, vc_id, pending_booster, pending_booster_match_id, target_match_id')
        .eq('squad_id', squadId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        playerIds: data.player_ids ?? [],
        captainId: data.captain_id ?? null,
        vcId:      data.vc_id      ?? null,
        // Booster staged for pendingBoosterMatchId — durable across reloads/
        // devices (see migration_v34). null/null just means "nothing staged".
        pendingBooster:        data.pending_booster            ?? null,
        pendingBoosterMatchId: data.pending_booster_match_id    ?? null,
        // The match this playerIds/captainId/vcId snapshot was explicitly
        // Saved for (see migration_v35). null means "not confirmed for any
        // specific match" — lockMatchXI treats that as untrustworthy for
        // locking and carries the previous locked XI forward instead.
        targetMatchId: data.target_match_id ?? null,
      };
    },

    /**
     * Persist the squad's current editable draft XI.
     * No transfer counting — this is just a free save.
     *
     * pendingBooster/pendingBoosterMatchId (both optional) durably record
     * "this squad wants `pendingBooster` applied to `pendingBoosterMatchId`" —
     * written alongside the XI so a staged pick can never be silently lost
     * even if the immediate activateBooster attempt in the caller fails or
     * races. lockMatchXI reconciles this into a real user_booster_activations
     * row at lock time if it isn't there already.
     *
     * targetMatchId (optional) durably records "this exact playerIds/
     * captainId/vcId snapshot was explicitly Saved for this match" — the
     * guarantee lockMatchXI relies on to never lock in a stale/unconfirmed
     * draft (see migration_v35 / ShooterXI-class incidents where a shared,
     * un-matched draft got consumed by whichever match's auto-lock catch-up
     * happened to run next).
     *
     * IMPORTANT: all three of pendingBooster/pendingBoosterMatchId/
     * targetMatchId are only written when the caller explicitly passes them
     * (checked via `!== undefined`, not just truthiness) — callers that
     * don't know/care about booster staging or match-targeting (mobile-XI
     * promotion, free_hit's post-match revert, etc.) must never silently
     * wipe out a currently-staged pick or a confirmed target match just by
     * re-saving playerIds/captainId/vcId. To genuinely clear either, pass
     * them explicitly as null.
     */
    async saveDraft(squadId, { playerIds, captainId, vcId, pendingBooster, pendingBoosterMatchId, targetMatchId }) {
      const sb = await getClient();
      const row = {
        squad_id  : squadId,
        player_ids: playerIds,
        captain_id: captainId ?? null,
        vc_id     : vcId      ?? null,
        updated_at: new Date().toISOString(),
      };
      if (pendingBooster        !== undefined) row.pending_booster          = pendingBooster;
      if (targetMatchId         !== undefined) row.target_match_id          = targetMatchId;
      if (pendingBoosterMatchId !== undefined) row.pending_booster_match_id = pendingBoosterMatchId;
      await withRlsRetry(sb, () => sb
        .from('squad_draft_xi')
        .upsert(row, { onConflict: 'squad_id' }),
        'saving your draft XI');
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

      // "First active lock" = this squad has no real transfer baseline — either it
      // never locked anything before, or the only prior lock on record was a
      // retroactive auto-lock for a match that was ALREADY completed by the time
      // the squad joined (so that XI was never actually picked by the user).
      // We distinguish that from the normal, common case of an actively-playing
      // squad whose previous match simply finished and got scored before they got
      // around to locking the next one — checked by looking for ANY earlier locked
      // match for this squad. If one exists, they've been actively playing and the
      // real baseline must be honored regardless of the previous match's status.
      let isFirstActiveLock = !prev.playerIds?.length;
      if (!isFirstActiveLock) {
        const prevMatchStatus = prev.matchId
          ? (allMatches.find(m => m.id === prev.matchId)?.status ?? null)
          : null;
        if (prevMatchStatus === 'completed') {
          const prevMatchNum = sorted.find(m => m.id === prev.matchId)?.match_number ?? 0;
          const earlierMatchIds = sorted
            .filter(m => (m.match_number ?? 0) < prevMatchNum)
            .map(m => m.id);
          if (earlierMatchIds.length) {
            const sb = await getClient();
            const { count } = await sb
              .from('user_match_xi')
              .select('id', { count: 'exact', head: true })
              .eq('squad_id', squadId)
              .in('match_id', earlierMatchIds);
            isFirstActiveLock = !(count > 0);
          } else {
            isFirstActiveLock = true; // prev is the earliest possible match — genuinely first lock
          }
        }
      }
      const baselinePlayerIds = isFirstActiveLock ? [] : prev.playerIds;

      // GUARANTEE: only ever lock in a draft that was explicitly Saved for
      // THIS match. squad_draft_xi is one shared row per squad with no
      // inherent match association beyond targetMatchId — without this
      // check, whichever match's auto-lock catch-up (slCheckAutoLock) fires
      // next just grabs "whatever's currently in the draft" and locks it,
      // with no way to tell whether it was actually meant for this match or
      // is stale/intended-for-a-different-match content that never got
      // confirmed here. (Real incident: a squad saved 3 minutes before a
      // match's lock time, but the save's target ended up mismatched, and
      // by the time the user next checked, that same draft had carried
      // forward into the NEXT match's editing session — meaning the
      // original match's lock either used stale content or never reflected
      // what was actually saved for it.)
      //
      // If the draft doesn't match, we do NOT guess — carry the previous
      // locked XI forward unchanged (0 transfers), exactly what a real
      // fantasy app does when a user makes no confirmed change for a given
      // match. Only throws if there's also no previous locked XI to fall
      // back on (i.e. genuinely nothing valid to lock at all).
      let xiPlayerIds = draft.playerIds, xiCaptainId = draft.captainId, xiVcId = draft.vcId;
      if (draft.targetMatchId !== matchId) {
        if (prev.playerIds?.length === 11) {
          xiPlayerIds = prev.playerIds;
          xiCaptainId = prev.captainId;
          xiVcId      = prev.vcId;
          console.warn(
            `[lockMatchXI] squad ${squadId}: draft.targetMatchId (${draft.targetMatchId}) does not match ` +
            `the match being locked (${matchId}) — carrying forward the previous locked XI (match ${prev.matchId}) ` +
            `instead of trusting an unconfirmed draft.`
          );
        } else {
          throw new Error(
            'No XI was explicitly saved for this match, and there is no previous locked XI to carry forward — save your team before it locks.'
          );
        }
      }

      // Write XI + transfers
      const result = await this.saveMatchXI(
        squadId, matchId,
        xiPlayerIds, xiCaptainId, xiVcId,
        baselinePlayerIds,
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

      // Itemized batting/bowling/fielding stat objects for every match/player combo
      // in this squad's season — needed by the shared pitch+breakdown component
      // (histBreakdownRowHtml) to show line-by-line scoring, mirroring the exact
      // join pattern getMatchHistoryDetailed uses for Daily.
      const matchIds  = [...new Set((xiRows || []).map(r => r.match_id))];
      const playerIds = [...new Set((xiRows || []).map(r => r.player_id))];

      // v_match_xi_with_scores.role comes from user_match_xi.role, which was
      // historically saved as a hardcoded 'bat' for every player regardless of
      // their real position (see saveMatchXI) — that put the whole XI into the
      // pitch view's BAT row. Re-resolve the real role from `players` here so
      // both old and new rows render correctly without needing a DB migration.
      let roleById = {};
      if (playerIds.length) {
        const { data: roleRows, error: e4 } = await sb
          .from('players')
          .select('id, role')
          .in('id', playerIds);
        if (e4) throw e4;
        (roleRows || []).forEach(p => { roleById[p.id] = p.role; });
      }

      let statIdx = {};
      if (matchIds.length && playerIds.length) {
        const { data: statRows, error: e3 } = await sb
          .from('player_match_stats')
          .select('match_id, player_id, raw_points, batting, bowling, fielding')
          .in('match_id', matchIds)
          .in('player_id', playerIds);
        if (e3) throw e3;
        (statRows || []).forEach(s => {
          (statIdx[s.match_id] ??= {})[s.player_id] = s;
        });
      }

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
        const st = statIdx[r.match_id]?.[r.player_id];
        byMatch[r.match_id].players.push({
          ...r,
          // Real role from `players`, not the (possibly hardcoded-'bat') value
          // stored on user_match_xi — see roleById note above.
          role      : roleById[r.player_id] || r.role,
          // base_points (from the view) IS the raw, pre-multiplier total — kept as
          // raw_points too so this row matches the shape histPitchToken/
          // histBreakdownRowHtml expect (same field name Daily's rows use).
          raw_points: r.base_points ?? null,
          batting   : st?.batting   ?? null,
          bowling   : st?.bowling   ?? null,
          fielding  : st?.fielding  ?? null,
        });
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

    // ─── Shared squads ───────────────────────────────────────────────────────

    /**
     * Return all squads that have primary_squad_id = primarySquadId.
     * These are shared private-league squads that mirror the primary squad's XI.
     * Called at lock time so the XI can be propagated automatically.
     *
     * @param {string} primarySquadId
     * @returns {Promise<Array<{id, name, contest_id, primary_squad_id}>>}
     */
    async getSharedSquads(primarySquadId) {
      if (!primarySquadId) return [];
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_squads')
        .select('id, name, contest_id, primary_squad_id')
        .eq('primary_squad_id', primarySquadId);
      if (error) throw error;
      return data || [];
    },

    /**
     * Copy the locked XI from a primary squad to all squads that share it,
     * for a specific match.  Called by slLockForMatch after locking the primary.
     *
     * For each shared squad, the primary squad's user_match_xi rows are
     * duplicated under the shared squad_id so that the scoring pipeline,
     * leaderboard queries, and season view all work without special handling.
     *
     * @param {string}   primarySquadId
     * @param {string}   matchId
     * @returns {Promise<number>}  number of shared squads updated
     */
    async propagateXIToSharedSquads(primarySquadId, matchId) {
      if (!primarySquadId || !matchId) return 0;
      const sb = await getClient();

      // 1. Get the primary squad's XI for this match
      const { data: xiRows, error: xErr } = await sb
        .from('user_match_xi')
        .select('player_id, is_captain, is_vc, role')
        .eq('squad_id', primarySquadId)
        .eq('match_id', matchId);
      if (xErr) throw xErr;
      if (!xiRows?.length) return 0;

      // 2. Get all shared squads
      const sharedSquads = await this.getSharedSquads(primarySquadId);
      if (!sharedSquads.length) return 0;

      let updated = 0;
      for (const shared of sharedSquads) {
        // Delete any existing XI rows for this shared squad + match (idempotent)
        await sb.from('user_match_xi')
          .delete()
          .eq('squad_id', shared.id)
          .eq('match_id', matchId);

        // Insert the primary squad's rows under the shared squad_id
        const rows = xiRows.map(r => ({
          squad_id  : shared.id,
          match_id  : matchId,
          player_id : r.player_id,
          is_captain: r.is_captain,
          is_vc     : r.is_vc,
          role      : r.role,
        }));
        const { error: iErr } = await sb.from('user_match_xi').insert(rows);
        if (iErr) {
          console.warn(`[propagateXI] Failed for shared squad ${shared.id}:`, iErr.message);
        } else {
          updated++;
        }
      }
      return updated;
    },

    // ─── Boosters ─────────────────────────────────────────────────────────────

    /**
     * All valid booster keys (in display order).
     * The behaviour of each is implemented in the scoring / transfer pipelines.
     */
    BOOSTER_KEYS: [
      'triple_captain',
      'wildcard',
      'free_hit',
      'os_double',
      'indian_double',
      'team_double',
    ],

    /**
     * Activate a booster for a squad + match.
     * Enforces: match not yet started, booster available in contest, uses not exhausted.
     *
     * For free_hit: pass snapshotXI = { playerIds, captainId, vcId } — stored so
     * the XI can be reverted automatically after the match.
     *
     * @param {string}       squadId
     * @param {string}       matchId
     * @param {string}       booster         one of BOOSTER_KEYS
     * @param {object|null}  contestConfig   contest row (must include available_boosters)
     * @param {object|null}  snapshotXI      free_hit only: {playerIds, captainId, vcId}
     * @returns {Promise<object>}  the new activation row
     */
    async activateBooster(squadId, matchId, booster, contestConfig = {}, snapshotXI = null) {
      if (!squadId) throw new Error('activateBooster: squadId required');
      if (!matchId) throw new Error('activateBooster: matchId required');
      if (!booster) throw new Error('activateBooster: booster required');

      const available = contestConfig?.available_boosters;
      if (!available || !(booster in available)) {
        throw new Error(`Booster "${booster}" is not available in this contest.`);
      }
      const totalUses = available[booster] ?? 0;
      if (totalUses < 1) throw new Error(`Booster "${booster}" is not offered in this contest.`);

      const sb = await getClient();

      // Check how many times this squad has already used this booster
      const { count: usedCount, error: cErr } = await sb
        .from('user_booster_activations')
        .select('id', { count: 'exact', head: true })
        .eq('squad_id', squadId)
        .eq('booster', booster);
      if (cErr) throw cErr;
      if ((usedCount ?? 0) >= totalUses) {
        throw new Error(`You have already used all ${totalUses} ${booster.replace(/_/g,' ')} boost${totalUses > 1 ? 's' : ''}.`);
      }

      // Insert the activation (UNIQUE constraint on squad_id + match_id + booster prevents duplicates)
      const row = {
        squad_id: squadId,
        match_id: matchId,
        booster,
        snapshot: snapshotXI ? {
          playerIds: snapshotXI.playerIds,
          captainId: snapshotXI.captainId,
          vcId     : snapshotXI.vcId,
        } : null,
      };
      try {
        return await withRlsRetry(sb, () => sb
          .from('user_booster_activations')
          .insert(row)
          .select()
          .single(),
          `activating ${booster.replace(/_/g, ' ')}`);
      } catch (error) {
        if (error.code === '23505') throw new Error(`You already have ${booster.replace(/_/g,' ')} active for this match.`);
        throw error;
      }
    },

    /**
     * Cancel (deactivate) a booster for a squad + match.
     * Should only be called before the match has started.
     *
     * @param {string} squadId
     * @param {string} matchId
     * @param {string} booster
     */
    async deactivateBooster(squadId, matchId, booster) {
      const sb = await getClient();
      await withRlsRetry(sb, () => sb
        .from('user_booster_activations')
        .delete()
        .eq('squad_id', squadId)
        .eq('match_id', matchId)
        .eq('booster', booster),
        `removing ${booster.replace(/_/g, ' ')}`);
    },

    /**
     * All booster activations for a squad (across all matches).
     * Used to compute "uses remaining" for each booster type.
     *
     * @param {string} squadId
     * @returns {Promise<Array<{id, match_id, booster, activated_at, snapshot}>>}
     */
    async getBoosterActivations(squadId) {
      if (!squadId) return [];
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_booster_activations')
        .select('id, match_id, booster, activated_at, snapshot')
        .eq('squad_id', squadId)
        .order('activated_at');
      if (error) throw error;
      return data || [];
    },

    /**
     * Lock-relevant fields (id, lock_time, start_time) for a set of match ids.
     * Used by getSlBoosterContext() to determine which OTHER matches' booster
     * activations have actually locked (coalesce(lock_time,start_time) <=
     * now()) vs. which are still just a reversible, unsaved-until-lock commit
     * — mirrors the same lock gate used in getLeaderboardSL() above.
     *
     * @param {string[]} matchIds
     * @returns {Promise<Array<{id, lock_time, start_time}>>}
     */
    async getMatchesByIds(matchIds) {
      if (!matchIds || !matchIds.length) return [];
      const sb = await getClient();
      const { data, error } = await sb
        .from('matches')
        .select('id, lock_time, start_time')
        .in('id', matchIds);
      if (error) throw error;
      return data || [];
    },

    /**
     * Return the active booster (if any) for a specific squad + match.
     * Boosters that affect scoring (triple_captain, os_double, indian_double, team_double)
     * or transfers (wildcard, free_hit) are all retrieved here.
     *
     * Returns null if no booster is active for this match.
     *
     * @param {string} squadId
     * @param {string} matchId
     * @returns {Promise<string|null>}   booster key or null
     */
    async getActiveBoosterForMatch(squadId, matchId) {
      if (!squadId || !matchId) return null;
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_booster_activations')
        .select('booster')
        .eq('squad_id', squadId)
        .eq('match_id', matchId)
        .maybeSingle();
      if (error) throw error;
      return data?.booster ?? null;
    },

    /**
     * Fetch all booster activations for a match across ALL squads in one query.
     * Returns a map of { [squadId]: boosterKey }.
     * Used by the scoring pipeline so it isn't blocked by per-user RLS when
     * computing scores for squads belonging to other users.
     * Requires the "booster_activations_read_all" policy on user_booster_activations.
     */
    async getAllBoostersForMatch(matchId) {
      if (!matchId) return {};
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_booster_activations')
        .select('squad_id, booster')
        .eq('match_id', matchId);
      if (error) throw error;
      const map = {};
      (data || []).forEach(r => { map[r.squad_id] = r.booster; });
      return map;
    },

    /**
     * Retrieve the free_hit snapshot for a squad + match.
     * Returns null if no free_hit was activated or no snapshot was stored.
     *
     * @param {string} squadId
     * @param {string} matchId
     * @returns {Promise<{playerIds, captainId, vcId}|null>}
     */
    async getFreeHitSnapshot(squadId, matchId) {
      if (!squadId || !matchId) return null;
      const sb = await getClient();
      const { data, error } = await sb
        .from('user_booster_activations')
        .select('snapshot')
        .eq('squad_id', squadId)
        .eq('match_id', matchId)
        .eq('booster', 'free_hit')
        .maybeSingle();
      if (error) throw error;
      return data?.snapshot ?? null;
    },

    /**
     * Update the available_boosters JSONB on a contest.
     * Pass null to remove all boosters from the contest.
     *
     * @param {string}      contestId
     * @param {object|null} boosters  e.g. { triple_captain: 1, wildcard: 1 }
     */
    async updateContestBoosters(contestId, boosters) {
      if (!contestId) throw new Error('updateContestBoosters: contestId required');
      const sb = await getClient();
      const { data, error } = await sb
        .from('contests')
        .update({ available_boosters: boosters ?? null })
        .eq('id', contestId)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error('No rows updated — your account may not have permission to edit this contest (check RLS policies on the contests table).');
      }
    },

    // ─── Close-Out Tournament ─────────────────────────────────────────────────

    /**
     * Returns approximate row counts for every transactional table that is
     * scoped to `tournamentId`.  Used by the admin close-out panel to show
     * how much data will be deleted.
     *
     * Shape: { [tableKey]: { label, description, count, canDelete } }
     *
     * We use `select('id', { count: 'exact', head: true })` which asks the
     * server for a COUNT without returning any rows.
     */
    async getTournamentTableCounts(tournamentId) {
      if (!tournamentId) throw new Error('getTournamentTableCounts: tournamentId required');
      const sb = await getClient();

      // Helper — count rows with a filter, return 0 on any error
      const count = async (table, column, value) => {
        const { count: n, error } = await sb
          .from(table)
          .select('*', { count: 'exact', head: true })
          .eq(column, value);
        if (error) return 0;
        return n ?? 0;
      };

      // For tables linked through contests / squads we need the contest IDs first
      const { data: contests } = await sb
        .from('contests')
        .select('id')
        .eq('tournament_id', tournamentId);
      const contestIds = (contests ?? []).map(c => c.id);

      // squad IDs for the deepest joins
      let squadIds = [];
      if (contestIds.length) {
        const { data: squads } = await sb
          .from('user_squads')
          .select('id')
          .in('contest_id', contestIds);
        squadIds = (squads ?? []).map(s => s.id);
      }

      // Count each table
      const [
        matchXiCount,
        matchXiScoresCount,
        userSquadsCount,
        matchesCount,
        tournamentPlayersCount,
        contestsCount,
      ] = await Promise.all([
        squadIds.length
          ? sb.from('user_match_xi').select('*', { count: 'exact', head: true }).in('squad_id', squadIds).then(r => r.count ?? 0)
          : Promise.resolve(0),
        squadIds.length
          ? sb.from('user_match_xi_scores').select('*', { count: 'exact', head: true }).in('squad_id', squadIds).then(r => r.count ?? 0)
          : Promise.resolve(0),
        contestIds.length
          ? sb.from('user_squads').select('*', { count: 'exact', head: true }).in('contest_id', contestIds).then(r => r.count ?? 0)
          : Promise.resolve(0),
        count('matches',             'tournament_id', tournamentId),
        count('tournament_players',  'tournament_id', tournamentId),
        count('contests',            'tournament_id', tournamentId),
      ]);

      return {
        user_match_xi: {
          label:       'Match XI picks',
          description: 'Every player selected in a user\'s XI for each match',
          count:       matchXiCount,
          canDelete:   true,
          defaultOn:   true,
        },
        user_match_xi_scores: {
          label:       'XI scores',
          description: 'Per-player fantasy points awarded each match',
          count:       matchXiScoresCount,
          canDelete:   true,
          defaultOn:   true,
        },
        user_squads: {
          label:       'User squads',
          description: 'Each user\'s squad registration for a contest',
          count:       userSquadsCount,
          canDelete:   true,
          defaultOn:   true,
        },
        matches: {
          label:       'Match schedule',
          description: 'All match records for this tournament',
          count:       matchesCount,
          canDelete:   true,
          defaultOn:   false,
        },
        tournament_players: {
          label:       'Tournament player pool',
          description: 'Credit values and team assignments for this tournament',
          count:       tournamentPlayersCount,
          canDelete:   true,
          defaultOn:   false,
        },
        contests: {
          label:       'Contests & leagues',
          description: 'Contest configurations, private leagues, and invite codes',
          count:       contestsCount,
          canDelete:   true,
          defaultOn:   false,
        },
      };
    },

    /**
     * Closes out a tournament:
     *  1. Sets tournaments.end_date = today  (marks it as finished in the app)
     *  2. Sets all contests.is_active = false for this tournament
     *  3. Deletes rows from each table in `tablesToClear` (array of table keys
     *     from getTournamentTableCounts — e.g. ['user_match_xi', 'user_squads'])
     *
     * Deletions happen in dependency order so FK constraints are never violated:
     *   user_match_xi_scores → user_match_xi → user_squads → contests
     *   matches → tournament_players
     *
     * Returns { tablesCleared: string[], errors: string[] }
     */
    async closeOutTournament(tournamentId, tablesToClear = []) {
      if (!tournamentId) throw new Error('closeOutTournament: tournamentId required');
      const sb = await getClient();

      const cleared = [];
      const errors  = [];

      // Step 1 — mark tournament ended today
      const today = new Date().toISOString().split('T')[0];
      const { error: tErr } = await sb
        .from('tournaments')
        .update({ end_date: today })
        .eq('id', tournamentId);
      if (tErr) errors.push(`tournaments.end_date: ${tErr.message}`);

      // Step 2 — deactivate all contests
      const { error: cErr } = await sb
        .from('contests')
        .update({ is_active: false })
        .eq('tournament_id', tournamentId);
      if (cErr) errors.push(`contests.is_active: ${cErr.message}`);

      // Get contest IDs (needed for squad-level deletes)
      const { data: contests } = await sb
        .from('contests')
        .select('id')
        .eq('tournament_id', tournamentId);
      const contestIds = (contests ?? []).map(c => c.id);

      // Get squad IDs (needed for XI-level deletes)
      let squadIds = [];
      if (contestIds.length) {
        const { data: squads } = await sb
          .from('user_squads')
          .select('id')
          .in('contest_id', contestIds);
        squadIds = (squads ?? []).map(s => s.id);
      }

      const want = new Set(tablesToClear);

      // Delete in correct FK order
      // ── user_match_xi_scores (deepest) ──
      if (want.has('user_match_xi_scores') && squadIds.length) {
        const { error } = await sb
          .from('user_match_xi_scores')
          .delete()
          .in('squad_id', squadIds);
        if (error) errors.push(`user_match_xi_scores: ${error.message}`);
        else cleared.push('user_match_xi_scores');
      }

      // ── user_match_xi ──
      if (want.has('user_match_xi') && squadIds.length) {
        const { error } = await sb
          .from('user_match_xi')
          .delete()
          .in('squad_id', squadIds);
        if (error) errors.push(`user_match_xi: ${error.message}`);
        else cleared.push('user_match_xi');
      }

      // ── user_squads ──
      if (want.has('user_squads') && contestIds.length) {
        const { error } = await sb
          .from('user_squads')
          .delete()
          .in('contest_id', contestIds);
        if (error) errors.push(`user_squads: ${error.message}`);
        else cleared.push('user_squads');
      }

      // ── matches ──
      if (want.has('matches')) {
        const { error } = await sb
          .from('matches')
          .delete()
          .eq('tournament_id', tournamentId);
        if (error) errors.push(`matches: ${error.message}`);
        else cleared.push('matches');
      }

      // ── tournament_players ──
      if (want.has('tournament_players')) {
        const { error } = await sb
          .from('tournament_players')
          .delete()
          .eq('tournament_id', tournamentId);
        if (error) errors.push(`tournament_players: ${error.message}`);
        else cleared.push('tournament_players');
      }

      // ── contests (last — others reference it) ──
      if (want.has('contests')) {
        const { error } = await sb
          .from('contests')
          .delete()
          .eq('tournament_id', tournamentId);
        if (error) errors.push(`contests: ${error.message}`);
        else cleared.push('contests');
      }

      return { tablesCleared: cleared, errors };
    },

    // ─── Notifications ────────────────────────────────────────────────────
    // Backs the HomeScreen ticker (mirrors the Expo app's notificationsStore).
    // notifications_log is admin-broadcast history (migration_v36), readable
    // by every authenticated user; notification_reads (migration_v37) tracks
    // per-user read state for the inbox's unread highlight only — it does
    // NOT gate ticker visibility, which is purely time-based via
    // ticker_hours (migration_v38) and computed by the caller.

    /** Most recent admin-sent notifications, newest first. */
    async getNotifications(limit = 50) {
      const sb = await getClient();
      const { data, error } = await sb
        .from('notifications_log')
        .select('id, title, body, created_at, ticker_hours')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data;
    },

    /** Notification ids the current user has already opened. */
    async getMyNotificationReads() {
      const sb = await getClient();
      const { data, error } = await sb
        .from('notification_reads')
        .select('notification_id');
      if (error) throw error;
      return (data || []).map(r => r.notification_id);
    },

    /** Marks a batch of notification ids as read for the current user. */
    async markNotificationsRead(notificationIds) {
      if (!notificationIds?.length) return;
      const sb = await getClient();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const rows = notificationIds.map(id => ({ user_id: user.id, notification_id: id }));
      const { error } = await sb
        .from('notification_reads')
        .upsert(rows, { onConflict: 'user_id,notification_id' });
      if (error) console.warn('[db] markNotificationsRead failed:', error.message);
    },
  };
}
