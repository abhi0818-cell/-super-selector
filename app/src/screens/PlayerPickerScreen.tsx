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
  Animated,
  Dimensions,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Player, PlayerRole } from '../types';
import { useTeamStore, RULES, canAddPlayer, getDomesticLabel } from '../store/teamStore';
import { useContestStore } from '../store/contestStore';
import { supabase } from '../lib/supabase';
import PlayerCard from '../components/PlayerCard';
import PlayerStatsModal from '../components/PlayerStatsModal';
import CricketPitch from '../components/CricketPitch';
import BudgetBar from '../components/BudgetBar';
import RoleStats from '../components/RoleStats';
import Jersey from '../components/Jersey';
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
  matchType:   string | null;
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

// Statuses that don't belong in the "upcoming" schedule preview — mirrors
// the same set already used by playsAfterMap below, so "upcoming" means the
// same thing everywhere in this screen.
const UPCOMING_HIDE_STATUS = new Set(['completed', 'live', 'in_progress']);

// Playoff fixtures often don't have a match number assigned yet (TBD until
// the league stage settles), so they must sort to the END of the schedule —
// never coerce a missing number to 0, or they'll jump to the front. Mirrors
// the `hasNumber`/sort logic used for the web schedule chips.
const hasMatchNumber = (m: { matchNumber: number | null }) => m.matchNumber != null;

// Among unnumbered matches, fall back to the playoff stage order (set via
// admin's match_type field) rather than an arbitrary tie — Eliminator/Q1
// before Q2, Q2 before the Final, etc.
const STAGE_ORDER: Record<string, number> = {
  qualifier_1: 1,
  eliminator:  2,
  semi_final:  2,
  qualifier_2: 3,
  final:       4,
};
const stageRank = (m: { matchType: string | null }) => STAGE_ORDER[m.matchType ?? ''] ?? 0;

const byMatchNumberAsc = (
  a: { matchNumber: number | null; matchType?: string | null },
  b: { matchNumber: number | null; matchType?: string | null }
) => {
  const aN = hasMatchNumber(a), bN = hasMatchNumber(b);
  if (aN && bN) return (a.matchNumber as number) - (b.matchNumber as number);
  if (aN) return -1;
  if (bN) return 1;
  return stageRank({ matchType: a.matchType ?? null }) - stageRank({ matchType: b.matchType ?? null });
};

const SCREEN_W  = Dimensions.get('window').width;
const SCREEN_H  = Dimensions.get('window').height;
const DRAWER_W  = Math.min(340, Math.round(SCREEN_W * 0.84));

// ─── Component ────────────────────────────────────────────────────────────────

interface PlayerPickerScreenProps {
  // Open/close state stays owned by MyXIScreen (mutual exclusivity between
  // the two lives there — see handleToggleMyXI/handleToggleSchedule) — only
  // the toggle *buttons* live here now, in the context banner row, so
  // MyXIScreen's own modal header row is just Cancel/Title/Next.
  scheduleOpen?:      boolean;
  onCloseSchedule?:   () => void;
  onToggleSchedule?:  () => void;
  // "My XI" preview — same pattern as scheduleOpen above, but shows the
  // already-picked XI as a pitch map instead of upcoming fixtures, so it
  // can be checked or trimmed without losing whatever pool filters are
  // currently narrowing the list underneath.
  myXIOpen?:          boolean;
  onCloseMyXI?:       () => void;
  onToggleMyXI?:      () => void;
}

