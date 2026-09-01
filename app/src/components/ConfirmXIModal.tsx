/**
 * ConfirmXIModal — gradient-first Pass 1
 *
 * Step 1 · Captain & Vice-Captain
 * Step 2 · Review & Save
 * Requires: expo-linear-gradient
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CaptaincyRole, PlayerRole, SelectedPlayer } from '../types';
import CricketPitch from './CricketPitch';
import Jersey from './Jersey';
import { getBoosterMeta, TRANSFER_BOOSTERS } from '../store/boosterStore';
import BoosterIcon from './BoosterIcon';
import { fontSize, radius, spacing, shadow } from '../theme';
import Coachmark from './Coachmark';
import { useCoachmarkTarget } from '../hooks/useCoachmarkTarget';
import { useOnboardingStore } from '../store/onboardingStore';

// ─── Role colours (fallback when no teamColor set) ────────────────────────────

const ROLE_COLOR: Record<PlayerRole, string> = {
  wk: '#C9A84C', bat: '#1A2744', ar: '#2D6A35', bowl: '#7A3012',
};
const ROLE_LABEL: Record<PlayerRole, string> = {
  wk: 'WK', bat: 'BAT', ar: 'AR', bowl: 'BOWL',
};

// ─── Palette ──────────────────────────────────────────────────────────────────

const G = {
  bg:      ['#F5F0E0', '#EDE8D5', '#E8E2CE'] as const,
  header:  ['rgba(245,240,224,0.98)', 'rgba(237,232,213,0.95)'] as const,
  footer:  ['rgba(245,240,224,0.97)', 'rgba(237,232,213,0.97)'] as const,
  nextBtn: ['#1C1F26', '#2A2E38', '#3E4451'] as const,
  saveBtn: ['#2D6A35', '#1A6B2F'] as const,
  hint:    ['rgba(201,168,76,0.08)', 'rgba(245,240,224,0.6)'] as const,
} as const;

const C = {
  text:    '#1C1F26',
  muted:   '#7A7060',
  accent:  '#C9A84C',
  good:    '#2D6A35',
  bad:     '#C0392B',
  gold:    '#92650A',
  border:  'rgba(201,168,76,0.25)',
  borderA: 'rgba(201,168,76,0.5)',
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortenName(name: string) {
  const w = name.trim().split(' ');
  return w.length > 1 ? `${w[0][0]}. ${w.slice(1).join(' ')}` : w[0];
}

// ─── Step 1: Captain picker ───────────────────────────────────────────────────

interface CaptainStepProps {
  players:  SelectedPlayer[];
  onAssign: (id: string, role: CaptaincyRole) => void;
  assignRowRef?: React.RefObject<View | null>;
}

const ROLE_ORDER: Record<string, number> = { wk: 0, bat: 1, ar: 2, bowl: 3 };

function CaptainStep({ players, onAssign, assignRowRef }: CaptainStepProps) {
  const sorted      = [...players].sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
  const captain     = players.find(p => p.captaincy === 'captain');
  const viceCaptain = players.find(p => p.captaincy === 'vice_captain');
  const bothSet     = !!captain && !!viceCaptain;
  const nextRole: CaptaincyRole = captain ? 'vice_captain' : 'captain';

  const handleTap = (p: SelectedPlayer) => {
    if (p.captaincy === 'captain' || p.captaincy === 'vice_captain') {
      onAssign(p.id, p.captaincy);
    } else {
      onAssign(p.id, nextRole);
    }
  };

  return (
    <View style={styles.stepContainer}>

      {/* Assignment slots */}
      <View style={styles.assignRow} ref={assignRowRef} collapsable={false}>
        {/* Captain slot */}
        <View style={[styles.assignSlot, captain ? styles.assignSlotSet : styles.assignSlotEmpty]}>
          <View style={[styles.assignBadge, styles.assignBadgeC]}>
            <Text style={styles.assignBadgeText}>C</Text>
          </View>
          <View style={styles.assignSlotBody}>
            <Text style={styles.assignSlotLabel}>Captain · 2×</Text>
            <Text
              style={[styles.assignSlotName, captain ? styles.assignSlotNameSet : styles.assignSlotNameEmpty]}
              numberOfLines={1}
            >
              {captain ? shortenName(captain.name) : 'Tap a player below'}
            </Text>
          </View>
        </View>

        {/* VC slot */}
        <View style={[styles.assignSlot, viceCaptain ? styles.assignSlotSet : styles.assignSlotEmpty]}>
          <View style={[styles.assignBadge, styles.assignBadgeVC]}>
            <Text style={styles.assignBadgeText}>VC</Text>
          </View>
          <View style={styles.assignSlotBody}>
            <Text style={styles.assignSlotLabel}>Vice-Captain · 1.5×</Text>
            <Text
              style={[styles.assignSlotName, viceCaptain ? styles.assignSlotNameSet : styles.assignSlotNameEmpty]}
              numberOfLines={1}
            >
              {viceCaptain ? shortenName(viceCaptain.name) : captain ? 'Tap a player below' : '—'}
            </Text>
          </View>
        </View>
      </View>

      {/* Mode hint */}
      <LinearGradient colors={G.hint} style={styles.modeHint}>
        <Text style={styles.modeHintText}>
          {!captain
            ? '👆 Tap any player to set Captain'
            : !viceCaptain
            ? '👆 Now tap another player to set Vice-Captain'
            : '✓ Both set — tap any assigned player to change'}
        </Text>
      </LinearGradient>

      {/* Player grid */}
      <ScrollView
        style={styles.gridScroll}
        contentContainerStyle={styles.grid}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {sorted.map(p => {
          const isCap = p.captaincy === 'captain';
          const isVC  = p.captaincy === 'vice_captain';
          return (
            <Pressable
              key={p.id}
              style={({ pressed }) => [
                styles.capTile,
                isCap  && styles.capTileC,
                isVC   && styles.capTileVC,
                pressed && styles.capTilePressed,
              ]}
              onPress={() => handleTap(p)}
            >
              {(isCap || isVC) && (
                <View style={[styles.capTileBadge, isCap ? styles.assignBadgeC : styles.assignBadgeVC]}>
                  <Text style={styles.capTileBadgeText}>{isCap ? 'C' : 'VC'}</Text>
                </View>
              )}

              <View style={styles.capTileAvatar}>
                <Jersey code={p.team} color1={p.teamColor} color2={p.teamColor2} jerseySvg={p.teamJerseySvg} photoUrl={p.photoUrl} size={32} variant="pool" />
              </View>

              <Text style={styles.capTileName} numberOfLines={2}>{shortenName(p.name)}</Text>
              <View style={[styles.capTileRoleBadge, { borderColor: ROLE_COLOR[p.role] + '55' }]}>
                <Text style={[styles.capTileRoleText, { color: ROLE_COLOR[p.role] }]}>
                  {ROLE_LABEL[p.role]}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

    </View>
  );
}

// ─── Save-in-flight loader: a ball rolling along a mini pitch ─────────────────
// Shown on the Save button in place of its normal label while saveXI is in
// flight (see SummaryStep below). Picked over a plain spinner so the wait
// still feels like part of the app rather than a generic loading state.

const PITCH_TRACK_WIDTH = 96;
const PITCH_INSET       = 4;
const PITCH_BALL_SIZE   = 12;
const PITCH_TRAVEL       = PITCH_TRACK_WIDTH - PITCH_BALL_SIZE - PITCH_INSET * 2;

function RollingBallLoader() {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue:        1,
          duration:       800,
          easing:         Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue:        0,
          duration:       800,
          easing:         Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    // Stop cleanly on unmount (this only ever renders while saving=true, so
    // it unmounts as soon as the save resolves either way) — otherwise the
    // Animated loop keeps ticking on a detached node.
    return () => loop.stop();
  }, [progress]);

  const translateX = progress.interpolate({
    inputRange:  [0, 1],
    outputRange: [0, PITCH_TRAVEL],
  });
  const rotate = progress.interpolate({
    inputRange:  [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={styles.pitchTrack}>
      <View style={styles.pitchLine} />
      <View style={[styles.crease, styles.creaseLeft]} />
      <View style={[styles.crease, styles.creaseRight]} />
      <Animated.View style={[styles.pitchBall, { transform: [{ translateX }, { rotate }] }]}>
        <LinearGradient
          colors={['#C43A2E', '#6E1414']}
          style={styles.pitchBallInner}
          start={{ x: 0.3, y: 0.3 }}
          end={{ x: 1, y: 1 }}
        />
      </Animated.View>
    </View>
  );
}

// ─── Step 2: Summary ──────────────────────────────────────────────────────────

interface SummaryStepProps {
  current:        SelectedPlayer[];
  previous:       SelectedPlayer[];
  activeBoosterId?: string | null;
  saving?:        boolean;
  onBack:         () => void;
  onSave:         () => void;
  onCancel:       () => void;
  onSetCaptaincy: (id: string, role: CaptaincyRole) => void;
  onRemove:       (id: string) => void;
}

function SummaryStep({ current, previous, activeBoosterId, saving = false, onBack, onSave, onCancel, onSetCaptaincy, onRemove }: SummaryStepProps) {
  const added      = current.filter(p => !previous.find(b => b.id === p.id));
  const removed    = previous.filter(b => !current.find(p => p.id === b.id));
  const hasChanges = added.length > 0 || removed.length > 0;

  const boosterMeta = activeBoosterId ? getBoosterMeta(activeBoosterId) : null;
  // Wildcard/Free Hit make transfers unlimited-and-uncapped, so the IN/OUT
  // list below can run to a full 11-for-11 swap — this note explains why,
  // rather than leaving a long list unexplained.
  const isTransferBooster = !!activeBoosterId && TRANSFER_BOOSTERS.has(activeBoosterId);

  return (
    <View style={styles.stepContainer}>

      {/* Split row: pitch left, changes right */}
      <View style={styles.summaryRow}>
        <View style={styles.summaryPitch}>
          <CricketPitch
            players={current}
            onSetCaptaincy={onSetCaptaincy}
            onRemove={onRemove}
            readOnly
          />
        </View>

        <View style={styles.summaryChangesPanel}>
          {/* Booster banner — pinned above the (scrollable) IN/OUT list so it
              stays visible even when that list is long, mirrors the pitch's
              single-source-of-truth booster lookup (see MyXIScreen). */}
          {boosterMeta && (
            <View style={styles.boosterBanner}>
              <BoosterIcon icon={boosterMeta.icon} size={20} style={styles.boosterBannerIcon} />
              <View style={{ flex: 1 }}>
                <Text style={styles.boosterBannerName}>{boosterMeta.name} active</Text>
                {isTransferBooster && (
                  <Text style={styles.boosterBannerNote}>Unlimited transfers this match — no cap or deduction</Text>
                )}
              </View>
            </View>
          )}

          <Text style={styles.summaryChangesPanelTitle}>
            {hasChanges ? 'Transfers' : 'No changes'}
          </Text>

          {hasChanges ? (
            <ScrollView showsVerticalScrollIndicator={false} bounces={false} style={{ flex: 1 }}>
              {removed.map(p => (
                <View key={p.id} style={styles.changeItem}>
                  <View style={[styles.changeItemDot, { backgroundColor: C.bad }]} />
                  <View style={styles.changeItemBody}>
                    <Text style={[styles.changeItemName, { color: C.bad }]}>
                      {shortenName(p.name)}
                    </Text>
                    <Text style={styles.changeItemMeta}>OUT · {ROLE_LABEL[p.role]}</Text>
                  </View>
                </View>
              ))}
              {removed.length > 0 && added.length > 0 && (
                <View style={styles.transferDivider} />
              )}
              {added.map(p => (
                <View key={p.id} style={styles.changeItem}>
                  <View style={[styles.changeItemDot, { backgroundColor: C.good }]} />
                  <View style={styles.changeItemBody}>
                    <Text style={[styles.changeItemName, { color: C.good }]}>
                      {shortenName(p.name)}
                    </Text>
                    <Text style={styles.changeItemMeta}>IN · {ROLE_LABEL[p.role]}</Text>
                  </View>
                </View>
              ))}
            </ScrollView>
          ) : (
            <View style={styles.noChanges}>
              <Text style={styles.noChangesIcon}>🏏</Text>
              <Text style={styles.noChangesText}>Fresh XI</Text>
              <Text style={styles.noChangesSub}>No transfers this week</Text>
            </View>
          )}
        </View>
      </View>

      {/* Footer */}
      <LinearGradient colors={G.footer} style={styles.footer}>
        <Pressable style={styles.saveBtnWrap} onPress={saving ? undefined : onSave} disabled={saving}>
          <LinearGradient
            colors={G.nextBtn}
            style={styles.saveBtn}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
          >
            {saving ? (
              <RollingBallLoader />
            ) : (
              <Text style={styles.saveBtnText}>Save XI  ✓</Text>
            )}
          </LinearGradient>
        </Pressable>
        <Pressable
          style={[styles.cancelBtnWrap, saving && styles.cancelBtnWrapDisabled]}
          onPress={saving ? undefined : onCancel}
          disabled={saving}
        >
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </Pressable>
      </LinearGradient>
    </View>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

interface Props {
  visible:        boolean;
  contestName:    string;
  current:        SelectedPlayer[];
  previous:       SelectedPlayer[];
  /** Effective (pending-or-committed) booster for this match, or null/undefined
   *  on Daily contests (no boosters). Shown as a banner on the Review & Save step. */
  activeBoosterId?: string | null;
  /** True while onConfirm's save is actually in flight. Keeps the modal open
   *  with a loading state instead of closing immediately on tap — the caller
   *  (MyXIScreen) used to dismiss this modal the instant Save was pressed,
   *  landing the user back on My XI with nothing to show for several
   *  seconds until the success/failure message finally arrived. Staying
   *  open with a spinner keeps the whole "tap → wait → confirmed" sequence
   *  on one screen instead of splitting it across a screen transition. */
  saving?:        boolean;
  onSetCaptaincy: (id: string, role: CaptaincyRole) => void;
  onRemove:       (id: string) => void;
  onConfirm:      () => void;
  onEditMore:     () => void;
  onCancel:       () => void;
}

export default function ConfirmXIModal({
  visible, contestName, current, previous, activeBoosterId, saving = false,
  onSetCaptaincy, onRemove, onConfirm, onEditMore, onCancel,
}: Props) {
  const [step, setStep] = useState<'captain' | 'summary'>('captain');

  useEffect(() => {
    if (visible) setStep('captain');
  }, [visible]);

  // ── Onboarding: Captain/VC contextual tip (first time this modal opens) ──
  const { hasSeenCaptainVcTip, walkthroughEnabled, hydrated: onboardingHydrated, hydrate: hydrateOnboarding, completeCaptainVcTip } = useOnboardingStore();
  const [vcTipActive, setVcTipActive] = useState(false);
  const assignRowRef = useRef<View>(null);

  useEffect(() => { hydrateOnboarding(); }, [hydrateOnboarding]);

  useEffect(() => {
    if (!visible || step !== 'captain' || !onboardingHydrated || vcTipActive || !walkthroughEnabled || hasSeenCaptainVcTip) {
      if (!visible) setVcTipActive(false);
      return;
    }
    const t = setTimeout(() => {
      setVcTipActive(true);
    }, 400);
    return () => clearTimeout(t);
  }, [visible, step, onboardingHydrated, vcTipActive, walkthroughEnabled, hasSeenCaptainVcTip]);

  const vcTipTarget = useCoachmarkTarget(assignRowRef, vcTipActive);

  const finishVcTip = useCallback(() => {
    setVcTipActive(false);
    completeCaptainVcTip();
  }, [completeCaptainVcTip]);

  const stepLabel   = step === 'captain' ? 'Choose C & VC' : 'Review & Save';
  const captain     = current.find(p => p.captaincy === 'captain');
  const viceCaptain = current.find(p => p.captaincy === 'vice_captain');
  const bothSet     = !!captain && !!viceCaptain;

  return (
    <Modal
      visible={visible}
      animationType="none"
      presentationStyle="pageSheet"
      // While a save is in flight, block the hardware-back/swipe dismissal
      // too — same reasoning as disabling the header back button below:
      // navigating away mid-save leaves the user unsure whether it actually
      // went through, and (on the summary step) would tear down this screen
      // while saveXI is still writing.
      onRequestClose={saving ? () => {} : step === 'summary' ? () => setStep('captain') : onEditMore}
    >
      <View style={styles.root}>
        <LinearGradient colors={G.bg} style={StyleSheet.absoluteFill} />

        <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>

          {/* Header */}
          <LinearGradient colors={G.header} style={styles.header}>
            <Pressable
              style={styles.headerBack}
              onPress={saving ? undefined : (step === 'summary' ? () => setStep('captain') : onEditMore)}
              disabled={saving}
            >
              <Text style={[styles.headerBackText, saving && styles.headerBackTextDisabled]}>←</Text>
            </Pressable>
            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle}>{stepLabel}</Text>
              <Text style={styles.headerSub}>{contestName}</Text>
            </View>
            {step === 'captain' ? (
              <Pressable
                style={styles.headerNextWrap}
                onPress={bothSet ? () => setStep('summary') : undefined}
                disabled={!bothSet}
              >
                <LinearGradient
                  colors={G.nextBtn}
                  style={[styles.headerNext, !bothSet && styles.headerNextDisabled]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                >
                  <Text style={styles.headerNextText}>Next →</Text>
                </LinearGradient>
              </Pressable>
            ) : (
              <View style={styles.headerNextWrap} />
            )}
          </LinearGradient>

          {/* Step progress dots */}
          <View style={styles.dots}>
            <View style={[styles.dot, step === 'captain' ? styles.dotActive : styles.dotDone]} />
            <View style={[styles.dot, step === 'summary' ? styles.dotActive : styles.dotInactive]} />
          </View>

          {/* Step content */}
          {step === 'captain' ? (
            <CaptainStep
              players={current}
              onAssign={onSetCaptaincy}
              assignRowRef={assignRowRef}
            />
          ) : (
            <SummaryStep
              current={current}
              previous={previous}
              activeBoosterId={activeBoosterId}
              saving={saving}
              onBack={() => setStep('captain')}
              onSave={onConfirm}
              onCancel={onCancel}
              onSetCaptaincy={onSetCaptaincy}
              onRemove={onRemove}
            />
          )}

        </SafeAreaView>

        {/* First-time Captain/Vice-Captain tip — see onboardingStore/Coachmark. */}
        <Coachmark
          visible={vcTipActive && !!vcTipTarget}
          target={vcTipTarget}
          variant="tip"
          chipLabel="Quick tip"
          title="Pick your Captain and Vice-Captain"
          body="Your Captain scores double points, Vice-Captain 1.5x. Tap a player below to set Captain, then tap another for Vice-Captain."
          primaryLabel="Got it, I'll pick →"
          onPrimary={finishVcTip}
        />
      </View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex:            1,
    backgroundColor: '#F5F0E0',
  },
  safe: {
    flex: 1,
  },

  // Header
  header: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap:               spacing.sm,
  },
  headerBack: {
    width:           36,
    height:          36,
    alignItems:      'center',
    justifyContent:  'center',
    borderRadius:    radius.md,
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderWidth:     1,
    borderColor:     C.border,
  },
  headerBackText: { color: C.text, fontSize: 18, fontWeight: '700' },
  headerBackTextDisabled: { opacity: 0.3 },
  headerCenter:   { flex: 1, gap: 1, alignItems: 'center' },
  headerTitle:    { color: C.text, fontSize: fontSize.lg, fontWeight: '800', textAlign: 'center' },
  headerSub:      { color: C.muted, fontSize: fontSize.xs, textAlign: 'center' },
  stepPill: {
    backgroundColor:   'rgba(201,168,76,0.12)',
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.3)',
    borderRadius:      radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical:   3,
  },
  stepPillText: { color: C.accent, fontSize: fontSize.xs, fontWeight: '800' },

  // Progress dots
  dots: {
    flexDirection:     'row',
    justifyContent:    'center',
    gap:               6,
    paddingVertical:   8,
    backgroundColor:   'rgba(245,240,224,0.9)',
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  dot:         { width: 24, height: 4, borderRadius: 2 },
  dotActive:   { backgroundColor: C.accent },
  dotDone:     { backgroundColor: C.good },
  dotInactive: { backgroundColor: C.border },

  // Step wrapper
  stepContainer: { flex: 1 },

  // ── Captain step ─────────────────────────────────────────────────────────────

  assignRow: {
    flexDirection:     'row',
    gap:               spacing.sm,
    padding:           spacing.md,
    backgroundColor:   'rgba(245,240,224,0.9)',
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  assignSlot: {
    flex:           1,
    flexDirection:  'row',
    alignItems:     'center',
    gap:            spacing.sm,
    padding:        spacing.sm,
    borderRadius:   radius.lg,
    borderWidth:    1,
  },
  assignSlotSet:   { borderColor: 'rgba(201,168,76,0.25)', backgroundColor: 'rgba(255,255,255,0.6)' },
  assignSlotEmpty: { borderColor: 'rgba(201,168,76,0.4)',  backgroundColor: 'rgba(201,168,76,0.06)' },
  assignBadge: {
    width:          28,
    height:         28,
    borderRadius:   14,
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  },
  assignBadgeC:    { backgroundColor: '#C9A84C' },
  assignBadgeVC:   { backgroundColor: '#7A7060' },
  assignBadgeText: { color: '#1C1F26', fontSize: fontSize.xs, fontWeight: '900' },
  assignSlotBody:  { flex: 1 },
  assignSlotLabel: {
    color:         C.muted,
    fontSize:      fontSize.xs,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  assignSlotName:      { fontSize: fontSize.sm, fontWeight: '700', marginTop: 1 },
  assignSlotNameSet:   { color: C.text },
  assignSlotNameEmpty: { color: C.gold },

  // Hint bar
  modeHint: {
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(201,168,76,0.15)',
  },
  modeHintText: { color: C.text, fontSize: fontSize.xs, textAlign: 'center' },

  // Player grid
  gridScroll: { flex: 1 },
  grid: {
    flexDirection:  'row',
    flexWrap:       'wrap',
    padding:        spacing.md,
    gap:            spacing.sm,
    justifyContent: 'flex-start',
  },
  capTile: {
    width:             '30%',
    alignItems:        'center',
    gap:               4,
    paddingVertical:   spacing.md,
    paddingHorizontal: spacing.xs,
    backgroundColor:   'rgba(255,255,255,0.75)',
    borderRadius:      radius.xl,
    borderWidth:       1,
    borderColor:       C.border,
    position:          'relative',
  },
  capTileC:       { borderColor: '#C9A84C', backgroundColor: 'rgba(201,168,76,0.1)' },
  capTileVC:      { borderColor: '#7A7060', backgroundColor: 'rgba(122,112,96,0.08)' },
  capTilePressed: { opacity: 0.75, transform: [{ scale: 0.97 }] },

  capTileBadge: {
    position:       'absolute',
    top:             6,
    right:           6,
    width:           20,
    height:          20,
    borderRadius:    10,
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:          10,
  },
  capTileBadgeText: { color: '#1C1F26', fontSize: fontSize.xs, fontWeight: '900' },

  capTileAvatar: {
    alignItems:     'center',
    justifyContent: 'center',
  },

  capTileName: {
    color:      C.text,
    fontSize:   fontSize.xs,
    fontWeight: '700',
    textAlign:  'center',
    lineHeight: 15,
  },
  capTileRoleBadge: {
    borderWidth:       1,
    borderRadius:      radius.full,
    paddingHorizontal: 6,
    paddingVertical:   1,
  },
  capTileRoleText: { fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 0.5 },

  // ── Summary step ─────────────────────────────────────────────────────────────

  summaryRow: {
    flex:          1,
    flexDirection: 'row',
  },
  summaryPitch: {
    flex:             3,
    borderRightWidth: 1,
    borderRightColor: C.border,
  },
  summaryChangesPanel: {
    flex:    2,
    padding: spacing.md,
    gap:     spacing.sm,
  },
  summaryChangesPanelTitle: {
    color:         C.muted,
    fontSize:      fontSize.xs,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom:  4,
  },

  // Booster banner — pinned above the IN/OUT list (outside its ScrollView),
  // so it stays visible no matter how long the transfer list scrolls.
  boosterBanner: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               spacing.sm,
    padding:           spacing.sm,
    borderRadius:      radius.lg,
    borderWidth:       1,
    borderColor:       C.borderA,
    backgroundColor:   'rgba(201,168,76,0.1)',
    marginBottom:      spacing.sm,
  },
  boosterBannerIcon: { fontSize: 20 },
  boosterBannerName: { color: C.gold, fontSize: fontSize.sm, fontWeight: '800' },
  boosterBannerNote: { color: C.muted, fontSize: fontSize.xs, fontWeight: '600', marginTop: 1 },

  changeItem: {
    flexDirection:     'row',
    alignItems:        'flex-start',
    gap:               spacing.sm,
    paddingVertical:   spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  changeItemDot: {
    width:      8,
    height:     8,
    borderRadius: 4,
    marginTop:  3,
    flexShrink: 0,
  },
  changeItemBody: { flex: 1 },
  changeItemName: { fontSize: fontSize.sm, fontWeight: '700' },
  changeItemMeta: {
    color:         C.muted,
    fontSize:      fontSize.xs,
    fontWeight:    '600',
    letterSpacing: 0.5,
    marginTop:     1,
  },

  transferDivider: {
    height:          1,
    backgroundColor: C.border,
    marginVertical:  spacing.xs,
  },

  noChanges: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            spacing.sm,
  },
  noChangesIcon: { fontSize: 28 },
  noChangesText: { color: C.text, fontSize: fontSize.base, fontWeight: '700', textAlign: 'center' },
  noChangesSub:  { color: C.muted, fontSize: fontSize.xs, textAlign: 'center' },

  // Footer
  footer: {
    flexDirection:     'row',
    gap:               spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.md,
    borderTopWidth:    1,
    borderTopColor:    C.border,
  },

  // Next button (captain step)
  nextBtnWrap: { flex: 1 },
  nextBtn: {
    alignItems:      'center',
    paddingVertical: spacing.md,
    borderRadius:    radius.lg,
  },
  nextBtnDisabled: { opacity: 0.45 },
  nextBtnText: { color: '#fff', fontSize: fontSize.base, fontWeight: '800' },

  // Back button (summary step)
  backBtn: {
    flex:            1,
    alignItems:      'center',
    paddingVertical: spacing.md,
    borderRadius:    radius.lg,
    borderWidth:     1,
    borderColor:     C.border,
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  backBtnText: { color: C.text, fontSize: fontSize.base, fontWeight: '600' },

  // Save button (summary step)
  saveBtnWrap: { flex: 1 },
  saveBtn: {
    alignItems:      'center',
    paddingVertical: spacing.md,
    borderRadius:    radius.lg,
  },
  saveBtnText: { color: '#fff', fontSize: fontSize.base, fontWeight: '800' },

  // RollingBallLoader (shown on the Save button while saving)
  pitchTrack: {
    width:          PITCH_TRACK_WIDTH,
    height:         18,
    justifyContent: 'center',
  },
  pitchLine: {
    position:        'absolute',
    left:            PITCH_INSET,
    right:           PITCH_INSET,
    top:             '50%',
    height:          2,
    marginTop:       -1,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  crease: {
    position:        'absolute',
    top:             '50%',
    width:           2,
    height:          10,
    marginTop:       -5,
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  creaseLeft:  { left: PITCH_INSET },
  creaseRight: { right: PITCH_INSET },
  pitchBall: {
    position:  'absolute',
    left:      PITCH_INSET,
    top:       '50%',
    width:     PITCH_BALL_SIZE,
    height:    PITCH_BALL_SIZE,
    marginTop: -(PITCH_BALL_SIZE / 2),
  },
  pitchBallInner: {
    width:        PITCH_BALL_SIZE,
    height:       PITCH_BALL_SIZE,
    borderRadius: PITCH_BALL_SIZE / 2,
  },

  // Cancel button (summary step)
  cancelBtnWrap: {
    alignItems:        'center',
    paddingVertical:   spacing.md,
    borderRadius:      radius.lg,
    borderWidth:       1,
    borderColor:       'rgba(28,31,38,0.2)',
  },
  cancelBtnWrapDisabled: { opacity: 0.4 },
  cancelBtnText: { color: C.muted, fontSize: fontSize.base, fontWeight: '700' },

  // Header Next button (captain step)
  headerNextWrap: { width: 70 },
  headerNext: {
    alignItems:        'center',
    paddingVertical:   spacing.xs + 2,
    paddingHorizontal: spacing.sm,
    borderRadius:      radius.md,
  },
  headerNextDisabled: { opacity: 0.35 },
  headerNextText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
});
