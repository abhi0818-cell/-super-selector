/**
 * Per-player points breakdown panel — booster bar, BAT/BWL/FLD/BON/PTS column
 * headers, one row per player (role stripe, C/VC badge, multiplier badge),
 * and a totals footer. Extracted from LeaderboardScreen's TeamDetailModal so
 * the same rendering can be reused by the live-match team view (MyLiveTeamModal)
 * without duplicating ~150 lines of JSX/styles. Takes the same MatchTeam shape
 * seasonHistory.ts / dailyLeaderboard.ts already produce.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { PlayerRole } from '../types';
import { fontSize, radius, spacing } from '../theme';
import { MatchPlayer, MatchTeam } from '../lib/seasonHistory';

const G = {
  mwFooter: ['rgba(201,168,76,0.1)', 'rgba(245,240,224,0.85)'] as const,
};

const C = {
  text:    '#1C1F26',
  muted:   '#7A7060',
  accent:  '#C9A84C',
  border:  'rgba(201,168,76,0.25)',
};

const ROLE_COLOR: Record<PlayerRole, string> = {
  wk: '#C9A84C', bat: '#1A2744', ar: '#2D6A35', bowl: '#7A3012',
};
const ROLE_LABEL: Record<PlayerRole, string> = {
  wk: 'WK', bat: 'BAT', ar: 'AR', bowl: 'BOWL',
};

export function capMult(p: MatchPlayer): number {
  // Real, booster-aware multiplier from the scores view (handles triple
  // captain / team double / etc., not just plain captain/VC).
  if (p.multiplier != null) return p.multiplier;
  return p.captaincy === 'captain' ? 2 : p.captaincy === 'vice_captain' ? 1.5 : 1;
}
export function rawPts(p: MatchPlayer): number {
  return p.bat + p.bowl + p.field + p.bonus;
}
export function finalPts(p: MatchPlayer): number {
  return Math.round(rawPts(p) * capMult(p));
}

export default function TeamPointsBreakdown({ team, footerLabel }: { team: MatchTeam; footerLabel?: string }) {
  return (
    <>
      {/* Booster bar */}
      <View style={styles.boosterBar}>
        <Text style={styles.boosterBarLabel}>Boosters</Text>
        {team.boosters.length > 0
          ? team.boosters.map((b, i) => (
              <View key={i} style={styles.boosterPill}>
                <Text style={styles.boosterPillIcon}>{b.icon}</Text>
                <Text style={styles.boosterPillName}>{b.name}</Text>
              </View>
            ))
          : <Text style={styles.boosterNone}>None used</Text>
        }
      </View>

      {/* Column headers */}
      <View style={styles.colHeaders}>
        <Text style={[styles.colHdr, { flex: 1 }]}>Player</Text>
        <Text style={[styles.colHdr, { width: 30, textAlign: 'center' }]}>BAT</Text>
        <Text style={[styles.colHdr, { width: 30, textAlign: 'center' }]}>BWL</Text>
        <Text style={[styles.colHdr, { width: 30, textAlign: 'center' }]}>FLD</Text>
        <Text style={[styles.colHdr, { width: 30, textAlign: 'center' }]}>BON</Text>
        <Text style={[styles.colHdr, { width: 44, textAlign: 'right'  }]}>PTS</Text>
      </View>

      {/* Player rows */}
      {team.players.map((p, i) => {
        const isCap = p.captaincy === 'captain';
        const isVC  = p.captaincy === 'vice_captain';
        const mult  = capMult(p);
        const fp    = finalPts(p);

        return (
          <View key={i} style={[styles.playerRow, i % 2 === 1 && styles.playerRowAlt]}>
            <View style={[styles.roleStripe, { backgroundColor: ROLE_COLOR[p.role] }]} />

            <View style={styles.playerNameCell}>
              <View style={styles.playerNameRow}>
                {(isCap || isVC) && (
                  <View style={[styles.capBadge, isCap ? styles.capC : styles.capVC]}>
                    <Text style={styles.capBadgeText}>{isCap ? 'C' : 'VC'}</Text>
                  </View>
                )}
                <Text style={styles.playerName} numberOfLines={1}>{p.name}</Text>
              </View>
              <View style={styles.playerMeta}>
                <View style={[styles.rolePill, { borderColor: ROLE_COLOR[p.role] + '55' }]}>
                  <Text style={[styles.rolePillText, { color: ROLE_COLOR[p.role] }]}>
                    {ROLE_LABEL[p.role]}
                  </Text>
                </View>
                <Text style={styles.playerTeamText}>{p.team}</Text>
                {mult > 1 && (
                  <View style={[styles.multBadge, isCap ? styles.multC : styles.multVC]}>
                    <Text style={styles.multText}>×{mult}</Text>
                  </View>
                )}
              </View>
            </View>

            <Text style={[styles.statCol, p.bat   > 0 && styles.statColLit]}>{p.bat   || '—'}</Text>
            <Text style={[styles.statCol, p.bowl  > 0 && styles.statColLit]}>{p.bowl  || '—'}</Text>
            <Text style={[styles.statCol, p.field > 0 && styles.statColLit]}>{p.field || '—'}</Text>
            <Text style={[styles.statCol, p.bonus > 0 && styles.statColLit]}>{p.bonus || '—'}</Text>

            <Text style={[
              styles.finalPts,
              isCap && styles.finalPtsCap,
              isVC  && styles.finalPtsVC,
            ]}>
              {fp}
            </Text>
          </View>
        );
      })}

      {/* Totals footer */}
      <LinearGradient colors={G.mwFooter} style={styles.mwFooter} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
        <Text style={styles.mwFooterMatch} numberOfLines={1}>{footerLabel ?? ''}</Text>
        <Text style={styles.mwFooterPts}>{team.pts} pts</Text>
      </LinearGradient>
    </>
  );
}

