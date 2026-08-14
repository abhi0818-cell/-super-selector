/**
 * PrivateLeagueModal
 *
 * Mobile parity for the web app's "Create a private league" / "Join a
 * private league" panel (index.html's Leagues tab) — Phase 4 of
 * docs/PRIVATE_LEAGUES_DESIGN.md. Opened from ContestPicker's footer link.
 *
 * Same rules as web:
 *  - Creating from here always makes a standard/shared league (no custom
 *    rules/boosters exposed) — the squad here IS your main SL squad, so
 *    there's no separate "team name" to type; it mirrors your SL squad's
 *    own name, same fix as index.html's create form.
 *  - Joining by code only asks for a team name if the code turns out to
 *    belong to a genuinely independent (custom-rules) league — otherwise it
 *    mirrors your SL squad's name the same way.
 *  - Fixed at 3 members on create; only an admin can raise it later.
 */

import React, { useEffect, useState } from 'react';
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
import { useContestStore, toContestContext } from '../store/contestStore';
import { ContestContext } from '../types';

const C = {
  text:    '#1C1F26',
  muted:   '#7A7060',
  accent:  '#C9A84C',
  gold:    '#92650A',
  bad:     '#C0392B',
  good:    '#2E7D32',
  border:  'rgba(201,168,76,0.25)',
} as const;

interface Props {
  visible:      boolean;
  tournamentId: string | null;
  onDismiss:    () => void;
  onJoined:     (ctx: ContestContext) => void;
}

type Mode = 'create' | 'join';

