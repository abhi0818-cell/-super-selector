import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PlayerRole } from '../types';
import { fontSize, radius, spacing } from '../theme';
import { RULES } from '../store/teamStore';

interface Props {
  roleCounts: Record<PlayerRole, number>;
}

const ROLES: PlayerRole[] = ['wk', 'bat', 'ar', 'bowl'];
const ROLE_LABELS: Record<PlayerRole, string> = {
  wk: 'WK', bat: 'BAT', ar: 'AR', bowl: 'BOWL',
};

const C = {
  text:   '#1C1F26',
  muted:  '#7A7060',
  good:   '#2D6A35',
  bad:    '#C0392B',
  border: 'rgba(201,168,76,0.22)',
} as const;

export default function RoleStats({ roleCounts }: Props) {
  return (
    <View style={styles.container}>
      {ROLES.map(role => {
        const count = roleCounts[role] ?? 0;
        const [min, max] = RULES.role[role];
        const ok   = count >= min && count <= max;
        const over = count > max;

        return (
          <View
            key={role}
            style={[
              styles.stat,
              ok   && styles.statOk,
              over && styles.statBad,
            ]}
          >
            <Text style={styles.label}>{ROLE_LABELS[role]}</Text>
            <Text style={[styles.value, ok && styles.valueOk, over && styles.valueBad]}>
              {count}
            </Text>
            <Text style={styles.range}>{min}–{max}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection:     'row',
    gap:               5,
    paddingHorizontal: spacing.lg,
    paddingVertical:   4,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  stat: {
    flex:              1,
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'center',
    gap:               4,
    backgroundColor:   'rgba(0,0,0,0.04)',
    borderRadius:      radius.sm,
    paddingVertical:   4,
    paddingHorizontal: 4,
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.15)',
  },
  statOk: {
    backgroundColor: 'rgba(45,106,53,0.08)',
    borderColor:     'rgba(45,106,53,0.25)',
  },
  statBad: {
    backgroundColor: 'rgba(192,57,43,0.08)',
    borderColor:     'rgba(192,57,43,0.25)',
  },
  label: {
    color:         C.muted,
    fontSize:      11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontWeight:    '600',
  },
  value: {
    color:      C.text,
    fontSize:   fontSize.sm,
    fontWeight: '800',
  },
  valueOk:  { color: C.good },
  valueBad: { color: C.bad },
  range: {
    color:    C.muted,
    fontSize: 11,
  },
});