const styles = StyleSheet.create({
  // Booster bar
  boosterBar: {
    flexDirection:   'row',
    alignItems:      'center',
    flexWrap:        'wrap',
    gap:             spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm,
    backgroundColor:   'rgba(0,0,0,0.03)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(28,31,38,0.1)',
  },
  boosterBarLabel: {
    color:         C.muted,
    fontSize:      fontSize.xs,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  boosterPill: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               4,
    paddingHorizontal: spacing.sm,
    paddingVertical:   3,
    backgroundColor:   'rgba(201,168,76,0.10)',
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.3)',
    borderRadius:      radius.full,
  },
  boosterPillIcon: { fontSize: 12 },
  boosterPillName: { color: C.accent, fontSize: fontSize.xs, fontWeight: '700' },
  boosterNone:     { color: C.muted, fontSize: fontSize.xs, fontStyle: 'italic' },

  // Column headers
  colHeaders: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: spacing.md,
    paddingVertical:   6,
    backgroundColor:   'rgba(0,0,0,0.03)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(28,31,38,0.1)',
  },
  colHdr: {
    color:         C.muted,
    fontSize:      fontSize.xs,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Player rows
  playerRow: {
    flexDirection:   'row',
    alignItems:      'center',
    paddingRight:    spacing.md,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(28,31,38,0.08)',
    backgroundColor:   'transparent',
  },
  playerRowAlt: {
    backgroundColor: 'rgba(0,0,0,0.02)',
  },

  roleStripe: {
    width:         3,
    alignSelf:     'stretch',
    marginRight:   spacing.sm,
    borderRadius:  2,
    marginVertical: 4,
  },

  playerNameCell: {
    flex: 1,
    gap:  3,
    paddingRight: 4,
  },
  playerNameRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           5,
  },
  playerName: {
    color:      C.text,
    fontSize:   fontSize.sm,
    fontWeight: '700',
    flexShrink: 1,
  },
  playerMeta: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           5,
  },
  playerTeamText: {
    color:    C.muted,
    fontSize: fontSize.xs,
  },

  capBadge: {
    width:          16,
    height:         16,
    borderRadius:    8,
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  },
  capC:          { backgroundColor: '#C9A84C' },
  capVC:         { backgroundColor: '#7A7060' },
  capBadgeText:  { color: '#1C1F26', fontSize: 8, fontWeight: '900' },

  rolePill: {
    borderWidth:       1,
    borderRadius:      radius.full,
    paddingHorizontal: 4,
    paddingVertical:   1,
  },
  rolePillText: { fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 0.4 },

  multBadge: {
    paddingHorizontal: 5,
    paddingVertical:   1,
    borderRadius:      radius.full,
    borderWidth:       1,
  },
  multC:    { borderColor: '#C9A84C44', backgroundColor: 'rgba(201,168,76,0.15)' },
  multVC:   { borderColor: '#7A706044', backgroundColor: 'rgba(122,112,96,0.15)' },
  multText: { color: C.text, fontSize: fontSize.xs, fontWeight: '800' },

  statCol: {
    width:      30,
    textAlign:  'center',
    color:      C.muted,
    fontSize:   fontSize.xs,
    fontWeight: '500',
  },
  statColLit: {
    color:      C.text,
    fontWeight: '600',
  },

  finalPts: {
    width:      44,
    textAlign:  'right',
    color:      C.text,
    fontSize:   fontSize.sm,
    fontWeight: '800',
  },
  finalPtsCap: { color: '#C9A84C' },
  finalPtsVC:  { color: '#7A7060' },

  // Totals footer
  mwFooter: {
    flexDirection:    'row',
    justifyContent:   'space-between',
    alignItems:       'center',
    marginTop:        spacing.md,
    marginHorizontal: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm,
    borderRadius:      radius.lg,
    borderWidth:       1,
    borderColor:       'rgba(28,31,38,0.12)',
  },
  mwFooterMatch: { color: C.muted, fontSize: fontSize.xs, flexShrink: 1, marginRight: spacing.sm },
  mwFooterPts:   { color: C.text, fontSize: fontSize.base, fontWeight: '800' },
});
