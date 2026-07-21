/**
 * Fantasy Cricket Scoring Engine
 * Compatible with IPL / T20 / ODI / Test formats
 * 
 * Usage:
 *   import { calculateScore, applyMultiplier, SCORING_RULES } from './cricketScoringEngine.js';
 */

// ─── Scoring Rules ────────────────────────────────────────────────────────────

export const SCORING_RULES = {
  T20: {
    // Batting
    run: 1,
    boundary4: 1,          // bonus per four
    boundary6: 2,          // bonus per six
    thirty_run_bonus: 4,   // 30+ runs bonus
    half_century: 8,       // 50+ runs bonus
    century: 16,           // 100+ runs bonus
    duck: -2,              // dismissed for 0 (batters/AR/WK only)

    // Strike rate bonuses/penalties (min 10 balls faced)
    sr_above_170: 6,
    sr_140_to_170: 4,
    sr_below_70: -6,
    sr_70_to_100: -2,

    // Bowling
    wicket: 25,
    lbw_bowled_bonus: 8,   // extra if wicket type is LBW or Bowled
    maiden_over: 12,
    dot_ball: 1,
    three_wicket_haul: 8,
    four_wicket_haul: 8,
    five_wicket_haul: 16,

    // Economy rate bonuses/penalties (min 2 overs)
    economy_below_5: 6,
    economy_5_to_6: 4,
    economy_10_to_11: -4,
    economy_above_11: -6,

    // Fielding
    catch: 8,
    stumping: 12,
    run_out_direct: 12,
    run_out_indirect: 6,

    // Extras (deducted from bowler score)
    no_ball: -1,
    wide: -1,
  },

  ODI: {
    run: 1,
    boundary4: 1,
    boundary6: 2,
    half_century: 4,
    century: 8,
    duck: -3,

    sr_above_140: 6,
    sr_120_to_140: 2,
    sr_below_50: -6,
    sr_50_to_75: -2,

    wicket: 25,
    lbw_bowled_bonus: 8,
    maiden_over: 4,
    dot_ball: 0.5,
    four_wicket_haul: 4,
    five_wicket_haul: 8,

    economy_below_2_5: 6,
    economy_2_5_to_3_5: 4,
    economy_7_to_8: -4,
    economy_above_9: -6,

    catch: 8,
    stumping: 12,
    run_out_direct: 12,
    run_out_indirect: 6,

    no_ball: -1,
    wide: -1,
  },

  TEST: {
    run: 1,
    boundary4: 0,
    boundary6: 0,
    half_century: 4,
    century: 8,
    duck: -4,

    wicket: 16,
    lbw_bowled_bonus: 8,
    maiden_over: 4,
    five_wicket_haul: 8,

    catch: 8,
    stumping: 12,
    run_out_direct: 12,
    run_out_indirect: 6,

    no_ball: -1,
    wide: -1,
  },
};

