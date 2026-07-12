/**
 * BoostersBar — icon-first card tiles (Pass 2)
 * Shown in My XI between BudgetBar and RoleStats — Season Long contests only.
 *
 * All boosters are always visible in a single row (no horizontal scroll).
 * Tapping a chip only STAGES a pick locally (selectBooster) — nothing is
 * written to Supabase here. The staged pick is committed to
 * user_booster_activations only when the screen's Save XI action runs (see
 * MyXIScreen.handleConfirm → useBoosterStore.commitPending()), exactly
 * mirroring web's "click stages, Save XI persists" model.
 */

import React from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useBoosterStore } from '../store/boosterStore';
import { fontSize, radius, spacing } from '../theme';
import { SelectedPlayer } from '../types';

const C = {
  text:   '#1C1F26',
  muted:  '#7A7060',
  accent: '#C9A84C',
  gold:   '#92650A',
  good:   '#2D6A35',
  border: 'rgba(201,168,76,0.22)',
} as const;

interface Props {
  contestType: string | undefined;
  squadId:     string | null;
  matchId:     string | null;
  onStaged?:   (message: string) => void;
  /** The squad's true previous LOCKED XI — same baseline MyXIScreen already
   * tracks for the transfer diff. Used so activating Free Hit can snap the
   * picker to it (see below). */
  previousLockedXI?: SelectedPlayer[];
  /** teamStore.restoreXI — replaces the on-screen XI wholesale. */
  restoreXI?: (players: SelectedPlayer[]) => void;
}

export default function BoostersBar({ contestType, squadId, matchId, onStaged, previousLockedXI, restoreXI }: Props) {
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

    // Free Hit's whole premise is "make free changes from your CURRENT
    // locked team for this one match, then revert after" — so staging it
    // snaps the picker to that locked baseline immediately, same as web's
    // equivalent fix and mobile's own Revert to Locked. Previously staging
    // Free Hit left whatever was already on screen untouched (which could
    // be an unrelated stale draft), so the user never actually saw their
    // locked team to start editing from. Only on activation, not on
    // deselect, and only when a real locked baseline exists.
    let resetNote = '';
    if (becomingStaged && id === 'free_hit' && previousLockedXI?.length === 11 && restoreXI) {
      restoreXI(previousLockedXI);
      resetNote = ' Loaded your locked team — make your changes and Save XI.';
    }

    onStaged?.(becomingStaged
      ? `${b.icon} ${b.name} staged — Save XI to confirm.${resetNote}`
      : `${b.icon} ${b.name} removed — Save XI to confirm.`);
  };

  const handleInfo = (id: string) => {
    const b = boosters.find(x => x.id === id)!;
    Alert.alert(`${b.icon}  ${b.name}`, b.desc);
  };

  return (
    <View style={styles.wrapper}>
      <Text style={styles.sectionLabel}>Boosters</Text>
      <View style={styles.row}>
        {boosters.map(b => {
          const isOn      = b.status === 'active' || b.status === 'pending';
          const isPending = b.status === 'pending';
          const isUsed    = b.status === 'used';
          return (
            <Pressable
              key={b.id}
              style={({ pressed }) => [
                styles.card,
                isOn      && styles.cardActive,
                isPending && styles.cardPending,
                isUsed    && styles.cardUsed,
                pressed   && styles.cardPressed,
              ]}
              onPress={() => handlePress(b.id)}
              onLongPress={() => handleInfo(b.id)}
            >
              <Text style={styles.cardIcon}>{b.icon}</Text>
              <Text
                style={[styles.cardName, isUsed && styles.cardNameUsed]}
                numberOfLines={1}
              >
                {b.name}
              </Text>
              {isOn && (
                <Text style={[styles.cardStatus, isPending && styles.cardStatusPending]}>
                  {isPending ? 'Staged' : 'Active'}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
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
    fontSize:          11,
    fontWeight:        '700',
    textTransform:     'uppercase',
    letterSpacing:     0.8,
    paddingHorizontal: spacing.lg,
    marginBottom:      6,
  },
  row: {
    flexDirection:     'row',
    paddingHorizontal: spacing.lg,
    gap:               6,
  },

  // Card tile
  card: {
    flex:            1,
    alignItems:      'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderRadius:    radius.lg,
    borderWidth:     1,
    borderColor:     'rgba(201,168,76,0.2)',
    gap:             3,
  },
  cardActive: {
    backgroundColor: 'rgba(45,106,53,0.10)',
    borderColor:     'rgba(45,106,53,0.4)',
  },
  cardPending: {
    backgroundColor: 'rgba(201,168,76,0.15)',
    borderColor:     'rgba(201,168,76,0.55)',
  },
  cardUsed:    { opacity: 0.35 },
  cardPressed: { opacity: 0.75, transform: [{ scale: 0.97 }] },

  cardIcon: {
    fontSize: 20,
  },
  cardName: {
    color:      C.text,
    fontSize:   11,
    fontWeight: '600',
    textAlign:  'center',
  },
  cardNameUsed: { color: C.muted },
  cardStatus: {
    fontSize:   11,
    fontWeight: '700',
    color:      C.good,
  },
  cardStatusPending: { color: C.gold },
});
