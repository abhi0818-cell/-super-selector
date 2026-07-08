/**
 * profileUtils.ts
 *
 * Shared profile helpers for the mobile app.
 * Mirrors the resolveDisplayName() helper in db.js (web) — keep them in sync.
 */

/**
 * Resolve the leaderboard display name for a profile row.
 * Priority: team_name → display_name → 'Player'.
 *
 * Note: mobile queries only select `id, display_name, team_name` (no email),
 * so email is not in the fallback chain here. The web helper (db.js) includes
 * email as a third fallback because it has access to that column.
 */
export function resolveDisplayName(p: {
  team_name?: string | null;
  display_name?: string | null;
}): string {
  return p.team_name ?? p.display_name ?? 'Player';
}