// Captain gets 2×, vice-captain gets 1.5×
export const MULTIPLIERS = {
  captain: 2,
  vice_captain: 1.5,
  normal: 1,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function strikeRate(runs, ballsFaced) {
  if (ballsFaced === 0) return null;
  return (runs / ballsFaced) * 100;
}

function economyRate(runsConceded, ballsBowled) {
  if (ballsBowled === 0) return null;
  return (runsConceded / ballsBowled) * 6;
}

// ─── Core Scoring Functions ───────────────────────────────────────────────────

/**
 * Calculate batting points for a player's innings.
 *
 * @param {object} innings
 * @param {number} innings.runs
 * @param {number} innings.ballsFaced
 * @param {number} innings.fours
 * @param {number} innings.sixes
 * @param {boolean} innings.isDismissed
 * @param {string}  innings.role  - 'bat'|'bowl'|'ar'|'wk'
 * @param {string}  format        - 'T20'|'ODI'|'TEST'
 * @returns {{ points: number, breakdown: object }}
 */
export function calcBattingPoints(innings, format = 'T20') {
  const rules = SCORING_RULES[format];
  const { runs, ballsFaced, fours, sixes, isDismissed, role } = innings;
  const breakdown = {};

  // Base runs
  breakdown.runs = runs * rules.run;

  // Boundary bonuses
  breakdown.boundary4 = (fours || 0) * (rules.boundary4 || 0);
  breakdown.boundary6 = (sixes || 0) * (rules.boundary6 || 0);

  // Milestone bonuses
  if (runs >= 100) {
    breakdown.century = rules.century || 0;
  } else if (runs >= 50) {
    breakdown.half_century = rules.half_century || 0;
  } else if (runs >= 30) {
    breakdown.thirtyRunBonus = rules.thirty_run_bonus || 0;
  }

  // Duck penalty — applies to batters / all-rounders / wicket-keepers,
  // NOT to pure bowlers (standard Dream11 behavior).
  if (isDismissed && runs === 0 && role !== 'bowl') {
    breakdown.duck = rules.duck || 0;
  }

  // Strike rate (T20 / ODI only, min 10 balls)
  if (rules.sr_above_170 !== undefined && ballsFaced >= 10) {
    const sr = strikeRate(runs, ballsFaced);
    breakdown.strikeRateBonus = calcStrikeRateBonus(sr, format, rules);
  } else {
    breakdown.strikeRateBonus = 0;
  }

  const points = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { points, breakdown };
}

function calcStrikeRateBonus(sr, format, rules) {
  if (format === 'T20') {
    if (sr > 170) return rules.sr_above_170;
    if (sr >= 140) return rules.sr_140_to_170;
    if (sr < 70)  return rules.sr_below_70;
    if (sr < 100) return rules.sr_70_to_100;
  }
  if (format === 'ODI') {
    if (sr > 140) return rules.sr_above_140;
    if (sr >= 120) return rules.sr_120_to_140;
    if (sr < 50)  return rules.sr_below_50;
    if (sr < 75)  return rules.sr_50_to_75;
  }
  return 0;
}

/**
 * Calculate bowling points.
 *
 * @param {object} spell
 * @param {number} spell.wickets
 * @param {string[]} spell.wicketTypes  - e.g. ['bowled', 'lbw', 'caught']
 * @param {number} spell.maidens
 * @param {number} spell.runsConceded
 * @param {number} spell.ballsBowled
 * @param {number} spell.dotBalls
 * @param {number} spell.noBalls
 * @param {number} spell.wides
 * @param {string} format
 * @returns {{ points: number, breakdown: object }}
 */
export function calcBowlingPoints(spell, format = 'T20') {
  const rules = SCORING_RULES[format];
  const { wickets, wicketTypes = [], maidens, runsConceded, ballsBowled, dotBalls, noBalls, wides } = spell;
  const breakdown = {};

  // Wickets
  breakdown.wickets = wickets * rules.wicket;

  // LBW / Bowled bonus
  const premiumWickets = wicketTypes.filter(t => ['lbw', 'bowled'].includes(t.toLowerCase())).length;
  breakdown.lbwBowledBonus = premiumWickets * (rules.lbw_bowled_bonus || 0);

  // Haul bonuses
  if (wickets >= 5 && rules.five_wicket_haul) breakdown.fiveWicket = rules.five_wicket_haul;
  else if (wickets >= 4 && rules.four_wicket_haul) breakdown.fourWicket = rules.four_wicket_haul;
  else if (wickets >= 3 && rules.three_wicket_haul) breakdown.threeWicket = rules.three_wicket_haul;

  // Maidens
  breakdown.maidens = (maidens || 0) * rules.maiden_over;

  // Dot balls
  breakdown.dotBalls = (dotBalls || 0) * (rules.dot_ball || 0);

  // Economy rate — app rule: bowler must have bowled MORE than 1 over (>6 balls).
  if (ballsBowled > 6) {
    const eco = economyRate(runsConceded, ballsBowled);
    breakdown.economyBonus = calcEconomyBonus(eco, format, rules);
  } else {
    breakdown.economyBonus = 0;
  }

  // Extras penalties
  breakdown.noBalls = (noBalls || 0) * (rules.no_ball || 0);
  breakdown.wides   = (wides   || 0) * (rules.wide   || 0);

  const points = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { points, breakdown };
}

function calcEconomyBonus(eco, format, rules) {
  if (format === 'T20') {
    if (eco < 5)   return rules.economy_below_5;
    if (eco < 6)   return rules.economy_5_to_6;
    if (eco >= 11) return rules.economy_above_11;
    if (eco >= 10) return rules.economy_10_to_11;
  }
  if (format === 'ODI') {
    if (eco < 2.5) return rules.economy_below_2_5;
    if (eco < 3.5) return rules.economy_2_5_to_3_5;
    if (eco >= 9)  return rules.economy_above_9;
    if (eco >= 7)  return rules.economy_7_to_8;
  }
  return 0;
}

/**
 * Calculate fielding points.
 *
 * @param {object} fielding
 * @param {number} fielding.catches
 * @param {number} fielding.stumpings
 * @param {number} fielding.runOutDirect
 * @param {number} fielding.runOutIndirect
 * @param {string} format
 * @returns {{ points: number, breakdown: object }}
 */
export function calcFieldingPoints(fielding, format = 'T20') {
  const rules = SCORING_RULES[format];
  const { catches, stumpings, runOutDirect, runOutIndirect } = fielding;
  const breakdown = {
    catches:       (catches       || 0) * rules.catch,
    stumpings:     (stumpings     || 0) * rules.stumping,
    runOutDirect:  (runOutDirect  || 0) * rules.run_out_direct,
    runOutIndirect:(runOutIndirect|| 0) * rules.run_out_indirect,
  };
  const points = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { points, breakdown };
}

// ─── Master Calculator ────────────────────────────────────────────────────────

/**
 * Calculate total fantasy points for a player's full match performance.
 *
 * @param {object} player
 * @param {string} player.name
 * @param {string} player.role      - 'bat'|'bowl'|'ar'|'wk'
 * @param {string} player.captaincy - 'captain'|'vice_captain'|'normal'
 * @param {object} player.batting   - innings object (optional)
 * @param {object} player.bowling   - spell object (optional)
 * @param {object} player.fielding  - fielding object (optional)
 * @param {string} format
 * @returns {{ name, totalPoints, multiplier, rawPoints, breakdown }}
 */
export function calculateScore(player, format = 'T20') {
  const { name, role, captaincy = 'normal', batting, bowling, fielding } = player;
  const breakdown = {};
  let rawPoints = 0;

  if (batting) {
    const bat = calcBattingPoints({ ...batting, role }, format);
    breakdown.batting = bat.breakdown;
    rawPoints += bat.points;
  }

  if (bowling) {
    const bowl = calcBowlingPoints(bowling, format);
    breakdown.bowling = bowl.breakdown;
    rawPoints += bowl.points;
  }

  if (fielding) {
    const field = calcFieldingPoints(fielding, format);
    breakdown.fielding = field.breakdown;
    rawPoints += field.points;
  }

  const multiplier = MULTIPLIERS[captaincy] || 1;
  const totalPoints = Math.round(rawPoints * multiplier * 10) / 10;

  return { name, totalPoints, multiplier, rawPoints: Math.round(rawPoints * 10) / 10, breakdown };
}

/**
 * Score an entire team and return a ranked leaderboard.
 *
 * @param {object[]} players  - array of player objects (same shape as calculateScore)
 * @param {string}   format
 * @returns {object[]} sorted array of scored players
 */
export function scoreTeam(players, format = 'T20') {
  return players
    .map(p => calculateScore(p, format))
    .sort((a, b) => b.totalPoints - a.totalPoints);
}

// ─── Utility: pretty-print a score result ────────────────────────────────────

export function formatScoreReport(result) {
  const lines = [`${result.name} — ${result.totalPoints} pts`];
  if (result.multiplier > 1) {
    lines.push(`  (${result.rawPoints} raw × ${result.multiplier}× ${result.multiplier === 2 ? 'captain' : 'vc'})`);
  }
  for (const [category, cats] of Object.entries(result.breakdown)) {
    lines.push(`  ${category}:`);
    for (const [key, val] of Object.entries(cats)) {
      if (val !== 0) lines.push(`    ${key}: ${val > 0 ? '+' : ''}${val}`);
    }
  }
  return lines.join('\n');
}


// ─── Quick demo (runs when executed directly) ─────────────────────────────────

const demoPlayers = [
  {
    name: 'Rohit Sharma',
    role: 'bat',
    captaincy: 'captain',
    batting: { runs: 72, ballsFaced: 44, fours: 7, sixes: 4, isDismissed: true },
  },
  {
    name: 'Jasprit Bumrah',
    role: 'bowl',
    captaincy: 'vice_captain',
    bowling: {
      wickets: 3, wicketTypes: ['bowled', 'lbw', 'caught'],
      maidens: 1, runsConceded: 18, ballsBowled: 24, dotBalls: 10, noBalls: 0, wides: 1,
    },
    fielding: { catches: 1, stumpings: 0, runOutDirect: 0, runOutIndirect: 0 },
  },
  {
    name: 'Ravindra Jadeja',
    role: 'ar',
    captaincy: 'normal',
    batting: { runs: 34, ballsFaced: 18, fours: 2, sixes: 2, isDismissed: false },
    bowling: {
      wickets: 2, wicketTypes: ['caught', 'caught'],
      maidens: 0, runsConceded: 22, ballsBowled: 24, dotBalls: 6, noBalls: 0, wides: 0,
    },
    fielding: { catches: 2, stumpings: 0, runOutDirect: 0, runOutIndirect: 1 },
  },
  {
    name: 'MS Dhoni',
    role: 'wk',
    captaincy: 'normal',
    batting: { runs: 0, ballsFaced: 1, fours: 0, sixes: 0, isDismissed: true },
    fielding: { catches: 0, stumpings: 2, runOutDirect: 0, runOutIndirect: 0 },
  },
];

const results = scoreTeam(demoPlayers, 'T20');
results.forEach(r => console.log(formatScoreReport(r)));
export { demoPlayers };
