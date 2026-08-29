/**
 * ReplayWalkthroughSheet — bottom sheet opened from Rules ("🎓 Replay
 * Walkthrough"). Lets a user jump straight to one onboarding moment instead
 * of only being able to replay the whole thing from the top.
 *
 * Each row just resets that moment's onboardingStore flag (and, for Home,
 * flags a one-time replay override — see onboardingStore's replayRequest)
 * then navigates to the screen where it naturally fires. The Boosters and
 * Captain/VC tips aren't directly navigable to (they depend on squad/contest
 * state, or only show up mid-flow inside the Confirm XI modal) — those rows
 * just clear the flag and send the user to My XI, where the tip picks up
 * the next time that moment is actually reached.
 */

import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fontSize, radius, spacing } from '../theme';

interface Props {
  visible: boolean;
  onDismiss: () => void;
  onJumpHome: () => void;
  onJumpPickerTips: () => void;
  onJumpCaptainVc: () => void;
  onReplayAll: () => void;
}

function JumpRow({ icon, name, meta, onPress }: { icon: string; name: string; meta: string; onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowName}>{icon} {name}</Text>
        <Text style={styles.rowMeta}>{meta}</Text>
      </View>
      <Text style={styles.arrow}>›</Text>
    </Pressable>
  );
}

export default function ReplayWalkthroughSheet({
  visible, onDismiss, onJumpHome, onJumpPickerTips, onJumpCaptainVc, onReplayAll,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <Pressable style={styles.backdrop} onPress={onDismiss}>
        <Pressable style={styles.sheet} onPress={e => e.stopPropagation()}>
          <View style={styles.handle} />
          <Text style={styles.title}>Replay Walkthrough</Text>
          <Text style={styles.subtitle}>Jump straight to a section, or watch the whole thing again.</Text>

          <View style={styles.list}>
            <JumpRow icon="🏠" name="Home basics" meta="What each button on Home does" onPress={onJumpHome} />
            <JumpRow icon="🎯" name="Building your XI" meta="Budget, boosters, My XI & schedule" onPress={onJumpPickerTips} />
            <JumpRow icon="✅" name="Confirm & Save" meta="Captain, Vice-Captain, saving your XI" onPress={onJumpCaptainVc} />
          </View>

          <Pressable style={({ pressed }) => [styles.replayAllBtn, pressed && { opacity: 0.85 }]} onPress={onReplayAll}>
            <Text style={styles.replayAllText}>Replay everything from the start</Text>
          </Pressable>
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
  title: { color: colors.text, fontSize: fontSize.lg, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: fontSize.sm, lineHeight: 18, marginTop: -spacing.xs },
  list: { gap: spacing.sm, marginTop: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.panel2,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowName: { color: colors.text, fontSize: fontSize.base, fontWeight: '700' },
  rowMeta: { color: colors.muted, fontSize: fontSize.sm, marginTop: 2 },
  arrow: { color: colors.accent, fontSize: fontSize.lg, fontWeight: '700' },
  replayAllBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  replayAllText: { color: '#1C1F26', fontSize: fontSize.base, fontWeight: '700' },
  cancelBtn: { alignItems: 'center', paddingVertical: spacing.sm },
  cancelText: { color: colors.muted, fontSize: fontSize.sm, fontWeight: '600' },
});
