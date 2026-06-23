/**
 * LiveScorecardModal — full live scorecard (batting/bowling per innings).
 * Mirrors web's admin "Live scorecard" panel (index.html's renderScorecard/
 * renderInnings/renderBatRow/renderBowlRow), reading the same match_scorecards
 * row via lib/liveScore.ts. Opened from HomeScreen's live-score pill and
 * LeaderboardScreen's live-match banner.
 */

import React from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fontSize, radius, spacing, shadow } from '../theme';
import { useLiveScore, LiveInnings } from '../lib/liveScore';

const G = {
  bg:     ['#F5F0E0', '#EDE8D5', '#E8E2CE'] as const,
  modal:  ['rgba(245,240,224,0.99)', 'rgba(237,232,213,0.99)'] as const,
};

const C = {
  text:   '#1C1F26',
  muted:  '#7A7060',
  accent: '#C9A84C',
  live:   '#C0392B',
  border: 'rgba(201,168,76,0.25)',
};

interface Props {
  visible: boolean;
  matchId: string | null;
  title?: string;
  onClose: () => void;
}

function InningsBlock({ inn, idx }: { inn: LiveInnings; idx: number }) {
  return (
    <View style={styles.inningsBlock}>
      <View style={styles.inningsHeaderRow}>
        <Text style={styles.inningsTitle}>{inn.team || `Innings ${idx + 1}`}</Text>
        <Text style={styles.inningsScore}>{inn.runs}/{inn.wickets} <Text style={styles.inningsOvers}>({inn.overs})</Text></Text>
      </View>

      {inn.batting.length > 0 && (
        <View style={styles.table}>
          <View style={styles.tableHeadRow}>
            <Text style={[styles.tableHeadCell, styles.colName]}>Batter</Text>
            <Text style={[styles.tableHeadCell, styles.colNum]}>R</Text>
            <Text style={[styles.tableHeadCell, styles.colNum]}>B</Text>
            <Text style={[styles.tableHeadCell, styles.colNum]}>4s</Text>
            <Text style={[styles.tableHeadCell, styles.colNum]}>6s</Text>
            <Text style={[styles.tableHeadCell, styles.colNum]}>SR</Text>
          </View>
          {inn.batting.map((b, i) => {
            const sr = b.balls ? ((b.runs / b.balls) * 100).toFixed(1) : '–';
            const showDismissal = b.dismissal && b.dismissal !== 'not out';
            return (
              <View key={i} style={[styles.tableRow, i % 2 === 1 && styles.tableRowAlt]}>
                <View style={[styles.colName, { gap: 1 }]}>
                  <Text style={styles.batterName} numberOfLines={1}>{b.name}</Text>
                  {showDismissal && <Text style={styles.dismissalText} numberOfLines={1}>{b.dismissal}</Text>}
                </View>
                <Text style={[styles.tableCell, styles.colNum]}>{b.runs}</Text>
                <Text style={[styles.tableCell, styles.colNum]}>{b.balls}</Text>
                <Text style={[styles.tableCell, styles.colNum]}>{b.fours}</Text>
                <Text style={[styles.tableCell, styles.colNum]}>{b.sixes}</Text>
                <Text style={[styles.tableCell, styles.colNum]}>{sr}</Text>
              </View>
            );
          })}
        </View>
      )}

      {inn.bowling.length > 0 && (
        <View style={[styles.table, { marginTop: spacing.sm }]}>
          <View style={styles.tableHeadRow}>
            <Text style={[styles.tableHeadCell, styles.colName]}>Bowler</Text>
            <Text style={[styles.tableHeadCell, styles.colNum]}>O</Text>
            <Text style={[styles.tableHeadCell, styles.colNum]}>M</Text>
            <Text style={[styles.tableHeadCell, styles.colNum]}>R</Text>
            <Text style={[styles.tableHeadCell, styles.colNum]}>W</Text>
            <Text style={[styles.tableHeadCell, styles.colNum]}>Econ</Text>
          </View>
          {inn.bowling.map((bw, i) => {
            const econ = bw.overs ? (bw.runs / bw.overs).toFixed(1) : '–';
            return (
              <View key={i} style={[styles.tableRow, i % 2 === 1 && styles.tableRowAlt]}>
                <Text style={[styles.tableCell, styles.colName]} numberOfLines={1}>{bw.name}</Text>
                <Text style={[styles.tableCell, styles.colNum]}>{bw.overs}</Text>
                <Text style={[styles.tableCell, styles.colNum]}>{bw.maidens}</Text>
                <Text style={[styles.tableCell, styles.colNum]}>{bw.runs}</Text>
                <Text style={[styles.tableCell, styles.colNum]}>{bw.wickets}</Text>
                <Text style={[styles.tableCell, styles.colNum]}>{econ}</Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

export default function LiveScorecardModal({ visible, matchId, title, onClose }: Props) {
  const { score, loading } = useLiveScore(visible ? matchId : null);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.root}>
        <LinearGradient colors={G.bg} style={StyleSheet.absoluteFill} />
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>

          <LinearGradient colors={G.modal} style={styles.header}>
            <Pressable style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
            <View style={{ flex: 1 }}>
              <View style={styles.liveRow}>
                <View style={styles.liveDot} />
                <Text style={styles.liveLabel}>LIVE</Text>
              </View>
              <Text style={styles.headerTitle} numberOfLines={1}>{title ?? 'Scorecard'}</Text>
            </View>
          </LinearGradient>

          {loading && !score ? (
            <View style={styles.center}><ActivityIndicator size="large" color={C.accent} /></View>
          ) : !score || score.innings.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>No innings data yet — match may not have started.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
              {score.status ? <Text style={styles.statusLine}>{score.status}</Text> : null}
              {score.innings.map((inn, idx) => (
                <InningsBlock key={idx} inn={inn} idx={idx} />
              ))}
            </ScrollView>
          )}

        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F5F0E0' },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  closeBtn: {
    width: 34, height: 34, borderRadius: radius.md,
    backgroundColor: 'rgba(0,0,0,0.05)', borderWidth: 1, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  closeBtnText: { color: C.text, fontSize: fontSize.base, fontWeight: '700' },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.live },
  liveLabel: { color: C.live, fontSize: fontSize.xs, fontWeight: '800', letterSpacing: 0.6 },
  headerTitle: { color: C.text, fontSize: fontSize.base, fontWeight: '800', marginTop: 2 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { color: C.muted, fontSize: fontSize.base, textAlign: 'center' },

  body: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  statusLine: { color: C.muted, fontSize: fontSize.sm, fontStyle: 'italic', marginBottom: -spacing.xs },

  inningsBlock: {
    borderWidth: 1, borderColor: C.border, borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.75)', padding: spacing.md, gap: spacing.sm,
    ...shadow.card,
  },
  inningsHeaderRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  inningsTitle: { color: C.text, fontSize: fontSize.base, fontWeight: '800', flex: 1 },
  inningsScore: { color: C.accent, fontSize: fontSize.lg, fontWeight: '800' },
  inningsOvers: { color: C.muted, fontSize: fontSize.sm, fontWeight: '500' },

  table: { gap: 2 },
  tableHeadRow: { flexDirection: 'row', paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: C.border },
  tableHeadCell: { color: C.muted, fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },
  tableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  tableRowAlt: { backgroundColor: 'rgba(0,0,0,0.025)' },
  tableCell: { color: C.text, fontSize: fontSize.sm },
  colName: { flex: 1, paddingRight: 4 },
  colNum:  { width: 32, textAlign: 'center', color: C.muted, fontSize: fontSize.xs },
  batterName: { color: C.text, fontSize: fontSize.sm, fontWeight: '600' },
  dismissalText: { color: C.muted, fontSize: 9 },
});
