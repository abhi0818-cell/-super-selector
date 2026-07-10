/**
 * HomeScreen — wired to real Supabase data
 * Contests, SL squad stats, and match info all come from the DB.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect, CommonActions } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { RootTabParamList, ContestContext, PrivateLeague } from '../types';
import { useAuthStore } from '../store/authStore';
import { useTeamStore } from '../store/teamStore';
import { useTournamentStore } from '../store/tournamentStore';
import { supabase } from '../lib/supabase';
import {
  useContestStore,
  RealContest,
  toContestContext,
} from '../store/contestStore';
import { useLeaderboardStore } from '../store/leaderboardStore';
import LeagueSelector from '../components/LeagueSelector';
import MyLiveTeamModal from '../components/MyLiveTeamModal';
import { useLiveMatch, useLiveScore, formatLiveScoreLine } from '../lib/liveScore';
import { fontSize, radius, spacing, shadow } from '../theme';

type NavProp  = BottomTabNavigationProp<RootTabParamList, 'Home'>;
type TileType = 'daily' | 'sl' | 'private' | null;

// ─── Gradient palette ─────────────────────────────────────────────────────────

const G = {
  bg:       ['#F5F0E0', '#EDE8D5', '#E8E2CE'] as const,
  card:     ['rgba(201,168,76,0.18)', 'rgba(237,217,138,0.1)', 'rgba(245,240,224,0.5)'] as const,
  btnPick:  ['#1C1F26', '#2A2E38', '#3E4451'] as const,
  btnReady: ['#2D6A35', '#1A6B2F'] as const,
  statPts:  ['rgba(201,168,76,0.22)', 'rgba(245,240,224,0.9)'] as const,
  statRank: ['rgba(44,62,80,0.15)', 'rgba(245,240,224,0.9)'] as const,
  statXfer: ['rgba(201,168,76,0.18)', 'rgba(245,240,224,0.9)'] as const,
  pillGood: ['rgba(45,106,53,0.08)', 'rgba(45,106,53,0.03)'] as const,
  pillWarn: ['rgba(201,168,76,0.12)', 'rgba(201,168,76,0.05)'] as const,
  nested:   ['rgba(201,168,76,0.06)', 'rgba(245,240,224,0.6)'] as const,
} as const;

const C = {
  text:    '#1C1F26',
  muted:   '#7A7060',
  accent:  '#C9A84C',
  gold:    '#92650A',
  good:    '#2D6A35',
  bad:     '#C0392B',
  border:  'rgba(201,168,76,0.28)',
  borderA: 'rgba(201,168,76,0.6)',
} as const;

// ─── SL squad stats hook ──────────────────────────────────────────────────────

interface SlSquadStats {
  squadId:              string | null;
  points:               number;
  rank:                 number | null;
  transfersUsed:        number;
  totalTransfersAllowed: number | null;
  extraCost:            number;
  // Best-performing scored match so far — mirrors web's Season tab "Best
  // match" tile (renderPageSeasonTab in index.html): for each match the
  // squad has scores recorded for, net = that match's points minus that
  // match's transfer penalty; bestMatch* tracks the highest net.
  bestMatchPoints:      number | null;
  bestMatchLabel:       string | null;   // e.g. "M5"
  loading:              boolean;
}

function useSlSquadStats(contestId: string | null, userId: string | null): SlSquadStats {
  const [stats, setStats] = useState<SlSquadStats>({
    squadId: null, points: 0, rank: null,
    transfersUsed: 0, totalTransfersAllowed: null, extraCost: 4,
    bestMatchPoints: null, bestMatchLabel: null, loading: false,
  });

  // useFocusEffect (not plain useEffect) — Home stays mounted in the tab
  // navigator, so a plain mount-only effect would fetch once on cold start
  // and then freeze forever: scores/transfers that get written later in the
  // same app session (a match getting locked/scored while the app is still
  // open) would never show up here, even though every other screen that
  // re-fetches on its own mount (e.g. LeaderboardScreen) stays current. This
  // was the actual cause of "Rank updates, Points stays stuck at 0" — Rank
  // comes from leaderboardStore, which LeaderboardScreen refreshes each time
  // it's opened; Points came from this hook's one-time snapshot.
  useFocusEffect(
    useCallback(() => {
    if (!contestId || !userId) {
      setStats(s => ({ ...s, squadId: null, loading: false }));
      return;
    }
    let cancelled = false;
    const load = async () => {
      setStats(s => ({ ...s, loading: true }));
      try {
        // 1. Squad row — total_transfers_allowed/extra_transfer_point_cost are
        // NOT columns on user_squads (they live on `contests`, see
        // migration_v3_season_transfer_cap.sql). Selecting them here against
        // user_squads made this whole query error out silently (only `data`
        // was destructured, not `error`), so `squads` came back null on every
        // load — the real cause of "Points/Transfers/Best Match never
        // populate," independent of any focus/staleness issue.
        const { data: squads, error: squadErr } = await supabase
          .from('user_squads')
          .select('id')
          .eq('contest_id', contestId)
          .eq('user_id', userId)
          .limit(1);
        if (squadErr) console.warn('[useSlSquadStats] squad lookup failed:', squadErr);

        const squad = squads?.[0] ?? null;
        if (!squad || cancelled) { setStats(s => ({ ...s, loading: false })); return; }

        // 1b. Transfer config lives on the contest, not the squad.
        const { data: contestRow, error: contestErr } = await supabase
          .from('contests')
          .select('total_transfers_allowed, extra_transfer_point_cost')
          .eq('id', contestId)
          .maybeSingle();
        if (contestErr) console.warn('[useSlSquadStats] contest lookup failed:', contestErr);

        // 2. Scored points, grouped per match (needed for the Best Match tile;
        // the season total is just the sum across all matches).
        const { data: scores } = await supabase
          .from('user_match_xi_scores')
          .select('match_id, total_points')
          .eq('squad_id', squad.id);

        const pointsByMatch: Record<string, number> = {};
        (scores ?? []).forEach((r: any) => {
          pointsByMatch[r.match_id] = (pointsByMatch[r.match_id] ?? 0) + Number(r.total_points ?? 0);
        });
        const rawPts = Object.values(pointsByMatch).reduce((s, n) => s + n, 0);

        // 3. Transfer penalties, also grouped per match for the Best Match net.
        const { data: transfers } = await supabase
          .from('user_transfers')
          .select('match_id, points_deducted')
          .eq('squad_id', squad.id);

        const penaltyByMatch: Record<string, number> = {};
        (transfers ?? []).forEach((t: any) => {
          penaltyByMatch[t.match_id] = (penaltyByMatch[t.match_id] ?? 0) + Number(t.points_deducted ?? 0);
        });
        const penalty       = Object.values(penaltyByMatch).reduce((s, n) => s + n, 0);
        const transfersUsed = transfers?.length ?? 0;

        // 4. Best match — highest (points - penalty) among matches that have
        // at least one scored row. No scored matches yet → both null, tile
        // shows a placeholder.
        let bestMatchId: string | null = null;
        let bestNet = -Infinity;
        Object.keys(pointsByMatch).forEach(matchId => {
          const net = pointsByMatch[matchId] - (penaltyByMatch[matchId] ?? 0);
          if (net > bestNet) { bestNet = net; bestMatchId = matchId; }
        });

        let bestMatchLabel: string | null = null;
        let bestMatchPoints: number | null = null;
        if (bestMatchId && !cancelled) {
          bestMatchPoints = bestNet;
          const { data: m } = await supabase
            .from('matches')
            .select('match_number')
            .eq('id', bestMatchId)
            .maybeSingle();
          bestMatchLabel = m?.match_number != null ? `M${m.match_number}` : null;
        }

        if (!cancelled) {
          setStats({
            squadId:              squad.id,
            points:               rawPts - penalty,
            rank:                 null,   // populated via leaderboard store
            transfersUsed,
            totalTransfersAllowed: contestRow?.total_transfers_allowed ?? null,
            extraCost:            contestRow?.extra_transfer_point_cost ?? 4,
            bestMatchPoints,
            bestMatchLabel,
            loading:              false,
          });
        }
      } catch (e) {
        console.warn('[useSlSquadStats]', e);
        if (!cancelled) setStats(s => ({ ...s, loading: false }));
      }
    };
    load();
    return () => { cancelled = true; };
    }, [contestId, userId])
  );

  return stats;
}

// ─── Saved-XI status hook ──────────────────────────────────────────────────────
// Home's tiles need to know "does this contest already have a saved XI?"
// independent of teamStore.selected — that's a single shared in-memory slot
// that only gets populated once you open MyXIScreen for a given contest, so on
// a fresh login (or before navigating into a tile) it's empty and every tile
// would wrongly show "Pick 11" even when a squad is already saved. This hook
// checks the DB directly per contest instead.
//
// `carryForward: true` (SL/private) also accepts a squad's most recently
// saved match as "ready" if nothing's saved yet for the exact upcoming match —
// SL squads don't need to re-save every single match, mirrors the same
// carry-forward fallback teamStore.loadSavedXI uses.
function useXIStatus(opts: {
  contestId: string | null;
  matchId: string | null;
  userId: string | null;
  carryForward: boolean;
}): boolean {
  const { contestId, matchId, userId, carryForward } = opts;
  const [hasXI, setHasXI] = useState(false);

  // useFocusEffect for the same reason as useSlSquadStats above — Home stays
  // mounted across tab switches, so a saved-XI status fetched once on cold
  // start would never reflect a save that happened later in the session.
  useFocusEffect(
    useCallback(() => {
    if (!contestId || !matchId || !userId) { setHasXI(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const { data: squad } = await supabase
          .from('user_squads')
          .select('id')
          .eq('contest_id', contestId)
          .eq('user_id', userId)
          .maybeSingle();
        if (!squad?.id) { if (!cancelled) setHasXI(false); return; }

        const { count: exactCount } = await supabase
          .from('user_match_xi')
          .select('player_id', { count: 'exact', head: true })
          .eq('squad_id', squad.id)
          .eq('match_id', matchId);
        if ((exactCount ?? 0) > 0) { if (!cancelled) setHasXI(true); return; }

        if (carryForward) {
          const { count: anyCount } = await supabase
            .from('user_match_xi')
            .select('player_id', { count: 'exact', head: true })
            .eq('squad_id', squad.id);
          if (!cancelled) setHasXI((anyCount ?? 0) > 0);
          return;
        }

        if (!cancelled) setHasXI(false);
      } catch (e) {
        console.warn('[useXIStatus]', e);
        if (!cancelled) setHasXI(false);
      }
    })();
    return () => { cancelled = true; };
    }, [contestId, matchId, userId, carryForward])
  );

  return hasXI;
}

// ─── Next-match hook ──────────────────────────────────────────────────────────

interface NextMatch {
  id: string; match_number: number | null;
  home_team: string; away_team: string;
  start_time: string; lock_time: string | null; status: string;
}

function useNextMatch(tournamentId: string | null): NextMatch | null {
  const [match, setMatch] = useState<NextMatch | null>(null);
  useEffect(() => {
    if (!tournamentId) { setMatch(null); return; }
    let cancelled = false;
    const refresh = async () => {
      const { data } = await supabase
        .from('matches')
        .select('id, match_number, home_team_id, away_team_id, start_time, lock_time, status')
        .eq('tournament_id', tournamentId)
        .in('status', ['scheduled', 'delayed'])
        .order('start_time', { ascending: true })
        .limit(10);
      if (cancelled) return;
      const now  = Date.now();
      const next = (data ?? []).find((m: any) => new Date(m.lock_time ?? m.start_time).getTime() > now);
      if (!cancelled) setMatch(next ? {
        id: next.id, match_number: next.match_number ?? null,
        home_team: next.home_team_id ?? '?', away_team: next.away_team_id ?? '?',
        start_time: next.start_time, lock_time: next.lock_time ?? null, status: next.status,
      } : null);
    };
    refresh();
    const iv = setInterval(refresh, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [tournamentId]);
  return match;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'Live';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const mn = Math.floor((s % 3600) / 60), se = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mn}m`;
  if (mn > 0) return `${mn}m ${String(se).padStart(2, '0')}s`;
  return `${se}s`;
}

// ─── Countdown banner ─────────────────────────────────────────────────────────

function CountdownBanner({ match }: { match: NextMatch }) {
  const gateMs = new Date(match.lock_time ?? match.start_time).getTime();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const remaining = Math.max(0, gateMs - now);
  const isSoon    = remaining < 60 * 60 * 1000;
  const dotColor  = isSoon ? '#E67E22' : C.accent;
  const bg        = isSoon ? 'rgba(230,126,34,0.1)' : 'rgba(201,168,76,0.1)';
  const border    = isSoon ? 'rgba(230,126,34,0.35)' : 'rgba(201,168,76,0.35)';
  return (
    <View style={[styles.countdownBanner, { backgroundColor: bg, borderColor: border }]}>
      <View style={[styles.countdownDot, { backgroundColor: dotColor }]} />
      <View style={styles.countdownInfo}>
        <Text style={styles.countdownMatch} numberOfLines={1}>
          {match.match_number != null ? `M${match.match_number} · ` : ''}{match.home_team} vs {match.away_team}
        </Text>
        <Text style={[styles.countdownTime, { color: dotColor }]}>Locks in {formatCountdown(remaining)}</Text>
      </View>
      <Text style={styles.countdownIcon}>⏱</Text>
    </View>
  );
}

// ─── Pick Team button ─────────────────────────────────────────────────────────

function PickTeamButton({ onPress, onView, teamReady }: { onPress: () => void; onView: () => void; teamReady: boolean }) {
  return (
    <Pressable onPress={teamReady ? onView : onPress} style={({ pressed }) => pressed && { opacity: 0.82 }}>
      <LinearGradient colors={G.btnPick} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.pickBtn}>
        <Text style={styles.pickBtnIcon}>🏏</Text>
        <View style={styles.pickBtnMeta}>
          <Text style={styles.pickBtnTitle}>{teamReady ? 'View Your XI' : 'Pick Your XI'}</Text>
          {!teamReady && <Text style={styles.pickBtnSub}>Select your 11 players</Text>}
        </View>
        <Text style={styles.pickBtnArrow}>→</Text>
      </LinearGradient>
    </Pressable>
  );
}

function LiveScorePill({ scoreLine, onPress }: { scoreLine: string | null; onPress: () => void }) {
  if (!scoreLine) {
    return (
      <View style={styles.liveScorePill}>
        <Text style={styles.liveScoreIcon}>📡</Text>
        <Text style={styles.liveScoreLabel}>No match live right now</Text>
      </View>
    );
  }
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.liveScorePillActive, pressed && { opacity: 0.85 }]}>
      <View style={styles.liveDot} />
      <Text style={styles.liveScoreLabelActive} numberOfLines={1}>{scoreLine}</Text>
      <Text style={styles.liveScoreArrow}>›</Text>
    </Pressable>
  );
}

function ActionBlock({
  onPickTeam, onViewTeam, teamReady, liveMatchLabel, onOpenLiveScore,
}: {
  onPickTeam: () => void; onViewTeam: () => void; teamReady: boolean;
  liveMatchLabel: string | null; onOpenLiveScore: () => void;
}) {
  return (
    <View style={styles.actionBlock}>
      <PickTeamButton onPress={onPickTeam} onView={onViewTeam} teamReady={teamReady} />
      <LiveScorePill scoreLine={liveMatchLabel} onPress={onOpenLiveScore} />
    </View>
  );
}

// ─── Daily match hero card ────────────────────────────────────────────────────

function MatchHeroCard({ match }: { match: NextMatch | null }) {
  if (!match) {
    return (
      <View style={[styles.heroCard, { justifyContent: 'center', alignItems: 'center', paddingVertical: 24 }]}>
        <Text style={styles.heroDetailText}>No upcoming match scheduled</Text>
      </View>
    );
  }
  return (
    <LinearGradient colors={G.card} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.heroCard}>
      <View style={styles.heroTeamsRow}>
        <Text style={[styles.heroTeam, { textAlign: 'left' }]}>{match.home_team}</Text>
        <View style={styles.heroVsBadge}><Text style={styles.heroVs}>VS</Text></View>
        <Text style={[styles.heroTeam, { textAlign: 'right' }]}>{match.away_team}</Text>
      </View>
      {match.match_number != null && (
        <Text style={[styles.heroDetailText, { textAlign: 'center' }]}>Match {match.match_number}</Text>
      )}
    </LinearGradient>
  );
}

// ─── Nested private league row ────────────────────────────────────────────────

function NestedLeagueRow({ contest, onPress }: { contest: RealContest; onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => pressed && { opacity: 0.8 }} onPress={onPress}>
      <LinearGradient colors={G.nested} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.nestedRow}>
        <Text style={styles.nestedIcon}>🔒</Text>
        <View style={styles.nestedInfo}>
          <Text style={styles.nestedName}>{contest.name}</Text>
          <Text style={styles.nestedMeta}>Private league</Text>
        </View>
        <Text style={styles.nestedArrow}>›</Text>
      </LinearGradient>
    </Pressable>
  );
}

// ─── Contest tile shell ───────────────────────────────────────────────────────

interface TileProps {
  id: TileType; icon: string; title: string; subtitle: string;
  open: boolean; onToggle: () => void; headerRight?: React.ReactNode;
  children: React.ReactNode;
}

function ContestTile({ icon, title, subtitle, open, onToggle, headerRight, children }: TileProps) {
  return (
    <View style={[styles.tile, open && styles.tileOpen]}>
      <LinearGradient
        colors={open ? ['rgba(201,168,76,0.1)', 'rgba(245,240,224,0)'] : ['rgba(201,168,76,0.04)', 'transparent']}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill} pointerEvents="none"
      />
      <Pressable
        style={({ pressed }) => [styles.tileHeader, open && styles.tileHeaderOpen, pressed && { opacity: 0.85 }]}
        onPress={onToggle}
      >
        <View style={[styles.tileIconWrap, open && styles.tileIconWrapOpen]}>
          <Text style={styles.tileIcon}>{icon}</Text>
        </View>
        <View style={styles.tileTitles}>
          <Text style={styles.tileName}>{title}</Text>
          <Text style={styles.tileMeta}>{subtitle}</Text>
        </View>
        {headerRight}
        <View style={[styles.chevronWrap, open && styles.chevronWrapOpen]}>
          <Text style={styles.chevronText}>›</Text>
        </View>
      </Pressable>
      {open && <View style={styles.tileBody}>{children}</View>}
    </View>
  );
}

// ─── SL compact header stats ──────────────────────────────────────────────────

function SLHeaderStats({ stats }: { stats: SlSquadStats }) {
  if (!stats.squadId || stats.points === 0 && stats.transfersUsed === 0) return null;
  const freeLeft = stats.totalTransfersAllowed !== null
    ? Math.max(0, stats.totalTransfersAllowed - stats.transfersUsed)
    : null;
  return (
    <View style={styles.slHeaderStats}>
      <Text style={styles.slHeaderPts}>{stats.points}</Text>
      <Text style={styles.slHeaderPtsSub}>pts</Text>
      {freeLeft !== null && (
        <>
          <View style={styles.slHeaderDivider} />
          <Text style={[styles.slHeaderXfer, freeLeft === 0 && styles.slHeaderXferWarn]}>
            {freeLeft}/{stats.totalTransfersAllowed}
          </Text>
          <Text style={styles.slHeaderPtsSub}>xfr</Text>
        </>
      )}
    </View>
  );
}

// ─── SL stats grid ────────────────────────────────────────────────────────────

function SLStatsGrid({ stats, rank }: { stats: SlSquadStats; rank: number | null }) {
  if (stats.loading) {
    return <ActivityIndicator size="small" color={C.accent} style={{ marginVertical: 16 }} />;
  }
  // No join gate — mirrors the web Season tab, which always shows the active
  // screen and silently creates the squad on first XI save (see saveSlXiHandler
  // in index.html / teamStore.ts's saveXI). Before that first save, squadId is
  // null and these stats are just their zero/empty defaults — same shape a
  // freshly-joined squad would show, so there's nothing to gate here.
  //
  // All four tiles below always render (previously the Transfers tile was
  // hidden whenever totalTransfersAllowed came back null — which happens both
  // pre-squad AND for genuinely-unlimited-transfer contests — leaving the grid
  // looking incomplete). Each tile now falls back to its own placeholder
  // instead of disappearing.
  const hasSquad      = stats.squadId !== null;
  const unlimitedXfer = hasSquad && stats.totalTransfersAllowed === null;
  const freeLeft      = stats.totalTransfersAllowed !== null
    ? Math.max(0, stats.totalTransfersAllowed - stats.transfersUsed)
    : null;

  return (
    <View style={styles.slGrid}>
      <LinearGradient colors={G.statPts} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.slStatCard}>
        <Text style={styles.slStatVal}>{stats.points}</Text>
        <Text style={styles.slStatLabel}>Total Points</Text>
      </LinearGradient>
      <LinearGradient colors={G.statRank} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.slStatCard}>
        <Text style={styles.slStatVal}>{rank != null ? `#${rank}` : '—'}</Text>
        <Text style={styles.slStatLabel}>Your Rank</Text>
      </LinearGradient>
      <LinearGradient
        colors={freeLeft === 0 ? ['rgba(192,57,43,0.18)', 'rgba(245,240,224,0.9)'] : G.statXfer}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.slStatCard}
      >
        {!hasSquad ? (
          <Text style={styles.slStatVal}>—</Text>
        ) : unlimitedXfer ? (
          <Text style={styles.slStatVal}>{stats.transfersUsed}<Text style={styles.slStatSub}>/∞</Text></Text>
        ) : (
          <Text style={[styles.slStatVal, freeLeft === 0 && { color: C.bad }]}>
            {freeLeft}<Text style={styles.slStatSub}>/{stats.totalTransfersAllowed}</Text>
          </Text>
        )}
        <Text style={styles.slStatLabel}>Transfers</Text>
      </LinearGradient>
      <LinearGradient colors={G.statPts} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.slStatCard}>
        <Text style={styles.slStatVal}>
          {stats.bestMatchPoints != null ? stats.bestMatchPoints : '—'}
        </Text>
        <Text style={styles.slStatLabel}>
          {stats.bestMatchLabel ? `Best · ${stats.bestMatchLabel}` : 'Best Match'}
        </Text>
      </LinearGradient>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const navigation                       = useNavigation<NavProp>();
  const { user, signOut }                = useAuthStore();
  const { selected, validation }         = useTeamStore();
  const { setContext }                   = useContestStore();
  const { tournaments, selectedTournamentId } = useTournamentStore();
  const { contests, loadContests, contestsLoading } = useContestStore();
  const { entries: lbEntries, loadLeaderboard }     = useLeaderboardStore();

  const [openTile, setOpenTile]               = useState<TileType>(null);
  const [selectorVisible, setSelectorVisible] = useState(false);
  const [selectorContests, setSelectorContests] = useState<RealContest[]>([]);
  const [liveModalVisible, setLiveModalVisible] = useState(false);

  const firstName        = user?.email?.split('@')[0] ?? 'Player';
  const teamReady        = validation.valid;
  // xiReady is DB-backed — true even on first load before teamStore hydrates.
  // validation.valid only becomes true after loadSavedXI runs (on MyXI tab).
  // Combining both means the pill shows correctly on cold start AND mid-session.
  const activeTournament = tournaments.find(t => t.id === selectedTournamentId);
  const nextMatch        = useNextMatch(selectedTournamentId);

  // Live score — ported from web's admin "Live scorecard" panel, reading the
  // same match_scorecards row the CricAPI/scraper poller keeps fresh.
  const liveMatch         = useLiveMatch(selectedTournamentId ?? null);
  const { score: liveScore } = useLiveScore(liveMatch?.id ?? null);
  const liveScoreLine     = formatLiveScoreLine(liveScore);
  const liveMatchTitle    = liveMatch
    ? `${liveMatch.homeTeamId ?? '?'} vs ${liveMatch.awayTeamId ?? '?'}${liveMatch.matchNumber != null ? ` · M${liveMatch.matchNumber}` : ''}`
    : undefined;
  // Pill label — match name only, no score (e.g. "M24 · LAKR vs WF")
  const liveMatchPillLabel = liveMatch
    ? `M${liveMatch.matchNumber != null ? liveMatch.matchNumber : '?'} · ${liveMatch.homeTeamId ?? '?'} vs ${liveMatch.awayTeamId ?? '?'}`
    : null;

  // Derive contest categories from real data
  const dailyContest    = contests.find(c => c.contestType === 'daily' && !c.isPrivate) ?? null;
  const slContest       = contests.find(c => c.contestType === 'sl'    && !c.isPrivate) ?? null;
  const privateContests = contests.filter(c => c.isPrivate);

  // Real SL squad stats
  const slStats = useSlSquadStats(slContest?.id ?? null, user?.id ?? null);

  // Per-contest saved-XI status (DB-backed, independent of teamStore.selected —
  // see useXIStatus above for why that matters)
  const dailyXIReady = useXIStatus({
    contestId:    dailyContest?.id ?? null,
    matchId:      nextMatch?.id ?? null,
    userId:       user?.id ?? null,
    carryForward: false,
  });
  const slXIReady = useXIStatus({
    contestId:    slContest?.id ?? null,
    matchId:      nextMatch?.id ?? null,
    userId:       user?.id ?? null,
    carryForward: true,
  });

  // Rank from leaderboard
  const myLbEntry = slContest ? (lbEntries[slContest.id] ?? []).find(e => e.isCurrentUser) : null;
  const myRank    = myLbEntry?.rank ?? null;

  // Load contests on tournament change
  useEffect(() => {
    if (selectedTournamentId) loadContests(selectedTournamentId);
  }, [selectedTournamentId]);

  // Load leaderboard on every focus, not just once when the SL contest is
  // first known — Home stays mounted across tab switches, so a mount-only
  // fetch goes stale the moment a match gets scored later in the session.
  // (Rank had been masking this: it only looked fresh because visiting the
  // Leaderboard screen separately refreshes this same shared store.)
  useFocusEffect(
    useCallback(() => {
      if (slContest?.id) loadLeaderboard(slContest.id);
    }, [slContest?.id])
  );

  const toggleTile = (tile: TileType) => setOpenTile(prev => prev === tile ? null : tile);

  const pickForContext = (ctx: ContestContext) => {
    setContext(ctx);
    navigation.navigate('MyXI', { openPicker: true });
  };

  const handlePickContest = (contest: RealContest) => {
    pickForContext(toContestContext(contest));
  };

  const handlePickPrivate = () => {
    if (privateContests.length === 1) {
      pickForContext(toContestContext(privateContests[0]));
    } else {
      setSelectorContests(privateContests);
      setSelectorVisible(true);
    }
  };

  const canSwitchTournament = tournaments.length > 1;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <LinearGradient colors={G.bg} style={StyleSheet.absoluteFill} />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={styles.brandRow}>
              <LinearGradient colors={[C.accent, C.gold]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.brandDot} />
              <Text style={styles.brandText}>
                <Text style={styles.brandSuper}>Maestro</Text>
              </Text>
            </View>
            <Text style={styles.welcomeText}>Hey {firstName} 👋</Text>
          </View>
          <Pressable style={({ pressed }) => [styles.signOutBtn, pressed && { opacity: 0.7 }]} onPress={signOut}>
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        </View>

        {/* ── Tournament context bar ────────────────────────────────────── */}
        {activeTournament && (
          <View style={styles.tournamentBar}>
            <View style={styles.tournamentInfo}>
              <Text style={styles.tournamentIcon}>🏆</Text>
              <Text style={styles.tournamentName} numberOfLines={1}>{activeTournament.name}</Text>
              <View style={styles.tournamentFormatBadge}>
                <Text style={styles.tournamentFormatText}>{activeTournament.format}</Text>
              </View>
            </View>
            {canSwitchTournament && (
              <Pressable
                style={({ pressed }) => [styles.switchBtn, pressed && { opacity: 0.7 }]}
                onPress={() => navigation.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'TournamentLobby' as any }] }))}
              >
                <Text style={styles.switchBtnText}>Switch →</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* ── Next match countdown ──────────────────────────────────────── */}
        {nextMatch && <CountdownBanner match={nextMatch} />}

        {/* ── Team status pill — incomplete warning only ─────────────────── */}
        {(() => {
          const xiReady = slXIReady || dailyXIReady || teamReady;
          if (xiReady || selected.length === 0) return null;
          return (
            <Pressable onPress={() => navigation.navigate('MyXI')}>
              <LinearGradient
                colors={G.pillWarn}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                style={[styles.statusPill, styles.pillBorderWarn]}
              >
                <Text style={styles.statusIcon}>⚡</Text>
                <Text style={[styles.statusText, styles.statusTextWarn]}>
                  {selected.length}/11 players · finish your XI
                </Text>
                <Text style={styles.statusArrow}>›</Text>
              </LinearGradient>
            </Pressable>
          );
        })()}

        {/* ── Section label ──────────────────────────────────────────────── */}
        {contestsLoading ? (
          <ActivityIndicator size="small" color={C.accent} style={{ marginVertical: 8 }} />
        ) : (
          <View style={styles.sectionRow}>
            <View style={styles.sectionLine} />
            <Text style={styles.sectionLabel}>Select a Contest</Text>
            <View style={styles.sectionLine} />
          </View>
        )}

        {/* ── Daily Contest ──────────────────────────────────────────────── */}
        {dailyContest && (
          <ContestTile
            id="daily"
            icon="📅"
            title={dailyContest.name}
            subtitle={nextMatch
              ? `${nextMatch.home_team} vs ${nextMatch.away_team}`
              : 'No upcoming match'}
            open={openTile === 'daily'}
            onToggle={() => toggleTile('daily')}
          >
            <MatchHeroCard match={nextMatch} />
            <ActionBlock
              onPickTeam={() => handlePickContest(dailyContest)}
              onViewTeam={() => navigation.navigate('MyXI')}
              teamReady={dailyXIReady}
              liveMatchLabel={liveMatchPillLabel}
              onOpenLiveScore={() => setLiveModalVisible(true)}
            />
          </ContestTile>
        )}

        {/* ── Season Long ────────────────────────────────────────────────── */}
        {slContest && (
          <ContestTile
            id="sl"
            icon="🏅"
            title={slContest.name}
            subtitle={privateContests.length > 0
              ? `${privateContests.length} private league${privateContests.length > 1 ? 's' : ''}`
              : 'Season long contest'}
            open={openTile === 'sl'}
            onToggle={() => toggleTile('sl')}
            headerRight={<SLHeaderStats stats={slStats} />}
          >
            <SLStatsGrid stats={slStats} rank={myRank} />

            {slStats.squadId && slStats.totalTransfersAllowed !== null && (
              <View style={styles.slMeta}>
                {slStats.transfersUsed >= slStats.totalTransfersAllowed && (
                  <View style={styles.xferWarning}>
                    <Text style={styles.xferWarningText}>
                      ⚠  No free transfers left — extra transfers cost {slStats.extraCost} pts each
                    </Text>
                  </View>
                )}
              </View>
            )}

            <ActionBlock
              onPickTeam={() => handlePickContest(slContest)}
              onViewTeam={() => navigation.navigate('MyXI')}
              teamReady={slXIReady}
              liveMatchLabel={liveMatchPillLabel}
              onOpenLiveScore={() => setLiveModalVisible(true)}
            />

            {/* Private leagues nested under SL */}
            {privateContests.length > 0 && (
              <>
                <View style={styles.nestedDivider}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerLabel}>Private Leagues</Text>
                  <View style={styles.dividerLine} />
                </View>
                {privateContests.map(c => (
                  <NestedLeagueRow key={c.id} contest={c} onPress={() => handlePickContest(c)} />
                ))}
              </>
            )}
          </ContestTile>
        )}

        {/* ── Empty state ─────────────────────────────────────────────────── */}
        {!contestsLoading && contests.length === 0 && (
          <View style={styles.notJoined}>
            <Text style={styles.notJoinedText}>No active contests for this tournament</Text>
          </View>
        )}

      </ScrollView>

      {/* League selector sheet (when multiple private leagues exist) */}
      <LeagueSelector
        visible={selectorVisible}
        leagues={selectorContests.map(c => ({
          id: c.id, name: c.name, members: 0, rank: null,
          ruleType: 'standard', deadline: c.deadline, isActive: true,
        } as PrivateLeague))}
        contestType="private"
        onSelect={(ctx) => { setSelectorVisible(false); pickForContext(ctx); }}
        onDismiss={() => setSelectorVisible(false)}
      />

      <MyLiveTeamModal
        visible={liveModalVisible}
        matchId={liveMatch?.id ?? null}
        title={liveMatchTitle}
        dailyContestId={dailyContest?.id ?? null}
        squadId={slStats.squadId ?? null}
        userId={user?.id ?? null}
        onClose={() => setLiveModalVisible(false)}
      />
    </SafeAreaView>
  );
}

