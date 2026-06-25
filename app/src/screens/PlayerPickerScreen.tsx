/**
 * PlayerPickerScreen — with multi-select match filter + OS counter
 * Rendered inside a Modal from MyXIScreen — no standalone SafeAreaView needed.
 *
 * Match selector: multi-select chips. Player pool = union of teams from all
 * selected matches. Selecting no match shows the full pool.
 *
 * OS counter: shown below budget bar when the tournament format has a cap < 11.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Player, PlayerRole } from '../types';
import { useTeamStore, RULES } from '../store/teamStore';
import { useContestStore } from '../store/contestStore';
import { supabase } from '../lib/supabase';
import PlayerCard from '../components/PlayerCard';
import PlayerStatsModal from '../components/PlayerStatsModal';
import BudgetBar from '../components/BudgetBar';
import RoleStats from '../components/RoleStats';
import { fontSize, radius, spacing } from '../theme';

// ─── Types ────────────────────────────────────────────────────────────────────

type RoleFilter = 'ALL' | PlayerRole;

interface MatchOption {
  id:          string;
  matchNumber: number | null;
  homeTeamId:  string;
  awayTeamId:  string;
  status:      string;
  startTime:   string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLE_FILTERS: RoleFilter[] = ['ALL', 'wk', 'bat', 'ar', 'bowl'];
const ROLE_LABELS: Record<RoleFilter, string> = {
  ALL: 'All', wk: 'WK', bat: 'BAT', ar: 'AR', bowl: 'BOWL',
};

const C = {
  text:    '#1C1F26',
  muted:   '#7A7060',
  accent:  '#C9A84C',
  gold:    '#92650A',
  good:    '#2D6A35',
  bad:     '#C0392B',
  border:  'rgba(201,168,76,0.22)',
  active:  '#1C1F26',
} as const;

// ─── Component ────────────────────────────────────────────────────────────────

export default function PlayerPickerScreen() {
  const {
    players,
    selected,
    creditsSpent,
    creditsLeft,
    roleCounts,
    togglePlayer,
    tournamentId,
    currentMatchId,
    format,
    recentForm,
  } = useTeamStore();

  const { activeContext } = useContestStore();

  const [search, setSearch]         = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('ALL');
  const [overseasOnly, setOverseasOnly] = useState(false);
  const [statsPlayer, setStatsPlayer]   = useState<Player | null>(null);

  // ── Match selector state ──────────────────────────────────────────────────
  const [matches, setMatches]           = useState<MatchOption[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  // Multi-select: Set of selected match IDs. Empty = show all players.
  const [selectedMatchIds, setSelectedMatchIds] = useState<Set<string>>(
    () => currentMatchId ? new Set([currentMatchId]) : new Set()
  );

  // Fetch matches when component mounts or tournamentId changes
  useEffect(() => {
    if (!tournamentId) return;
    let cancelled = false;
    const load = async () => {
      setMatchesLoading(true);
      try {
        const { data, error } = await supabase
          .from('matches')
          .select('id, match_number, home_team_id, away_team_id, status, start_time')
          .eq('tournament_id', tournamentId)
          .order('match_number', { ascending: true });

        if (error) throw error;
        if (cancelled) return;

        const opts: MatchOption[] = (data ?? []).map((m: any) => ({
          id:          m.id,
          matchNumber: m.match_number ?? null,
          homeTeamId:  m.home_team_id ?? '',
          awayTeamId:  m.away_team_id ?? '',
          status:      m.status ?? 'scheduled',
          startTime:   m.start_time ?? null,
        }));
        setMatches(opts);
      } catch (e) {
        console.warn('[PlayerPicker] failed to load matches:', e);
      } finally {
        if (!cancelled) setMatchesLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [tournamentId]);

  // Seed selection with currentMatchId once matches are loaded (if not already set)
  useEffect(() => {
    if (selectedMatchIds.size === 0 && currentMatchId && matches.some(m => m.id === currentMatchId)) {
      setSelectedMatchIds(new Set([currentMatchId]));
    }
  }, [matches, currentMatchId]);

  // Toggle a match in/out of the selection set
  const toggleMatch = useCallback((id: string) => {
    setSelectedMatchIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const clearMatchFilter = useCallback(() => {
    setSelectedMatchIds(new Set());
  }, []);

  // ── OS counter ────────────────────────────────────────────────────────────
  // Only show when the tournament format has a meaningful overseas cap (< 11).
  const osCap = RULES.maxOverseas[format] ?? 11;
  const showOsCounter = osCap > 0 && osCap < 11;
  const osSelected = useMemo(
    () => selected.filter(p => p.overseas).length,
    [selected]
  );
  const osOver = osSelected > osCap;

  // ── Derived player filter ─────────────────────────────────────────────────
  const selectedIds = useMemo(() => new Set(selected.map(p => p.id)), [selected]);

  // Build union of teams from all selected matches
  const matchTeams = useMemo((): Set<string> | null => {
    if (selectedMatchIds.size === 0) return null; // no filter
    const teams = new Set<string>();
    matches.forEach(m => {
      if (selectedMatchIds.has(m.id)) {
        if (m.homeTeamId) teams.add(m.homeTeamId);
        if (m.awayTeamId) teams.add(m.awayTeamId);
      }
    });
    return teams;
  }, [selectedMatchIds, matches]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return players.filter(p => {
      if (matchTeams && !matchTeams.has(p.team)) return false;
      if (roleFilter !== 'ALL' && p.role !== roleFilter) return false;
      if (overseasOnly && !p.overseas) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [players, matchTeams, roleFilter, overseasOnly, search]);

  const isDisabled = useCallback((player: Player): boolean => {
    if (selectedIds.has(player.id)) return false;
    return selected.length >= 11;
  }, [selectedIds, selected.length]);

  const renderItem = useCallback(({ item }: { item: Player }) => (
    <PlayerCard
      player={item}
      selected={selectedIds.has(item.id)}
      disabled={isDisabled(item)}
      onPress={() => togglePlayer(item)}
      recentForm={recentForm[item.id]}
      onStatsPress={() => setStatsPlayer(item)}
    />
  ), [selectedIds, isDisabled, togglePlayer, recentForm]);

  const keyExtractor = useCallback((item: Player) => item.id, []);

  // Summary label for selected matches
  const matchFilterLabel = useMemo(() => {
    if (selectedMatchIds.size === 0) return null;
    const sel = matches.filter(m => selectedMatchIds.has(m.id));

    if (selectedMatchIds.size === 1 && sel.length === 1) {
      // Single match: show "A vs B"
      const m = sel[0];
      return `${filtered.length} players · ${m.homeTeamId} vs ${m.awayTeamId}`;
    }

    // Multiple matches: show unique team names comma-separated
    const teamSet = new Set<string>();
    sel.forEach(m => { if (m.homeTeamId) teamSet.add(m.homeTeamId); if (m.awayTeamId) teamSet.add(m.awayTeamId); });
    return `${filtered.length} players · ${[...teamSet].join(', ')}`;
  }, [selectedMatchIds, matches, filtered.length]);

  return (
    <View style={styles.container}>

      {/* League context banner */}
      {activeContext && (
        <View style={styles.contextBanner}>
          <Text style={styles.contextIcon}>
            {activeContext.contestType === 'daily' ? '📅' : activeContext.contestType === 'sl' ? '🏅' : '🔒'}
          </Text>
          <Text style={styles.contextText}>
            Picking for:{' '}
            <Text style={styles.contextName}>{activeContext.leagueName}</Text>
          </Text>
          {activeContext.ruleType === 'custom' && (
            <View style={styles.customBadge}>
              <Text style={styles.customBadgeText}>Custom rules</Text>
            </View>
          )}
        </View>
      )}

      {/* Fixed header */}
      <View style={styles.header}>

        {/* Budget bar */}
        <BudgetBar
          creditsSpent={creditsSpent}
          creditsLeft={creditsLeft}
          playerCount={selected.length}
        />

        {/* OS counter — only when tournament has a cap */}
        {showOsCounter && (
          <View style={[styles.osRow, osOver && styles.osRowBad]}>
            <Text style={styles.osIcon}>✈️</Text>
            <Text style={[styles.osLabel, osOver && styles.osLabelBad]}>
              Overseas
            </Text>
            <View style={[styles.osPill, osOver && styles.osPillBad]}>
              <Text style={[styles.osPillText, osOver && styles.osPillTextBad]}>
                {osSelected} / {osCap}
              </Text>
            </View>
            {osOver && (
              <Text style={styles.osWarn}>cap exceeded</Text>
            )}
          </View>
        )}

        <RoleStats roleCounts={roleCounts} />

        {/* ── Match selector (multi-select) ──────────────────────────────── */}
        <View style={styles.matchSelectorSection}>
          <View style={styles.matchSelectorHeader}>
            <Text style={styles.matchSelectorLabel}>Filter by match</Text>
            {selectedMatchIds.size > 0 && (
              <Pressable onPress={clearMatchFilter} style={styles.clearBtn}>
                <Text style={styles.clearBtnText}>Clear</Text>
              </Pressable>
            )}
            {matchesLoading && (
              <ActivityIndicator size="small" color={C.accent} style={{ marginLeft: 4 }} />
            )}
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.matchChips}
          >
            {matches.map(m => {
              const active    = selectedMatchIds.has(m.id);
              const isCurrent = m.id === currentMatchId;
              const isLive    = m.status === 'live' || m.status === 'in_progress';
              const label     = m.matchNumber != null ? `M${m.matchNumber}` : m.id.slice(0, 4);
              return (
                <Pressable
                  key={m.id}
                  style={[
                    styles.matchChip,
                    active && styles.matchChipActive,
                    !active && isCurrent && styles.matchChipCurrent,
                  ]}
                  onPress={() => toggleMatch(m.id)}
                >
                  {/* Gold dot for current (upcoming) match */}
                  {isCurrent && !active && <View style={styles.matchChipDot} />}
                  <Text style={[
                    styles.matchChipText,
                    active && styles.matchChipTextActive,
                    !active && isCurrent && styles.matchChipTextCurrent,
                  ]}>
                    {label}
                  </Text>
                  {/* Red dot for live matches */}
                  {isLive && <View style={styles.liveDot} />}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {/* Filter summary hint */}
        {matchFilterLabel && (
          <View style={styles.matchHint}>
            <Text style={styles.matchHintText}>{matchFilterLabel}</Text>
          </View>
        )}

        {/* Search */}
        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search player or team…"
            placeholderTextColor={C.muted}
            value={search}
            onChangeText={setSearch}
            clearButtonMode="while-editing"
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>

        {/* Role filter chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          {ROLE_FILTERS.map(r => {
            const active = roleFilter === r;
            return (
              <Pressable
                key={r}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setRoleFilter(r)}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {ROLE_LABELS[r]}
                  {r !== 'ALL' && roleCounts[r as PlayerRole] > 0 && (
                    <Text style={[styles.chipCount, active && styles.chipCountActive]}>
                      {' '}{roleCounts[r as PlayerRole]}
                    </Text>
                  )}
                </Text>
              </Pressable>
            );
          })}

          {/* Overseas-only filter chip — only when tournament has an overseas slot */}
          {osCap > 0 && (
            <Pressable
              style={[styles.chip, styles.osChip, overseasOnly && styles.osChipActive]}
              onPress={() => setOverseasOnly(v => !v)}
            >
              <Text style={[styles.chipText, overseasOnly && styles.chipTextActive]}>
                ✈️{' '}
                <Text style={[styles.chipCount, overseasOnly && styles.chipCountActive]}>
                  OS
                </Text>
              </Text>
            </Pressable>
          )}
        </ScrollView>
      </View>

      {/* Player list */}
      <View style={styles.listContainer}>
        <FlatList
          data={filtered}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={styles.empty}>
              {matchesLoading ? 'Loading matches…' : 'No players match your filter'}
            </Text>
          }
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={5}
        />
      </View>

      <PlayerStatsModal
        visible={!!statsPlayer}
        player={statsPlayer}
        tournamentId={tournamentId}
        onClose={() => setStatsPlayer(null)}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex:            1,
    backgroundColor: 'transparent',
  },
  header: {
    flexShrink: 0,
  },
  listContainer: {
    flex: 1,
  },

  // Context banner
  contextBanner: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm + 2,
    backgroundColor:   'rgba(201,168,76,0.07)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(201,168,76,0.2)',
  },
  contextIcon: { fontSize: 14 },
  contextText: { color: C.muted, fontSize: fontSize.sm, flex: 1 },
  contextName: { color: C.accent, fontWeight: '700' },
  customBadge: {
    backgroundColor:   'rgba(201,168,76,0.12)',
    borderRadius:      radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical:   2,
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.28)',
  },
  customBadgeText: { color: C.gold, fontSize: fontSize.xs, fontWeight: '700' },

  // OS counter row
  osRow: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical:   6,
    backgroundColor:   'rgba(201,168,76,0.06)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(201,168,76,0.14)',
  },
  osRowBad: {
    backgroundColor:   'rgba(192,57,43,0.06)',
    borderBottomColor: 'rgba(192,57,43,0.18)',
  },
  osIcon:  { fontSize: 13 },
  osLabel: {
    color:      C.muted,
    fontSize:   fontSize.sm,
    fontWeight: '600',
    flex:       1,
  },
  osLabelBad: { color: C.bad },
  osPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical:   2,
    backgroundColor:   'rgba(201,168,76,0.12)',
    borderRadius:      radius.full,
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.4)',
  },
  osPillBad: {
    backgroundColor: 'rgba(192,57,43,0.10)',
    borderColor:     'rgba(192,57,43,0.45)',
  },
  osPillText: {
    color:      C.gold,
    fontSize:   fontSize.xs,
    fontWeight: '800',
  },
  osPillTextBad: { color: C.bad },
  osWarn: {
    color:      C.bad,
    fontSize:   fontSize.xs,
    fontWeight: '600',
  },

  // Match selector
  matchSelectorSection: {
    paddingTop:        spacing.md,
    paddingBottom:     spacing.xs,
  },
  matchSelectorHeader: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: spacing.lg,
    marginBottom:      spacing.xs + 2,
    gap:               spacing.sm,
  },
  matchSelectorLabel: {
    color:         C.text,
    fontSize:      fontSize.xs,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    flex:          1,
  },
  clearBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical:   2,
    borderRadius:      radius.full,
    borderWidth:       1,
    borderColor:       'rgba(28,31,38,0.22)',
    backgroundColor:   'rgba(28,31,38,0.05)',
  },
  clearBtnText: {
    color:      C.text,
    fontSize:   fontSize.xs,
    fontWeight: '600',
  },
  matchChips: {
    paddingHorizontal: spacing.lg,
    gap:               spacing.sm,
    flexDirection:     'row',
    paddingBottom:     spacing.xs,
  },
  matchChip: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               4,
    paddingHorizontal: spacing.md,
    paddingVertical:   6,
    borderRadius:      radius.full,
    backgroundColor:   'rgba(0,0,0,0.04)',
    borderWidth:       1,
    borderColor:       C.border,
  },
  matchChipActive: {
    backgroundColor: C.active,
    borderColor:     C.active,
  },
  matchChipCurrent: {
    backgroundColor: 'rgba(201,168,76,0.12)',
    borderColor:     'rgba(201,168,76,0.5)',
    borderWidth:     1.5,
  },
  matchChipDot: {
    width:           6,
    height:          6,
    borderRadius:    3,
    backgroundColor: C.accent,
  },
  matchChipText: {
    color:      C.text,
    fontSize:   fontSize.sm,
    fontWeight: '600',
  },
  matchChipTextActive: {
    color:      '#fff',
    fontWeight: '800',
  },
  matchChipTextCurrent: {
    color:      C.gold,
    fontWeight: '700',
  },
  liveDot: {
    width:           6,
    height:          6,
    borderRadius:    3,
    backgroundColor: '#E74C3C',
  },

  // Match filter summary hint
  matchHint: {
    paddingHorizontal: spacing.lg,
    paddingVertical:   4,
    backgroundColor:   'rgba(201,168,76,0.06)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(201,168,76,0.12)',
  },
  matchHintText: {
    color:    C.muted,
    fontSize: fontSize.xs,
  },

  // Search
  searchRow: {
    paddingHorizontal: spacing.lg,
    paddingTop:        spacing.md,
    paddingBottom:     spacing.sm,
  },
  searchInput: {
    backgroundColor:   'rgba(0,0,0,0.04)',
    borderWidth:       1,
    borderColor:       C.border,
    borderRadius:      radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm + 2,
    color:             C.text,
    fontSize:          fontSize.base,
  },

  // Role chips
  chips: {
    paddingHorizontal: spacing.lg,
    paddingBottom:     spacing.sm,
    gap:               spacing.sm,
    flexDirection:     'row',
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical:   6,
    borderRadius:      radius.full,
    backgroundColor:   'rgba(0,0,0,0.04)',
    borderWidth:       1,
    borderColor:       C.border,
  },
  chipActive: {
    backgroundColor: C.active,
    borderColor:     C.active,
  },
  chipText: {
    color:      C.text,
    fontSize:   fontSize.sm,
    fontWeight: '500',
  },
  chipTextActive: {
    color:      '#fff',
    fontWeight: '700',
  },
  chipCount:       { fontWeight: '700' },
  chipCountActive: { color: 'rgba(255,255,255,0.8)' },
  osChip: {
    borderColor: 'rgba(201,168,76,0.35)',
  },
  osChipActive: {
    backgroundColor: C.accent,
    borderColor:     C.accent,
  },

  // List
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom:     spacing.xxl,
    paddingTop:        spacing.sm,
  },
  empty: {
    color:      C.muted,
    fontSize:   fontSize.base,
    textAlign:  'center',
    marginTop:  spacing.xxl,
  },
});
