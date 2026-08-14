/**
 * ContestPicker — gradient-first Pass 1
 * Shown at the top of My XI when no contest context is set.
 * Loads real contests from Supabase via contestStore; falls back to
 * hardcoded placeholders while loading.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ContestContext, ContestType } from '../types';
import { useContestStore, toContestContext } from '../store/contestStore';
import { useTeamStore } from '../store/teamStore';
import { fontSize, radius, spacing, shadow } from '../theme';
import PrivateLeagueModal from './PrivateLeagueModal';

interface Props {
  onSelect: (ctx: ContestContext) => void;
}

const C = {
  text:    '#1C1F26',
  muted:   '#7A7060',
  accent:  '#C9A84C',
  gold:    '#92650A',
  border:  'rgba(201,168,76,0.25)',
} as const;

const ICON_BG: Record<ContestType, string[]> = {
  daily:   ['rgba(201,168,76,0.22)', 'rgba(245,240,224,0.7)'],
  sl:      ['rgba(146,101,10,0.18)', 'rgba(245,240,224,0.7)'],
  private: ['rgba(28,31,38,0.14)', 'rgba(245,240,224,0.7)'],
};

const CONTEST_ICONS: Record<ContestType, string> = {
  daily:   '📅',
  sl:      '🏅',
  private: '🔒',
};

const CONTEST_SUBTITLES: Record<ContestType, string> = {
  daily:   "Standard rules · today's match",
  sl:      'Season Long · standard rules',
  private: 'Private league',
};

export default function ContestPicker({ onSelect }: Props) {
  const { contests, contestsLoading, loadContests } = useContestStore();
  const tournamentId = useTeamStore(s => s.tournamentId);
  const [leagueModalOpen, setLeagueModalOpen] = useState(false);

  // Load contests once we know the tournament
  useEffect(() => {
    if (tournamentId && contests.length === 0) {
      loadContests(tournamentId);
    }
  }, [tournamentId]);

  // After creating/joining a private league, refresh the list (so it shows
  // up in "Your Leagues" style browsing here next time) and select it right
  // away, same as index.html's create/join handlers do.
  const handleLeagueJoined = (ctx: ContestContext) => {
    setLeagueModalOpen(false);
    if (tournamentId) loadContests(tournamentId);
    onSelect(ctx);
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Pick XI for which contest?</Text>
        <Text style={styles.subtitle}>
          Select a contest before picking your players — each contest may have different rules.
        </Text>
      </View>

      {contestsLoading ? (
        <View style={styles.spinner}>
          <ActivityIndicator size="large" color="#C9A84C" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
        >
          {contests.map((contest, i) => {
            const ctx = toContestContext(contest);
            return (
              <Pressable
                key={contest.id ?? i}
                style={({ pressed }) => [styles.optionWrap, pressed && styles.optionPressed]}
                onPress={() => onSelect(ctx)}
              >
                <View style={styles.option}>
                  {/* Icon bubble */}
                  <LinearGradient
                    colors={(ICON_BG[contest.contestType] ?? ICON_BG.private) as any}
                    style={styles.iconBubble}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                  >
                    <Text style={styles.iconText}>
                      {CONTEST_ICONS[contest.contestType] ?? '🏏'}
                    </Text>
                  </LinearGradient>

                  {/* Text */}
                  <View style={styles.optionBody}>
                    <Text style={styles.optionName}>{contest.name}</Text>
                    <Text style={styles.optionMeta}>
                      {contest.isPrivate
                        ? (contest.isShared ? 'Private league · shares your SL XI' : 'Private league · custom rules')
                        : CONTEST_SUBTITLES[contest.contestType]}
                    </Text>
                  </View>

                  {/* Private badge */}
                  {contest.isPrivate && (
                    <View style={styles.customBadge}>
                      <Text style={styles.customBadgeText}>Private</Text>
                    </View>
                  )}

                  <Text style={styles.arrow}>›</Text>
                </View>
              </Pressable>
            );
          })}

          {/* Empty state — shown only if loaded but no contests returned */}
          {!contestsLoading && contests.length === 0 && (
            <Text style={styles.empty}>No active contests found</Text>
          )}

          {/* Create/join a private league — Phase 4 of
              docs/PRIVATE_LEAGUES_DESIGN.md. Mirrors index.html's Leagues
              tab; previously mobile could only pick among leagues it was
              already a member of. */}
          <Pressable
            style={({ pressed }) => [styles.leagueLinkWrap, pressed && styles.optionPressed]}
            onPress={() => setLeagueModalOpen(true)}
          >
            <Text style={styles.leagueLinkText}>🔒 Create or join a private league</Text>
          </Pressable>
        </ScrollView>
      )}

      <PrivateLeagueModal
        visible={leagueModalOpen}
        tournamentId={tournamentId ?? null}
        onDismiss={() => setLeagueModalOpen(false)}
        onJoined={handleLeagueJoined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  header: {
    padding:           spacing.xl,
    paddingBottom:     spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap:               spacing.xs,
  },
  title: {
    color:         C.text,
    fontSize:      fontSize.xl,
    fontWeight:    '800',
    letterSpacing: 0.2,
  },
  subtitle: {
    color:      C.muted,
    fontSize:   fontSize.base,
    lineHeight: 22,
  },

  spinner: {
    flex: 1,
    alignItems:     'center',
    justifyContent: 'center',
  },

  list: {
    padding: spacing.lg,
    gap:     spacing.sm,
  },

  optionWrap:    {},
  optionPressed: { opacity: 0.80, transform: [{ scale: 0.99 }] },
  option: {
    flexDirection:    'row',
    alignItems:       'center',
    gap:              spacing.md,
    backgroundColor:  'rgba(255,255,255,0.8)',
    borderWidth:      1,
    borderColor:      C.border,
    borderRadius:     radius.xl,
    padding:          spacing.lg,
    ...shadow.card,
  },

  iconBubble: {
    width:          44,
    height:         44,
    borderRadius:   radius.lg,
    alignItems:     'center',
    justifyContent: 'center',
    borderWidth:    1,
    borderColor:    'rgba(0,0,0,0.06)',
  },
  iconText: { fontSize: 22 },

  optionBody: { flex: 1, gap: 3 },
  optionName: { color: C.text, fontSize: fontSize.base, fontWeight: '700' },
  optionMeta: { color: C.muted, fontSize: fontSize.sm },

  customBadge: {
    backgroundColor:   'rgba(201,168,76,0.12)',
    borderRadius:      radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical:   3,
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.35)',
  },
  customBadgeText: {
    color:      '#92650A',
    fontSize:   fontSize.xs,
    fontWeight: '700',
  },

  arrow: { color: C.muted, fontSize: 24, fontWeight: '300' },

  empty: {
    color:      C.muted,
    fontSize:   fontSize.base,
    textAlign:  'center',
    marginTop:  spacing.xxl,
  },

  leagueLinkWrap: {
    marginTop:         spacing.md,
    paddingVertical:   spacing.md,
    alignItems:        'center',
    borderWidth:       1,
    borderStyle:       'dashed',
    borderColor:       C.border,
    borderRadius:      radius.lg,
  },
  leagueLinkText: {
    color:      C.gold,
    fontSize:   fontSize.sm,
    fontWeight: '700',
  },
});
