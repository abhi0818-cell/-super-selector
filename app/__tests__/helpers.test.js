/**
 * helpers.test.js
 *
 * Phase 1b — tests for the two duplicated helper patterns across web + mobile:
 *   1. Leaderboard display-name resolution (team_name ?? display_name ?? email)
 *   2. Dot-ball gating (returns 0 unless tournament.dot_ball_enabled is true)
 *
 * Both helpers are extracted to tests/web-scoring-engine.js. These tests
 * assert the logic is correct once, and the cross-check tests (scoringCrossCheck)
 * ensure the mobile implementations stay in sync.
 *
 * Run: cd app && node -r ./node_modules/sucrase/register --test __tests__/helpers.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDisplayName, effectiveDotBall } = require('../../tests/web-scoring-engine.js');

// ─── resolveDisplayName ───────────────────────────────────────────────────────

describe('resolveDisplayName — name-fallback chain', () => {
  it('prefers team_name when all three present', () => {
    const result = resolveDisplayName({ team_name: 'RCBFanatics', display_name: 'Abhinav Gupta', email: 'abhi@test.com', id: 'abc-123' });
    assert.equal(result, 'RCBFanatics');
  });

  it('falls back to display_name when team_name is null', () => {
    const result = resolveDisplayName({ team_name: null, display_name: 'Abhinav Gupta', email: 'abhi@test.com', id: 'abc-123' });
    assert.equal(result, 'Abhinav Gupta');
  });

  it('falls back to display_name when team_name is empty string', () => {
    const result = resolveDisplayName({ team_name: '', display_name: 'Abhinav Gupta', email: 'abhi@test.com', id: 'abc-123' });
    assert.equal(result, 'Abhinav Gupta');
  });

  it('falls back to email when both team_name and display_name are null', () => {
    const result = resolveDisplayName({ team_name: null, display_name: null, email: 'abhi@test.com', id: 'abc-123' });
    assert.equal(result, 'abhi@test.com');
  });

  it('falls back to first 8 chars of id when team_name, display_name, email all null/empty', () => {
    const result = resolveDisplayName({ team_name: null, display_name: null, email: null, id: 'd7cf42cd-659f-4973' });
    assert.equal(result, 'd7cf42cd');
  });

  it('all null — returns empty string (no crash)', () => {
    const result = resolveDisplayName({ team_name: null, display_name: null, email: null, id: null });
    assert.equal(typeof result, 'string');
  });

  it('backfilled rows where display_name = email (pre-v33 migration) still resolve gracefully', () => {
    // Row created before migration_v33: team_name is null, display_name was set to email
    const result = resolveDisplayName({ team_name: null, display_name: 'anuj.sfc@gmail.com', email: 'anuj.sfc@gmail.com', id: 'd7cf42cd' });
    assert.equal(result, 'anuj.sfc@gmail.com'); // display_name wins; team_name absent
  });

  it('post-v33 row with team_name set correctly', () => {
    const result = resolveDisplayName({ team_name: 'ShooterXI', display_name: 'Kumar Harshit', email: 'kumarharshit03@gmail.com', id: '84b34d83' });
    assert.equal(result, 'ShooterXI');
  });
});

// ─── effectiveDotBall ─────────────────────────────────────────────────────────

describe('effectiveDotBall — dot-ball gate', () => {
  it('returns base value when dot_ball_enabled is true', () => {
    assert.equal(effectiveDotBall(1,   true),  1);
    assert.equal(effectiveDotBall(0.5, true),  0.5);
  });

  it('returns 0 when dot_ball_enabled is false', () => {
    assert.equal(effectiveDotBall(1,   false), 0);
    assert.equal(effectiveDotBall(0.5, false), 0);
  });

  it('returns 0 when dot_ball_enabled is null (treated as falsy)', () => {
    assert.equal(effectiveDotBall(1, null),      0);
    assert.equal(effectiveDotBall(1, undefined),  0);
  });

  it('returns 0 even if base value is 0 and flag is true', () => {
    assert.equal(effectiveDotBall(0, true), 0);
  });

  it('integration: bowling points with dot_ball gated off = same as dot_ball=0 override', () => {
    const { calcBowling, DEFAULT_SCORING_RULES } = require('../../tests/web-scoring-engine.js');
    const spell = { wickets: 1, wicketTypes: [], maidens: 0, runsConceded: 10, ballsBowled: 12, dotBalls: 6, noBalls: 0, wides: 0 };

    // Using the gate helper to build the override
    const gatedRules = { ...DEFAULT_SCORING_RULES.T20, dot_ball: effectiveDotBall(DEFAULT_SCORING_RULES.T20.dot_ball, false) };
    const gated = calcBowling(spell, 'T20', gatedRules);

    // Direct override with dot_ball: 0
    const direct = calcBowling(spell, 'T20', { ...DEFAULT_SCORING_RULES.T20, dot_ball: 0 });

    assert.equal(gated.points, direct.points);
    assert.equal(gated.breakdown.dotBalls, 0);
  });
});
