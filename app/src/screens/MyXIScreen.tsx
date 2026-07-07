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
import { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
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

export default function MyXIScreen({ route }: Props) {
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
  const { loadBoosters, commitPending, discardPending } = useBoosterStore();
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
    loadSavedXI,
    saveXI,
    saveError,
  } = useTeamStore();

  const [pickerOpen, setPickerOpen]       = useState(false);
  const [confirmOpen, setConfirmOpen]     = useState(false);
  const [snapshot, setSnapshot]           = useState<SelectedPlayer[]>([]);
  const autoOpenHandled = useRef(false);

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

  const currentMatchId = useTeamStore(s => s.currentMatchId);
  const nextMatchTime  = useTeamStore(s => s.nextMatchTime);
  const isFirstMatch   = useTeamStore(s => s.isFirstMatch);
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
    loadSavedXI(currentMatchId, activeContext.contestId, activeContext.contestType);
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

    const err = await saveXI({
      matchId:     currentMatchId,
      contestId:   activeContext.contestId,
      contestType: activeContext.contestType,
    });

    if (err) {
      Alert.alert('Save Failed', err);
      return;
    }

    // Commit any staged booster pick now that the XI save succeeded — this
    // is the one place a booster choice actually gets written to
    // user_booster_activations (mirrors web's saveSlXiHandler step 2b).
    // Picking a booster pill never wrote to the DB directly; see
    // boosterStore.selectBooster.
    let boosterNote = '';
    try {
      const result = await commitPending();
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
            if (err) Alert.alert('Could not revert', err);
            else discardPending(); // also drop any staged-not-saved booster pick
          },
        },
      ]);
    }
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
                  {activeContext.leagueName} ⇄
                </Text>
              </Pressable>
            )}
          </View>
          <View style={styles.topBarRight}>
            {user && (
              <Text style={styles.userEmail} numberOfLines={1}>
                {teamName || user.email}
              </Text>
            )}
            <Pressable style={styles.signOutBtn} onPress={handleSignOut}>
              <Text style={styles.signOutText}>Sign Out</Text>
            </Pressable>
          </View>
        </LinearGradient>

        {/* ── Info strip: countdown + transfers ────────────────────────── */}
        {(countdown || (activeContext && activeContext.contestType !== 'daily')) && (
          <View style={styles.infoStrip}>
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
                <Text style={styles.infoPillLabel}>Transfers left </Text>
                <Text style={styles.infoPillValue}>
                  {isFirstMatch
                    ? '∞'
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
                haven't locked yet (i.e. made against the last locked XI). */}
            {activeContext && activeContext.contestType !== 'daily' && pendingTransfers > 0 && (
              <View style={styles.infoPill}>
                <Text style={styles.infoPillIcon}>🔄</Text>
                <Text style={styles.infoPillLabel}>Pending </Text>
                <Text style={styles.infoPillValue}>
                  {pendingTransfers} transfer{pendingTransfers !== 1 ? 's' : ''}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Clarifying note for pending transfers — shown until the match locks */}
        {activeContext && activeContext.contestType !== 'daily' && pendingTransfers > 0 && (
          <View style={styles.pendingNote}>
            <Text style={styles.pendingNoteText}>
              {pendingTransfers} transfer{pendingTransfers !== 1 ? 's' : ''} made from your last locked XI
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

          {/* Budget bar */}
          <BudgetBar
            creditsSpent={creditsSpent}
            creditsLeft={creditsLeft}
            playerCount={selected.length}
          />

          {/* Boosters — SL / private leagues only */}
          <BoostersBar
            contestType={activeContext?.contestType}
            squadId={squadId}
            matchId={currentMatchId}
            onStaged={showToast}
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

              {/* Status strip */}
              <LinearGradient colors={G.statusBg} style={styles.statusStrip}>
                {/* Edit / Transfer action */}
                <Pressable onPress={openPicker} style={styles.actionPill}>
                  <Text style={styles.actionPillText}>{fabLabel}</Text>
                </Pressable>
                <Pressable style={styles.resetBtn} onPress={handleReset}>
                  <Text style={styles.resetBtnText}>
                    {isDaily ? 'Reset XI' : 'Revert to Saved'}
                  </Text>
                </Pressable>
              </LinearGradient>
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
            onSetCaptaincy={(id, role) => setCaptaincy(id, role)}
            onRemove={(id) => removePlayer(id)}
            onConfirm={handleConfirm}
            onEditMore={handleEditMore}
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
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={handlePickerDone}
        >
          <View style={styles.modalRoot}>
            <LinearGradient colors={G.bg} style={StyleSheet.absoluteFill} />
            <SafeAreaView style={styles.modalSafe} edges={['top']}>
              {/* Modal header */}
              <LinearGradient colors={G.modalHdr} style={styles.modalHeader}>
                <Pressable onPress={() => setPickerOpen(false)} style={styles.cancelBtn}>
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
    borderBottomColor: 'rgba(201,168,76,0.25)',
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
  topBarRight: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
  },
  userEmail: {
    color:    C.muted,
    fontSize: fontSize.xs,
    maxWidth: 120,
  },
  signOutBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.xs + 2,
    borderWidth:       1.5,
    borderColor:       'rgba(28,31,38,0.30)',
    borderRadius:      radius.md,
  },
  signOutText: {
    color:      C.text,
    fontSize:   fontSize.sm,
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
    borderTopColor:   'rgba(201,168,76,0.2)',
  },
  actionPill: {
    backgroundColor:   '#1C1F26',
    borderRadius:      radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical:   5,
  },
  actionPillText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '800', letterSpacing: 0.3 },
  resetBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical:   4,
    borderWidth:       1.5,
    borderColor:       'rgba(192,57,43,0.65)',
    borderRadius:      radius.full,
  },
  resetBtnText: { color: C.bad, fontSize: fontSize.xs, fontWeight: '700' },
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
  modalSubtitle: { color: C.accent, fontSize: fontSize.sm },
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

  // Info strip (countdown + transfers)
  infoStrip: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.xs,
    backgroundColor:   'rgba(201,168,76,0.07)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(201,168,76,0.18)',
    flexWrap:          'wrap',
  },
  infoPill: {
    flexDirection:  'row',
    alignItems:     'center',
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth:    1,
    borderColor:    'rgba(201,168,76,0.25)',
    borderRadius:   radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical:   3,
    gap:            3,
  },
  infoPillIcon:  { fontSize: 11 },
  infoPillLabel: { fontSize: fontSize.sm, color: C.muted },
  infoPillValue: { fontSize: fontSize.sm, fontWeight: '700', color: C.accent },

  pendingNote: {
    paddingHorizontal: spacing.lg,
    paddingVertical:   4,
    backgroundColor:   'rgba(201,168,76,0.05)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(201,168,76,0.12)',
  },
  pendingNoteText: {
    fontSize: fontSize.xs,
    color:    C.muted,
  },
});