export default function PrivateLeagueModal({ visible, tournamentId, onDismiss, onJoined }: Props) {
  const { getMainSlSquad, previewLeagueByCode, createPrivateLeague, joinLeagueByCode } = useContestStore();

  const [mode, setMode]           = useState<Mode>('create');
  const [mainSquad, setMainSquad] = useState<{ id: string; name: string } | null | undefined>(undefined); // undefined = not loaded yet

  const [leagueName, setLeagueName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [joinTeamName, setJoinTeamName] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [notice, setNotice]     = useState<string | null>(null); // success note shown briefly before close

  useEffect(() => {
    if (!visible || !tournamentId) return;
    setMode('create');
    setLeagueName(''); setInviteCode(''); setJoinTeamName('');
    setError(null); setNotice(null);
    setMainSquad(undefined);
    getMainSlSquad(tournamentId).then(setMainSquad).catch(() => setMainSquad(null));
  }, [visible, tournamentId]);

  const closeSoon = (ctx: ContestContext, note: string) => {
    setNotice(note);
    setTimeout(() => { onJoined(ctx); }, 900);
  };

  const handleCreate = async () => {
    if (!tournamentId) return;
    if (!mainSquad) {
      setError('Join the main Season Long league first — a private league here mirrors that team, so there\'s nothing to mirror yet.');
      return;
    }
    const name = leagueName.trim();
    if (!name) { setError('Enter a league name.'); return; }

    setSubmitting(true); setError(null);
    try {
      const created = await createPrivateLeague(tournamentId, name);
      if (created.error || !created.contest) {
        setError(created.error ?? 'Could not create the league.');
        return;
      }
      // Auto-join as the creator, same as index.html — using the main SL
      // squad's own id/name so this league's squad mirrors it from the start.
      const joined = await joinLeagueByCode(created.contest.inviteCode ?? '', mainSquad.name, mainSquad.id);
      if (joined.error || !joined.contest) {
        setError(joined.error ?? 'League created, but joining it failed — try Join with the invite code.');
        return;
      }
      const backfillNote = joined.backfillError
        ? ' (past match history hit an error — it\'ll need a retry)'
        : joined.backfilledMatches ? ` — including ${joined.backfilledMatches} match${joined.backfilledMatches !== 1 ? 'es' : ''} already played` : '';
      closeSoon(toContestContext(joined.contest), `✓ "${name}" created${backfillNote}. Code: ${created.contest.inviteCode}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoin = async () => {
    const code = inviteCode.trim().toUpperCase();
    if (!code) { setError('Enter an invite code.'); return; }

    setSubmitting(true); setError(null);
    try {
      const preview = await previewLeagueByCode(code);
      if (preview.error || !preview.contest) {
        setError(preview.error ?? 'Invalid invite code.');
        return;
      }
      const shared = preview.contest.isShared;
      const primarySquadId = shared ? (mainSquad?.id ?? null) : null;

      let teamName: string | null;
      if (shared && mainSquad?.name) {
        teamName = mainSquad.name;
      } else if (shared) {
        teamName = joinTeamName.trim() || null; // edge case: no main SL squad yet
      } else {
        if (!joinTeamName.trim()) {
          setError('This is a custom-rules league — enter a team name.');
          return;
        }
        teamName = joinTeamName.trim();
      }

      const joined = await joinLeagueByCode(code, teamName, primarySquadId);
      if (joined.error || !joined.contest) {
        setError(joined.error ?? 'Could not join this league.');
        return;
      }
      const note = !joined.isShared
        ? `✓ Joined "${joined.contest.name}" — pick your XI for this league.`
        : joined.backfillError
          ? `✓ Joined "${joined.contest.name}" — your SL XI is shared here, but pulling in past history hit an error.`
          : joined.backfilledMatches
            ? `✓ Joined "${joined.contest.name}" — including ${joined.backfilledMatches} match${joined.backfilledMatches !== 1 ? 'es' : ''} already played.`
            : `✓ Joined "${joined.contest.name}" — your SL XI is shared here.`;
      closeSoon(toContestContext(joined.contest), note);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onDismiss}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
        <View style={[styles.card, shadow.card]}>
          <Text style={styles.title}>Private Leagues</Text>

          <View style={styles.tabs}>
            <Pressable style={[styles.tab, mode === 'create' && styles.tabActive]} onPress={() => { setMode('create'); setError(null); }}>
              <Text style={[styles.tabText, mode === 'create' && styles.tabTextActive]}>Create</Text>
            </Pressable>
            <Pressable style={[styles.tab, mode === 'join' && styles.tabActive]} onPress={() => { setMode('join'); setError(null); }}>
              <Text style={[styles.tabText, mode === 'join' && styles.tabTextActive]}>Join by code</Text>
            </Pressable>
          </View>

          {notice ? (
            <Text style={styles.notice}>{notice}</Text>
          ) : mode === 'create' ? (
            <>
              <Text style={styles.subtitle}>
                Uses tournament scoring rules. Your team here is the same as your Season Long team
                {mainSquad ? `, ${mainSquad.name}` : ''} — just showing up in this league's leaderboard too.
                Up to 3 members; an admin can raise that for you.
              </Text>
              <TextInput
                style={styles.input}
                value={leagueName}
                onChangeText={setLeagueName}
                placeholder="League name (e.g. The Office League)"
                placeholderTextColor={C.muted}
                autoCapitalize="words"
                editable={!submitting}
              />
              {mainSquad === null && (
                <Text style={styles.error}>Join the main Season Long league first — there's nothing to mirror yet.</Text>
              )}
              {error && <Text style={styles.error}>{error}</Text>}
              <Pressable
                style={({ pressed }) => [styles.confirmBtn, (submitting || mainSquad === undefined) && styles.confirmBtnDisabled, pressed && styles.confirmBtnPressed]}
                disabled={submitting || mainSquad === undefined}
                onPress={handleCreate}
              >
                {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.confirmBtnText}>Create</Text>}
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.subtitle}>
                Enter the invite code your friend shared. Standard-rules leagues automatically use your
                Season Long team — a team name is only needed for custom-rules leagues.
              </Text>
              <TextInput
                style={[styles.input, styles.codeInput]}
                value={inviteCode}
                onChangeText={t => setInviteCode(t.toUpperCase())}
                placeholder="Invite code"
                placeholderTextColor={C.muted}
                autoCapitalize="characters"
                maxLength={8}
                editable={!submitting}
              />
              <TextInput
                style={styles.input}
                value={joinTeamName}
                onChangeText={setJoinTeamName}
                placeholder="Team name (only needed for custom-rules leagues)"
                placeholderTextColor={C.muted}
                autoCapitalize="words"
                editable={!submitting}
              />
              {error && <Text style={styles.error}>{error}</Text>}
              <Pressable
                style={({ pressed }) => [styles.confirmBtn, submitting && styles.confirmBtnDisabled, pressed && styles.confirmBtnPressed]}
                disabled={submitting}
                onPress={handleJoin}
              >
                {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.confirmBtnText}>Join</Text>}
              </Pressable>
            </>
          )}

          <Pressable style={styles.cancelBtn} onPress={onDismiss}>
            <Text style={styles.cancelText}>{notice ? 'Close' : 'Cancel'}</Text>
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
    maxWidth:        400,
    backgroundColor: '#F5F0E0',
    borderRadius:    radius.xl,
    borderWidth:     1,
    borderColor:     C.border,
    padding:         spacing.xl,
    gap:             spacing.sm,
  },
  title: {
    color:      C.text,
    fontSize:   fontSize.xl,
    fontWeight: '800',
    textAlign:  'center',
    marginBottom: spacing.xs,
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderRadius: radius.lg,
    padding: 3,
    marginBottom: spacing.xs,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderRadius: radius.md,
  },
  tabActive: { backgroundColor: '#1C1F26' },
  tabText: { color: C.muted, fontSize: fontSize.sm, fontWeight: '700' },
  tabTextActive: { color: '#fff' },
  subtitle: {
    color:      C.muted,
    fontSize:   fontSize.xs,
    lineHeight: 16,
    marginBottom: spacing.xs,
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
  },
  codeInput: {
    textAlign: 'center',
    letterSpacing: 2,
  },
  error: {
    color:      C.bad,
    fontSize:   fontSize.xs,
    textAlign:  'center',
  },
  notice: {
    color:      C.good,
    fontSize:   fontSize.sm,
    fontWeight: '600',
    textAlign:  'center',
    paddingVertical: spacing.lg,
  },
  confirmBtn: {
    width:             '100%',
    marginTop:         spacing.xs,
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
  cancelBtn: {
    padding: spacing.sm,
    alignItems: 'center',
  },
  cancelText: {
    color:      C.muted,
    fontSize:   fontSize.sm,
    fontWeight: '600',
  },
});
