import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fontSize, radius, spacing } from '../theme';
import { RULES } from '../store/teamStore';

interface Props {
  creditsSpent: number;
  creditsLeft:  number;
  playerCount:  number;
}

const C = {
  text:    '#1C1F26',
  muted:   '#7A7060',
  accent:  '#C9A84C',
  bad:     '#C0392B',
  gold:    '#92650A',
  border:  'rgba(201,168,76,0.22)',
} as const;

export default function BudgetBar({ creditsSpent, creditsLeft, playerCount }: Props) {
  const pct  = Math.min((creditsSpent / RULES.budget) * 100, 100);
  const over = creditsSpent > RULES.budget;
  const full = playerCount >= RULES.total;

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Text style={styles.label}>Budget</Text>
        <Text style={[styles.value, over && styles.bad]}>
          {creditsLeft.toFixed(1)} CR left
        </Text>
        <View style={[styles.countPill, full && styles.countPillFull]}>
          <Text style={[styles.count, full && styles.countFull]}>
            {playerCount}/{RULES.total}
          </Text>
        </View>
      </View>

      {/* Progress track */}
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { width: `${pct}%` as any },
            over && styles.fillOver,
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm,
    backgroundColor:   'rgba(245,240,224,0.97)',
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap:               6,
  },
  row: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
  },
  label: {
    color:         C.muted,
    fontSize:      fontSize.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flex:          1,
  },
  value: {
    color:      C.accent,
    fontSize:   fontSize.sm,
    fontWeight: '700',
  },
  bad: {
    color: C.bad,
  },
  countPill: {
    paddingHorizontal: 8,
    paddingVertical:   2,
    borderRadius:      radius.full,
    backgroundColor:   'rgba(201,168,76,0.1)',
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.28)',
  },
  countPillFull: {
    backgroundColor: 'rgba(45,106,53,0.12)',
    borderColor:     'rgba(45,106,53,0.3)',
  },
  count: {
    color:      C.muted,
    fontSize:   fontSize.xs,
    fontWeight: '700',
  },
  countFull: {
    color: '#2D6A35',
  },
  track: {
    height:           4,
    backgroundColor:  'rgba(201,168,76,0.15)',
    borderRadius:     radius.full,
    overflow:         'hidden',
  },
  fill: {
    height:          '100%',
    backgroundColor: C.accent,
    borderRadius:    radius.full,
  },
  fillOver: {
    backgroundColor: C.bad,
  },
});
