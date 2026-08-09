/**
 * scoringUtils.ts
 *
 * Shared scoring helpers for the mobile app.
 */

import { SCORING_RULES, ScoringRuleSet } from '../engine/cricketScoringEngine';
import { MatchFormat } from '../types';

/**
 * Single source of truth for "what rules apply to this player's points" on
 * the mobile app, mirroring scoringEngine.shared.js's resolveEffectiveRules()
 * (root canonical module — kept in sync here rather than imported directly,
 * since Metro's default project root is app/, not the repo root; see that
 * file's header for the full consolidation notes).
 *
 * Merge order: built-in default → tournament.scoring_rules override →
 * contest.scoring_rules override, then the dot-ball gate (migration_v30)
 * forces dot_ball to 0 unless the tournament has explicitly turned it on,
 * regardless of what numeric weight is saved in either rules object.
 *
 * Before this, dailyLeaderboard.ts/seasonHistory.ts only ever applied this
 * resolution to BOWLING (via the old bowlingRulesFor, kept below for
 * back-compat) — batting and fielding breakdowns were computed against the
 * hardcoded SCORING_RULES default no matter what a tournament or contest had
 * actually customized, so the itemized "My Team" breakdown could silently
 * disagree with the real persisted total for any tournament/league running
 * non-default batting or fielding rules.
 */
export function resolveEffectiveRules(
  fmt: MatchFormat,
  // Untyped on purpose — these come straight off a Supabase JSONB column
  // (tournaments.scoring_rules / contests.scoring_rules), so there's no
  // compile-time guarantee of shape beyond "maybe has a key per format".
  tournamentScoringRules: Record<string, any> | null | undefined,
  contestScoringRules: Record<string, any> | null | undefined,
  dotBallEnabled: boolean | null | undefined,
): ScoringRuleSet {
  const rules: ScoringRuleSet = {
    ...SCORING_RULES[fmt],
    ...(tournamentScoringRules?.[fmt] ?? {}),
    ...(contestScoringRules?.[fmt] ?? {}),
  };
  if (!dotBallEnabled) rules.dot_ball = 0;
  return rules;
}

/**
 * @deprecated Prefer resolveEffectiveRules(), which also honors
 * tournament/contest scoring_rules for batting and fielding, not just the
 * dot-ball gate. Kept for any caller not yet migrated.
 */
export function bowlingRulesFor(
  fmt: MatchFormat,
  dotBallEnabled: boolean | null | undefined,
): typeof SCORING_RULES[MatchFormat] | undefined {
  return dotBallEnabled ? undefined : { ...SCORING_RULES[fmt], dot_ball: 0 };
}
