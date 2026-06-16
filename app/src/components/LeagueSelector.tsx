/**
 * LeagueSelector
 * Bottom sheet shown when the user taps "Pick Team" and has multiple
 * active leagues with different rules. They must pick which league's
 * rules to apply before entering the player picker.
 */

import React from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { PrivateLeague, ContestContext, ContestType } from '../types';
import { colors, fontSize, radius, spacing } from '../theme';

interface Props {
  visible:       boolean;
  leagues:       PrivateLeague[];   // active custom-rule leagues to choose from
  contestType:   ContestType;
  onSelect:      (ctx: ContestContext) => void;
  onDismiss:     () => void;
}

export default function LeagueSelector({ visible, leagues, contestType, onSelect, onDismiss }: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onDismiss}
    >
      <Pressable style={styles.backdrop} onPress={onDismiss}>
        <Pressable style={styles.sheet} onPress={e => e.stopPropagation()}>
          <View style={styles.handle} />

          <Text style={styles.title}>Pick XI for which league?</Text>
          <Text style={styles.subtitle}>
            These leagues have different rules. Select one to apply its rules to your XI.
          </Text>

          <View style={styles.list}>
            {leagues.map(league => (
              <Pressable
                key={league.id}
                style={styles.leagueRow}
                onPress={() => onSelect({
                  contestId:   league.id,
                  contestType,
                  leagueId:   league.id,
                  leagueName: league.name,
                  ruleType:   league.ruleType,
                  deadline:   league.deadline,
                })}
              >
                <View style={styles.leagueInfo}>
                  <Text style={styles.leagueName}>{league.name}</Text>
                  <View style={styles.leagueMeta}>
                    <Text style={styles.leagueMetaText}>{league.members} members</Text>
                    <View style={styles.ruleBadge}>
                      <Text style={styles.ruleBadgeText}>Custom rules</Text>
                    </View>
                  </View>
                </View>
                {league.rank !== null && (
                  <View style={styles.rankBadge}>
                    <Text style={styles.rankText}>#{league.rank}</Text>
                  </View>
                )}
                <Text style={styles.arrow}>›</Text>
              </Pressable>
            ))}
          </View>

          <Pressable style={styles.cancelBtn} onPress={onDismiss}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.panel,
    borderTopLeftRadius: radius.xl + 4,
    borderTopRightRadius: radius.xl + 4,
    padding: spacing.xl,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: colors.border,
    borderRadius: radius.full,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.muted,
    fontSize: fontSize.sm,
    lineHeight: 18,
    marginTop: -spacing.xs,
  },
  list: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  leagueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.panel2,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  leagueInfo: {
    flex: 1,
    gap: 4,
  },
  leagueName: {
    color: colors.text,
    fontSize: fontSize.base,
    fontWeight: '600',
  },
  leagueMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  leagueMetaText: {
    color: colors.muted,
    fontSize: fontSize.sm,
  },
  ruleBadge: {
    backgroundColor: 'rgba(201,168,76,0.15)',
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: 'rgba(201,168,76,0.35)',
  },
  ruleBadgeText: {
    color: colors.accent2,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  rankBadge: {
    backgroundColor: 'rgba(201,168,76,0.1)',
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: 'rgba(201,168,76,0.3)',
  },
  rankText: {
    color: colors.accent,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  arrow: {
    color: colors.muted,
    fontSize: 20,
  },
  cancelBtn: {
    padding: spacing.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginTop: spacing.xs,
  },
  cancelText: {
    color: colors.muted,
    fontSize: fontSize.base,
    fontWeight: '600',
  },
});
