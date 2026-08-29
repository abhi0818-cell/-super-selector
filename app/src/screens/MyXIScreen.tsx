/**
 * MyXIScreen — gradient-first redesign (Pass 1)
 * Requires: expo-linear-gradient  →  npx expo install expo-linear-gradient
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Alert,
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { RootTabParamList, SelectedPlayer, CaptaincyRole, ContestContext } from '../types';
import { useTeamStore, RULES } from '../store/teamStore';
import { useAuthStore } from '../store/authStore';
import { useContestStore } from '../store/contestStore';
import { useBoosterStore } from '../store/boosterStore';
import CricketPitch from '../components/CricketPitch';
import ConfirmXIModal from '../components/ConfirmXIModal';
import BudgetBar from '../components/BudgetBar';
import BoostersBar from '../components/BoostersBar';
import Coachmark, { CoachmarkTarget } from '../components/Coachmark';
import { useOnboardingStore } from '../store/onboardingStore';
import RoleStats from '../components/RoleStats';
import ContestPicker from '../components/ContestPicker';
import NameSquadModal from '../components/NameSquadModal';
import PlayerPickerScreen from './PlayerPickerScreen';
import { fontSize, radius, spacing, shadow } from '../theme';
import {
  fetchContestTransferConfig,
  fetchTournamentMatches,
  getTransferUsage,
  getPreviousMatchXI,
  computeIsFirstActiveLock,
} from '../lib/transferCap';

type Props = BottomTabScreenProps<RootTabParamList, 'MyXI'>;

// ─── Gradient palette ─────────────────────────────────────────────────────────

const G = {
  bg:         ['#F5F0E0', '#EDE8D5', '#E8E2CE'] as const,
  header:     ['rgba(245,240,224,0.98)', 'rgba(237,232,213,0.95)'] as const,
  fabPick:    ['#1C1F26', '#2A2E38', '#3E4451'] as const,
  fabXfer:    ['#92650A', '#7A5208'] as const,
  fabReady:   ['#2D6A35', '#1A6B2F'] as const,
  statusBg:   ['rgba(245,240,224,0.97)', 'rgba(237,232,213,0.97)'] as const,
  emptyBtn:   ['#1C1F26', '#2A2E38'] as const,
  modalHdr:   ['rgba(245,240,224,0.99)', 'rgba(237,232,213,0.99)'] as const,
  doneBtn:    ['#1C1F26', '#2A2E38'] as const,
} as const;

const C = {
  text:    '#1C1F26',
  muted:   '#7A7060',
  accent:  '#C9A84C',
  gold:    '#92650A',
  good:    '#2D6A35',
  bad:     '#C0392B',
  border:  'rgba(201,168,76,0.25)',
  borderA: 'rgba(201,168,76,0.5)',
} as const;

// ─── Saved-XI snapshot comparison ─────────────────────────────────────────────
// Used to gate "Revert to Saved" so it only arms when the on-screen XI
// actually differs from what's saved — showing it greyed out otherwise
// (rather than hiding it) reads clearer than a button that appears/
// disappears, per the mobile status-strip design.
type XISnapshot = { ids: string[]; cap: string | null; vc: string | null };

function snapshotFromSelected(list: SelectedPlayer[]): XISnapshot {
  return {
    ids: list.map(p => p.id).slice().sort(),
    cap: list.find(p => p.captaincy === 'captain')?.id ?? null,
    vc:  list.find(p => p.captaincy === 'vice_captain')?.id ?? null,
  };
}

function snapshotsEqual(a: XISnapshot | null, b: XISnapshot | null): boolean {
  if (!a || !b) return false;
  if (a.ids.length !== b.ids.length) return false;
  for (let i = 0; i < a.ids.length; i++) if (a.ids[i] !== b.ids[i]) return false;
  return a.cap === b.cap && a.vc === b.vc;
}

export default function MyXIScreen({ route }: Props) {
  const navigation = useNavigation<BottomTabNavigationProp<RootTabParamList>>();
  const { signOut, user }               = useAuthStore();
  const [teamName, setTeamName] = useState<string | null>(
    (user?.user_metadata as any)?.team_name ?? null
  );
  useEffect(() => {
    if (!user || teamName) return;
    supabase.from('profiles').select('team_name').eq('id', user.id).maybeSingle()
      .then(({ data }) => { if (data?.team_name) setTeamName(data.team_name); });
  }, [user?.id]);
  const { activeContext, setContext }   = useContestStore();
  const { loadBoosters, commitPending, discardPending, selectBooster } = useBoosterStore();

  // ── Name-your-squad prompt ──────────────────────────────────────────────
  // Shown once, right after picking a contest that the user doesn't already
  // have a squad in — see NameSquadModal for why this exists (squads used
  // to be silently created as "My Squad", which is what still shows on the
  // leaderboard for anyone who joined before this prompt existed).
  const [pendingContest, setPendingContest] = useState<{ ctx: ContestContext; openPicker: boolean } | null>(null);
  const [namingSubmitting, setNamingSubmitting] = useState(false);
  const [namingError, setNamingError] = useState<string | null>(null);
  const ensureSquad = useTeamStore(s => s.ensureSquad);

  const handleContestSelect = async (ctx: ContestContext, openPickerAfter: boolean) => {
    if (!user) { setContext(ctx); return; }
    try {
      const { data: existing } = await supabase
        .from('user_squads')
        .select('id')
        .eq('contest_id', ctx.contestId)
        .eq('user_id',    user.id)
        .maybeSingle();

      if (existing?.id) {
        setContext(ctx);
        if (openPickerAfter) openPicker();
        return;
      }
    } catch (e) {
      console.warn('[MyXIScreen] squad lookup before naming prompt failed:', e);
      // Fall through to the naming prompt anyway — ensureSquad's own
      // get-or-create will safely no-op if a squad turns out to exist.
    }
    setNamingError(null);
    setPendingContest({ ctx, openPicker: openPickerAfter });
  };

  const handleConfirmSquadName = async (name: string) => {
    if (!pendingContest || !user) return;
    setNamingSubmitting(true);
    setNamingError(null);
    try {
      const squadId = await ensureSquad(pendingContest.ctx.contestId, name);
      if (!squadId) {
        setNamingError("Couldn't save that name — please try again.");
        return;
      }
      // Update the account-level default too, so the next new contest this
      // user joins starts prefilled with whatever they last used.
      await supabase.from('profiles').update({ team_name: name }).eq('id', user.id);
      setTeamName(name);

      setContext(pendingContest.ctx);
      if (pendingContest.openPicker) openPicker();
      setPendingContest(null);
    } catch (e: any) {
      console.warn('[MyXIScreen] failed to name squad:', e);
      setNamingError("Couldn't save that name — please try again.");
    } finally {
      setNamingSubmitting(false);
    }
  };

  const {
    players,
    selected,
    creditsSpent,
    creditsLeft,
    roleCounts,
    validation,
    removePlayer,
    setCaptaincy,
    resetXI,
    restoreXI,
    loadSavedXI,
    saveXI,
    saveError,
    loadTournamentContext,
  } = useTeamStore();

  // Re-resolve currentMatchId every time this screen gains focus, not just
  // once at cold app launch (RootNavigator's one-shot loadTournamentContext
  // call). Without this, a match that locks WHILE the app is already running
  // (or backgrounded/resumed without a fresh auth event) leaves currentMatchId
  // pointed at the now-locked match for the rest of the session — every
  // downstream read inherits the staleness: loadBoosters() resolves booster
  // status against the wrong match (a booster genuinely used on the stale
  // match then reads as still "active" here), and Revert to Locked's
  // getPreviousMatchXI() computes "previous match" one hop too far back
  // (e.g. shows M30 instead of M31 once M31 has locked and M32 is next).
  // Confirmed in production: mobile showed the wrong Revert-to-Locked team
  // and a stale "active" booster until the app was force-restarted; web
  // re-derives its current match live and didn't have either problem.
  useFocusEffect(
    useCallback(() => {
      loadTournamentContext();
    }, [loadTournamentContext])
  );

  const [pickerOpen, setPickerOpen]       = useState(false);
  // Match-schedule preview drawer, opened from the picker modal's header.
  // Owned here (not inside PlayerPickerScreen) so closing/reopening the
  // picker always starts with the drawer collapsed.
  const [scheduleOpen, setScheduleOpen]   = useState(false);
  // "My XI" preview drawer — same idea as scheduleOpen above, but shows the
  // already-picked XI as a pitch map instead of upcoming fixtures, so it can
  // be checked/trimmed inside the picker without fighting whatever pool
  // filters are currently narrowing the list. Mutually exclusive with
  // scheduleOpen (see handleToggleMyXI/handleToggleSchedule below) — only
  // one of the two header drawers is ever open at once.
  const [myXIOpen, setMyXIOpen]           = useState(false);
  const [confirmOpen, setConfirmOpen]     = useState(false);
  // True while handleConfirm's saveXI() call is actually in flight. Keeps
  // ConfirmXIModal open (with its own spinner) instead of dismissing it the
  // instant Save is tapped — previously the modal closed immediately,
  // dropping the user back onto My XI with no visible sign anything was
  // happening until the success toast/failure alert showed up 1-3+ seconds
  // later. See ConfirmXIModal's `saving` prop.
  const [confirmSaving, setConfirmSaving] = useState(false);
  const [snapshot, setSnapshot]           = useState<SelectedPlayer[]>([]);
  const autoOpenHandled = useRef(false);
  // Baseline for "Revert to Saved" no-op detection — whatever's actually
  // saved (loaded from DB, just-saved, or just-reverted-to) for the
  // currently-viewed match. null until the first load resolves.
  const [savedSnapshot, setSavedSnapshot] = useState<XISnapshot | null>(null);

  // ── Save-confirmation toast ────────────────────────────────────────────────
  const [toastMsg, setToastMsg]     = useState('');
  const toastOpacity                = useRef(new Animated.Value(0)).current;
  const toastTimer                  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastMsg(msg);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.delay(2200),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start();
    toastTimer.current = setTimeout(() => setToastMsg(''), 2800);
  }, [toastOpacity]);

  const openPicker = () => {
    setSnapshot([...selected]);
    setPickerOpen(true);
  };

  // Header toggles for the two picker drawers (My XI / Schedule) — mutually
  // exclusive: pressing one while the other is open switches to it instead
  // of stacking both; pressing the already-open one just closes it.
  const handleToggleMyXI = () => {
    if (scheduleOpen) { setScheduleOpen(false); setMyXIOpen(true); }
    else setMyXIOpen(o => !o);
  };
  const handleToggleSchedule = () => {
    if (myXIOpen) { setMyXIOpen(false); setScheduleOpen(true); }
    else setScheduleOpen(o => !o);
  };

  const handlePickerDone = () => {
    // Only advance to the Captain/Vice-Captain + Save summary once the XI is
    // actually full — previously this always advanced regardless of count,
    // so a squad that happened to satisfy role-minimums at fewer than 11
    // (validation.errors stays empty below 11 since role-minimum checks only
    // run once the squad is full — see validate() in teamStore.ts) could
    // slip through to Save with 10 players and no captain requirement ever
    // being enforced. Gate on the actual count here, matching web's pool,
    // which never lets you finish an XI short of RULES.total in the first
    // place.
    if (selected.length < RULES.total) {
      Alert.alert(
        'XI not complete',
        `Pick ${RULES.total - selected.length} more player${RULES.total - selected.length === 1 ? '' : 's'} before continuing — you have ${selected.length} of ${RULES.total}.`
      );
      return;
    }
    setPickerOpen(false);
    setScheduleOpen(false);
    setMyXIOpen(false);
    setConfirmOpen(true);
  };

  const handleEditMore = () => {
    setConfirmOpen(false);
    setPickerOpen(true);
  };

  const currentMatchId    = useTeamStore(s => s.currentMatchId);
  const currentMatchLabel = useTeamStore(s => s.currentMatchLabel);
  const nextMatchTime     = useTeamStore(s => s.nextMatchTime);
  const isFirstMatch      = useTeamStore(s => s.isFirstMatch);
  const setBudgetCapSuspended = useTeamStore(s => s.setBudgetCapSuspended);

  // Suspend the 100cr budget cap while Free Hit is the effective (staged-or-
  // committed) booster for this match — mirrors web's slBudgetCapSuspended().
  // Wildcard does NOT suspend this (its pick is permanent).
  const boosters = useBoosterStore(s => s.boosters);
  useEffect(() => {
    const freeHit = boosters.find(b => b.id === 'free_hit');
    const suspended = !!freeHit && (freeHit.status === 'active' || freeHit.status === 'pending');
    setBudgetCapSuspended(suspended);
  }, [boosters, setBudgetCapSuspended]);

  // ── Countdown ──────────────────────────────────────────────────────────────
  const [countdown, setCountdown] = useState('');
  useEffect(() => {
    if (!nextMatchTime) { setCountdown(''); return; }
    function tick() {
      const diff = new Date(nextMatchTime!).getTime() - Date.now();
      if (diff <= 0) { setCountdown('Locked'); return; }
      const h  = Math.floor(diff / 3_600_000);
      const m  = Math.floor((diff % 3_600_000) / 60_000);
      const s  = Math.floor((diff % 60_000) / 1_000);
      if (h > 0) setCountdown(`${h}h ${m}m`);
      else if (m > 0) setCountdown(`${m}m ${s}s`);
      else setCountdown(`${s}s`);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextMatchTime]);

  // ── Transfers ──────────────────────────────────────────────────────────────
  // transferInfo: null = not loaded yet; { used, total, free } = loaded
  const [transferInfo, setTransferInfo] = useState<{
    used: number; total: number | null; free: number;
  } | null>(null);
  const [squadId, setSquadId] = useState<string | null>(null);

  // ── Onboarding: Boosters contextual tip (first visit, SL/private only) ──
  const { hasSeenBoostersTip, hydrated: onboardingHydrated, hydrate: hydrateOnboarding, completeBoostersTip, replayRequest, clearReplayRequest } = useOnboardingStore();
  const [boostersTipActive, setBoostersTipActive] = useState(false);
  const [boostersTipTarget, setBoostersTipTarget] = useState<CoachmarkTarget | null>(null);
  const boostersBarRef = useRef<View>(null);
  const boostersEligible = activeContext?.contestType === 'sl' || activeContext?.contestType === 'private';

  useEffect(() => { hydrateOnboarding(); }, [hydrateOnboarding]);

  useEffect(() => {
    if (!onboardingHydrated || hasSeenBoostersTip || !boostersEligible) return;
    const t = setTimeout(() => {
      setBoostersTipActive(true);
      if (replayRequest === 'boosters') clearReplayRequest();
    }, 500);
    return () => clearTimeout(t);
  }, [onboardingHydrated, hasSeenBoostersTip, boostersEligible, replayRequest, clearReplayRequest]);

  useEffect(() => {
    if (!boostersTipActive) return;
    const raf = requestAnimationFrame(() => {
      boostersBarRef.current?.measureInWindow((x: number, y: number, width: number, height: number) => {
        if (width > 0 && height > 0) setBoostersTipTarget({ x, y, width, height });
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [boostersTipActive]);

  const finishBoostersTip = useCallback(() => {
    setBoostersTipActive(false);
    setBoostersTipTarget(null);
    completeBoostersTip();
  }, [completeBoostersTip]);
  // Transfers pending for the CURRENT (not-yet-locked) match. Two sources,
  // checked in order:
  //   1. user_transfers (match_id = currentMatchId) — set once this match
  //      has actually locked (mobile's own saveXI writes here immediately,
  //      "save IS the lock"; web's saveXI doesn't touch this until the
  //      lock-matches cron fires at start_time).
  //   2. squad_draft_xi vs. previousLockedXI — the pre-lock diff, mirrors
  //      web's client-side renderSlXferInfoBar() math. Without this, a web
  //      save sitting in the draft table (not yet locked) was invisible
  //      here — mobile showed 0 pending / full budget remaining even though
  //      web was already showing "N pending ... remaining after lock".
  const [pendingTransfers, setPendingTransfers] = useState(0);
  // Budget remaining if the current draft locks in as-is (cap − used − pending).
  // null when uncapped or not yet known.
  const [remainingAfterLock, setRemainingAfterLock] = useState<number | null>(null);
  // The squad's true previous LOCKED XI (baseline checkAndLogTransfers diffs
  // against) — used as the "previous" comparison for the Review & Save
  // modal's IN/OUT list, so that list always matches what actually gets
  // counted as a transfer server-side.
  const [previousLockedXI, setPreviousLockedXI] = useState<SelectedPlayer[]>([]);

  // Reverts the XI to the last saved draft (DB), or the last locked XI if no
  // draft exists, or the snapshot from when the picker was opened as a last resort.
  const revertXI = useCallback(async () => {
    // Always discard any staged (not-yet-saved) booster pick on cancel
    discardPending();
    if (activeContext && currentMatchId) {
      const err = await loadSavedXI(currentMatchId, activeContext.contestId, activeContext.contestType);
      if (err) {
        if (previousLockedXI.length > 0) restoreXI(previousLockedXI);
        else restoreXI(snapshot);
      }
    } else {
      restoreXI(snapshot);
    }
  }, [activeContext, currentMatchId, discardPending, loadSavedXI, previousLockedXI, restoreXI, snapshot]);

  const handlePickerCancel = useCallback(async () => {
    setPickerOpen(false);
    setScheduleOpen(false);
    setMyXIOpen(false);
    await revertXI();
  }, [revertXI]);

  useEffect(() => {
    setSquadId(null);  // reset when contest changes
    if (!activeContext || activeContext.contestType === 'daily') return;
    loadTransfers();
    // players.length included so the previousLockedXI baseline (built from
    // the `players` pool) gets (re)built once the pool finishes loading,
    // instead of staying empty forever if this effect's first run raced it.
  }, [activeContext?.contestId, currentMatchId, players.length]);

  // ── Auto-restore saved XI on mount / contest change ────────────────────────
  // Fires once all three prerequisites are ready: contest known, match known,
  // and player list loaded (needed to reconstruct SelectedPlayer objects).
  //
  // Keyed by contestId+matchId (not by "is selected empty") so that switching
  // contests (e.g. Daily → SL from Home) always clears the previous contest's
  // 11 players and fetches the new contest's own saved squad — `selected`
  // lives in the shared teamStore, not scoped per-contest, so without this key
  // check a non-empty `selected` from the contest you just left would look
  // "already loaded" and the new contest's real saved XI would never load.
  // Within the SAME contest+match (e.g. switching tabs and back), the key
  // matches and this correctly stays a no-op, preserving mid-edit work.
  const loadedForKey = useRef<string | null>(null);
  useEffect(() => {
    if (!activeContext)         return;
    if (!currentMatchId)        return;
    if (players.length === 0)   return;

    const key = `${activeContext.contestId}:${currentMatchId}`;
    if (loadedForKey.current === key) return;
    loadedForKey.current = key;

    resetXI();
    loadSavedXI(currentMatchId, activeContext.contestId, activeContext.contestType).then(() => {
      setSavedSnapshot(snapshotFromSelected(useTeamStore.getState().selected));
    });
  }, [activeContext?.contestId, currentMatchId, players.length]);

  async function loadTransfers() {
    if (!activeContext) return;
    try {
      // Fetch contest config (mirrors web's transfer-cap config lookup)
      const { config, tournamentId } = await fetchContestTransferConfig(activeContext.contestId);

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: squad } = await supabase
        .from('user_squads')
        .select('id')
        .eq('contest_id', activeContext.contestId)
        .eq('user_id', user.id)
        .maybeSingle();

      // Load boosters regardless of squad — without a squad, all show as 'available'
      if (currentMatchId) {
        loadBoosters(activeContext.contestId, squad?.id ?? null, currentMatchId, isFirstMatch);
      }

      if (!squad) {
        setTransferInfo({ used: 0, total: config.total_transfers_allowed, free: config.free_transfers_per_match ?? 1 });
        setPendingTransfers(0);
        setRemainingAfterLock(null);
        setPreviousLockedXI([]);
        return;
      }

      // Track squadId so BoostersBar can activate / deactivate boosters
      setSquadId(squad.id);

      // Transfers used = actual player swaps logged in user_transfers, scoped
      // to the current phase (regular/playoff) — mirrors checkAndLogTransfers'
      // seasonXferCount tally. Previously this counted user_match_xi rows,
      // which has 11 rows per match (one per XI player), massively overcounting
      // "transfers" as roughly (matches saved × 11).
      if (currentMatchId && tournamentId) {
        const allMatches = await fetchTournamentMatches(tournamentId);
        const { used, cap } = await getTransferUsage(squad.id, currentMatchId, config, allMatches);
        setTransferInfo({ used, total: cap, free: config.free_transfers_per_match ?? 1 });

        // The squad's true previous LOCKED XI — same baseline
        // checkAndLogTransfers diffs against — so the Review & Save modal's
        // IN/OUT list always matches what actually gets counted as a
        // transfer, instead of diffing against whatever was on-screen when
        // the picker happened to be opened.
        const prev = await getPreviousMatchXI(squad.id, currentMatchId, allMatches, config.start_match_number);
        const isFirstActiveLock = await computeIsFirstActiveLock(squad.id, prev, allMatches);
        const baseline = isFirstActiveLock ? { playerIds: [] as string[], captainId: null, vcId: null } : prev;
        const baselineXI: SelectedPlayer[] = baseline.playerIds
          .map(id => players.find(p => p.id === id))
          .filter((p): p is typeof players[number] => !!p)
          .map(p => ({
            ...p,
            captaincy: (p.id === baseline.captainId ? 'captain' : p.id === baseline.vcId ? 'vice_captain' : 'normal') as CaptaincyRole,
          }));
        setPreviousLockedXI(baselineXI);

        // Transfers already committed FOR this specific (not-yet-locked) match
        // — the rows checkAndLogTransfers writes with match_id = currentMatchId
        // when the XI was last saved. These are the swaps that will "take"
        // once this match's transfer window closes.
        const { count: lockedPendingCount } = await supabase
          .from('user_transfers')
          .select('id', { count: 'exact', head: true })
          .eq('squad_id', squad.id)
          .eq('match_id', currentMatchId);

        let pending = lockedPendingCount ?? 0;

        // Pre-lock fallback: nothing's logged in user_transfers yet if this
        // match hasn't locked (web's saveXI only writes squad_draft_xi until
        // the lock-matches cron fires at start_time — see teamStore.ts Path
        // A0). Diff the draft against the locked baseline the same way
        // checkAndLogTransfers will once it actually locks, so "pending"
        // shows up here too instead of only after the fact.
        if (pending === 0) {
          const { data: draft } = await supabase
            .from('squad_draft_xi')
            .select('player_ids, target_match_id')
            .eq('squad_id', squad.id)
            .maybeSingle();
          if (draft?.target_match_id === currentMatchId && draft.player_ids?.length) {
            const prevSet = new Set(baseline.playerIds);
            const draftIds = draft.player_ids as string[];
            const playersOut = baseline.playerIds.filter(id => !draftIds.includes(id));
            const playersIn  = draftIds.filter(id => !prevSet.has(id));
            pending = Math.min(playersOut.length, playersIn.length);
          }
        }

        setPendingTransfers(pending);
        setRemainingAfterLock(cap !== null ? Math.max(0, cap - used - pending) : null);
      } else {
        setTransferInfo({ used: 0, total: config.total_transfers_allowed, free: config.free_transfers_per_match ?? 1 });
        setPendingTransfers(0);
        setRemainingAfterLock(null);
        setPreviousLockedXI([]);
      }
    } catch (e) {
      console.warn('[MyXI] loadTransfers failed', e);
    }
  }

  const handleConfirm = async () => {
    if (!activeContext) return;

    if (!currentMatchId) {
      Alert.alert('No Match', 'Could not find an upcoming match to save XI for.');
      return;
    }

    // Stay on the confirm modal (with its own spinner — see `saving` prop)
    // for the whole save instead of dismissing it up front. It used to close
    // immediately on tap, dropping the user back onto My XI to stare at an
    // unchanged screen for however long saveXI took, with no indication
    // anything was happening until the toast/alert finally arrived. Now the
    // modal only closes once we actually know whether the save succeeded,
    // so the screen transition and the result land together.
    setConfirmSaving(true);
    try {
      const saveResult = await saveXI({
        matchId:     currentMatchId,
        contestId:   activeContext.contestId,
        contestType: activeContext.contestType,
      });

      if (saveResult.error) {
        // Leave the modal open so the user can see what happened and retry
        // right away — the C/VC picks and summary they already made are
        // still right there instead of having to reopen the whole flow.
        Alert.alert('Save Failed', saveResult.error);
        return;
      }

      // Save succeeded — now it's safe to close the confirm modal and land
      // back on My XI together with the confirmation, instead of before it.
      setConfirmOpen(false);

      // What was just saved IS now the saved baseline — re-arm "Revert to
      // Saved" as a no-op (greyed) until the user edits again.
      setSavedSnapshot(snapshotFromSelected(selected));

      // Commit any staged booster pick now that the XI save succeeded — this
      // is the one place a booster choice actually gets written to
      // user_booster_activations (mirrors web's saveSlXiHandler step 2b).
      // Picking a booster pill never wrote to the DB directly; see
      // boosterStore.selectBooster.
      //
      // IMPORTANT: pass saveResult.squadId/matchId — the REAL ids saveXI just
      // used, after any internal redirect (to the next unlocked match) or
      // squad creation (first-ever save) — instead of letting commitPending
      // fall back to boosterStore's own cached _squadId/_matchId. Those can be
      // stale relative to what was just actually saved; trusting them instead
      // of the fresh result is exactly what silently dropped ShooterXI's Team
      // Double booster (looked picked, "XI saved" toast showed, nothing ever
      // written to user_booster_activations for the match that really locked).
      let boosterNote = '';
      try {
        const result = await commitPending(saveResult.squadId ?? undefined, saveResult.matchId ?? undefined);
        if (result?.changed) boosterNote = ` ${result.message}`;
      } catch (e: any) {
        Alert.alert('Booster save failed', e?.message ?? 'Please try again.');
      }

      showToast(`✓  XI saved for ${activeContext.leagueName}${boosterNote}`);
    } finally {
      setConfirmSaving(false);
    }
    // Re-load transfers + boosters — first save creates the squad, so
    // squadId wasn't set yet; this picks it up and refreshes booster state.
    loadTransfers();
  };

  const isDaily  = activeContext?.contestType === 'daily';
  const isSL     = activeContext?.contestType === 'sl' || activeContext?.contestType === 'private';
  const hasSquad = selected.length > 0;

  // Wildcard OR Free Hit suspends the season transfer-count cap for this
  // match — mirrors web's slTransferCapSuspended() (pending-or-committed,
  // not just committed, so the messaging updates the instant you pick the
  // booster, before Save XI). Transfers logged while either is active don't
  // draw against the season budget, so showing them as "N pending" (which
  // implies they'll count once locked) is actively misleading — the info
  // pill/note below switch to "free of cost" wording when this is true.
  const suspendingBooster  = boosters.find(b => (b.id === 'wildcard' || b.id === 'free_hit') &&
    (b.status === 'active' || b.status === 'pending'));
  const transferCapSuspended = isSL && !!suspendingBooster;

  // Genuinely uncapped this match — either a booster suspends the cap, or
  // transferInfo.total resolved to null (no budget configured, or this is
  // the playoff opener carved out by playoff_first_match_unlimited). Distinct
  // from transferInfo === null (not loaded yet), which falls through to the
  // normal "pending" wording until the real value arrives.
  const isUncappedTransfers = transferCapSuspended || transferInfo?.total === null;

  // Full clarifying sentence for pending transfers — same wording web's
  // renderSlXferInfoBar() uses ("N pending transfers · X remaining after
  // lock. Counts when M2 starts"). Used to live in its own always-visible
  // row under the info strip; that row was one of the things squishing the
  // pitch. Now it's folded into the Xfers pill (short form) and shown in
  // full via a tap — see the pill's onPress below.
  const pendingDetailText = transferCapSuspended
    ? `${pendingTransfers} free change${pendingTransfers !== 1 ? 's' : ''} this match (${suspendingBooster?.name ?? 'booster'} active)`
      + (countdown && countdown !== 'Locked' ? ` — locks in ${countdown}` : ' — locks with this match')
    : transferInfo?.total === null
      ? `${pendingTransfers} free transfer${pendingTransfers !== 1 ? 's' : ''}`
        + (countdown && countdown !== 'Locked' ? ` — locks in ${countdown}` : ' — locks with this match')
      : `${pendingTransfers} pending transfer${pendingTransfers !== 1 ? 's' : ''}`
        + (remainingAfterLock !== null ? ` · ${remainingAfterLock} remaining after lock` : '')
        + '.'
        + (currentMatchLabel ? ` Counts when ${currentMatchLabel} starts.` : '');

  // ── Revert button gating (SL/private only) ────────────────────────────────
  // "Revert to Locked": there's an actual saved-but-not-yet-locked transfer
  // to undo — compare the SAVED snapshot directly against previousLockedXI
  // (matches web's lastSavedXI-vs-lastLockedXI check), rather than trusting
  // pendingTransfers (a count of user_transfers rows). That table is
  // deliberately left unwritten when Wildcard/Free Hit is active — those
  // transfers are free, so checkAndLogTransfers skips logging them — which
  // made this pill vanish under either booster even though the squad still
  // genuinely differed from what's locked. Direct snapshot comparison has
  // no such blind spot.
  const showRevertLocked = isSL && !!savedSnapshot && previousLockedXI.length > 0 &&
    !snapshotsEqual(savedSnapshot, snapshotFromSelected(previousLockedXI));
  // "Revert to Saved": only a real change to discard. Shown greyed out
  // rather than hidden when it would be a no-op, alongside Revert to
  // Locked, per the agreed two-pill layout.
  //
  // Requires savedSnapshot !== null explicitly — snapshotsEqual() treats
  // either side being null as "different" (by design, so showRevertLocked
  // doesn't fire on an unloaded previousLockedXI), which meant this flag
  // read `true` for the one render between mount and the load effect's
  // setSavedSnapshot() call, since savedSnapshot starts null. That's the
  // "lights up, then deactivates immediately" flash: real bug, not a
  // rendering glitch — this condition was live and enabled for a frame
  // before the actual saved baseline arrived to correct it.
  const hasUnsavedChanges = isSL && savedSnapshot !== null &&
    !snapshotsEqual(snapshotFromSelected(selected), savedSnapshot);
  const showRevertColumn  = isSL && (showRevertLocked || hasUnsavedChanges);

  const fabLabel = (() => {
    if (isDaily)   return hasSquad ? '✎  Edit XI' : '+ Pick XI';
    if (!hasSquad) return '+ Pick Your Squad';
    return '⇄  Make Transfers';
  })();

  const fabColors = (() => {
    if (isSL && hasSquad) return G.fabXfer;
    if (validation.valid && hasSquad) return G.fabReady;
    return G.fabPick;
  })();

  const modalTitle = (() => {
    if (isDaily)   return hasSquad ? 'Edit XI' : 'Pick XI';
    if (!hasSquad) return 'Pick Your Squad';
    return 'Make Transfers';
  })();

  useEffect(() => {
    if (route.params?.openPicker && !autoOpenHandled.current) {
      autoOpenHandled.current = true;
      openPicker();
    }
  }, [route.params]);

  useEffect(() => {
    if (!route.params?.openPicker) {
      autoOpenHandled.current = false;
    }
  }, [route.params?.openPicker]);

  const handleReset = () => {
    if (isDaily) {
      Alert.alert('Reset XI', 'Remove all players from your team?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: resetXI },
      ]);
    } else {
      // SL / private — revert to last saved XI
      if (!currentMatchId || !activeContext) return;
      Alert.alert('Revert to Saved', 'Discard changes and reload your last saved XI?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revert',
          onPress: async () => {
            const err = await loadSavedXI(currentMatchId, activeContext.contestId, activeContext.contestType);
            if (err) {
              Alert.alert('Could not revert', err);
            } else {
              discardPending(); // also drop any staged-not-saved booster pick
              setSavedSnapshot(snapshotFromSelected(useTeamStore.getState().selected));
            }
          },
        },
      ]);
    }
  };

  // "Revert to Locked" — discards an already-saved transfer entirely (not
  // just unsaved on-screen edits), rolling back to the squad's currently
  // scored/locked XI. Distinct from "Revert to Saved" above, which only
  // undoes edits made since the last save. Mirrors web's #slRevertLockedBtn
  // handler: restore previousLockedXI, stage-and-commit removal of any
  // booster committed for this match, then persist via the normal saveXI
  // path (mobile has no separate draft/lock step — save IS the write to
  // user_match_xi — so "reverting" here means writing the locked team back
  // over the saved-but-not-yet-locked one).
  const handleRevertToLocked = () => {
    if (!currentMatchId || !activeContext) return;
    const committedBooster = boosters.find(b => b.status === 'active');
    const boosterNote = committedBooster
      ? `\n\n${committedBooster.name} is currently active for the next match and will also be removed.`
      : '';
    Alert.alert(
      'Revert to Locked',
      `Discard your saved transfer and roll back to your currently locked XI?${boosterNote}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revert',
          style: 'destructive',
          onPress: async () => {
            restoreXI(previousLockedXI);
            // Stage the committed booster's removal (selectBooster toggles an
            // already-effective pick off) — nothing is written to Supabase
            // until commitPending() below, same as a normal save.
            if (committedBooster) selectBooster(committedBooster.id);

            const saveResult = await saveXI({
              matchId:     currentMatchId,
              contestId:   activeContext.contestId,
              contestType: activeContext.contestType,
            });
            if (saveResult.error) {
              Alert.alert('Revert failed', saveResult.error);
              return;
            }

            // Explicitly clear this match's transfer log rather than trusting
            // saveXI's internal diff (restored playerIds vs. its own freshly
            // recomputed baseline) to land on exactly zero. Reverting to
            // locked means "no difference from what's locked" by definition
            // — there should be nothing pending for this match, full stop.
            // This is what was missing: the diff-based approach left "N
            // pending" showing after a revert whenever it didn't resolve to
            // a clean zero.
            if (saveResult.squadId && saveResult.matchId) {
              const { error: clearErr } = await supabase
                .from('user_transfers')
                .delete()
                .eq('squad_id', saveResult.squadId)
                .eq('match_id', saveResult.matchId);
              if (clearErr) {
                console.warn('[MyXI] revert-to-locked: transfer log clear failed (non-fatal):', clearErr.message);
              }
            }
            setPendingTransfers(0);

            let boosterMsg = '';
            try {
              const result = await commitPending(saveResult.squadId ?? undefined, saveResult.matchId ?? undefined);
              if (result?.changed) boosterMsg = ` ${result.message}`;
            } catch (e: any) {
              Alert.alert('Booster removal failed', e?.message ?? 'Please try again.');
            }

            setSavedSnapshot(snapshotFromSelected(previousLockedXI));
            showToast(`Reverted to locked XI.${boosterMsg}`);
            loadTransfers();
          },
        },
      ],
    );
  };

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: signOut },
    ]);
  };

  return (
    <View style={styles.root}>
      {/* Full-screen gradient background */}
      <LinearGradient colors={G.bg} style={StyleSheet.absoluteFill} />

      <SafeAreaView style={styles.safe} edges={['top']}>

        {/* ── Top bar ─────────────────────────────────────────────────── */}
        <LinearGradient colors={G.header} style={styles.topBar}>
          <View style={styles.topBarLeft}>
            {/* Brand dot */}
            <View style={styles.brandDot} />
            <Text style={styles.topBarTitle}>My XI</Text>
            {activeContext && (
              <Pressable
                style={styles.contextChip}
                onPress={() => setContext(null as any)}
              >
                <Text style={styles.contextChipText} numberOfLines={1}>
                  {activeContext.leagueName} ▾
                </Text>
              </Pressable>
            )}
          </View>
          {user && (
            <Pressable style={styles.profileChip} onPress={handleSignOut}>
              <Text style={styles.profileChipText} numberOfLines={1}>
                {teamName ?? user.email?.split('@')[0] ?? ''}
              </Text>
            </Pressable>
          )}
        </LinearGradient>

        {/* ── Info strip: countdown + transfers ────────────────────────── */}
        {(countdown || currentMatchLabel || (activeContext && activeContext.contestType !== 'daily')) && (
          <View style={styles.infoStrip}>
            {/* Match label — shown first */}
            {currentMatchLabel ? (
              <View style={styles.infoPill}>
                <Text style={styles.infoPillIcon}>🏏</Text>
                <Text style={styles.infoPillValue} numberOfLines={1}>{currentMatchLabel}</Text>
              </View>
            ) : null}

            {/* Countdown — dropped the "Locks in " label and bumped the clock
                icon up a couple points so it still reads as a countdown on
                its own. Shaving those words off is what lets this pill sit
                on the same row as the match label and Xfers pills instead
                of wrapping to a second row (same squished-pitch cause as
                the other info-strip/action-row fixes). */}
            {countdown ? (
              <View style={styles.infoPill}>
                <Text style={[styles.infoPillIcon, styles.clockIcon]}>⏱</Text>
                <Text style={[
                  styles.infoPillValue,
                  countdown === 'Locked' && { color: C.bad },
                ]}>
                  {countdown}
                </Text>
              </View>
            ) : null}

            {/* Transfers left — SL / private only. Pending count (transfers
                already saved for the upcoming match but not yet locked)
                used to be a second pill right next to this one — same icon,
                redundant. Now it's folded into this pill's value as a
                " · N pending" suffix. The full clarifying sentence (locks
                in / remaining after lock / counts when the next match
                starts) no longer sits in its own always-visible row either
                — tap the pill to see it. Both changes were about giving
                CricketPitch back the vertical space those extra rows were
                eating into. */}
            {activeContext && activeContext.contestType !== 'daily' && (
              <Pressable
                style={styles.infoPill}
                disabled={pendingTransfers === 0}
                onPress={() => Alert.alert(isUncappedTransfers ? 'Free transfers' : 'Pending transfers', pendingDetailText)}
              >
                <Text style={styles.infoPillIcon}>{pendingTransfers > 0 && isUncappedTransfers ? '⚡' : '⇄'}</Text>
                <Text style={styles.infoPillLabel}>Xfers </Text>
                <Text style={styles.infoPillValue}>
                  {isFirstMatch
                    ? '∞'
                    : transferCapSuspended
                      ? `⚡ ${suspendingBooster?.name ?? 'Free'}`
                      : transferInfo === null
                        ? '…'
                        : transferInfo.total === null
                          ? 'Unlimited'
                          : `${Math.max(0, transferInfo.total - transferInfo.used)}/${transferInfo.total}`
                  }
                  {pendingTransfers > 0 ? ` · ${pendingTransfers} ${isUncappedTransfers ? 'free' : 'pending'}` : ''}
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {/* No contest selected */}
        {!activeContext && (
          <ContestPicker onSelect={(ctx) => {
            handleContestSelect(ctx, !!route.params?.openPicker);
          }} />
        )}

        {activeContext && <>

          {/* Boosters — SL / private leagues only */}
          <View ref={boostersBarRef}>
            <BoostersBar
              contestType={activeContext?.contestType}
              squadId={squadId}
              matchId={currentMatchId}
              onStaged={showToast}
              previousLockedXI={previousLockedXI}
              restoreXI={restoreXI}
            />
          </View>

          {/* Budget bar */}
          <BudgetBar
            creditsSpent={creditsSpent}
            creditsLeft={creditsLeft}
            playerCount={selected.length}
          />

          {/* Role stats */}
          <RoleStats roleCounts={roleCounts} />

          {/* Validation messages */}
          {(validation.errors.length > 0 || validation.warnings.length > 0) && (
            <View style={styles.messages}>
              {validation.errors.map((msg, i) => (
                <View key={`e${i}`} style={[styles.msg, styles.msgError]}>
                  <Text style={styles.msgErrorText}>⚠ {msg}</Text>
                </View>
              ))}
              {validation.warnings.map((msg, i) => (
                <View key={`w${i}`} style={[styles.msg, styles.msgWarn]}>
                  <Text style={styles.msgWarnText}>• {msg}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Squad pitch or empty state */}
          {selected.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>{isSL ? '🏅' : '🏏'}</Text>
              <Text style={styles.emptyTitle}>
                {isSL ? 'Pick your squad' : 'Your XI is empty'}
              </Text>
              <Text style={styles.emptySub}>
                {isSL
                  ? 'Build your season-long Team — you can make transfers before each match.'
                  : `Pick fresh for today's match. Your XI locks at toss time.`}
              </Text>
              <Pressable onPress={openPicker} style={styles.emptyBtnWrap}>
                <LinearGradient colors={G.emptyBtn} style={styles.emptyPickBtn} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                  <Text style={styles.emptyPickBtnText}>{fabLabel}</Text>
                </LinearGradient>
              </Pressable>
            </View>
          ) : (
            <View style={styles.pitchWrapper}>
              <CricketPitch
                players={selected}
                onSetCaptaincy={(id, role) => setCaptaincy(id, role)}
                onRemove={(id) => removePlayer(id)}
              />

              {/* Status strip — SL/private used to split into two columns
                  (Make Transfers spans both rows on the left; Revert to
                  Saved / Revert to Locked stacked as pills on the right).
                  That stack made the strip two rows tall, which ate into
                  CricketPitch's flex:1 share of the screen and squished the
                  pitch — worst right after a team change, since that's
                  exactly when both revert pills are live. Now everything —
                  the status pill and both reverts — sits in a single row,
                  so the strip stays one row tall regardless of how many
                  pills are showing. Daily is unaffected; it never had a
                  revert column. */}
              {isSL && showRevertColumn ? (
                <LinearGradient colors={G.statusBg} style={[styles.statusStrip, styles.statusStripRow]}>
                  <Pressable onPress={openPicker} style={styles.actionPillRow}>
                    <Text style={styles.actionPillRowText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                      {fabLabel}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.revertPillRow, !hasUnsavedChanges && styles.revertPillDisabled]}
                    onPress={handleReset}
                    disabled={!hasUnsavedChanges}
                  >
                    <Text
                      style={[styles.revertPillText, !hasUnsavedChanges && styles.revertPillTextDisabled]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.7}
                    >
                      Revert to saved
                    </Text>
                  </Pressable>
                  {showRevertLocked && (
                    <Pressable style={styles.revertPillRow} onPress={handleRevertToLocked}>
                      <Text style={styles.revertPillText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                        Revert to locked
                      </Text>
                    </Pressable>
                  )}
                </LinearGradient>
              ) : (
                <LinearGradient colors={G.statusBg} style={styles.statusStrip}>
                  <Pressable onPress={openPicker} style={styles.actionPill}>
                    <Text style={styles.actionPillText}>{fabLabel}</Text>
                  </Pressable>
                  {isDaily && (
                    <Pressable style={styles.resetBtn} onPress={handleReset}>
                      <Text style={styles.resetBtnText}>Reset XI</Text>
                    </Pressable>
                  )}
                </LinearGradient>
              )}
            </View>
          )}

        </> /* end activeContext block */}

        {/* Confirm XI Modal */}
        {activeContext && (
          <ConfirmXIModal
            visible={confirmOpen}
            contestName={activeContext.leagueName}
            current={selected}
            // SL/private: diff against the squad's true previous LOCKED XI —
            // the same baseline checkAndLogTransfers counts transfers
            // against — so the IN/OUT list here always matches what actually
            // gets logged on Save. Daily has no transfer concept, so it
            // keeps diffing against the picker-open snapshot (just shows
            // what changed this session).
            previous={isDaily ? snapshot : previousLockedXI}
            // Effective (pending-or-committed) booster for this match — same
            // single-source-of-truth lookup CricketPitch uses, so the Review
            // & Save banner always agrees with what the pitch/stat tile show.
            activeBoosterId={boosters.find(b => b.status === 'active' || b.status === 'pending')?.id ?? null}
            saving={confirmSaving}
            onSetCaptaincy={(id, role) => setCaptaincy(id, role)}
            onRemove={(id) => removePlayer(id)}
            onConfirm={handleConfirm}
            onEditMore={handleEditMore}
            onCancel={async () => {
              setConfirmOpen(false);
              setPickerOpen(false);
              await revertXI();
              navigation.navigate('Home');
            }}
          />
        )}

        {/* ── Save confirmation toast ──────────────────────────────────── */}
        {toastMsg !== '' && (
          <Animated.View style={[styles.toast, { opacity: toastOpacity }]} pointerEvents="none">
            <Text style={styles.toastText}>{toastMsg}</Text>
          </Animated.View>
        )}

        {/* Player Picker Modal */}
        <Modal
          visible={pickerOpen}
          animationType="none"
          presentationStyle="pageSheet"
          onRequestClose={handlePickerDone}
        >
          <View style={styles.modalRoot}>
            <LinearGradient colors={G.bg} style={StyleSheet.absoluteFill} />
            <SafeAreaView style={styles.modalSafe} edges={['top']}>
              {/* Modal header */}
              <LinearGradient colors={G.modalHdr} style={styles.modalHeader}>
                <Pressable onPress={handlePickerCancel} style={styles.cancelBtn}>
                  <Text style={styles.cancelBtnText}>✕</Text>
                </Pressable>
                <View style={styles.modalHeaderLeft}>
                  <Text style={styles.modalTitle} numberOfLines={1}>{modalTitle}</Text>
                  {activeContext && (
                    <Text style={styles.modalSubtitle} numberOfLines={1}>
                      {activeContext.leagueName}
                    </Text>
                  )}
                </View>
                <Pressable onPress={handlePickerDone} style={styles.doneBtnWrap}>
                  <LinearGradient colors={G.doneBtn} style={styles.doneBtn} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                    <Text style={styles.doneBtnText}>Next  →</Text>
                  </LinearGradient>
                </Pressable>
              </LinearGradient>

              {/* Picker content — the "My XI" / Schedule toggle buttons now
                  render inside PlayerPickerScreen itself, on its own context
                  banner row ("M8 · JK vs TKR" etc.) instead of up here next
                  to Cancel/Title/Next. That row had room for them without
                  squeezing the title down to "Make Tra…"; this one didn't.
                  Open/close state and the mutual-exclusivity toggle logic
                  stay owned here regardless — only the buttons moved. */}
              <PlayerPickerScreen
                scheduleOpen={scheduleOpen}
                onCloseSchedule={() => setScheduleOpen(false)}
                onToggleSchedule={handleToggleSchedule}
                myXIOpen={myXIOpen}
                onCloseMyXI={() => setMyXIOpen(false)}
                onToggleMyXI={handleToggleMyXI}
              />
            </SafeAreaView>
          </View>
        </Modal>

      </SafeAreaView>

      {/* Name-your-squad prompt — shown right after picking a contest that
          doesn't have a squad yet (see handleContestSelect above) */}
      <NameSquadModal
        visible={!!pendingContest}
        contestName={pendingContest?.ctx.leagueName ?? ''}
        initialName={teamName ?? ''}
        submitting={namingSubmitting}
        error={namingError}
        onConfirm={handleConfirmSquadName}
      />

      {/* First-visit Boosters tip — see onboardingStore/Coachmark. */}
      <Coachmark
        visible={boostersTipActive && !!boostersTipTarget}
        target={boostersTipTarget}
        variant="tip"
        chipLabel="Quick tip"
        title="Boosters"
        body="Boosters give your squad a one-time edge — extra points, a free hit, or a bench swap. Tap one to stage it, then Save XI to lock it in."
        primaryLabel="Got it →"
        onPrimary={finishBoostersTip}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#F5F0E0',
  },
  safe: {
    flex: 1,
  },

  // Top bar
  topBar: {
    flexDirection:    'row',
    alignItems:       'center',
    justifyContent:   'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical:  spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(28,31,38,0.1)',
  },
  topBarLeft: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
    flex:          1,
  },
  brandDot: {
    width:           8,
    height:          8,
    borderRadius:    4,
    backgroundColor: '#C9A84C',
    shadowColor:     '#C9A84C',
    shadowOffset:    { width: 0, height: 0 },
    shadowOpacity:   0.9,
    shadowRadius:    6,
  },
  topBarTitle: {
    color:      C.text,
    fontSize:   fontSize.lg,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  contextChip: {
    backgroundColor:   'rgba(28,31,38,0.07)',
    borderRadius:      radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical:   3,
    borderWidth:       1.5,
    borderColor:       'rgba(28,31,38,0.22)',
    maxWidth:          140,
  },
  contextChipText: {
    color:      C.text,
    fontSize:   fontSize.xs,
    fontWeight: '700',
  },
  profileChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical:   spacing.xs,
    borderRadius:      radius.md,
    backgroundColor:   'rgba(28,31,38,0.06)',
    borderWidth:       1,
    borderColor:       'rgba(28,31,38,0.15)',
    maxWidth:          130,
  },
  profileChipText: {
    color:      C.muted,
    fontSize:   fontSize.xs,
    fontWeight: '600',
  },

  // Messages
  messages: {
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm,
    gap:               4,
  },
  msg: {
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm - 2,
    borderRadius:      radius.sm,
    borderLeftWidth:   3,
  },
  msgError:     { backgroundColor: 'rgba(192,57,43,0.08)', borderLeftColor: C.bad },
  msgErrorText: { color: C.bad, fontSize: fontSize.sm },
  msgWarn:      { backgroundColor: 'rgba(201,168,76,0.1)', borderLeftColor: C.gold },
  msgWarnText:  { color: C.gold, fontSize: fontSize.sm },

  // Pitch wrapper
  pitchWrapper: {
    flex: 1,
  },

  // Empty state
  emptyContainer: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            spacing.md,
    padding:        spacing.xl,
  },
  emptyIcon:  { fontSize: 52 },
  emptyTitle: { color: C.text, fontSize: fontSize.xl, fontWeight: '700' },
  emptySub:   { color: C.muted, fontSize: fontSize.base, textAlign: 'center', lineHeight: 22 },
  emptyBtnWrap: { marginTop: spacing.sm },
  emptyPickBtn: {
    borderRadius:    radius.full,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  emptyPickBtnText: { color: '#fff', fontSize: fontSize.base, fontWeight: '700' },

  // Status strip
  statusStrip: {
    flexDirection:    'row',
    flexWrap:         'wrap',
    alignItems:       'center',
    justifyContent:   'center',
    gap:              spacing.sm,
    paddingVertical:  spacing.sm,
    paddingHorizontal: spacing.lg,
    borderTopWidth:   1,
    borderTopColor:   'rgba(28,31,38,0.1)',
  },
  actionPill: {
    backgroundColor:   '#1C1F26',
    borderRadius:      radius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm + 2,
  },
  actionPillText: { color: '#fff', fontSize: fontSize.base, fontWeight: '800', letterSpacing: 0.3 },
  resetBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical:   4,
    borderWidth:       1.5,
    borderColor:       'rgba(192,57,43,0.65)',
    borderRadius:      radius.full,
  },
  resetBtnText: { color: C.bad, fontSize: fontSize.xs, fontWeight: '700' },

  // Single-row status strip (SL/private, when there's something to revert):
  // Make Transfers + Revert to Saved + Revert to Locked all sit side by
  // side in one row instead of stacking the reverts into a second row.
  // Keeping this one row tall (vs. the old two-row split) is what frees up
  // the vertical space CricketPitch needs — see the comment above where
  // this is used. Pills share the row via flex so they always fit
  // regardless of how many are showing; text shrinks with
  // adjustsFontSizeToFit rather than wrapping or clipping.
  statusStripRow: {
    flexWrap:   'nowrap',
    alignItems: 'stretch',
    gap:        6,
  },
  actionPillRow: {
    flex:              1.3,
    backgroundColor:   '#1C1F26',
    borderRadius:      radius.md,
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: spacing.sm,
    paddingVertical:   spacing.sm,
  },
  actionPillRowText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800', letterSpacing: 0.2 },
  revertPillRow: {
    flex:              1,
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: 4,
    paddingVertical:   spacing.sm,
    borderWidth:       1.5,
    borderColor:       'rgba(192,57,43,0.65)',
    borderRadius:      radius.md,
  },
  revertPillDisabled: {
    borderColor:     'rgba(122,112,96,0.3)',
    backgroundColor: 'rgba(122,112,96,0.06)',
  },
  revertPillText: { color: C.bad, fontSize: fontSize.sm, fontWeight: '700', textAlign: 'center' },
  revertPillTextDisabled: { color: C.muted },
  transferBar: {
    paddingHorizontal: spacing.md,
    paddingVertical:   4,
    backgroundColor:   'rgba(201,168,76,0.08)',
    borderRadius:      radius.full,
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.25)',
  },
  transferBarWarn: {
    backgroundColor: 'rgba(192,57,43,0.08)',
    borderColor:     'rgba(192,57,43,0.22)',
  },
  transferBarText: { color: C.muted, fontSize: fontSize.xs, textAlign: 'center' },


  // Save toast
  toast: {
    position:          'absolute',
    bottom:            spacing.xl + 8,
    alignSelf:         'center',
    backgroundColor:   '#1C1F26',
    borderRadius:      radius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm + 2,
    shadowColor:       '#000',
    shadowOffset:      { width: 0, height: 4 },
    shadowOpacity:     0.22,
    shadowRadius:      8,
    elevation:         8,
    zIndex:            999,
  },
  toastText: {
    color:      '#fff',
    fontSize:   fontSize.base,
    fontWeight: '700',
    letterSpacing: 0.2,
  },

  // Modal
  modalRoot: {
    flex:            1,
    backgroundColor: '#F5F0E0',
  },
  modalSafe: {
    flex: 1,
  },
  modalHeader: {
    flexDirection:    'row',
    alignItems:       'center',
    justifyContent:   'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical:  spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(201,168,76,0.25)',
  },
  modalHeaderLeft: { flex: 1, flexShrink: 1, gap: 2 },
  modalTitle:    { color: C.text, fontSize: fontSize.lg, fontWeight: '800' },
  modalSubtitle: { color: C.muted, fontSize: fontSize.sm },
  cancelBtn: {
    width:           34,
    height:          34,
    borderRadius:    radius.md,
    backgroundColor: 'rgba(28,31,38,0.06)',
    borderWidth:     1.5,
    borderColor:     'rgba(28,31,38,0.22)',
    alignItems:      'center',
    justifyContent:  'center',
    marginRight:     spacing.sm,
  },
  cancelBtnText: {
    color:      C.text,
    fontSize:   fontSize.base,
    fontWeight: '700',
  },
  doneBtnWrap: {},
  doneBtn: {
    borderRadius:    radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm,
  },
  doneBtnText: { color: '#fff', fontSize: fontSize.base, fontWeight: '700' },
  // scheduleBtn/myxiBtn styles moved to PlayerPickerScreen.tsx — the buttons
  // themselves now render on its context banner row, not this header.

  // Info strip (countdown + transfers) — wraps when there are 4+ pills
  infoStrip: {
    flexDirection:     'row',
    alignItems:        'center',
    flexWrap:          'wrap',
    gap:               spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical:   spacing.xs,
    backgroundColor:   'rgba(0,0,0,0.03)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(28,31,38,0.08)',
  },
  infoPill: {
    flexDirection:     'row',
    alignItems:        'center',
    flexShrink:        1,
    backgroundColor:   'rgba(255,255,255,0.6)',
    borderWidth:       1,
    borderColor:       'rgba(28,31,38,0.12)',
    borderRadius:      radius.full,
    paddingHorizontal: 6,
    paddingVertical:   2,
    gap:               3,
  },
  infoPillIcon:  { fontSize: 10 },
  infoPillLabel: { fontSize: fontSize.xs, color: C.muted },
  infoPillValue: { fontSize: fontSize.xs, fontWeight: '700', color: C.text },
  // Slightly bigger than the other pill icons — stands in for the "Locks
  // in " label that was dropped from the countdown pill, so it still
  // reads as a countdown at a glance.
  clockIcon: { fontSize: 13 },
});
