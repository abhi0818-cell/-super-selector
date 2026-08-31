/**
 * Shared "has this match's XI lock gate passed?" check.
 *
 * Mirrors the RLS lock gate used in migration_v27_daily_team_lock_rls.sql:
 *   COALESCE(lock_time, start_time) <= now()
 *
 * A match with neither lock_time nor start_time set has no lock gate yet
 * (e.g. not fully scheduled) and is treated as NOT locked.
 *
 * NOTE: this is for "can the user still edit/save their XI" checks only.
 * Do NOT use this to decide whether a match should appear in history/
 * leaderboards — many matches never get lock_time/start_time populated at
 * all, which made every match fail this gate and disappear from history.
 * Use isMatchPlayed() below for that instead (mirrors web's own filter).
 */
export function isMatchLocked(m: { lock_time?: string | null; start_time?: string | null }): boolean {
  const lockAt = m.lock_time ?? m.start_time ?? null;
  return !!lockAt && new Date(lockAt).getTime() <= Date.now();
}

interface MatchLockCandidate {
  id:           string;
  match_number?: number | null;
  lock_time?:   string | null;
  start_time?:  string | null;
  status?:      string | null;
}

/**
 * A match that's finished OR was called off must stop being treated as "the
 * next match" — mirrors web's isMatchOver() in index.html. Without this, an
 * abandoned match (status flipped by admin, but its lock gate may still read
 * as "not yet passed") would keep being picked as findNextUnlockedMatch()'s
 * result instead of rolling users to the actual next scheduled match.
 */
export function isMatchOver(m: { status?: string | null }): boolean {
  return m.status === 'completed' || m.status === 'abandoned' || m.status === 'cancelled';
}

/**
 * Given a tournament's matches, find the earliest one that hasn't locked yet.
 * Mirrors web's findNextScheduledMatch() (index.html). Deliberately excludes
 * not just 'completed' matches but anything past its lock gate — a match that
 * has gone live (status flips to 'live'/'in_progress', not 'completed') must
 * stop being treated as "the current match", otherwise the app keeps showing/
 * editing that match's now-locked XI instead of advancing to the next one the
 * user actually saved a fresh team for (the bug this was added to fix: saving
 * from mobile landed correctly in the DB, but currentMatchId still pointed at
 * the live match, so the screen kept showing its stale locked XI).
 */
export function findNextUnlockedMatch<T extends MatchLockCandidate>(matches: T[]): T | null {
  const candidates = matches.filter(m => !isMatchOver(m) && !isMatchLocked(m));
  const withTime = candidates
    .filter(m => m.lock_time || m.start_time)
    .sort((a, b) =>
      new Date((a.lock_time ?? a.start_time) as string).getTime() -
      new Date((b.lock_time ?? b.start_time) as string).getTime());
  const withoutTime = candidates
    .filter(m => !m.lock_time && !m.start_time)
    .sort((a, b) => (a.match_number ?? 0) - (b.match_number ?? 0));
  return withTime[0] ?? withoutTime[0] ?? null;
}

/**
 * Has this match actually been played (so it belongs in history/leaderboards)?
 * Status is set reliably by the scoring pipeline (poll-cricapi / scrape-scorecard)
 * regardless of whether lock_time/start_time are populated, so this is the
 * correct gate for "should this show as a matchweek" — not isMatchLocked.
 *
 * Also includes 'live': lock-matches sets status='live' at kickoff, and
 * poll-cricapi only flips it to 'in_progress' once CricAPI confirms play has
 * started — there's a window where a match is genuinely underway but still
 * reads 'live'. Every other status consumer in the app (teamStore.ts,
 * PlayerPickerScreen.tsx, liveScore.ts) already treats 'live' and
 * 'in_progress' as the same "currently live" state; this was the one place
 * still missing 'live', which made a freshly-locked live match invisible to
 * history/leaderboard drill-downs until poll-cricapi caught up.
 *
 * Also includes 'abandoned'/'cancelled' (i.e. any isMatchOver() status, not
 * just 'completed') — a match that locked (toss happened, squads/boosters/
 * transfers committed) and then got called off still needs to show up as a
 * matchweek, scored on whatever play happened before the wash-out (zero if
 * none — see RulesScreen's "abandoned match" rule: locked transfers/boosters
 * for it are never refunded, exactly as if it had been played in full).
 * Previously this only checked 'completed'/'in_progress'/'live', so an
 * abandoned match — CPL M21 being the case that surfaced it — silently
 * vanished from every squad's matchweek history/leaderboard drill-down on
 * mobile, even though its teams had locked and web's own SL detail view
 * (which gates on lock time, not status) showed it fine with a 0.
 */
export function isMatchPlayed(m: { status?: string | null }): boolean {
  return isMatchOver(m) || m.status === 'in_progress' || m.status === 'live';
}
