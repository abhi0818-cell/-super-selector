/**
 * BoostersBar — gradient-first Pass 1
 * Shown in My XI between BudgetBar and RoleStats — Season Long contests only.
 *
 * Tapping a chip only STAGES a pick locally (selectBooster) — nothing is
 * written to Supabase here. The staged pick is committed to
 * user_booster_activations only when the screen's Save XI action runs (see
 * MyXIScreen.handleConfirm → useBoosterStore.commitPending()), exactly
 * mirroring web's "click stages, Save XI persists" model. This used to call
 * activateBooster/deactivateBooster directly from an Alert.alert confirm,
 * writing to the DB the instant you tapped — that's what made mobile diverge
 * from web's behavior.
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
  gold:   '#92650A',
  good:   '#2D6A35',
  border: 'rgba(201,168,76,0.22)',
} as const;

const STATUS_CONFIG: Record<BoosterStatus, { label: string; color: string; bg: string }> = {
  available: { label: 'Available', color: C.accent, bg: 'rgba(201,168,76,0.10)' },
  pending:   { label: 'Staged*',    color: C.gold,   bg: 'rgba(201,168,76,0.22)' },
  active:    { label: 'Active',     color: C.good,   bg: 'rgba(45,106,53,0.10)'  },
  used:      { label: 'Used',       color: C.muted,  bg: 'rgba(0,0,0,0.05)'      },
};

interface Props {
  contestType: string | undefined;
  squadId:     string | null;
  matchId:     string | null;
  /** Optional toast callback so the caller's existing toast UI can surface staging feedback. */
  onStaged?: (message: string) => void;
}

export default function BoostersBar({ contestType, squadId, matchId, onStaged }: Props) {
  const { boosters, selectBooster } = useBoosterStore();

  if (contestType !== 'sl' && contestType !== 'private') return null;

  const handlePress = (id: string) => {
    const b = boosters.find(x => x.id === id)!;

    if (b.status === 'used') {
      const reason = b.usedInOther >= b.totalUses
        ? 'This booster has already been used this season.'
        : 'Another booster is already selected for this match, or this one has no effect here.';
      Alert.alert(`${b.icon}  ${b.name}`, reason);
      return;
    }

    const becomingStaged = b.status === 'available';
    selectBooster(id);
    onStaged?.(becomingStaged
      ? `${b.icon} ${b.name} staged — Save XI to confirm.`
      : `${b.icon} ${b.name} removed — Save XI to confirm.`);
  };

  const handleInfo = (id: string) => {
    const b = boosters.find(x => x.id === id)!;
    Alert.alert(`${b.icon}  ${b.name}`, b.desc);
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
          const cfg       = STATUS_CONFIG[b.status];
          const isOn      = b.status === 'active' || b.status === 'pending';
          const isPending = b.status === 'pending';
          const isUsed    = b.status === 'used';
          return (
            <Pressable
              key={b.id}
              style={({ pressed }) => [
                styles.chip,
                isOn      && styles.chipActive,
                isPending && styles.chipPending,
                isUsed    && styles.chipUsed,
                pressed   && styles.chipPressed,
              ]}
              onPress={() => handlePress(b.id)}
              onLongPress={() => handleInfo(b.id)}
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
              {isOn && <Text style={[styles.activeCheck, isPending && { color: C.gold }]}>{isPending ? '*' : '✓'}</Text>}
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
  chipPending: {
    borderColor:     'rgba(146,101,10,0.5)',
    backgroundColor: 'rgba(146,101,10,0.10)',
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
