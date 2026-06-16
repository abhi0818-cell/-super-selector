/**
 * BoostersBar — gradient-first Pass 1
 * Shown in My XI between BudgetBar and RoleStats — Season Long contests only.
 */

import React from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useBoosterStore, BoosterStatus } from '../store/boosterStore';
import { fontSize, radius, spacing } from '../theme';

const C = {
  text:   '#1C1F26',
  muted:  '#7A7060',
  accent: '#C9A84C',
  good:   '#2D6A35',
  border: 'rgba(201,168,76,0.22)',
} as const;

const STATUS_CONFIG: Record<BoosterStatus, { label: string; color: string; bg: string }> = {
  available: { label: 'Available', color: C.accent, bg: 'rgba(201,168,76,0.10)' },
  active:    { label: 'Active',    color: C.good,   bg: 'rgba(45,106,53,0.10)'  },
  used:      { label: 'Used',      color: C.muted,  bg: 'rgba(0,0,0,0.05)'      },
};

interface Props {
  contestType: string | undefined;
  squadId:     string | null;
  matchId:     string | null;
}

export default function BoostersBar({ contestType, squadId, matchId }: Props) {
  const { boosters, activateBooster, deactivateBooster } = useBoosterStore();

  if (contestType !== 'sl' && contestType !== 'private') return null;

  const handlePress = (id: string) => {
    const b = boosters.find(x => x.id === id)!;

    if (b.status === 'used') {
      Alert.alert(`${b.icon}  ${b.name}`, 'This booster has already been used this season.');
      return;
    }

    if (b.status === 'active') {
      // Deactivate — only allowed before match locks
      Alert.alert(
        `${b.icon}  ${b.name}`,
        'Remove this booster for the current match?',
        [
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              if (!squadId || !matchId) return;
              try {
                await deactivateBooster(squadId, matchId);
              } catch {
                Alert.alert('Error', 'Could not remove booster. Please try again.');
              }
            },
          },
          { text: 'Keep', style: 'cancel' },
        ],
      );
      return;
    }

    // Activate
    Alert.alert(
      `${b.icon}  ${b.name}`,
      b.desc,
      [
        {
          text: 'Activate',
          onPress: async () => {
            if (!squadId || !matchId) return;
            try {
              await activateBooster(squadId, matchId, id);
            } catch {
              Alert.alert('Error', 'Could not activate booster. Please try again.');
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  return (
    <View style={styles.wrapper}>
      <Text style={styles.sectionLabel}>Boosters</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {boosters.map(b => {
          const cfg    = STATUS_CONFIG[b.status];
          const isOn   = b.status === 'active';
          const isUsed = b.status === 'used';
          return (
            <Pressable
              key={b.id}
              style={({ pressed }) => [
                styles.chip,
                isOn   && styles.chipActive,
                isUsed && styles.chipUsed,
                pressed && styles.chipPressed,
              ]}
              onPress={() => handlePress(b.id)}
            >
              <Text style={styles.chipIcon}>{b.icon}</Text>
              <View style={styles.chipBody}>
                <Text style={[styles.chipName, isUsed && styles.chipNameUsed]}>
                  {b.name}
                </Text>
                <View style={[styles.statusPill, { backgroundColor: cfg.bg }]}>
                  <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
                </View>
              </View>
              {isOn && <Text style={styles.activeCheck}>✓</Text>}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor:   'rgba(245,240,224,0.97)',
    paddingVertical:   spacing.sm,
  },
  sectionLabel: {
    color:             C.muted,
    fontSize:          9,
    fontWeight:        '700',
    textTransform:     'uppercase',
    letterSpacing:     1,
    paddingHorizontal: spacing.lg,
    marginBottom:      4,
  },
  row: {
    paddingHorizontal: spacing.lg,
    gap:               spacing.sm,
    flexDirection:     'row',
  },
  chip: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm,
    backgroundColor:   'rgba(0,0,0,0.04)',
    borderRadius:      radius.lg,
    borderWidth:       1,
    borderColor:       C.border,
  },
  chipActive: {
    borderColor:     'rgba(45,106,53,0.4)',
    backgroundColor: 'rgba(45,106,53,0.08)',
  },
  chipUsed:    { opacity: 0.4 },
  chipPressed: { opacity: 0.75, transform: [{ scale: 0.97 }] },
  chipIcon:    { fontSize: 18 },
  chipBody:    { gap: 3 },
  chipName: {
    color:      C.text,
    fontSize:   fontSize.sm,
    fontWeight: '700',
  },
  chipNameUsed: { color: C.muted },
  statusPill: {
    borderRadius:      radius.full,
    paddingHorizontal: 6,
    paddingVertical:   1,
    alignSelf:         'flex-start',
  },
  statusText: {
    fontSize:      8,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  activeCheck: {
    color:      '#2D6A35',
    fontSize:   fontSize.base,
    fontWeight: '800',
    marginLeft: spacing.xs,
  },
});
