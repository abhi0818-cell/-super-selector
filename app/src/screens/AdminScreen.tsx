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
  lock_time: string | null;
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

/**
 * Effective lock gate for a match — lock_time overrides start_time when set,
 * but a 'delayed' match with no lock_time yet has NO gate at all. Mirrors
 * web's effectiveLockTime() (index.html) and the lock-matches Edge Function,
 * which only ever checks lock_time for status='delayed' matches.
 */
function effectiveLockTime(m: AdminMatch): string | null {
  if (m.status === 'delayed' && !m.lock_time) return null;
  return m.lock_time ?? m.start_time ?? null;
}

function formatRelative(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const mins = Math.round(Math.abs(diffMs) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const label = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return diffMs > 0 ? `locks in ${label}` : `overdue by ${label}`;
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

function MatchLockSection({
  matches, loading, onRefresh, onDraft,
}: {
  matches: AdminMatch[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onDraft: (title: string, body: string, tickerHours: string) => void;
}) {
  const [running, setRunning]       = useState(false);
  const [result, setResult]         = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId]         = useState<string | null>(null);
  const [manualTime, setManualTime] = useState('');

  // Live + the next 1 upcoming, or the next 2 upcoming if nothing's live —
  // keeps this to exactly what's actionable right now instead of dumping
  // every scheduled match in the tournament.
  const live     = matches.filter(m => m.status === 'live' || m.status === 'in_progress');
  const upcoming = matches
    .filter(m => m.status === 'scheduled' || m.status === 'delayed')
    .slice()
    .sort((a, b) => {
      const ta = effectiveLockTime(a);
      const tb = effectiveLockTime(b);
      if (!ta && !tb) return (a.match_number ?? 0) - (b.match_number ?? 0);
      if (!ta) return 1;
      if (!tb) return -1;
      return new Date(ta).getTime() - new Date(tb).getTime();
    });
  const visible = live.length > 0
    ? [...live, ...upcoming.slice(0, 1)]
    : upcoming.slice(0, 2);

  function matchLabel(m: AdminMatch) {
    return `M${m.match_number ?? '?'} (${m.home_team_id} vs ${m.away_team_id})`;
  }

  async function runLock() {
    setRunning(true);
    setResult(null);
    try {
      const { error } = await supabase.functions.invoke('lock-matches', { body: {} });
      if (error) throw error;
      setResult('Lock run complete ✓');
      await onRefresh();
    } catch (e: any) {
      setResult(`Error: ${e?.message ?? 'unknown'}`);
    } finally {
      setRunning(false);
    }
  }

  async function applyPatch(
    m: AdminMatch, patch: Record<string, any>,
    successMsg: string, draftTitle: string, draftBody: string,
  ) {
    setBusyId(m.id);
    try {
      const { error } = await supabase.from('matches').update(patch).eq('id', m.id);
      if (error) throw error;
      await onRefresh();
      setExpandedId(null);
      setManualTime('');
      // Duration floor on notifications_log.ticker_hours is 0.25h (15 min) —
      // there's no true 5-min option without loosening that shared validation,
      // so delay pings default to the floor rather than touching it.
      onDraft(draftTitle, draftBody, '0.25');
      Alert.alert('Done', successMsg);
    } catch (e: any) {
      Alert.alert('Failed', e?.message ?? 'unknown error');
    } finally {
      setBusyId(null);
    }
  }

  // Pushes lock_time if one's already set (the active gate once delayed),
  // otherwise start_time (still just the informational kickoff). First push
  // also promotes 'scheduled' → 'delayed' — the lock-matches Edge Function
  // only checks lock_time for status='delayed' matches, so a start_time push
  // alone wouldn't otherwise change when the match actually locks.
  async function pushTime(m: AdminMatch, minutes: number) {
    const base = m.lock_time || m.start_time;
    if (!base) { Alert.alert('No start time set', 'Set a start time first (web admin).'); return; }
    const target   = m.lock_time ? 'lock_time' : 'start_time';
    const newTime  = new Date(new Date(base).getTime() + minutes * 60000).toISOString();
    const patch: Record<string, any> = { [target]: newTime };
    if (m.status === 'scheduled') patch.status = 'delayed';
    await applyPatch(
      m, patch,
      `Pushed ${target === 'lock_time' ? 'lock' : 'start'} time +${minutes} min.`,
      `Match M${m.match_number ?? '?'} delayed`,
      `${matchLabel(m)} delayed — team lock pushed back ${minutes} min.`,
    );
  }

  // Sets a firm lock_time (e.g. a known toss/inspection time) rather than
  // nudging it in 15/30-min steps — same day as the match's start_time.
  async function setLockTime(m: AdminMatch) {
    const hhmm = manualTime.trim();
    if (!/^\d{1,2}:\d{2}$/.test(hhmm)) { Alert.alert('Invalid time', 'Use 24h HH:MM, e.g. 20:45.'); return; }
    const baseDate = (m.start_time ?? new Date().toISOString()).slice(0, 10);
    const [hh, mm] = hhmm.split(':');
    const d = new Date(`${baseDate}T${hh.padStart(2, '0')}:${mm}:00`); // parsed as device-local time
    if (isNaN(d.getTime())) { Alert.alert('Invalid time', 'Could not parse that time.'); return; }
    const patch: Record<string, any> = { lock_time: d.toISOString() };
    if (m.status === 'scheduled') patch.status = 'delayed';
    await applyPatch(
      m, patch,
      `Lock time set to ${hhmm}.`,
      `Match M${m.match_number ?? '?'} delayed`,
      `${matchLabel(m)} delayed — team lock now set for ${hhmm}.`,
    );
  }

  function abandon(m: AdminMatch) {
    Alert.alert(
      'Abandon match?',
      `${matchLabel(m)} will no longer lock — you'll roll to the next scheduled match instead.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Abandon', style: 'destructive',
          onPress: () => applyPatch(
            m, { status: 'abandoned' },
            'Match marked abandoned.',
            `Match M${m.match_number ?? '?'} abandoned`,
            `${matchLabel(m)} has been abandoned.`,
          ),
        },
      ],
    );
  }

  if (loading) return <ActivityIndicator color={C.accent} style={{ margin: spacing.md }} />;

  return (
    <View>
      <Text style={s.hint}>
        Showing the live match (if any) plus the next upcoming one — tap a match to push its
        time or mark it delayed/abandoned. "Run Lock Now" still processes every match whose
        lock gate has passed, tournament-wide, regardless of the cron schedule.
      </Text>

      {visible.length === 0 ? (
        <Text style={s.empty}>No live or upcoming matches right now.</Text>
      ) : (
        visible.map(m => {
          const lockAt      = effectiveLockTime(m);
          const isExpanded  = expandedId === m.id;
          return (
            <View key={m.id}>
              <Pressable
                style={s.matchRow}
                onPress={() => setExpandedId(isExpanded ? null : m.id)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.matchLabel}>{matchLabel(m)}</Text>
                  <Text style={s.matchSub}>
                    {lockAt ? formatRelative(lockAt) : 'no lock gate set — will not auto-lock'}
                  </Text>
                </View>
                <View style={[s.statusPill, { backgroundColor: statusColor(m.status) }]}>
                  <Text style={s.statusText}>{m.status}</Text>
                </View>
              </Pressable>

              {isExpanded && (
                <View style={s.delayPanel}>
                  <Text style={s.delayPanelLabel}>
                    Push {m.lock_time ? 'lock' : 'start'} time
                  </Text>
                  <View style={s.delayBtnRow}>
                    <Pressable style={s.delayBtn} onPress={() => pushTime(m, 15)} disabled={busyId === m.id}>
                      <Text style={s.delayBtnText}>+15m</Text>
                    </Pressable>
                    <Pressable style={s.delayBtn} onPress={() => pushTime(m, 30)} disabled={busyId === m.id}>
                      <Text style={s.delayBtnText}>+30m</Text>
                    </Pressable>
                  </View>

                  <Text style={s.delayPanelLabel}>Or set a firm lock time (24h, same day)</Text>
                  <View style={s.delayBtnRow}>
                    <TextInput
                      style={s.manualTimeInput}
                      placeholder="20:45"
                      placeholderTextColor={C.muted}
                      value={manualTime}
                      onChangeText={setManualTime}
                      keyboardType="numbers-and-punctuation"
                      maxLength={5}
                    />
                    <Pressable style={s.delayBtn} onPress={() => setLockTime(m)} disabled={busyId === m.id}>
                      <Text style={s.delayBtnText}>Set</Text>
                    </Pressable>
                  </View>

                  <Pressable style={s.abandonBtn} onPress={() => abandon(m)} disabled={busyId === m.id}>
                    {busyId === m.id
                      ? <ActivityIndicator color={C.bad} size="small" />
                      : <Text style={s.abandonBtnText}>🚫 Abandon match</Text>
                    }
                  </Pressable>
                </View>
              )}
            </View>
          );
        })
      )}

      <Pressable
        style={[s.primaryBtn, running && s.btnDisabled]}
        onPress={runLock}
        disabled={running}
      >
        {running
          ? <ActivityIndicator color="#1C1F26" />
          : <Text style={s.primaryBtnText}>🔒 Run Lock Now (all matches)</Text>
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

/**
 * Names a source (CricAPI, CricketAddictor, Business Standard) sends when IT
 * failed to identify a player — not a real name. These can never be aliased
 * to one specific local player: the same literal string shows up for
 * different actual players across different matches, so a static alias just
 * silently mis-credits stats to whoever was picked the first time (this is
 * exactly how "player not found" → Abayanga Khaka happened).
 * Mirrors db.js's isPlaceholderName (web admin) — keep in sync.
 */
function isPlaceholderName(rawName: string): boolean {
  const PLACEHOLDER_NAMES = new Set(['player not found']);
  const norm = String(rawName ?? '').toLowerCase().trim();
  return PLACEHOLDER_NAMES.has(norm) || norm.startsWith('empty');
}

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
    if (isPlaceholderName(row.raw_name)) {
      Alert.alert(
        'Cannot alias',
        `"${row.raw_name}" is a generic "not found" placeholder from the source feed, not a real name — it can't be mapped to one player. Use Ignore instead.`,
      );
      return;
    }
    setBusy(row.id);
    // 1. Create alias
    const { error: aliasErr } = await supabase
      .from('player_name_aliases')
      .upsert({
        player_id:     player.id,
        tournament_id: tournamentId,
        alias:         row.raw_name.toLowerCase().trim(),
        source:        row.source,
      }, { onConflict: 'alias,source,tournament_id', ignoreDuplicates: true });
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

function NotifySection({
  title, setTitle, body, setBody, tickerHours, setTickerHours,
}: {
  title: string; setTitle: (v: string) => void;
  body: string; setBody: (v: string) => void;
  tickerHours: string; setTickerHours: (v: string) => void;
}) {
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
    case 'abandoned':
    case 'cancelled':   return 'rgba(184,60,60,0.15)';
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

  // Lifted out of NotifySection so Match Lock's delay/abandon actions can
  // pre-fill and auto-open a draft notification (draftNotification below).
  const [notifyTitle, setNotifyTitle]     = useState('');
  const [notifyBody, setNotifyBody]       = useState('');
  const [notifyHours, setNotifyHours]     = useState('6');

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
      .select('id, match_number, home_team_id, away_team_id, status, start_time, lock_time')
      .eq('tournament_id', selectedTournamentId)
      .not('status', 'in', '(completed,abandoned,cancelled)')
      .order('match_number', { ascending: true });
    setMatches((data ?? []) as AdminMatch[]);
    setMatchLoading(false);
  }, [selectedTournamentId]);

  useFocusEffect(useCallback(() => { loadMatches(); }, [loadMatches]));

  function toggle(s: 'lock' | 'fetch' | 'map' | 'notify') {
    setOpenSection(o => o === s ? null : s);
  }

  // Called from MatchLockSection after a delay push / manual lock-time set /
  // abandon — pre-fills the Notify draft and jumps straight to that section
  // so the admin can review + send in one flow instead of hunting for it.
  function draftNotification(title: string, body: string, hours: string) {
    setNotifyTitle(title);
    setNotifyBody(body);
    setNotifyHours(hours);
    setOpenSection('notify');
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
              <MatchLockSection
                matches={matches}
                loading={matchLoading}
                onRefresh={loadMatches}
                onDraft={draftNotification}
              />
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
              <NotifySection
                title={notifyTitle} setTitle={setNotifyTitle}
                body={notifyBody} setBody={setNotifyBody}
                tickerHours={notifyHours} setTickerHours={setNotifyHours}
              />
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
  matchSub:   { fontSize: fontSize.xs, color: C.muted, marginTop: 2 },
  statusPill: { borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontSize: fontSize.xs, color: C.text, fontWeight: '600', textTransform: 'uppercase' },

  // Match Lock — delay panel
  delayPanel:      { backgroundColor: C.panel2, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  delayPanelLabel: { fontSize: fontSize.xs, color: C.muted, marginBottom: spacing.xs, marginTop: spacing.xs, textTransform: 'uppercase', fontWeight: '600' },
  delayBtnRow:     { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  delayBtn:        { flex: 1, backgroundColor: C.panel, borderWidth: 1, borderColor: C.accent, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
  delayBtnText:    { fontSize: fontSize.sm, fontWeight: '700', color: C.accent },
  manualTimeInput: { flex: 1, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: radius.md, padding: spacing.sm, fontSize: fontSize.base, color: C.text, textAlign: 'center' },
  abandonBtn:      { borderWidth: 1, borderColor: C.bad, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center', marginTop: spacing.xs },
  abandonBtnText:  { fontSize: fontSize.sm, fontWeight: '700', color: C.bad },

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