// ─── Styles (unchanged from original) ────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll:    { padding: spacing.lg, gap: spacing.md, paddingBottom: 48 },

  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: spacing.xs, paddingBottom: spacing.sm },
  headerLeft:   { gap: 4 },
  brandRow:     { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  brandDot: { width: 10, height: 10, borderRadius: radius.full, shadowColor: '#C9A84C', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.9, shadowRadius: 8, elevation: 4 },
  brandText:     { fontSize: fontSize.xl, letterSpacing: 0.2 },
  brandSuper:    { color: '#1C1F26', fontFamily: 'PlayfairDisplay_700Bold' },
  welcomeText: { color: C.muted, fontSize: fontSize.base, letterSpacing: 0.1, marginLeft: 18 },
  signOutBtn: { paddingHorizontal: spacing.md, paddingVertical: 6, borderWidth: 1.5, borderColor: 'rgba(28,31,38,0.30)', borderRadius: radius.full },
  signOutText: { color: C.text, fontSize: fontSize.sm, fontWeight: '600' },

  tournamentBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(201,168,76,0.3)', backgroundColor: 'rgba(201,168,76,0.07)', marginBottom: spacing.xs },
  tournamentInfo: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  tournamentIcon: { fontSize: 14 },
  tournamentName: { color: C.text, fontSize: fontSize.sm, fontWeight: '700', flex: 1 },
  tournamentFormatBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, backgroundColor: 'rgba(201,168,76,0.15)', borderRadius: radius.full, borderWidth: 1, borderColor: 'rgba(201,168,76,0.3)' },
  tournamentFormatText: { color: C.gold, fontSize: fontSize.xs, fontWeight: '700' },
  switchBtn: { paddingHorizontal: spacing.md, paddingVertical: 4, backgroundColor: 'rgba(28,31,38,0.07)', borderRadius: radius.full, borderWidth: 1.5, borderColor: 'rgba(28,31,38,0.22)', marginLeft: spacing.sm },
  switchBtnText: { color: C.text, fontSize: fontSize.sm, fontWeight: '700' },

  countdownBanner: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.lg, borderWidth: 1, marginBottom: spacing.xs },
  countdownDot:  { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  countdownInfo: { flex: 1, gap: 2 },
  countdownMatch: { color: C.text, fontSize: fontSize.sm, fontWeight: '700' },
  countdownTime:  { fontSize: fontSize.sm, fontWeight: '600' },
  countdownIcon:  { fontSize: 16 },

  statusPill: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderRadius: radius.lg, borderWidth: 1 },
  pillBorderGood:  { borderColor: 'rgba(45,106,53,0.4)' },
  pillBorderDark:  { borderColor: 'transparent' },
  pillBorderWarn:  { borderColor: 'rgba(201,168,76,0.5)' },
  statusIcon:      { fontSize: 14 },
  statusText:      { flex: 1, fontSize: fontSize.base, fontWeight: '800', letterSpacing: 0.2 },
  statusTextGood:  { color: '#2D6A35' },
  statusTextDark:  { color: '#fff' },
  statusTextWarn:  { color: '#92650A' },
  statusArrow:     { color: C.muted, fontSize: 20 },

  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginVertical: 4 },
  sectionLine:  { flex: 1, height: 1, backgroundColor: 'rgba(201,168,76,0.2)' },
  sectionLabel: { color: C.muted, fontSize: fontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.2 },

  tile: { borderWidth: 1, borderColor: C.border, borderRadius: radius.xl, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.75)', ...shadow.card },
  tileOpen: { borderColor: C.borderA, shadowColor: '#C9A84C', shadowOpacity: 0.35, shadowRadius: 16, elevation: 12 },
  tileHeader: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: spacing.md },
  tileHeaderOpen: { borderBottomWidth: 1, borderBottomColor: 'rgba(201,168,76,0.15)' },
  tileIconWrap: { width: 42, height: 42, borderRadius: radius.lg, backgroundColor: 'rgba(201,168,76,0.1)', borderWidth: 1, borderColor: 'rgba(201,168,76,0.25)', alignItems: 'center', justifyContent: 'center' },
  tileIconWrapOpen: { backgroundColor: 'rgba(201,168,76,0.2)', borderColor: 'rgba(201,168,76,0.5)' },
  tileIcon:   { fontSize: 22 },
  tileTitles: { flex: 1, gap: 3 },
  tileName:   { color: C.text, fontSize: fontSize.base, fontWeight: '700', letterSpacing: 0.1 },
  tileMeta:   { color: C.muted, fontSize: fontSize.sm },
  chevronWrap: { width: 28, height: 28, borderRadius: radius.full, backgroundColor: 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' },
  chevronWrapOpen: { backgroundColor: 'rgba(201,168,76,0.15)' },
  chevronText: { color: C.muted, fontSize: 18, fontWeight: '600' },
  tileBody:    { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md },

  heroCard: { borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm, borderWidth: 1, borderColor: 'rgba(201,168,76,0.28)', overflow: 'hidden' },
  heroTeamsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  heroTeam: { color: C.text, fontSize: fontSize.xl, fontWeight: '800', letterSpacing: 0.3, flex: 1 },
  heroVsBadge: { paddingHorizontal: spacing.md, paddingVertical: 4, backgroundColor: 'rgba(201,168,76,0.12)', borderRadius: radius.full, borderWidth: 1, borderColor: 'rgba(201,168,76,0.35)', marginHorizontal: spacing.sm },
  heroVs: { color: C.accent, fontSize: fontSize.xs, fontWeight: '800', letterSpacing: 1.5 },
  heroDetailText: { color: 'rgba(28,31,38,0.65)', fontSize: fontSize.sm },

  actionBlock: { gap: spacing.sm },
  pickBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.lg },
  pickBtnIcon:  { fontSize: 22 },
  pickBtnMeta:  { flex: 1 },
  pickBtnTitle: { color: '#fff', fontSize: fontSize.base, fontWeight: '800', letterSpacing: 0.2 },
  pickBtnSub:   { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, marginTop: 2 },
  pickBtnArrow: { color: '#fff', fontSize: fontSize.lg, fontWeight: '700' },
  liveScorePill: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: 'rgba(0,0,0,0.03)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)', borderRadius: radius.lg, opacity: 0.5 },
  liveScoreIcon:  { fontSize: 16 },
  liveScoreLabel: { color: C.muted, fontSize: fontSize.sm, fontWeight: '600', flex: 1 },
  liveScorePillActive: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: 'rgba(192,57,43,0.08)', borderWidth: 1, borderColor: 'rgba(192,57,43,0.3)', borderRadius: radius.lg },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.bad, flexShrink: 0 },
  liveScoreLabelActive: { color: C.text, fontSize: fontSize.sm, fontWeight: '700', flex: 1 },
  liveScoreArrow: { color: C.muted, fontSize: fontSize.lg, fontWeight: '600' },

  slHeaderStats: { flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: spacing.xs, paddingHorizontal: spacing.sm, paddingVertical: 4, backgroundColor: 'rgba(201,168,76,0.1)', borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(201,168,76,0.2)' },
  slHeaderPts:     { color: C.accent, fontSize: fontSize.sm, fontWeight: '800' },
  slHeaderPtsSub:  { color: C.muted, fontSize: 9, fontWeight: '600' },
  slHeaderDivider: { width: 1, height: 12, backgroundColor: 'rgba(0,0,0,0.1)', marginHorizontal: 2 },
  slHeaderXfer:    { color: C.gold, fontSize: fontSize.sm, fontWeight: '800' },
  slHeaderXferWarn:{ color: '#C0392B' },

  // Wraps to a 2x2 layout — now that there are 4 SL tiles (Points/Rank/
  // Transfers/Best Match), a single row would squeeze each one too narrow.
  slGrid:    { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  slStatCard: { flexBasis: '47%', flexGrow: 1, alignItems: 'center', gap: 4, paddingVertical: spacing.md, borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)', overflow: 'hidden' },
  slStatVal:   { color: C.text, fontSize: fontSize.xl, fontWeight: '800' },
  slStatSub:   { color: C.muted, fontSize: fontSize.sm, fontWeight: '400' },
  slStatLabel: { color: C.muted, fontSize: fontSize.xs, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },

  slMeta: { gap: 4 },
  xferWarning: { marginTop: 4, padding: spacing.sm, backgroundColor: 'rgba(192,57,43,0.08)', borderRadius: radius.sm, borderLeftWidth: 3, borderLeftColor: '#C0392B' },
  xferWarningText: { color: '#C0392B', fontSize: fontSize.sm },

  notJoined: { padding: spacing.md, backgroundColor: 'rgba(0,0,0,0.03)', borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)' },
  notJoinedText: { color: C.muted, fontSize: fontSize.sm },

  nestedDivider: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dividerLine:   { flex: 1, height: 1, backgroundColor: 'rgba(201,168,76,0.2)' },
  dividerLabel:  { color: C.muted, fontSize: fontSize.xs, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  nestedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(201,168,76,0.2)', overflow: 'hidden' },
  nestedIcon:  { fontSize: 16 },
  nestedInfo:  { flex: 1, gap: 2 },
  nestedName:  { color: C.text, fontSize: fontSize.base, fontWeight: '600' },
  nestedMeta:  { color: C.muted, fontSize: fontSize.sm },
  nestedArrow: { color: C.muted, fontSize: 20 },
});
