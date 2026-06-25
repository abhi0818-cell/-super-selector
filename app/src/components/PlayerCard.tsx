import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Player } from '../types';
import { fontSize, radius, spacing, shadow } from '../theme';
import RoleTag from './RoleTag';
import Jersey from './Jersey';

interface Props {
  player:       Player;
  selected:     boolean;
  disabled:     boolean;
  onPress:      () => void;
  // Last-3 raw_points, newest first (undefined = not loaded yet, null entries = no data for that slot).
  recentForm?:  (number | null)[];
  // Opens the match-history modal. Omit to hide the stat row entirely.
  onStatsPress?: () => void;
}

const C = {
  text:    '#1C1F26',
  muted:   '#7A7060',
  accent:  '#C9A84C',
  good:    '#2D6A35',
  gold:    '#92650A',
  border:  'rgba(201,168,76,0.22)',
  borderS: 'rgba(201,168,76,0.55)',
} as const;

// Same thresholds/colors as web's form-pip classes (f-hi/f-mid/f-lo/f-na in
// index.html) so the two clients show identical form signals.
function pipStyle(pts: number | null | undefined): { bg: string; fg: string } {
  if (pts == null) return { bg: 'rgba(122,112,96,0.25)', fg: C.muted };
  if (pts >= 50)   return { bg: '#1d8a4a', fg: '#fff' };
  if (pts >= 25)   return { bg: '#b8860b', fg: '#fff' };
  return                  { bg: '#b03a3a', fg: '#fff' };
}

export default function PlayerCard({ player, selected, disabled, onPress, recentForm, onStatsPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.card,
        selected  && styles.cardSelected,
        disabled && !selected && styles.cardDisabled,
        pressed   && styles.cardPressed,
      ]}
    >
      <Jersey
        code={player.team}
        color1={player.teamColor}
        color2={player.teamColor2}
        size={34}
        variant="pool"
      />

      <View style={styles.left}>
        <Text style={styles.name} numberOfLines={1}>{player.name}</Text>
        <View style={styles.meta}>
          <RoleTag role={player.role} />
          <Text style={styles.team}>{player.team}</Text>
          {player.overseas && (
            <View style={styles.osTag}>
              <Text style={styles.osText}>✈️</Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.right}>
        <Text style={styles.credits}>{player.credits.toFixed(1)}</Text>
        <Text style={styles.creditsLabel}>CR</Text>

        {onStatsPress && (
          <View style={styles.statRow}>
            <View style={styles.pips}>
              {[0, 1, 2].map(i => {
                const pts = recentForm?.[i] ?? null;
                const { bg, fg } = pipStyle(pts);
                return (
                  <View key={i} style={[styles.pip, { backgroundColor: bg }]}>
                    <Text style={[styles.pipText, { color: fg }]}>
                      {pts == null ? '–' : Math.round(pts)}
                    </Text>
                  </View>
                );
              })}
            </View>
            <Pressable onPress={onStatsPress} hitSlop={8} style={styles.statBtn}>
              <Text style={styles.statBtnText}>📊</Text>
            </Pressable>
          </View>
        )}
      </View>

      {selected && (
        <View style={styles.checkBadge}>
          <Text style={styles.checkText}>✓</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderWidth:     1,
    borderColor:     C.border,
    borderRadius:    radius.lg,
    padding:         spacing.md,
    flexDirection:   'row',
    alignItems:      'center',
    gap:             spacing.sm,
    ...shadow.card,
  },
  cardSelected: {
    borderColor:     C.borderS,
    backgroundColor: 'rgba(201,168,76,0.1)',
  },
  cardDisabled: {
    opacity: 0.38,
  },
  cardPressed: {
    transform: [{ scale: 0.98 }],
    opacity:   0.85,
  },

  left: {
    flex: 1,
    gap:  4,
  },
  name: {
    color:      C.text,
    fontSize:   fontSize.base,
    fontWeight: '600',
  },
  meta: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           6,
    flexWrap:      'wrap',
  },
  team: {
    color:    C.muted,
    fontSize: fontSize.sm,
  },
  osTag: {
    paddingHorizontal: 5,
    paddingVertical:   1,
    borderRadius:      radius.sm - 2,
    backgroundColor:   'rgba(201,168,76,0.12)',
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.30)',
    overflow:          'hidden',
  },
  osText: {
    fontSize: 12,
  },

  right: {
    alignItems: 'flex-end',
  },
  credits: {
    color:      C.gold,
    fontSize:   fontSize.base,
    fontWeight: '700',
  },
  creditsLabel: {
    color:         C.muted,
    fontSize:      fontSize.xs,
    letterSpacing: 0.5,
  },

  statRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
    marginTop:     4,
  },
  pips: {
    flexDirection: 'row',
    gap:           3,
  },
  pip: {
    width:          16,
    height:         16,
    borderRadius:   4,
    alignItems:     'center',
    justifyContent: 'center',
  },
  pipText: {
    fontSize:   9,
    fontWeight: '700',
  },
  statBtn: {
    paddingHorizontal: 2,
    paddingVertical:   1,
  },
  statBtnText: {
    fontSize: 13,
  },

  checkBadge: {
    width:          20,
    height:         20,
    borderRadius:   radius.full,
    backgroundColor: C.accent,
    alignItems:     'center',
    justifyContent: 'center',
    position:       'absolute',
    top:            -6,
    right:          -6,
  },
  checkText: {
    color:      '#1C1F26',
    fontSize:   11,
    fontWeight: '800',
  },
});
