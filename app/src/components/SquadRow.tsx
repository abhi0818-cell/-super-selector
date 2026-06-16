import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SelectedPlayer, CaptaincyRole } from '../types';
import { colors, fontSize, radius, spacing } from '../theme';
import RoleTag from './RoleTag';

interface Props {
  player: SelectedPlayer;
  onRemove: () => void;
  onSetCaptaincy: (role: CaptaincyRole) => void;
}

export default function SquadRow({ player, onRemove, onSetCaptaincy }: Props) {
  const isCap = player.captaincy === 'captain';
  const isVC  = player.captaincy === 'vice_captain';

  return (
    <View style={styles.row}>
      {/* Player info */}
      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>{player.name}</Text>
          {isCap && <View style={styles.capBadge}><Text style={styles.capText}>C</Text></View>}
          {isVC  && <View style={styles.vcBadge}><Text style={styles.vcText}>VC</Text></View>}
        </View>
        <View style={styles.meta}>
          <RoleTag role={player.role} />
          <Text style={styles.team}>{player.team}</Text>
          <Text style={styles.credits}>{player.credits.toFixed(1)} CR</Text>
        </View>
      </View>

      {/* Captain / VC buttons */}
      <Pressable
        style={[styles.capBtn, isCap && styles.capBtnActive]}
        onPress={() => onSetCaptaincy('captain')}
        hitSlop={6}
      >
        <Text style={[styles.capBtnText, isCap && styles.capBtnTextActive]}>C</Text>
      </Pressable>

      <Pressable
        style={[styles.capBtn, isVC && styles.vcBtnActive]}
        onPress={() => onSetCaptaincy('vice_captain')}
        hitSlop={6}
      >
        <Text style={[styles.capBtnText, isVC && styles.vcBtnTextActive]}>VC</Text>
      </Pressable>

      {/* Remove */}
      <Pressable style={styles.removeBtn} onPress={onRemove} hitSlop={8}>
        <Text style={styles.removeBtnText}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(201,168,76,0.2)',
    gap: spacing.sm,
  },
  info: {
    flex: 1,
    gap: 3,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  name: {
    color: colors.text,
    fontSize: fontSize.base,
    fontWeight: '600',
    flex: 1,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  team: {
    color: colors.muted,
    fontSize: fontSize.sm,
  },
  credits: {
    color: colors.accent2,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  capBadge: {
    backgroundColor: 'rgba(201,168,76,0.2)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  capText: {
    color: colors.accent2,
    fontSize: fontSize.xs,
    fontWeight: '800',
  },
  vcBadge: {
    backgroundColor: 'rgba(122,112,96,0.12)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  vcText: {
    color: colors.muted,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  capBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  capBtnActive: {
    backgroundColor: colors.accent2,
    borderColor: colors.accent2,
  },
  vcBtnActive: {
    backgroundColor: 'rgba(201,168,76,0.2)',
    borderColor: colors.accent2,
  },
  capBtnText: {
    color: colors.muted,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  capBtnTextActive: {
    color: '#422006',
  },
  vcBtnTextActive: {
    color: colors.accent2,
  },
  removeBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: {
    color: colors.bad,
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '400',
  },
});
