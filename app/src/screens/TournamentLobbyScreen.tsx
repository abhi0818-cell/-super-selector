/**
 * TournamentLobbyScreen
 *
 * Shown when a user signs in and there are multiple active tournaments
 * (or when they tap "Switch Tournament" from Home).
 * If only one tournament is active it is auto-selected and this screen
 * is skipped — but the user can always navigate here manually.
 */

import React, { useEffect } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { RootStackParamList } from '../types';
import { useTournamentStore, Tournament } from '../store/tournamentStore';
import { useTeamStore }    from '../store/teamStore';
import { useContestStore } from '../store/contestStore';
import { useAuthStore }    from '../store/authStore';
import { colors, fontSize, radius, spacing } from '../theme';

type NavProp = StackNavigationProp<RootStackParamList, 'TournamentLobby'>;

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function TournamentCard({
  tournament,
  isSelected,
  onPress,
}: {
  tournament:  Tournament;
  isSelected:  boolean;
  onPress:     () => void;
}) {
  const dateRange =
    tournament.startDate || tournament.endDate
      ? `${formatDate(tournament.startDate)}${tournament.endDate ? ` – ${formatDate(tournament.endDate)}` : ''}`
      : null;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        isSelected && styles.cardSelected,
        pressed && { opacity: 0.88 },
      ]}
      onPress={onPress}
    >
      {/* Format badge */}
      <View style={styles.cardHeader}>
        <View style={[styles.formatBadge, isSelected && styles.formatBadgeSelected]}>
          <Text style={[styles.formatText, isSelected && styles.formatTextSelected]}>
            {tournament.format}
          </Text>
        </View>
        {isSelected && (
          <View style={styles.activeBadge}>
            <Text style={styles.activeBadgeText}>Playing</Text>
          </View>
        )}
      </View>

      {/* Name */}
      <Text style={[styles.cardName, isSelected && styles.cardNameSelected]}>
        {tournament.name}
      </Text>

      {/* Date range */}
      {dateRange ? (
        <Text style={styles.cardDate}>{dateRange}</Text>
      ) : null}

      {/* Play button */}
      <View style={[styles.playBtn, isSelected && styles.playBtnSelected]}>
        <Text style={[styles.playBtnText, isSelected && styles.playBtnTextSelected]}>
          {isSelected ? '✓ Currently playing' : 'Play this tournament →'}
        </Text>
      </View>
    </Pressable>
  );
}

export default function TournamentLobbyScreen() {
  const navigation = useNavigation<NavProp>();
  const { signOut, user } = useAuthStore();

  const { tournaments, selectedTournamentId, loading, loadTournaments, selectTournament } =
    useTournamentStore();
  const loadTournamentContext = useTeamStore(s => s.loadTournamentContext);
  const loadContests          = useContestStore(s => s.loadContests);
  const clearContext          = useContestStore(s => s.clearContext);

  useEffect(() => {
    loadTournaments();
  }, []);

  const handleSelect = async (tournament: Tournament) => {
    // Clear the active contest context so the previous tournament's contest
    // doesn't bleed into the new tournament's My XI screen.
    clearContext();
    await selectTournament(tournament.id);
    // Reload team + contest data for the newly selected tournament.
    // Use tournament.id directly — don't read from teamStore which may be stale.
    await Promise.all([
      loadTournamentContext(),
      loadContests(tournament.id),
    ]);
    navigation.replace('Main');
  };

  const firstName = user?.email?.split('@')[0] ?? 'Player';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Header ────────────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>
              <Text style={styles.brandSuper}>Maestro</Text>
            </Text>
            <Text style={styles.greeting}>Hey {firstName} 👋</Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.signOutBtn, pressed && { opacity: 0.7 }]}
            onPress={signOut}
          >
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        </View>

        {/* ── Section label ─────────────────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>Choose a tournament</Text>

        {/* ── Tournament cards ──────────────────────────────────────────────── */}
        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.loadingText}>Loading tournaments…</Text>
          </View>
        ) : tournaments.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No active tournaments</Text>
            <Text style={styles.emptyText}>
              Ask the admin to mark a tournament as active.
            </Text>
          </View>
        ) : (
          <View style={styles.cards}>
            {tournaments.map(t => (
              <TournamentCard
                key={t.id}
                tournament={t}
                isSelected={t.id === selectedTournamentId}
                onPress={() => handleSelect(t)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll:    { padding: spacing.lg, paddingBottom: 48 },

  // Header
  header: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'flex-start',
    marginBottom:   spacing.xl,
  },
  brand: { fontSize: fontSize.xl, letterSpacing: 0.2 },
  brandSuper:     { color: colors.text, fontFamily: 'PlayfairDisplay_700Bold' },
  greeting: {
    color:      colors.muted,
    fontSize:   fontSize.base,
    marginTop:  2,
  },
  signOutBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical:   6,
    borderWidth:       1,
    borderColor:       colors.border,
    borderRadius:      radius.full,
  },
  signOutText: { color: colors.muted, fontSize: fontSize.sm, fontWeight: '600' },

  // Section
  sectionLabel: {
    fontSize:      fontSize.sm,
    fontWeight:    '700',
    color:         colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom:  spacing.md,
  },

  // Cards
  cards: { gap: spacing.md },

  card: {
    backgroundColor: colors.panel,
    borderWidth:     1,
    borderColor:     colors.border,
    borderRadius:    radius.xl,
    padding:         spacing.lg,
    gap:             spacing.sm,
  },
  cardSelected: {
    borderColor:     colors.accent,
    borderWidth:     2,
    backgroundColor: colors.panel,
  },

  cardHeader: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
    marginBottom:  2,
  },
  formatBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical:   3,
    borderRadius:      radius.full,
    backgroundColor:   colors.panel2,
    borderWidth:       1,
    borderColor:       colors.border,
  },
  formatBadgeSelected: {
    backgroundColor: colors.accent2,
    borderColor:     colors.accent2,
  },
  formatText:         { fontSize: fontSize.xs, fontWeight: '700', color: colors.muted },
  formatTextSelected: { color: colors.text },

  activeBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical:   3,
    borderRadius:      radius.full,
    backgroundColor:   colors.good,
  },
  activeBadgeText: {
    fontSize:   fontSize.xs,
    fontWeight: '700',
    color:      '#fff',
  },

  cardName: {
    fontSize:   fontSize.xl,
    fontWeight: '800',
    color:      colors.text,
  },
  cardNameSelected: { color: colors.text },

  cardDate: {
    fontSize: fontSize.sm,
    color:    colors.muted,
  },

  playBtn: {
    marginTop:       spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius:    radius.md,
    backgroundColor: colors.panel2,
    alignItems:      'center',
    borderWidth:     1,
    borderColor:     colors.border,
  },
  playBtnSelected: {
    backgroundColor: colors.accent,
    borderColor:     colors.accent,
  },
  playBtnText:         { fontSize: fontSize.base, fontWeight: '700', color: colors.muted },
  playBtnTextSelected: { color: colors.panel },

  // Loading / empty
  loadingWrap: {
    alignItems:  'center',
    paddingTop:  spacing.xxl,
    gap:         spacing.md,
  },
  loadingText: { color: colors.muted, fontSize: fontSize.sm },

  emptyWrap: {
    alignItems:  'center',
    paddingTop:  spacing.xxl,
    gap:         spacing.sm,
  },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  emptyText:  { fontSize: fontSize.sm, color: colors.muted, textAlign: 'center' },
});
