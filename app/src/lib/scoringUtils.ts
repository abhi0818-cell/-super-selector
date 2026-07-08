/**
 * scoringUtils.ts
 *
 * Shared scoring helpers for the mobile app.
 */

import { SCORING_RULES } from '../engine/cricketScoringEngine';
import { MatchFormat } from '../types';

/**
 * Returns the bowling rules to use for scoring, gating dot-ball points by
 * whether the tournament has them enabled.
 *
 * When dotBallEnabled is false/null/undefined, dot_ball is clamped to 0 by
 * returning an overridden rules object. When true, the normal rules are used
 * (returning undefined signals the engine to use its defaults).
 *
 * Mirrors the dot-ball clamping pattern used on the web (db.js / index.html)
 * and in the poll-cricapi / scrape-scorecard scripts.
 */
export function bowlingRulesFor(
  fmt: MatchFormat,
  dotBallEnabled: boolean | null | undefined,
): typeof SCORING_RULES[MatchFormat] | undefined {
  return dotBallEnabled ? undefined : { ...SCORING_RULES[fmt], dot_ball: 0 };
}
