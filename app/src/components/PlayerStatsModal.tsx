/**
 * PlayerStatsModal — "Match-by-match history" popup opened from the 📊 stat
 * icon on a PlayerCard. Mobile port of index.html's openPlayerStatsModal:
 * same query (getPlayerMatchHistory), same line-formatting, same column
 * layout (Match / Performance / Pts), just rendered as a bottom sheet
 * instead of a centered web modal.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { Player } from '../types';
import { fontSize, radius, spacing } from '../theme';
import {
  getPlayerMatchHistory,
  PlayerMatchHistoryRow,
  formatBattingLine,
  formatBowlingLine,
  formatFieldingLine,
} from '../lib/playerHistory';

const C = {
  text:   '#1C1F26',
  muted:  '#7A7060',
  accent: '#C9A84C',
  gold:   '#92650A',
  border: 'rgba(201,168,76,0.22)',
} as const;

interface Props {
  visible:      boolean;
  player:       Player | null;
  tournamentId: string | null;
  onClose:      () => void;
}

export default function PlayerStatsModal({ visible, player, tournamentId, onClose }: Props) {
  const [rows, setRows]       = useState<PlayerMatchHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !player) { setRows([]); return; }
    let cancelled = false;
    setLoading(true);
    getPlayerMatchHistory(player.id, 8, tournamentId)
      .then(data => { if (!cancelled) setRows(data); })
      .catch(err => {
        console.warn('[PlayerStatsModal] getPlayerMatchHistory failed:', err);
        if (!cancelled) setRows([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, player, tournamentId]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              {player?.name ?? ''} — Match history
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
          </View>

          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator size="small" color={C.accent} />
            </View>
          ) : rows.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>No match history yet for this player.</Text>
            </View>
          ) : (
            <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
              <View style={styles.tableHeaderRow}>
                <Text style={[styles.th, styles.colMatch]}>Match</Text>
                <Text style={[styles.th, styles.colPerf]}>Performance</Text>
                <Text style={[styles.th, styles.colPts]}>Pts</Text>
              </View>
              {rows.map(r => {
                const oppCode = r.homeTeam === player?.team ? r.awayTeam : r.homeTeam;
                const lines = [
                  formatBattingLine(r.batting),
                  formatBowlingLine(r.bowling),
                  formatFieldingLine(r.fielding),
                ].filter(Boolean).join('\n');

                return (
                  <View key={r.matchId} style={styles.row}>
                    <View style={styles.colMatch}>
                      <Text style={styles.cellPrimary}>M{r.matchNumber ?? '?'}</Text>
                      <Text style={styles.cellMuted}>vs {oppCode || '?'}</Text>
                    </View>
                    <Text style={[styles.cellPrimary, styles.colPerf]}>{lines}</Text>
                    <Text style={[styles.cellPts, styles.colPts]}>
                      {r.rawPoints != null ? r.rawPoints : '-'}
                    </Text>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent:  'flex-end',
  },
  sheet: {
    backgroundColor:      '#FFFFFF',
    borderTopLeftRadius:  radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal:    spacing.lg,
    paddingTop:           spacing.lg,
    paddingBottom:        spacing.xl,
    maxHeight:            '80%',
  },
  header: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginBottom:   spacing.md,
  },
  title: {
    color:      C.text,
    fontSize:   fontSize.base,
    fontWeight: '700',
    flex:       1,
    marginRight: spacing.sm,
  },
  closeText: { color: C.muted, fontSize: fontSize.lg },

  center: { paddingVertical: spacing.xxl, alignItems: 'center' },
  emptyText: { color: C.muted, fontSize: fontSize.sm, textAlign: 'center' },

  scroll: { maxHeight: 380 },

  tableHeaderRow: {
    flexDirection:     'row',
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    paddingBottom:     spacing.xs,
    marginBottom:      spacing.xs,
  },
  th: {
    color:         C.muted,
    fontSize:      fontSize.xs,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  colMatch: { flex: 1 },
  colPerf:  { flex: 2 },
  colPts:   { width: 36, textAlign: 'right' },

  row: {
    flexDirection:     'row',
    paddingVertical:   spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(201,168,76,0.12)',
  },
  cellPrimary: { color: C.text, fontSize: fontSize.sm, lineHeight: 17 },
  cellMuted:   { color: C.muted, fontSize: fontSize.xs, marginTop: 1 },
  cellPts:     { color: C.text, fontSize: fontSize.sm, fontWeight: '700' },
});
