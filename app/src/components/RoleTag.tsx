import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PlayerRole } from '../types';
import { colors, fontSize, radius, spacing } from '../theme';

interface Props { role: PlayerRole; size?: 'sm' | 'md' }

const ROLE_LABELS: Record<PlayerRole, string> = {
  wk: 'WK', bat: 'BAT', ar: 'AR', bowl: 'BOWL',
};

const ROLE_COLORS: Record<PlayerRole, { bg: string; text: string }> = {
  bat:  colors.roleBat,
  bowl: colors.roleBowl,
  ar:   colors.roleAr,
  wk:   colors.roleWk,
};

export default function RoleTag({ role, size = 'sm' }: Props) {
  const { bg, text } = ROLE_COLORS[role];
  return (
    <View style={[styles.tag, { backgroundColor: bg }, size === 'md' && styles.tagMd]}>
      <Text style={[styles.label, { color: text }, size === 'md' && styles.labelMd]}>
        {ROLE_LABELS[role]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 2,
    borderRadius: radius.sm - 2,
    alignSelf: 'flex-start',
  },
  tagMd: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  label: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  labelMd: {
    fontSize: fontSize.sm,
  },
});
