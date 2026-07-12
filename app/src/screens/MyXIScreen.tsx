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
import { useNavigation } from '@react-navigation/native';
import { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { RootTabParamList, SelectedPlayer, CaptaincyRole } from '../types';
import { useTeamStore, RULES } from '../store/teamStore';
import { useAuthStore } from '../store/authStore';
import { useContestStore } from '../store/contestStore';
import { useBoosterStore } from '../store/boosterStore';
import CricketPitch from '../components/CricketPitch';
import ConfirmXIModal from '../components/ConfirmXIModal';
import BudgetBar from '../components/BudgetBar';
import BoostersBar from '../components/BoostersBar';
import RoleStats from '../components/RoleStats';
import ContestPicker from '../components/ContestPicker';
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
  } = useTeamStore();

  const [pickerOpen, setPickerOpen]       = useState(false);
  const [confirmOpen, setConfirmOpen]     = useState(false);
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

  const handlePickerDone = () => {
    setPickerOpen(false);
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
  // Transfers already committed for the CURRENT (not-yet-locked) match —
  // i.e. swaps made against the squad's last locked XI that will take effect
  // once this match's transfer window closes. Read straight from
  // user_transfers (match_id = currentMatchId), the same rows
  // checkAndLogTransfers writes on Save — so this count always matches what
  // was actually logged, not a UI-only diff.
  const [pendingTransfers, setPendingTransfers] = useState(0);
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

        // Transfers already committed FOR this specific (not-yet-locked) match
        // — the rows checkAndLogTransfers writes with match_id = currentMatchId
        // when the XI was last saved. These are the swaps that will "take"
        // once this match's transfer window closes.
        const { count: pendingCount } = await supabase
          .from('user_transfers')
          .select('id', { count: 'exact', head: true })
          .eq('squad_id', squad.id)
          .eq('match_id', currentMatchId);
        setPendingTransfers(pendingCount ?? 0);

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
      } else {
        setTransferInfo({ used: 0, total: config.total_transfers_allowed, free: config.free_transfers_per_match ?? 1 });
        setPendingTransfers(0);
        setPreviousLockedXI([]);
      }
    } catch (e) {
      console.warn('[MyXI] loadTransfers failed', e);
    }
  }

  const handleConfirm = async () => {
    setConfirmOpen(false);
    if (!activeContext) return;

    if (!currentMatchId) {
      Alert.alert('No Match', 'Could not find an upcoming match to save XI for.');
      return;
    }

    const saveResult = await saveXI({
      matchId:     currentMatchId,
      contestId:   activeContext.contestId,
      contestType: activeContext.contestType,
    });

    if (saveResult.error) {
      Alert.alert('Save Failed', saveResult.error);
      return;
    }

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

            {/* Countdown */}
            {countdown ? (
              <View style={styles.infoPill}>
                <Text style={styles.infoPillIcon}>⏱</Text>
                <Text style={styles.infoPillLabel}>Locks in </Text>
                <Text style={[
                  styles.infoPillValue,
                  countdown === 'Locked' && { color: C.bad },
                ]}>
                  {countdown}
                </Text>
              </View>
            ) : null}

            {/* Transfers left — SL / private only */}
            {activeContext && activeContext.contestType !== 'daily' && (
              <View style={styles.infoPill}>
                <Text style={styles.infoPillIcon}>⇄</Text>
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
                </Text>
              </View>
            )}

            {/* Pending — transfers already saved for the upcoming match that
                haven't locked yet (i.e. made against the last locked XI).
                Wording switches when Wildcard/Free Hit is active — those
                transfers are free of cost and don't draw against the season
                cap, so "pending" (implying they'll be charged) would be
                misleading. */}
            {activeContext && activeContext.contestType !== 'daily' && pendingTransfers > 0 && (
              <View style={styles.infoPill}>
                <Text style={styles.infoPillIcon}>{transferCapSuspended ? '⚡' : '🔄'}</Text>
                <Text style={styles.infoPillValue}>
                  {transferCapSuspended ? `${pendingTransfers} free` : `${pendingTransfers} pending`}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Clarifying note for pending transfers — shown until the match locks */}
        {activeContext && activeContext.contestType !== 'daily' && pendingTransfers > 0 && (
          <View style={styles.pendingNote}>
            <Text style={styles.pendingNoteText}>
              {transferCapSuspended
                ? `${pendingTransfers} change${pendingTransfers !== 1 ? 's' : ''} this match — free of cost and uncapped (${suspendingBooster?.name ?? 'booster'} active)`
                : `${pendingTransfers} transfer${pendingTransfers !== 1 ? 's' : ''} made from your last locked XI`}
              {countdown && countdown !== 'Locked' ? ` — locks in ${countdown}` : ' — locks with this match'}
            </Text>
          </View>
        )}

        {/* No contest selected */}
        {!activeContext && (
          <ContestPicker onSelect={(ctx) => {
            setContext(ctx);
            if (route.params?.openPicker) openPicker();
          }} />
        )}

        {activeContext && <>

          {/* Boosters — SL / private leagues only */}
          <BoostersBar
            contestType={activeContext?.contestType}
            squadId={squadId}
            matchId={currentMatchId}
            onStaged={showToast}
            previousLockedXI={previousLockedXI}
            restoreXI={restoreXI}
          />

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

              {/* Status strip — SL/private splits into two columns (Make
                  Transfers spans both rows on the left; Revert to Saved /
                  Revert to Locked stack as small pills on the right, only
                  when there's actually something to revert). Daily keeps the
                  original single-row layout — it has no locked/saved split. */}
              {isSL && showRevertColumn ? (
                <LinearGradient colors={G.statusBg} style={[styles.statusStrip, styles.statusStripSplit]}>
                  <Pressable onPress={openPicker} style={styles.actionPillTall}>
                    <Text style={styles.actionPillText}>{fabLabel}</Text>
                  </Pressable>
                  <View style={styles.revertColumn}>
                    <Pressable
                      style={[styles.revertPill, !hasUnsavedChanges && styles.revertPillDisabled]}
                      onPress={handleReset}
                      disabled={!hasUnsavedChanges}
                    >
                      <Text
                        style={[styles.revertPillText, !hasUnsavedChanges && styles.revertPillTextDisabled]}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.8}
                      >
                        Revert to saved
                      </Text>
                    </Pressable>
                    {showRevertLocked && (
                      <Pressable style={styles.revertPill} onPress={handleRevertToLocked}>
                        <Text style={styles.revertPillText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                          Revert to locked
                        </Text>
                      </Pressable>
                    )}
                  </View>
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
                  <Text style={styles.modalTitle}>{modalTitle}</Text>
                  {activeContext && (
                    <Text style={styles.modalSubtitle}>
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

              {/* Picker content */}
              <PlayerPickerScreen />
            </SafeAreaView>
          </View>
        </Modal>

      </SafeAreaView>
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

  // Two-column status strip (SL/private, when there's something to revert):
  // Each revert pill sizes to its OWN content (fixed paddingVertical, no
  // flex:1) instead of dividing whatever height Make Transfers happens to
  // need — that flex:1-divides-an-undetermined-height setup was the bug:
  // with only a single-line action button on the left driving the row's
  // height, two flex:1 pills on the right were squeezed to ~19px each,
  // clipping the text. Now the pills set their own comfortable height via
  // padding, the column's height is just whatever that adds up to, and
  // Make Transfers (alignItems:'stretch' below) grows to match it instead.
  statusStripSplit: {
    flexWrap:   'nowrap',
    alignItems: 'stretch',
  },
  actionPillTall: {
    flex:              1.4,
    backgroundColor:   '#1C1F26',
    borderRadius:      radius.md,
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: spacing.md,
  },
  revertColumn: {
    flex:           1,
    flexDirection:  'column',
    gap:            6,
    justifyContent: 'center',
  },
  revertPill: {
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: spacing.sm,
    paddingVertical:   7,
    minHeight:         30,
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
  modalHeaderLeft: { gap: 2 },
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

  pendingNote: {
    paddingHorizontal: spacing.lg,
    paddingVertical:   4,
    backgroundColor:   'transparent',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(28,31,38,0.08)',
  },
  pendingNoteText: {
    fontSize: fontSize.xs,
    color:    C.muted,
  },
});
