/**
 * WalkthroughSettingsSheet — bottom sheet opened from Rules ("🎓
 * Walkthrough"). Replaces the earlier "jump to a section" design: this is
 * purely on/off switches, not navigation. A master switch is a full kill
 * switch over everything; each section switch is "has this been marked
 * seen" inverted — flipping one ON re-arms it to show again the next time
 * you naturally reach that screen/moment, exactly like a first-time user
 * would see it. Nothing here jumps you anywhere or forces a screen open.
 */

import React from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { colors, fontSize, radius, spacing } from '../theme';

interface SectionState {
  key: string;
  icon: string;
  name: string;
  meta: string;
  seen: boolean; // hasSeenX — true means currently suppressed/off
  onToggle: (on: boolean) => void;
}

interface Props {
  visible: boolean;
  onDismiss: () => void;
  walkthroughEnabled: boolean;
  onToggleWalkthrough: (on: boolean) => void;
  sections: SectionState[];
}

function SectionRow({ section, disabled }: { section: SectionState; disabled: boolean }) {
  return (
    <View style={[styles.row, disabled && styles.rowDisabled]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowName}>{section.icon} {section.name}</Text>
        <Text style={styles.rowMeta}>{section.meta}</Text>
      </View>
      <Switch
        value={!section.seen}
        onValueChange={section.onToggle}
        disabled={disabled}
        trackColor={{ false: colors.border, true: colors.accent }}
        thumbColor="#FFFFFF"
      />
    </View>
  );
}

export default function WalkthroughSettingsSheet({
  visible, onDismiss, walkthroughEnabled, onToggleWalkthrough, sections,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <Pressable style={styles.backdrop} onPress={onDismiss}>
        <Pressable style={styles.sheet} onPress={e => e.stopPropagation()}>
          <View style={styles.handle} />
          <Text style={styles.title}>Walkthrough</Text>
          <Text style={styles.subtitle}>
            Turn onboarding tips on or off. When on, a section shows the next time you naturally reach it — nothing jumps you there.
          </Text>

          <View style={styles.masterRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.masterName}>Walkthrough</Text>
              <Text style={styles.rowMeta}>{walkthroughEnabled ? 'On — sections below can fire' : 'Off — nothing will show'}</Text>
            </View>
            <Switch
              value={walkthroughEnabled}
              onValueChange={onToggleWalkthrough}
              trackColor={{ false: colors.border, true: colors.accent }}
              thumbColor="#FFFFFF"
            />
          </View>

          <View style={styles.list}>
            {sections.map(s => (
              <SectionRow key={s.key} section={s} disabled={!walkthroughEnabled} />
            ))}
          </View>

          <Pressable style={styles.cancelBtn} onPress={onDismiss}>
            <Text style={styles.cancelText}>Done</Text>
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
  masterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: 'rgba(201,168,76,0.1)',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.lg,
    marginTop: spacing.xs,
  },
  masterName: { color: colors.text, fontSize: fontSize.base, fontWeight: '700' },
  list: { gap: spacing.sm },
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
  rowDisabled: { opacity: 0.45 },
  rowName: { color: colors.text, fontSize: fontSize.base, fontWeight: '700' },
  rowMeta: { color: colors.muted, fontSize: fontSize.sm, marginTop: 2 },
  cancelBtn: { alignItems: 'center', paddingVertical: spacing.sm },
  cancelText: { color: colors.muted, fontSize: fontSize.sm, fontWeight: '600' },
});
