/**
 * Shared "has this match's XI lock gate passed?" check.
 *
 * Mirrors the RLS lock gate used in migration_v27_daily_team_lock_rls.sql:
 *   COALESCE(lock_time, start_time) <= now()
 *
 * A match with neither lock_time nor start_time set has no lock gate yet
 * (e.g. not fully scheduled) and is treated as NOT locked — it shouldn't
 * appear in any "history" view until it actually locks.
 */
export function isMatchLocked(m: { lock_time?: string | null; start_time?: string | null }): boolean {
  const lockAt = m.lock_time ?? m.start_time ?? null;
  return !!lockAt && new Date(lockAt).getTime() <= Date.now();
}
