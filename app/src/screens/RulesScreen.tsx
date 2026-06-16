/**
 * RulesScreen
 *
 * Tournament-specific rules page — tab next to Leaderboard.
 * Reads live from DB:
 *   • scoring_rules  (tournaments.scoring_rules JSONB)
 *   • available_boosters (contests.available_boosters string[])
 * Plus a static Private League concept section.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../lib/supabase';
import { useTournamentStore } from '../store/tournamentStore';
import { useContestStore }    from '../store/contestStore';
import { colors, fontSize, radius, spacing } from '../theme';

// ─── Gradient palette (matches rest of app) ───────────────────────────────────

const G = {
  bg:     ['#F5F0E0', '#EDE8D5', '#E8E2CE'] as const,
  header: ['rgba(245,240,224,0.98)', 'rgba(237,232,213,0.95)'] as const,
  card:   ['#FFFFFF', '#FAF8F2'] as const,
  accent: ['#C9A84C', '#B8912A'] as const,
};

// ─── Booster metadata ─────────────────────────────────────────────────────────

const BOOSTER_META: Record<string, { icon: string; name: string; desc: string }> = {
  triple_captain: {
    icon: '⚡',
    name: 'Triple Captain',
    desc: 'Your Captain scores 3× their base points for one match. Use once per season.',
  },
  dual_captain: {
    icon: '👥',
    name: 'Dual Captain',
    desc: 'Both Captain and Vice-Captain score 2× their base points for one match. Use once per season.',
  },
  team_double: {
    icon: '🚀',
    name: 'Team Double',
    desc: 'All 11 players score double points this matchweek. Use once per season.',
  },
  free_hit: {
    icon: '🔄',
    name: 'Free Hit',
    desc: 'One extra free transfer this matchweek at no points cost. Use once per season.',
  },
  wildcard: {
    icon: '♾️',
    name: 'Wildcard',
    desc: 'Unlimited transfers this matchweek, no points deduction. Use once per season.',
  },
  indian_double: {
    icon: '🇺🇸',
    name: 'US Double',
    desc: 'All US domestic (non-overseas) players in your XI score 2× this matchweek. Use once per season.',
  },
  os_double: {
    icon: '✈️',
    name: 'OS Double',
    desc: 'All overseas players in your XI score 2× their base points. Use once per season.',
  },
};

// ─── Scoring rule display config ──────────────────────────────────────────────

type RuleRow = { label: string; key: string; unit?: string };

const BATTING_ROWS: RuleRow[] = [
  { label: 'Run scored',          key: 'run',            unit: 'per run' },
  { label: 'Boundary (4)',        key: 'boundary4',      unit: 'bonus' },
  { label: 'Six (6)',             key: 'boundary6',      unit: 'bonus' },
  { label: 'Half-century (50)',   key: 'half_century',   unit: 'bonus' },
  { label: 'Century (100)',       key: 'century',        unit: 'bonus' },
  { label: 'Duck (dismissed 0)',  key: 'duck',           unit: 'pts' },
  { label: 'SR > 170',           key: 'sr_above_170',   unit: 'bonus' },
  { label: 'SR 140–170',         key: 'sr_140_to_170',  unit: 'bonus' },
  { label: 'SR 70–100',          key: 'sr_70_to_100',   unit: 'pts' },
  { label: 'SR < 70',            key: 'sr_below_70',    unit: 'pts' },
];

const BOWLING_ROWS: RuleRow[] = [
  { label: 'Wicket',              key: 'wicket',           unit: 'per wkt' },
  { label: '4-wicket haul',       key: 'four_wicket_haul', unit: 'bonus' },
  { label: '5-wicket haul',       key: 'five_wicket_haul', unit: 'bonus' },
  { label: 'Maiden over',         key: 'maiden_over',      unit: 'bonus' },
  { label: 'Dot ball',            key: 'dot_ball',         unit: 'per dot' },
  { label: 'Economy < 5',         key: 'economy_below_5',  unit: 'bonus' },
  { label: 'Economy 5–6',         key: 'economy_5_to_6',   unit: 'bonus' },
  { label: 'Economy 10–11',       key: 'economy_10_to_11', unit: 'pts' },
  { label: 'Economy > 11',        key: 'economy_above_11', unit: 'pts' },
];

const FIELDING_ROWS: RuleRow[] = [
  { label: 'Catch',               key: 'catch',            unit: 'pts' },
  { label: 'Stumping',            key: 'stumping',         unit: 'pts' },
  { label: 'Run-out (direct)',    key: 'run_out_direct',   unit: 'pts' },
  { label: 'Run-out (indirect)',  key: 'run_out_indirect', unit: 'pts' },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title, icon }: { title: string; icon: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionIcon}>{icon}</Text>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function RuleTable({
  title,
  rows,
  rules,
}: {
  title:  string;
  rows:   RuleRow[];
  rules:  Record<string, number>;
}) {
  const visibleRows = rows.filter(r => rules[r.key] !== undefined && rules[r.key] !== 0);
  if (!visibleRows.length) return null;

  return (
    <View style={styles.ruleTable}>
      <Text style={styles.tableTitle}>{title}</Text>
      {visibleRows.map((row, i) => {
        const val = rules[row.key];
        const isNeg = val < 0;
        return (
          <View
            key={row.key}
            style={[styles.tableRow, i % 2 === 0 && styles.tableRowAlt]}
          >
            <Text style={styles.tableLabel}>{row.label}</Text>
            <Text style={[styles.tableValue, isNeg && styles.tableValueNeg]}>
              {isNeg ? '' : '+'}{val} {row.unit ?? 'pts'}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function BoosterCard({ id }: { id: string }) {
  const meta = BOOSTER_META[id] ?? { icon: '🎯', name: id, desc: 'Special booster — use once per season.' };
  return (
    <LinearGradient colors={G.card} style={styles.boosterCard}>
      <Text style={styles.boosterIcon}>{meta.icon}</Text>
      <View style={styles.boosterBody}>
        <Text style={styles.boosterName}>{meta.name}</Text>
        <Text style={styles.boosterDesc}>{meta.desc}</Text>
      </View>
    </LinearGradient>
  );
}

function InfoCard({ children }: { children: React.ReactNode }) {
  return (
    <LinearGradient colors={G.card} style={styles.infoCard}>
      {children}
    </LinearGradient>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function RulesScreen() {
  const { selectedTournamentId, tournaments } = useTournamentStore();
  const { contests } = useContestStore();

  const tournament = tournaments.find(t => t.id === selectedTournamentId);

  const [rules, setRules]             = useState<Record<string, any> | null>(null);
  const [boosters, setBoosters]       = useState<string[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);

  const fmt = (tournament?.format ?? 'T20').toUpperCase() === 'ODI' ? 'ODI' : 'T20';

  useEffect(() => {
    if (!selectedTournamentId) { setLoading(false); return; }
    load();
  }, [selectedTournamentId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // 1. Scoring rules from tournament
      const { data: tData, error: tErr } = await supabase
        .from('tournaments')
        .select('scoring_rules')
        .eq('id', selectedTournamentId!)
        .single();
      if (tErr) throw tErr;

      const fmtRules = tData?.scoring_rules?.[fmt] ?? null;
      setRules(fmtRules);

      // 2. Boosters from the first active public contest (SL / daily)
      // Use already-loaded contests from store if available, else query
      let boosterList: string[] = [];
      if (contests.length) {
        const slContest = contests.find(c => c.contestType === 'sl' || c.contestType === 'daily');
        if (slContest) {
          const { data: cData } = await supabase
            .from('contests')
            .select('available_boosters')
            .eq('id', slContest.id)
            .single();
          boosterList = Array.isArray(cData?.available_boosters) ? cData.available_boosters : [];
        }
      } else {
        // Fallback: query directly
        const { data: cRows } = await supabase
          .from('contests')
          .select('available_boosters')
          .eq('tournament_id', selectedTournamentId!)
          .eq('is_active', true)
          .not('available_boosters', 'is', null)
          .limit(1)
          .single();
        boosterList = Array.isArray(cRows?.available_boosters) ? cRows.available_boosters : [];
      }
      setBoosters(boosterList);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load rules');
    } finally {
      setLoading(false);
    }
  }

  // ── Default T20 rules (shown when tournament has none configured) ─────────────
  const DEFAULT_RULES: Record<string, number> = {
    run: 1, boundary4: 1, boundary6: 2,
    half_century: 8, century: 16, duck: -2,
    sr_above_170: 6, sr_140_to_170: 4, sr_below_70: -6, sr_70_to_100: -4,
    wicket: 25, maiden_over: 8, dot_ball: 0,
    four_wicket_haul: 8, five_wicket_haul: 16,
    economy_below_5: 6, economy_5_to_6: 4, economy_10_to_11: -4, economy_above_11: -6,
    catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
  };

  const displayRules: Record<string, number> = rules ?? DEFAULT_RULES;
  const isDefault = !rules;

  return (
    <LinearGradient colors={G.bg} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <LinearGradient colors={G.header} style={styles.header}>
          <Text style={styles.headerTitle}>Rules</Text>
          {tournament && (
            <Text style={styles.headerSub}>
              {tournament.name} · {fmt}
            </Text>
          )}
        </LinearGradient>

        {loading ? (
          <View style={styles.centred}>
            <ActivityIndicator size="large" color={colors.accent} />
          </View>
        ) : error ? (
          <View style={styles.centred}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >

            {/* ── 1. Scoring ──────────────────────────────────────────────── */}
            <SectionHeader title="Scoring" icon="🏏" />

            {isDefault && (
              <View style={styles.defaultBadge}>
                <Text style={styles.defaultBadgeText}>
                  Showing default {fmt} scoring — admin can customise per tournament
                </Text>
              </View>
            )}

            <InfoCard>
              <Text style={styles.infoNote}>
                Each player earns points based on their in-match performance. Your XI total
                is the sum of all 11 players, with Captain earning <Text style={styles.infoEmph}>2×</Text> and
                Vice-Captain <Text style={styles.infoEmph}>1.5×</Text> their base points.
              </Text>
            </InfoCard>

            <RuleTable title="Batting"  rows={BATTING_ROWS}  rules={displayRules} />
            <RuleTable title="Bowling"  rows={BOWLING_ROWS}  rules={displayRules} />
            <RuleTable title="Fielding" rows={FIELDING_ROWS} rules={displayRules} />

            {/* ── 2. Boosters ─────────────────────────────────────────────── */}
            {boosters.length > 0 && (
              <>
                <SectionHeader title="Boosters" icon="⚡" />
                <InfoCard>
                  <Text style={styles.infoNote}>
                    Boosters are one-time power-ups available in Season Long and private leagues.
                    Only <Text style={styles.infoEmph}>one booster</Text> can be active per match.
                    Once used it cannot be reapplied.
                  </Text>
                </InfoCard>
                {boosters.map(id => (
                  <BoosterCard key={id} id={id} />
                ))}
              </>
            )}

            {/* ── 3. Private Leagues ──────────────────────────────────────── */}
            <SectionHeader title="Private Leagues" icon="🔒" />

            <InfoCard>
              <Text style={styles.infoNote}>
                Private leagues let you compete against a specific group of friends using
                a <Text style={styles.infoEmph}>shared player pool</Text> from this tournament.
              </Text>
            </InfoCard>

            {[
              {
                icon: '👥',
                heading: 'Same XI, different contest',
                body: 'Your XI is shared across the season-long contest and all private leagues you join — pick once, compete everywhere.',
              },
              {
                icon: '📋',
                heading: 'Custom base rules',
                body: 'Each private league can have its own scoring ruleset configured by the league admin — different from the public contest.',
              },
              {
                icon: '⚡',
                heading: 'Configurable boosters',
                body: 'The league admin chooses which boosters are available. A private league may offer a different booster set than the main contest.',
              },
              {
                icon: '🔑',
                heading: 'Joining',
                body: 'Ask the league creator for the invite code. Go to Home → Season Long → Leagues → Join with code.',
              },
            ].map(item => (
              <LinearGradient key={item.heading} colors={G.card} style={styles.conceptCard}>
                <Text style={styles.conceptIcon}>{item.icon}</Text>
                <View style={styles.conceptBody}>
                  <Text style={styles.conceptHeading}>{item.heading}</Text>
                  <Text style={styles.conceptText}>{item.body}</Text>
                </View>
              </LinearGradient>
            ))}

            <View style={{ height: 32 }} />
          </ScrollView>
        )}
      </SafeAreaView>
    </LinearGradient>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Layout
  centred: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl,
  },
  scroll: { padding: spacing.lg, paddingTop: spacing.md, gap: spacing.md },

  // Header
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontSize:   fontSize.xl,
    fontWeight: '800',
    color:      colors.text,
  },
  headerSub: {
    fontSize:  fontSize.sm,
    color:     colors.muted,
    marginTop: 2,
  },

  // Section header
  sectionHeader: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            spacing.sm,
    marginTop:      spacing.md,
    marginBottom:   spacing.xs,
  },
  sectionIcon:  { fontSize: 18 },
  sectionTitle: {
    fontSize:      fontSize.base,
    fontWeight:    '800',
    color:         colors.text,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },

  // Default badge
  defaultBadge: {
    backgroundColor: 'rgba(201,168,76,0.12)',
    borderWidth:     1,
    borderColor:     'rgba(201,168,76,0.3)',
    borderRadius:    radius.md,
    padding:         spacing.sm,
    marginBottom:    spacing.xs,
  },
  defaultBadgeText: {
    fontSize:  fontSize.sm,
    color:     colors.muted,
    textAlign: 'center',
  },

  // Info card
  infoCard: {
    borderRadius:  radius.lg,
    borderWidth:   1,
    borderColor:   colors.border,
    padding:       spacing.md,
    marginBottom:  spacing.xs,
  },
  infoNote: {
    fontSize:   fontSize.sm,
    color:      colors.muted,
    lineHeight: 18,
  },
  infoEmph: {
    fontWeight: '700',
    color:      colors.accent,
  },

  // Rule table
  ruleTable: {
    borderRadius:  radius.lg,
    borderWidth:   1,
    borderColor:   colors.border,
    overflow:      'hidden',
    marginBottom:  spacing.xs,
  },
  tableTitle: {
    fontSize:          fontSize.sm,
    fontWeight:        '700',
    color:             colors.muted,
    textTransform:     'uppercase',
    letterSpacing:     0.8,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm,
    backgroundColor:   'rgba(201,168,76,0.08)',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tableRow: {
    flexDirection:     'row',
    justifyContent:    'space-between',
    alignItems:        'center',
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm,
    backgroundColor:   '#FFFFFF',
  },
  tableRowAlt: {
    backgroundColor: '#FAF8F2',
  },
  tableLabel: {
    fontSize: fontSize.sm,
    color:    colors.text,
    flex:     1,
  },
  tableValue: {
    fontSize:   fontSize.sm,
    fontWeight: '700',
    color:      colors.good,
    minWidth:   72,
    textAlign:  'right',
  },
  tableValueNeg: {
    color: colors.bad,
  },

  // Booster cards
  boosterCard: {
    flexDirection:  'row',
    alignItems:     'flex-start',
    gap:            spacing.md,
    padding:        spacing.md,
    borderRadius:   radius.lg,
    borderWidth:    1,
    borderColor:    colors.border,
    marginBottom:   spacing.xs,
  },
  boosterIcon: { fontSize: 26, marginTop: 2 },
  boosterBody: { flex: 1 },
  boosterName: {
    fontSize:   fontSize.base,
    fontWeight: '700',
    color:      colors.text,
    marginBottom: 3,
  },
  boosterDesc: {
    fontSize:   fontSize.sm,
    color:      colors.muted,
    lineHeight: 18,
  },

  // Concept cards (Private League section)
  conceptCard: {
    flexDirection:  'row',
    alignItems:     'flex-start',
    gap:            spacing.md,
    padding:        spacing.md,
    borderRadius:   radius.lg,
    borderWidth:    1,
    borderColor:    colors.border,
    marginBottom:   spacing.xs,
  },
  conceptIcon:    { fontSize: 22, marginTop: 2 },
  conceptBody:    { flex: 1 },
  conceptHeading: {
    fontSize:   fontSize.base,
    fontWeight: '700',
    color:      colors.text,
    marginBottom: 3,
  },
  conceptText: {
    fontSize:   fontSize.sm,
    color:      colors.muted,
    lineHeight: 18,
  },

  errorText: { fontSize: fontSize.base, color: colors.bad, textAlign: 'center' },
});
