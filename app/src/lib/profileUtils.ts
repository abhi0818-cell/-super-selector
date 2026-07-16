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

/**
 * Resolve the ACTUAL PERSON's name for a profile row — deliberately skips
 * team_name, unlike resolveDisplayName above. Use this anywhere a squad/team
 * name is already shown as its own separate label (e.g. the Season Long
 * leaderboard: squad name is the bold primary line, this is the small
 * "owned by" sub-line underneath it). Squads are typically created using the
 * same team_name the account set at signup, so using resolveDisplayName
 * there showed the team name twice — once as the squad name, once as this
 * line. Mirrors resolvePersonName() in db.js (web) — keep them in sync.
 */
export function resolvePersonName(p: {
  first_name?: string | null;
  last_name?: string | null;
  display_name?: string | null;
  team_name?: string | null;
}): string {
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (p.display_name && p.display_name !== p.team_name) return p.display_name;
  return 'Player';
}
