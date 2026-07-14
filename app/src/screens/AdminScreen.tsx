/**
 * AdminScreen — mobile admin panel (visible only to ADMIN_EMAIL)
 *
 * Four sections:
 *  1. Match Lock       — trigger lock-matches Edge Function
 *  2. Fetch Scores     — trigger poll-cricapi / scrape-scorecard per match
 *  3. Player Map       — resolve scraper_unmatched + scraper_fielding_issues
 *  4. Notify           — send a push notification to every registered device
 *                        via the send-push-notification Edge Function
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  TextInput, FlatList, Alert, StyleSheet, SafeAreaView,
  KeyboardAvoidingView, Keyboard, Platform, TouchableWithoutFeedback,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuthStore } from '../store/authStore';
import { useTournamentStore } from '../store/tournamentStore';
import { useTeamStore } from '../store/teamStore';
import { colors as C, spacing, radius, fontSize } from '../theme';

const ADMIN_EMAIL = 'abhi0818@gmail.com';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminMatch {
  id: string;
  match_number: number | null;
  home_team_id: string | null;
  away_team_id: string | null;
  status: string;
  start_time: string | null;
}

interface UnmatchedRow {
  id: string;
  match_id: string;
  raw_name: string;
  source: string;
  context: string;
  matches: { match_number: number | null } | null;
}

interface FieldingIssueRow {
  id: string;
  match_id: string;
  raw_name: string;
  field: string;
  batter_name: string;
  candidates: string[] | null;
  matches: { match_number: number | null } | null;
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({
  title, badge, open, onToggle, children,
}: {
  title: string; badge?: number; open: boolean;
  onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <View style={s.section}>
      <Pressable style={s.sectionHeader} onPress={onToggle}>
        <Text style={s.sectionTitle}>{title}</Text>
        <View style={s.sectionHeaderRight}>
          {badge != null && badge > 0 && (
            <View style={s.badge}><Text style={s.badgeText}>{badge}</Text></View>
          )}
          <Text style={s.chevron}>{open ? '▲' : '▼'}</Text>
        </View>
      </Pressable>
      {open && <View style={s.sectionBody}>{children}</View>}
    </View>
  );
}

// ─── 1. Match Lock ────────────────────────────────────────────────────────────

function MatchLockSection({ matches, loading }: { matches: AdminMatch[]; loading: boolean }) {
  const [running, setRunning] = useState(false);
  const [result, setResult]   = useState<string | null>(null);

  const lockableStatuses = ['scheduled', 'delayed', 'in_progress'];
  const lockable = matches.filter(m => lockableStatuses.includes(m.status));

  async function runLock() {
    setRunning(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke('lock-matches', { body: {} });
      if (error) throw error;
      setResult('Lock run complete ✓');
    } catch (e: any) {
      setResult(`Error: ${e?.message ?? 'unknown'}`);
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <ActivityIndicator color={C.accent} style={{ margin: spacing.md }} />;

  return (
    <View>
      <Text style={s.hint}>
        Runs the lock-matches function immediately — locks all squads for any match
        whose lock gate has passed regardless of cron schedule.
      </Text>

      {lockable.length === 0 ? (
        <Text style={s.empty}>No lockable matches right now.</Text>
      ) : (
        lockable.map(m => (
          <View key={m.id} style={s.matchRow}>
            <Text style={s.matchLabel}>
              M{m.match_number ?? '?'} · {m.home_team_id} vs {m.away_team_id}
            </Text>
            <View style={[s.statusPill, { backgroundColor: statusColor(m.status) }]}>
              <Text style={s.statusText}>{m.status}</Text>
            </View>
          </View>
        ))
      )}

      <Pressable
        style={[s.primaryBtn, running && s.btnDisabled]}
        onPress={runLock}
        disabled={running}
      >
        {running
          ? <ActivityIndicator color="#1C1F26" />
          : <Text style={s.primaryBtnText}>🔒 Run Lock Now</Text>
        }
      </Pressable>

      {result && (
        <Text style={[s.resultText, result.startsWith('Error') && { color: C.bad }]}>
          {result}
        </Text>
      )}
    </View>
  );
}

// ─── 2. Fetch Scores ──────────────────────────────────────────────────────────

function FetchScoresSection({ matches, loading }: { matches: AdminMatch[]; loading: boolean }) {
  const [pending, setPending] = useState<Record<string, 'cricapi' | 'scrape' | null>>({});
  const [results, setResults] = useState<Record<string, string>>({});

  async function trigger(matchId: string, fn: 'poll-cricapi' | 'scrape-scorecard', key: 'cricapi' | 'scrape') {
    setPending(p => ({ ...p, [matchId + key]: key }));
    setResults(r => ({ ...r, [matchId + key]: '' }));
    try {
      const { error } = await supabase.functions.invoke(fn, { body: { matchId } });
      if (error) throw error;
      setResults(r => ({ ...r, [matchId + key]: '✓ done' }));
    } catch (e: any) {
      setResults(r => ({ ...r, [matchId + key]: `✗ ${e?.message ?? 'error'}` }));
    } finally {
      setPending(p => ({ ...p, [matchId + key]: null }));
    }
  }

  if (loading) return <ActivityIndicator color={C.accent} style={{ margin: spacing.md }} />;

  const liveMatches = matches.filter(m =>
    ['live', 'in_progress', 'scheduled', 'delayed'].includes(m.status)
  );

  if (liveMatches.length === 0) {
    return <Text style={s.empty}>No active matches to fetch scores for.</Text>;
  }

  return (
    <View>
      <Text style={s.hint}>Manually trigger a score fetch for a specific match.</Text>
      {liveMatches.map(m => {
        const cricKey   = m.id + 'cricapi';
        const scrapeKey = m.id + 'scrape';
        return (
          <View key={m.id} style={s.fetchRow}>
            <Text style={s.matchLabel}>
              M{m.match_number ?? '?'} · {m.home_team_id} vs {m.away_team_id}
            </Text>
            <View style={s.fetchBtns}>
              <Pressable
                style={[s.fetchBtn, s.fetchBtnCricapi, pending[cricKey] && s.btnDisabled]}
                onPress={() => trigger(m.id, 'poll-cricapi', 'cricapi')}
                disabled={!!pending[cricKey]}
              >
                {pending[cricKey]
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={s.fetchBtnText}>CricAPI</Text>
                }
              </Pressable>
              <Pressable
                style={[s.fetchBtn, s.fetchBtnScrape, pending[scrapeKey] && s.btnDisabled]}
                onPress={() => trigger(m.id, 'scrape-scorecard', 'scrape')}
                disabled={!!pending[scrapeKey]}
              >
                {pending[scrapeKey]
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={s.fetchBtnText}>Scrape</Text>
                }
              </Pressable>
            </View>
            {(results[cricKey] || results[scrapeKey]) && (
              <Text style={s.fetchResult}>
                {[results[cricKey], results[scrapeKey]].filter(Boolean).join('  ')}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ─── 3. Player Map ────────────────────────────────────────────────────────────

function PlayerMapSection({ tournamentId }: { tournamentId: string | null }) {
  const { players } = useTeamStore();
  const [tab, setTab]               = useState<'unmatched' | 'fielding'>('unmatched');
  const [unmatched, setUnmatched]   = useState<UnmatchedRow[]>([]);
  const [fielding, setFielding]     = useState<FieldingIssueRow[]>([]);
  const [loadingPM, setLoadingPM]   = useState(false);
  // Per-row resolve state: which row is being resolved, search text, result
  const [resolving, setResolving]   = useState<string | null>(null);   // row id
  const [search, setSearch]         = useState('');
  const [busy, setBusy]             = useState<string | null>(null);   // row id being saved

  const load = useCallback(async () => {
    if (!tournamentId) return;
    setLoadingPM(true);
    try {
      const [{ data: u }, { data: f }] = await Promise.all([
        supabase
          .from('scraper_unmatched')
          .select('id, match_id, raw_name, source, context, matches(match_number)')
          .eq('tournament_id', tournamentId)
          .is('resolved_at', null)
          .order('created_at', { ascending: false }),
        supabase
          .from('scraper_fielding_issues')
          .select('id, match_id, raw_name, field, batter_name, candidates, matches(match_number)')
          .eq('tournament_id', tournamentId)
          .is('resolved_at', null)
          .order('created_at', { ascending: false }),
      ]);
      setUnmatched((u ?? []) as unknown as UnmatchedRow[]);
      setFielding((f ?? []) as unknown as FieldingIssueRow[]);
    } finally {
      setLoadingPM(false);
    }
  }, [tournamentId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function ignore(table: 'scraper_unmatched' | 'scraper_fielding_issues', id: string) {
    setBusy(id);
    const { error } = await supabase
      .from(table)
      .update({ resolved_at: new Date().toISOString(), resolved_by: 'ignored' })
      .eq('id', id);
    if (error) { Alert.alert('Error', error.message); }
    else { await load(); }
    setBusy(null);
  }

  async function resolveAlias(row: UnmatchedRow, player: { id: string; name: string }) {
    setBusy(row.id);
    // 1. Create alias
    const { error: aliasErr } = await supabase
      .from('player_name_aliases')
      .upsert({
        player_id:     player.id,
        tournament_id: tournamentId,
        alias:         row.raw_name.toLowerCase().trim(),
        source:        row.source,
      }, { onConflict: 'alias,source,tournament_id' });
    if (aliasErr) { Alert.alert('Alias error', aliasErr.message); setBusy(null); return; }

    // 2. Mark resolved
    const { error: resolveErr } = await supabase
      .from('scraper_unmatched')
      .update({ resolved_at: new Date().toISOString(), resolved_by: 'alias' })
      .eq('id', row.id);
    if (resolveErr) { Alert.alert('Resolve error', resolveErr.message); setBusy(null); return; }

    setResolving(null);
    setSearch('');
    await load();
    setBusy(null);
  }

  const filteredPlayers = search.trim().length >= 2
    ? players.filter(p => p.name.toLowerCase().includes(search.toLowerCase())).slice(0, 8)
    : [];

  if (loadingPM) return <ActivityIndicator color={C.accent} style={{ margin: spacing.md }} />;

  return (
    <View>
      {/* Sub-tabs */}
      <View style={s.subTabBar}>
        {(['unmatched', 'fielding'] as const).map(t => (
          <Pressable
            key={t}
            style={[s.subTab, tab === t && s.subTabActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[s.subTabText, tab === t && s.subTabTextActive]}>
              {t === 'unmatched'
                ? `Unmatched (${unmatched.length})`
                : `Fielding (${fielding.length})`}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'unmatched' && (
        unmatched.length === 0
          ? <Text style={s.empty}>No unmatched players ✓</Text>
          : unmatched.map(row => (
            <View key={row.id} style={s.playerMapRow}>
              <View style={s.playerMapMeta}>
                <Text style={s.rawName}>"{row.raw_name}"</Text>
                <Text style={s.playerMapSub}>
                  M{row.matches?.match_number ?? '?'} · {row.source} · {row.context}
                </Text>
              </View>

              <View style={s.playerMapActions}>
                <Pressable
                  style={[s.smallBtn, s.smallBtnGhost]}
                  onPress={() => ignore('scraper_unmatched', row.id)}
                  disabled={busy === row.id}
                >
                  <Text style={s.smallBtnText}>Ignore</Text>
                </Pressable>
                <Pressable
                  style={[s.smallBtn, s.smallBtnAccent]}
                  onPress={() => {
                    setResolving(r => r === row.id ? null : row.id);
                    setSearch('');
                  }}
                  disabled={busy === row.id}
                >
                  <Text style={[s.smallBtnText, { color: '#1C1F26' }]}>
                    {resolving === row.id ? 'Cancel' : 'Resolve'}
                  </Text>
                </Pressable>
              </View>

              {resolving === row.id && (
                <View style={s.resolvePanel}>
                  <TextInput
                    style={s.searchInput}
                    placeholder="Search player name…"
                    placeholderTextColor={C.muted}
                    value={search}
                    onChangeText={setSearch}
                    autoFocus
                  />
                  {filteredPlayers.map(p => (
                    <Pressable
                      key={p.id}
                      style={s.playerResult}
                      onPress={() => resolveAlias(row, p)}
                      disabled={busy === row.id}
                    >
                      <Text style={s.playerResultName}>{p.name}</Text>
                      <Text style={s.playerResultSub}>{p.team} · {p.role}</Text>
                    </Pressable>
                  ))}
                  {search.trim().length >= 2 && filteredPlayers.length === 0 && (
                    <Text style={s.empty}>No players match "{search}"</Text>
                  )}
                  {busy === row.id && (
                    <ActivityIndicator color={C.accent} style={{ marginTop: spacing.sm }} />
                  )}
                </View>
              )}
            </View>
          ))
      )}

      {tab === 'fielding' && (
        fielding.length === 0
          ? <Text style={s.empty}>No fielding issues ✓</Text>
          : fielding.map(row => (
            <View key={row.id} style={s.playerMapRow}>
              <View style={s.playerMapMeta}>
                <Text style={s.rawName}>"{row.raw_name}"</Text>
                <Text style={s.playerMapSub}>
                  M{row.matches?.match_number ?? '?'} · {row.field} · off {row.batter_name}
                </Text>
                {row.candidates && row.candidates.length > 0 && (
                  <Text style={s.candidates}>
                    Candidates: {row.candidates.join(', ')}
                  </Text>
                )}
              </View>
              <View style={s.playerMapActions}>
                <Pressable
                  style={[s.smallBtn, s.smallBtnGhost]}
                  onPress={() => ignore('scraper_fielding_issues', row.id)}
                  disabled={busy === row.id}
                >
                  <Text style={s.smallBtnText}>Ignore</Text>
                </Pressable>
                <View style={[s.smallBtn, { backgroundColor: C.panel2, borderColor: C.border }]}>
                  <Text style={[s.smallBtnText, { color: C.muted }]}>Credit → web</Text>
                </View>
              </View>
            </View>
          ))
      )}
    </View>
  );
}

// ─── 4. Notify ────────────────────────────────────────────────────────────────

function NotifySection() {
  const [title, setTitle]   = useState('');
  const [body, setBody]     = useState('');
  const [tickerHours, setTickerHours] = useState('6');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const parsedHours = Number(tickerHours);
  const validHours  = Number.isFinite(parsedHours) && parsedHours >= 0.25 && parsedHours <= 72;
  const canSend = title.trim().length > 0 && body.trim().length > 0 && validHours && !sending;

  async function send() {
    Alert.alert(
      'Send to all users?',
      `"${title.trim()}" will be pushed to every registered device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Send', style: 'destructive', onPress: doSend },
      ],
    );
  }

  async function doSend() {
    setSending(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke('send-push-notification', {
        body: { title: title.trim(), body: body.trim(), tickerHours: parsedHours },
      });
      if (error) throw error;
      setResult(`Sent ${data?.sent ?? 0} · Failed ${data?.failed ?? 0}`);
      setTitle('');
      setBody('');
      setTickerHours('6');
    } catch (e: any) {
      setResult(`Error: ${e?.message ?? 'unknown'}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <View>
      <Text style={s.hint}>
        Sends a push notification to every device currently registered across all users, and
        scrolls it on the HomeScreen ticker for the duration below — independent of whether
        someone's already opened it.
      </Text>

      <TextInput
        style={s.notifyInput}
        placeholder="Title"
        placeholderTextColor={C.muted}
        value={title}
        onChangeText={setTitle}
        maxLength={80}
        returnKeyType="done"
        blurOnSubmit
      />
      <TextInput
        style={[s.notifyInput, s.notifyBody]}
        placeholder="Message"
        placeholderTextColor={C.muted}
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={200}
      />

      <View style={s.notifyDurationRow}>
        <Text style={s.notifyDurationLabel}>Show on Home for (hours)</Text>
        <TextInput
          style={s.notifyDurationInput}
          value={tickerHours}
          onChangeText={setTickerHours}
          keyboardType="numeric"
          maxLength={4}
        />
      </View>
      {!validHours && (
        <Text style={[s.resultText, { color: C.bad }]}>Enter a duration between 0.25 and 72 hours</Text>
      )}

      <Pressable
        style={[s.primaryBtn, !canSend && s.btnDisabled]}
        onPress={send}
        disabled={!canSend}
      >
        {sending
          ? <ActivityIndicator color="#1C1F26" />
          : <Text style={s.primaryBtnText}>🔔 Send Notification</Text>
        }
      </Pressable>

      {result && (
        <Text style={[s.resultText, result.startsWith('Error') && { color: C.bad }]}>
          {result}
        </Text>
      )}
    </View>
  );
}

// ─── Status colour helper ─────────────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case 'live':
    case 'in_progress': return 'rgba(45,106,53,0.15)';
    case 'delayed':     return 'rgba(201,168,76,0.2)';
    case 'completed':   return 'rgba(120,120,120,0.12)';
    default:            return 'rgba(120,120,120,0.08)';
  }
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function AdminScreen() {
  const { user }                   = useAuthStore();
  const { selectedTournamentId }   = useTournamentStore();
  const [matches, setMatches]      = useState<AdminMatch[]>([]);
  const [matchLoading, setMatchLoading] = useState(false);

  const [openSection, setOpenSection] = useState<'lock' | 'fetch' | 'map' | 'notify' | null>('lock');

  // Guard — should never render for non-admins (tab is hidden), but belt + suspenders
  if (user?.email !== ADMIN_EMAIL) {
    return (
      <SafeAreaView style={s.screen}>
        <Text style={{ color: C.muted, textAlign: 'center', margin: spacing.xl }}>
          Admin access only.
        </Text>
      </SafeAreaView>
    );
  }

  const loadMatches = useCallback(async () => {
    if (!selectedTournamentId) return;
    setMatchLoading(true);
    const { data } = await supabase
      .from('matches')
      .select('id, match_number, home_team_id, away_team_id, status, start_time')
      .eq('tournament_id', selectedTournamentId)
      .neq('status', 'completed')
      .order('match_number', { ascending: true });
    setMatches((data ?? []) as AdminMatch[]);
    setMatchLoading(false);
  }, [selectedTournamentId]);

  useFocusEffect(useCallback(() => { loadMatches(); }, [loadMatches]));

  function toggle(s: 'lock' | 'fetch' | 'map' | 'notify') {
    setOpenSection(o => o === s ? null : s);
  }

  const unmatchedCount = 0; // loaded inside PlayerMapSection; badge shown generically

  return (
    <SafeAreaView style={s.screen}>
      <Text style={s.title}>⚙️ Admin</Text>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <ScrollView
            contentContainerStyle={s.scroll}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >

            <Section
              title="Match Lock"
              open={openSection === 'lock'}
              onToggle={() => toggle('lock')}
            >
              <MatchLockSection matches={matches} loading={matchLoading} />
            </Section>

            <Section
              title="Fetch Scores"
              open={openSection === 'fetch'}
              onToggle={() => toggle('fetch')}
            >
              <FetchScoresSection matches={matches} loading={matchLoading} />
            </Section>

            <Section
              title="Player Map"
              open={openSection === 'map'}
              onToggle={() => toggle('map')}
            >
              <PlayerMapSection tournamentId={selectedTournamentId ?? null} />
            </Section>

            <Section
              title="Notify"
              open={openSection === 'notify'}
              onToggle={() => toggle('notify')}
            >
              <NotifySection />
            </Section>

          </ScrollView>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: spacing.lg, paddingBottom: 40 },
  title:  { fontSize: fontSize.xl, fontWeight: '700', color: C.text, padding: spacing.lg, paddingBottom: 0 },

  // Section
  section:       { backgroundColor: C.panel, borderRadius: radius.xl, borderWidth: 1, borderColor: C.border, marginBottom: spacing.md, overflow: 'hidden' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.lg },
  sectionHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionTitle:  { fontSize: fontSize.base, fontWeight: '700', color: C.text },
  sectionBody:   { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, borderTopWidth: 1, borderTopColor: C.border, paddingTop: spacing.md },
  chevron:       { fontSize: 10, color: C.muted },
  badge:         { backgroundColor: C.bad, borderRadius: radius.full, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText:     { fontSize: fontSize.xs, color: '#fff', fontWeight: '700' },

  // Shared match row
  matchRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: C.border },
  matchLabel: { fontSize: fontSize.md, color: C.text, flex: 1 },
  statusPill: { borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontSize: fontSize.xs, color: C.text, fontWeight: '600', textTransform: 'uppercase' },

  // Hints + empty
  hint:  { fontSize: fontSize.sm, color: C.muted, marginBottom: spacing.md, lineHeight: 16 },
  empty: { fontSize: fontSize.sm, color: C.muted, textAlign: 'center', paddingVertical: spacing.md },

  // Primary button
  primaryBtn:     { backgroundColor: C.accent, borderRadius: radius.lg, padding: spacing.md, alignItems: 'center', marginTop: spacing.lg },
  primaryBtnText: { fontSize: fontSize.base, fontWeight: '700', color: '#1C1F26' },
  btnDisabled:    { opacity: 0.5 },
  resultText:     { marginTop: spacing.sm, fontSize: fontSize.sm, color: C.good, textAlign: 'center' },

  // Fetch scores
  fetchRow:     { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: C.border },
  fetchBtns:    { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  fetchBtn:     { flex: 1, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center', height: 34, justifyContent: 'center' },
  fetchBtnCricapi: { backgroundColor: '#2D6A35' },
  fetchBtnScrape:  { backgroundColor: '#1A4B8C' },
  fetchBtnText:    { fontSize: fontSize.sm, color: '#fff', fontWeight: '700' },
  fetchResult:     { fontSize: fontSize.xs, color: C.muted, marginTop: 4 },

  // Sub-tabs (Player Map)
  subTabBar:       { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  subTab:          { flex: 1, paddingVertical: spacing.sm, alignItems: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel2 },
  subTabActive:    { backgroundColor: C.accent, borderColor: C.accent },
  subTabText:      { fontSize: fontSize.sm, fontWeight: '600', color: C.muted },
  subTabTextActive:{ color: '#1C1F26' },

  // Player map rows
  playerMapRow:    { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: C.border },
  playerMapMeta:   { marginBottom: spacing.sm },
  rawName:         { fontSize: fontSize.base, fontWeight: '600', color: C.text },
  playerMapSub:    { fontSize: fontSize.sm, color: C.muted, marginTop: 2 },
  candidates:      { fontSize: fontSize.xs, color: C.accent, marginTop: 2 },
  playerMapActions:{ flexDirection: 'row', gap: spacing.sm },

  smallBtn:        { flex: 1, paddingVertical: 6, paddingHorizontal: spacing.sm, borderRadius: radius.md, alignItems: 'center', borderWidth: 1 },
  smallBtnGhost:   { borderColor: C.border, backgroundColor: 'transparent' },
  smallBtnAccent:  { borderColor: C.accent, backgroundColor: C.accent },
  smallBtnText:    { fontSize: fontSize.sm, fontWeight: '600', color: C.text },

  // Notify
  notifyInput: { backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: radius.md, padding: spacing.sm, fontSize: fontSize.base, color: C.text, marginBottom: spacing.sm },
  notifyBody:  { minHeight: 70, textAlignVertical: 'top' },
  notifyDurationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  notifyDurationLabel: { fontSize: fontSize.sm, color: C.text, flex: 1 },
  notifyDurationInput: { width: 64, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: radius.md, padding: spacing.sm, fontSize: fontSize.base, color: C.text, textAlign: 'center' },

  // Resolve panel (inline player search)
  resolvePanel:    { marginTop: spacing.sm, backgroundColor: C.panel2, borderRadius: radius.md, padding: spacing.sm },
  searchInput:     { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: radius.md, padding: spacing.sm, fontSize: fontSize.base, color: C.text, marginBottom: spacing.sm },
  playerResult:    { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: C.border },
  playerResultName:{ fontSize: fontSize.base, fontWeight: '600', color: C.text },
  playerResultSub: { fontSize: fontSize.xs, color: C.muted },
});
