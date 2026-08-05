/**
 * NameSquadModal
 *
 * Shown once, right after a user picks a contest in ContestPicker that they
 * don't yet have a squad in (see MyXIScreen's ContestPicker.onSelect wiring).
 * Squads used to be silently created with the literal name "My Squad" on
 * first Save XI (see teamStore.ensureSquad) — this is the actual naming
 * step that was missing, so the leaderboard shows a real team name instead
 * of "My Squad" for every entry.
 *
 * Prefilled from profiles.team_name (the name captured at signup) when
 * available, but always editable — a user may want a different name per
 * contest/league.
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { fontSize, radius, spacing, shadow } from '../theme';

const C = {
  text:    '#1C1F26',
  muted:   '#7A7060',
  accent:  '#C9A84C',
  gold:    '#92650A',
  bad:     '#C0392B',
  border:  'rgba(201,168,76,0.25)',
} as const;

const MAX_LEN = 30;

interface Props {
  visible:      boolean;
  contestName:  string;
  initialName:  string;
  onConfirm:    (name: string) => void | Promise<void>;
  submitting?:  boolean;
  error?:       string | null;
}

export default function NameSquadModal({ visible, contestName, initialName, onConfirm, submitting, error }: Props) {
  const [name, setName] = useState(initialName);

  // Reset the draft whenever a fresh prefill comes in (new contest picked)
  React.useEffect(() => { if (visible) setName(initialName); }, [visible, initialName]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.backdrop}
      >
        <View style={[styles.card, shadow.card]}>
          <Text style={styles.emoji}>🏏</Text>
          <Text style={styles.title}>Name your squad</Text>
          <Text style={styles.subtitle}>
            This is how you'll appear on the {contestName} leaderboard.
          </Text>

          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Thunder XI"
            placeholderTextColor={C.muted}
            maxLength={MAX_LEN}
            autoFocus
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={() => canSubmit && onConfirm(trimmed)}
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={({ pressed }) => [
              styles.confirmBtn,
              !canSubmit && styles.confirmBtnDisabled,
              pressed && canSubmit && styles.confirmBtnPressed,
            ]}
            disabled={!canSubmit}
            onPress={() => onConfirm(trimmed)}
          >
            {submitting
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.confirmBtnText}>Confirm</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems:      'center',
    justifyContent:  'center',
    padding:         spacing.xl,
  },
  card: {
    width:           '100%',
    maxWidth:        360,
    backgroundColor: '#F5F0E0',
    borderRadius:    radius.xl,
    borderWidth:     1,
    borderColor:     C.border,
    padding:         spacing.xl,
    alignItems:      'center',
    gap:             spacing.sm,
  },
  emoji: { fontSize: 32, marginBottom: spacing.xs },
  title: {
    color:      C.text,
    fontSize:   fontSize.xl,
    fontWeight: '800',
    textAlign:  'center',
  },
  subtitle: {
    color:      C.muted,
    fontSize:   fontSize.sm,
    textAlign:  'center',
    lineHeight: 18,
    marginBottom: spacing.sm,
  },
  input: {
    width:             '100%',
    borderWidth:       1,
    borderColor:       C.border,
    borderRadius:      radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm + 2,
    fontSize:          fontSize.base,
    fontWeight:        '600',
    color:             C.text,
    backgroundColor:   'rgba(255,255,255,0.85)',
    textAlign:         'center',
  },
  error: {
    color:      C.bad,
    fontSize:   fontSize.xs,
    textAlign:  'center',
  },
  confirmBtn: {
    width:             '100%',
    marginTop:         spacing.sm,
    backgroundColor:   '#1C1F26',
    borderRadius:      radius.lg,
    paddingVertical:   spacing.md,
    alignItems:        'center',
    justifyContent:    'center',
  },
  confirmBtnPressed:  { opacity: 0.85 },
  confirmBtnDisabled: { opacity: 0.4 },
  confirmBtnText: {
    color:      '#fff',
    fontSize:   fontSize.base,
    fontWeight: '700',
  },
});