export default function PlayerPickerScreen({
  scheduleOpen = false,
  onCloseSchedule,
  onToggleSchedule,
  myXIOpen = false,
  onCloseMyXI,
  onToggleMyXI,
}: PlayerPickerScreenProps = {}) {
  const {
    players,
    selected,
    creditsSpent,
    creditsLeft,
    roleCounts,
    togglePlayer,
    removePlayer,
    tournamentId,
    currentMatchId,
    format,
    recentForm,
    budgetCapSuspended,
  } = useTeamStore();

  const { activeContext } = useContestStore();

  const [search, setSearch]         = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('ALL');
  const [overseasOnly, setOverseasOnly] = useState(false);
  const [domesticOnly, setDomesticOnly] = useState(false);
  const [statsPlayer, setStatsPlayer]   = useState<Player | null>(null);

  // Single-select team filter (independent of the match-derived team filter below).
  const [teamFilter, setTeamFilter] = useState<string>('ALL');

  // Single-select credits filter.
  type CreditsFilter = 'ALL' | 'LT8' | 'MID' | 'GT10';
  const [creditsFilter, setCreditsFilter] = useState<CreditsFilter>('ALL');
  const CREDITS_OPTIONS: { key: CreditsFilter; label: string }[] = [
    { key: 'ALL',  label: 'All' },
    { key: 'LT8',  label: 'Less than 8' },
    { key: 'MID',  label: 'Between 8 & 10' },
    { key: 'GT10', label: 'Greater than 10' },
  ];

  // ── Filter disclosure pills (Type / Teams / Matches / Credits) ────────────
  // Each panel toggles independently; multiple can be open at once. Mirrors the
  // web player pool: default closed for a compact bar, all-open reproduces the
  // old always-expanded layout.
  const [panelOpen, setPanelOpen] = useState({ type: false, teams: false, matches: false, credits: false });
  const togglePanel = useCallback((key: 'type' | 'teams' | 'matches' | 'credits') => {
    setPanelOpen(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

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
          .select('id, match_number, home_team_id, away_team_id, status, start_time, match_type')
          .eq('tournament_id', tournamentId)
          .neq('status', 'completed')
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
          matchType:   m.match_type ?? null,
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

  // Team list for the standalone Teams filter chips — derived from the current
  // tournament's player pool, mirroring web's renderTeamFilter().
  const teamList = useMemo(
    () => [...new Set(players.map(p => p.team))].sort(),
    [players]
  );

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
      if (teamFilter !== 'ALL' && p.team !== teamFilter) return false;
      if (creditsFilter === 'LT8'  && !(p.credits < 8)) return false;
      if (creditsFilter === 'MID'  && !(p.credits >= 8 && p.credits <= 10)) return false;
      if (creditsFilter === 'GT10' && !(p.credits > 10)) return false;
      if (roleFilter !== 'ALL' && p.role !== roleFilter) return false;
      if (overseasOnly && !p.overseas) return false;
      if (domesticOnly && p.overseas) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [players, matchTeams, teamFilter, creditsFilter, roleFilter, overseasOnly, domesticOnly, search]);

  const isDisabled = useCallback((player: Player): boolean => {
    if (selectedIds.has(player.id)) return false;
    // canAddPlayer folds in role caps + the reachability check (won't let a
    // slot be spent on an already-satisfied role if another role still needs
    // it to hit its minimum) — mirrors web's canAddToSlXi so the pool itself
    // makes an invalid final XI (e.g. 1 BAT of the required 3) unbuildable,
    // rather than only flagging it after 11 are already picked.
    return !canAddPlayer(selected, player, format, budgetCapSuspended);
  }, [selectedIds, selected, format, budgetCapSuspended]);

  // Current match label e.g. "M25 · MNY vs SO" — derived from the current match
  const currentMatchLabel = useMemo(() => {
    const m = matches.find(mx => mx.id === currentMatchId);
    if (!m) return null;
    return `M${m.matchNumber ?? '?'} · ${m.homeTeamId || '—'} vs ${m.awayTeamId || '—'}`;
  }, [matches, currentMatchId]);

  // "Plays next" / "After X matches" label per team — derived from the upcoming
  // match schedule. Only truly upcoming matches are counted (in_progress is excluded
  // so locked-match teams recalculate to their next future game automatically).
  const playsAfterMap = useMemo((): Map<string, string> => {
    // Anchor on the current match number to exclude past matches that aren't
    // yet marked completed in the DB. Label uses 1-based ordinal position so
    // "Plays next" = slot 1, "After 2 matches" = slot 2, etc.
    const currentMatch = matches.find(m => m.id === currentMatchId);
    const activeMN = currentMatch?.matchNumber ?? 0;
    const upcoming = matches
      .filter(m => !UPCOMING_HIDE_STATUS.has(m.status) && (m.matchNumber ?? 0) >= activeMN)
      .sort(byMatchNumberAsc);
    const map = new Map<string, string>();
    const allTeams = new Set(matches.flatMap(m => [m.homeTeamId, m.awayTeamId].filter(Boolean)));
    allTeams.forEach(team => {
      const idx = upcoming.findIndex(m => m.homeTeamId === team || m.awayTeamId === team);
      if (idx < 0) return;
      if (idx === 0) { map.set(team, 'Plays Next Match'); return; }
      map.set(team, `Plays After ${idx} match${idx > 1 ? 'es' : ''}`);
    });
    return map;
  }, [matches]);

  const renderItem = useCallback(({ item }: { item: Player }) => (
    <PlayerCard
      player={item}
      selected={selectedIds.has(item.id)}
      disabled={isDisabled(item)}
      onPress={() => togglePlayer(item)}
      recentForm={recentForm[item.id]}
      onStatsPress={() => setStatsPlayer(item)}
      playsAfterLabel={playsAfterMap.get(item.team) ?? null}
    />
  ), [selectedIds, isDisabled, togglePlayer, recentForm, playsAfterMap]);

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

  // ── Schedule preview drawer ─────────────────────────────────────────────────

  // Team colors keyed by code, derived from the player pool we already have
  // in memory — same colors PlayerCard's jerseys use, no extra fetch needed.
  const teamColorMap = useMemo(() => {
    const map = new Map<string, { color1: string | null; color2: string | null; jerseySvg: string | null }>();
    players.forEach(p => {
      if (p.team && !map.has(p.team)) {
        map.set(p.team, { color1: p.teamColor, color2: p.teamColor2, jerseySvg: p.teamJerseySvg ?? null });
      }
    });
    return map;
  }, [players]);

  // Every upcoming (not completed/live/in_progress) match, all of them —
  // the drawer scrolls rather than truncating to a fixed count.
  const upcomingMatches = useMemo(() => {
    return matches
      .filter(m => !UPCOMING_HIDE_STATUS.has(m.status))
      .sort(byMatchNumberAsc);
  }, [matches]);

  const scheduleAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(scheduleAnim, {
      toValue:      scheduleOpen ? 1 : 0,
      duration:     240,
      useNativeDriver: true,
    }).start();
  }, [scheduleOpen, scheduleAnim]);
  const drawerTranslateX = scheduleAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: [DRAWER_W + spacing.lg, 0],
  });

  // ── My XI preview drawer ────────────────────────────────────────────────────
  // Anchored (top:0/left/right/bottom, see styles.myxiDrawer) inside
  // listContainer rather than given a hardcoded height, so its real height
  // always matches whatever space listContainer actually has below the
  // search/filter bar on this device — that bar's own height varies (OS
  // counter row, expanded filter panels), so a height computed once from
  // window dimensions could either overshoot past the header above it or
  // leave the drawer short. The hidden position just needs to clear a full
  // screen height off the top, regardless of the drawer's real height.
  const myxiAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(myxiAnim, {
      toValue:      myXIOpen ? 1 : 0,
      duration:     240,
      useNativeDriver: true,
    }).start();
  }, [myXIOpen, myxiAnim]);
  const myxiTranslateY = myxiAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: [-SCREEN_H, 0],
  });

  const formatMatchWhen = (iso: string | null): string => {
    if (!iso) return '—';
    const d = new Date(iso);
    const dateStr = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${dateStr} · ${timeStr}`;
  };

  return (
    <View style={styles.container}>

      {/* Match + league context banner */}
      {(activeContext || currentMatchLabel) && (
        <View style={styles.contextBanner}>
          <Text style={styles.contextIcon}>
            {activeContext?.contestType === 'daily' ? '📅' : activeContext?.contestType === 'sl' ? '🏅' : '🔒'}
          </Text>
          <View style={{ flex: 1, gap: 2 }}>
            {currentMatchLabel && (
              <Text style={[styles.contextName, { fontSize: 13 }]}>{currentMatchLabel}</Text>
            )}
            {activeContext && (
              <Text style={styles.contextText} numberOfLines={1}>
                {activeContext.leagueName}
              </Text>
            )}
          </View>

          {/* "My XI" / Schedule toggles — moved down here (off MyXIScreen's
              modal header row) so Cancel/Title/Next have the top row to
              themselves and the title stops truncating. This row has the
              room they need since it's just icon + match/league label
              (flex-shrinkable) + these two buttons — no Cancel/Next
              competing for space here the way there was up top. Took the
              "Custom rules" badge's old spot (dropped from this screen per
              request — the underlying custom scoring/boosters still apply
              to the contest, this just isn't the place to surface it). */}
          <Pressable
            onPress={onToggleMyXI}
            style={[styles.myxiBtn, myXIOpen && styles.myxiBtnActive]}
          >
            <Text style={[styles.myxiBtnText, myXIOpen && styles.myxiBtnTextActive]}>
              🏏 My XI
            </Text>
            <View style={[styles.myxiBtnCount, myXIOpen && styles.myxiBtnCountActive]}>
              <Text style={[styles.myxiBtnCountText, myXIOpen && styles.myxiBtnCountTextActive]}>
                {selected.length}/{RULES.total}
              </Text>
            </View>
          </Pressable>
          <Pressable
            onPress={onToggleSchedule}
            style={[styles.scheduleBtn, scheduleOpen && styles.scheduleBtnActive]}
            accessibilityLabel="Schedule"
          >
            <Text style={[styles.scheduleBtnText, scheduleOpen && styles.scheduleBtnTextActive]}>
              📅
            </Text>
          </Pressable>
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

        {/* Search + disclosure pills (Type / Teams / Matches) — mirrors web.
            Each pill independently shows/hides its panel below; with all three
            open the bar looks exactly like the old always-expanded layout. */}
        <View style={styles.searchPillsRow}>
          <View style={styles.searchWrap}>
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
          <Pressable
            style={[styles.pill, panelOpen.type && styles.pillActive]}
            onPress={() => togglePanel('type')}
          >
            <Text style={[styles.pillText, panelOpen.type && styles.pillTextActive]}>
              Type {panelOpen.type ? '▴' : '▾'}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.pill, panelOpen.teams && styles.pillActive]}
            onPress={() => togglePanel('teams')}
          >
            <Text style={[styles.pillText, panelOpen.teams && styles.pillTextActive]}>
              Teams {panelOpen.teams ? '▴' : '▾'}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.pill, panelOpen.matches && styles.pillActive]}
            onPress={() => togglePanel('matches')}
          >
            <Text style={[styles.pillText, panelOpen.matches && styles.pillTextActive]}>
              Matches {panelOpen.matches ? '▴' : '▾'}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.pill, panelOpen.credits && styles.pillActive]}
            onPress={() => togglePanel('credits')}
          >
            <Text style={[styles.pillText, panelOpen.credits && styles.pillTextActive]}>
              Credits {panelOpen.credits ? '▴' : '▾'}
            </Text>
          </Pressable>
        </View>

        {/* Type panel: Role filter chips + OS — hidden until its pill is open */}
        {panelOpen.type && (
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

            {/* Non-overseas filter chip — same visibility condition as the OS
                chip above, labeled per-tournament via getDomesticLabel()
                (e.g. "US" for MLC, "Indian" for IPL). */}
            {osCap > 0 && (
              <Pressable
                style={[styles.chip, styles.domesticChip, domesticOnly && styles.domesticChipActive]}
                onPress={() => setDomesticOnly(v => !v)}
              >
                <Text style={[styles.chipText, domesticOnly && styles.chipTextActive]}>
                  🏠{' '}
                  <Text style={[styles.chipCount, domesticOnly && styles.chipCountActive]}>
                    {getDomesticLabel()}
                  </Text>
                </Text>
              </Pressable>
            )}
          </ScrollView>
        )}

        {/* Teams panel: single-select team filter — hidden until its pill is open */}
        {panelOpen.teams && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            <Pressable
              style={[styles.chip, teamFilter === 'ALL' && styles.chipActive]}
              onPress={() => setTeamFilter('ALL')}
            >
              <Text style={[styles.chipText, teamFilter === 'ALL' && styles.chipTextActive]}>
                All
              </Text>
            </Pressable>
            {teamList.map(t => {
              const active = teamFilter === t;
              return (
                <Pressable
                  key={t}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setTeamFilter(t)}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{t}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {/* ── Match selector (multi-select) — hidden until its pill is open ── */}
        {/* Only non-completed matches are fetched, so this list naturally
            starts at the live match (if any) or the next upcoming one. */}
        {panelOpen.matches && (
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
                  {/* Gold dot for current (live or next) match */}
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
        )}

        {/* Credits panel: single-select credits filter — hidden until its pill is open */}
        {panelOpen.credits && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            {CREDITS_OPTIONS.map(opt => {
              const active = creditsFilter === opt.key;
              return (
                <Pressable
                  key={opt.key}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setCreditsFilter(opt.key)}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {/* Filter summary hint */}
        {matchFilterLabel && (
          <View style={styles.matchHint}>
            <Text style={styles.matchHintText}>{matchFilterLabel}</Text>
          </View>
        )}
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
          bounces={false}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {matchesLoading ? 'Loading matches…' : 'No players match your filter'}
            </Text>
          }
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={5}
        />

        {/* "My XI" preview drawer — same mechanics as the Schedule drawer
            below (scrim + slide, opened from MyXIScreen's modal header,
            mutually exclusive with Schedule there), but anchored to
            listContainer (not the whole screen) and sized from top/bottom
            insets rather than a hardcoded height, so it can never overshoot
            upward past its own header or get clipped against the modal's
            header above — it only ever covers the list, leaving the
            search/filter bar above it visible and untouched. Shows the full
            `selected` list regardless of role/team/match/credits filters or
            search, so the XI can never hide behind a filter — tap a player
            to remove (captaincy stays off this sheet; see hideCaptaincy on
            CricketPitch). Re-tapping "My XI" (or the ✕, or the scrim)
            closes it and returns to the pool exactly where it was left. */}
        {myXIOpen && (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onCloseMyXI}
            accessibilityLabel="Close My XI preview"
          >
            <View style={styles.scheduleScrim} />
          </Pressable>
        )}
        <Animated.View
          style={[
            styles.myxiDrawer,
            { transform: [{ translateY: myxiTranslateY }] },
          ]}
          pointerEvents={myXIOpen ? 'auto' : 'none'}
        >
          <View style={styles.scheduleDrawerHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.scheduleDrawerTitle}>Your XI</Text>
              <Text style={styles.scheduleDrawerSub}>
                {selected.length} of {RULES.total} picked · tap a player to remove
              </Text>
            </View>
            <Pressable
              onPress={onCloseMyXI}
              style={styles.scheduleCloseBtn}
              accessibilityLabel="Close My XI preview"
            >
              <Text style={styles.scheduleCloseBtnText}>✕</Text>
            </Pressable>
          </View>

          {selected.length === 0 ? (
            <View style={styles.myxiEmpty}>
              <Text style={styles.myxiEmptyText}>
                No players picked yet — close this and tap players below to start building your XI.
              </Text>
            </View>
          ) : (
            <View style={styles.myxiPitchWrap}>
              <CricketPitch
                players={selected}
                onSetCaptaincy={() => {}}
                onRemove={(id) => removePlayer(id)}
                hideCaptaincy
              />
            </View>
          )}

          <Text style={styles.myxiHint}>
            Filters above are untouched — tap 🏏 My XI again to go back to picking.
          </Text>
        </Animated.View>
      </View>

      <PlayerStatsModal
        visible={!!statsPlayer}
        player={statsPlayer}
        tournamentId={tournamentId}
        onClose={() => setStatsPlayer(null)}
      />

      {/* Schedule preview drawer — slides in from the right over the player
          list. Opened via the "📅 Schedule" button in MyXIScreen's modal
          header; closing (✕ or the scrim) collapses it back to team
          selection without losing any in-progress picks underneath. */}
      {scheduleOpen && (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onCloseSchedule}
          accessibilityLabel="Close schedule preview"
        >
          <View style={styles.scheduleScrim} />
        </Pressable>
      )}
      <Animated.View
        style={[
          styles.scheduleDrawer,
          { width: DRAWER_W, transform: [{ translateX: drawerTranslateX }] },
        ]}
        pointerEvents={scheduleOpen ? 'auto' : 'none'}
      >
        <View style={styles.scheduleDrawerHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.scheduleDrawerTitle}>Upcoming matches</Text>
            <Text style={styles.scheduleDrawerSub}>
              {upcomingMatches.length} fixture{upcomingMatches.length !== 1 ? 's' : ''}
            </Text>
          </View>
          <Pressable
            onPress={onCloseSchedule}
            style={styles.scheduleCloseBtn}
            accessibilityLabel="Close schedule preview"
          >
            <Text style={styles.scheduleCloseBtnText}>✕</Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.scheduleDrawerList}
          showsVerticalScrollIndicator={false}
        >
          {upcomingMatches.length === 0 ? (
            <Text style={styles.scheduleEmptyText}>No upcoming matches scheduled.</Text>
          ) : (
            upcomingMatches.map(m => {
              const home = teamColorMap.get(m.homeTeamId);
              const away = teamColorMap.get(m.awayTeamId);
              return (
                <View key={m.id} style={styles.schedCard}>
                  <Text style={styles.schedNum}>M{m.matchNumber ?? '?'}</Text>
                  <View style={styles.schedVsRow}>
                    <Jersey code={m.homeTeamId} color1={home?.color1} color2={home?.color2} jerseySvg={home?.jerseySvg} size={32} variant="pool" />
                    <Text style={styles.schedVsLabel}>vs</Text>
                    <Jersey code={m.awayTeamId} color1={away?.color1} color2={away?.color2} jerseySvg={away?.jerseySvg} size={32} variant="pool" />
                  </View>
                  <Text style={styles.schedTime}>{formatMatchWhen(m.startTime)}</Text>
                </View>
              );
            })
          )}
        </ScrollView>
      </Animated.View>
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
    backgroundColor:   'rgba(0,0,0,0.03)',
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  contextIcon: { fontSize: 14 },
  contextText: { color: C.muted, fontSize: fontSize.sm, flex: 1 },
  contextName: { color: C.text, fontWeight: '700' },

  // "My XI" / Schedule toggle buttons — moved here from MyXIScreen's modal
  // header (see the context banner JSX above). Same look as before, just
  // relocated; styles copied rather than shared across files since RN
  // StyleSheet objects don't cross component boundaries.
  myxiBtn: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               4,
    borderRadius:      radius.md,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical:   spacing.xs + 2,
    backgroundColor:   'rgba(201,168,76,0.12)',
    borderWidth:       1,
    borderColor:       C.accent,
  },
  myxiBtnActive: {
    backgroundColor: C.accent,
  },
  myxiBtnText: {
    color:      C.gold,
    fontSize:   fontSize.xs,
    fontWeight: '700',
  },
  myxiBtnTextActive: {
    color: C.text,
  },
  myxiBtnCount: {
    borderRadius:      radius.full,
    paddingHorizontal: 5,
    paddingVertical:   1,
    backgroundColor:   'rgba(28,31,38,0.08)',
  },
  myxiBtnCountActive: {
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  myxiBtnCountText: {
    color:      C.gold,
    fontSize:   10,
    fontWeight: '800',
  },
  myxiBtnCountTextActive: {
    color: C.text,
  },
  scheduleBtn: {
    borderRadius:      radius.md,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical:   spacing.xs + 2,
    backgroundColor:   'rgba(201,168,76,0.12)',
    borderWidth:       1,
    borderColor:       C.accent,
  },
  scheduleBtnActive: {
    backgroundColor: C.accent,
  },
  scheduleBtnText: {
    color:      C.gold,
    fontSize:   fontSize.xs,
    fontWeight: '700',
  },
  scheduleBtnTextActive: {
    color: C.text,
  },

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

  // Search + disclosure pills row
  searchPillsRow: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop:        spacing.md,
    paddingBottom:     spacing.sm,
  },
  searchWrap: {
    flex:     1,
    minWidth: 90,
  },
  searchInput: {
    width:             '100%',
    backgroundColor:   'rgba(0,0,0,0.04)',
    borderWidth:       1,
    borderColor:       C.border,
    borderRadius:      radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm + 2,
    color:             C.text,
    fontSize:          fontSize.base,
  },

  // Disclosure pills (Type / Teams / Matches)
  pill: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical:   6,
    borderRadius:      radius.full,
    backgroundColor:   'rgba(0,0,0,0.04)',
    borderWidth:       1,
    borderColor:       C.border,
  },
  pillActive: {
    backgroundColor: C.active,
    borderColor:     C.active,
  },
  pillText: {
    color:      C.muted,
    fontSize:   fontSize.xs,
    fontWeight: '600',
  },
  pillTextActive: {
    color:      '#fff',
    fontWeight: '800',
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
    borderColor: C.border,
  },
  osChipActive: {
    backgroundColor: C.accent,
    borderColor:     C.accent,
  },
  domesticChip: {
    borderColor: C.border,
  },
  domesticChipActive: {
    backgroundColor: C.good,
    borderColor:     C.good,
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

  // Schedule preview drawer
  scheduleScrim: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  scheduleDrawer: {
    position:        'absolute',
    top:              0,
    right:            0,
    bottom:           0,
    backgroundColor:  '#F5F0E0',
    borderLeftWidth:  1,
    borderLeftColor:  C.border,
    shadowColor:      '#000',
    shadowOffset:     { width: -4, height: 0 },
    shadowOpacity:    0.18,
    shadowRadius:     12,
    elevation:        12,
  },
  scheduleDrawerHeader: {
    flexDirection:      'row',
    alignItems:          'center',
    gap:                 spacing.sm,
    paddingHorizontal:   spacing.lg,
    paddingVertical:     spacing.md,
    borderBottomWidth:   1,
    borderBottomColor:   C.border,
    backgroundColor:     '#FFFFFF',
  },
  scheduleDrawerTitle: {
    color:      C.text,
    fontSize:   fontSize.base,
    fontWeight: '800',
  },
  scheduleDrawerSub: {
    color:     C.muted,
    fontSize:  fontSize.xs,
    marginTop: 2,
  },
  scheduleCloseBtn: {
    width:           28,
    height:          28,
    borderRadius:    radius.full,
    backgroundColor: 'rgba(28,31,38,0.06)',
    alignItems:      'center',
    justifyContent:  'center',
  },
  scheduleCloseBtnText: {
    color:      C.text,
    fontSize:   fontSize.sm,
    fontWeight: '700',
  },
  scheduleDrawerList: {
    padding: spacing.md,
    gap:     spacing.sm,
  },
  scheduleEmptyText: {
    color:      C.muted,
    fontSize:   fontSize.sm,
    textAlign:  'center',
    marginTop:  spacing.xxl,
  },
  schedCard: {
    backgroundColor: '#FFFFFF',
    borderWidth:     1,
    borderColor:     C.border,
    borderRadius:    radius.lg,
    padding:         spacing.sm + 2,
    gap:             spacing.xs + 2,
  },
  schedNum: {
    alignSelf:         'flex-start',
    color:             C.muted,
    fontSize:          fontSize.xs,
    fontWeight:        '700',
    backgroundColor:   'rgba(0,0,0,0.04)',
    paddingHorizontal: spacing.xs + 2,
    paddingVertical:   2,
    borderRadius:      radius.sm,
  },
  schedVsRow: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            spacing.sm,
  },
  schedVsLabel: {
    color:      C.muted,
    fontSize:   fontSize.xs,
    fontWeight: '700',
  },
  schedTime: {
    color:     C.muted,
    fontSize:  fontSize.xs,
    textAlign: 'center',
  },

  // "My XI" preview drawer — reuses scheduleScrim/scheduleDrawerHeader/
  // scheduleCloseBtn styles above (same visual language), just its own
  // panel shape (top sheet vs. side panel). Anchored on all four sides
  // within listContainer (not given an explicit height) so it always fills
  // exactly the space available below the search/filter bar on this
  // device — it can't overshoot past the header above or get clipped
  // against the modal chrome below, whatever this device's actual layout
  // works out to.
  myxiDrawer: {
    position:        'absolute',
    left:            8,
    right:           8,
    top:             8,
    bottom:          8,
    backgroundColor: '#F5F0E0',
    borderRadius:    18,
    borderWidth:     1,
    borderColor:     C.border,
    shadowColor:     '#000',
    shadowOffset:    { width: 0, height: 6 },
    shadowOpacity:   0.18,
    shadowRadius:    14,
    elevation:       12,
    overflow:        'hidden',
  },
  myxiPitchWrap: {
    flex:              1,
    marginHorizontal:  spacing.md,
    marginTop:          spacing.xs,
    marginBottom:       spacing.xs,
    borderRadius:       14,
    overflow:           'hidden',
  },
  myxiEmpty: {
    flex:              1,
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: spacing.xl,
  },
  myxiEmptyText: {
    color:      C.muted,
    fontSize:   fontSize.sm,
    textAlign:  'center',
    lineHeight: 20,
  },
  myxiHint: {
    textAlign:         'center',
    color:             C.muted,
    fontSize:          fontSize.xs,
    paddingHorizontal: spacing.lg,
    paddingBottom:     spacing.sm,
  },
});
