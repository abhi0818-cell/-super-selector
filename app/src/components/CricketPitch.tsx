/**
 * CricketPitch
 * Renders the selected XI on a cricket field — no scrolling.
 * The four role zones (WK / BAT / AR / BOWL) each take a proportional
 * slice of the available height via flex. Tiles are flex-stretched
 * so any number of players in a row always fills the width.
 */

import React from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CaptaincyRole, PlayerRole, SelectedPlayer } from '../types';
import { useBoosterStore, getActiveTileBoosts } from '../store/boosterStore';

// ─── Field palette ────────────────────────────────────────────────────────────

const FIELD_BG     = '#1A3B1E';   // dark forest green (field stays green for realism)
const FIELD_OVAL   = '#2D6A35';   // medium green oval
const PITCH_SANDY  = '#B8935A';   // warmer sandy/clay pitch
const CREASE_LINE  = 'rgba(255,255,255,0.45)';
const DIVIDER      = 'rgba(0,0,0,0.08)';

// ─── Role colours (fallback when no team color is set) ────────────────────────
// Used only for the avatar background when player.teamColor is null.

const ROLE_COLOR: Record<PlayerRole, string> = {
  wk:   '#C9A84C',   // gold
  bat:  '#1A2744',   // dark navy
  ar:   '#2D6A35',   // dark green
  bowl: '#7A3012',   // dark terracotta
};

// ─── Role chip colours — must be legible on the dark green field ──────────────
// Bright/light tones that stand out against FIELD_BG (#1A3B1E) and FIELD_OVAL (#2D6A35).

const ROLE_CHIP_COLOR: Record<PlayerRole, string> = {
  wk:   '#FDE68A',   // bright amber
  bat:  '#93C5FD',   // sky blue
  ar:   '#6EE7B7',   // mint — distinct from the green field
  bowl: '#FCA5A5',   // coral / soft red
};

const ROLE_LABEL: Record<PlayerRole, string> = {
  wk:   'WK',
  bat:  'BAT',
  ar:   'AR',
  bowl: 'BOWL',
};

// ─── Player tile ─────────────────────────────────────────────────────────────

interface TileProps {
  player:         SelectedPlayer;
  onSetCaptaincy: (role: CaptaincyRole) => void;
  onRemove:       () => void;
  readOnly?:      boolean;
}

function PlayerTile({ player, onSetCaptaincy, onRemove, readOnly }: TileProps) {
  const isCap = player.captaincy === 'captain';
  const isVC  = player.captaincy === 'vice_captain';

  // Directly select the boosters array — Zustand tracks this reference properly.
  // activeBoosters() is a derived method and can miss reactivity in some builds.
  const boosters   = useBoosterStore(s => s.boosters);
  const tileBoosts = getActiveTileBoosts(
    player.captaincy,
    boosters.filter(b => b.status === 'active'),
  );

  // "Virat Kohli" → "V. Kohli"
  const words     = player.name.trim().split(' ');
  const shortName = words.length > 1
    ? `${words[0][0]}. ${words.slice(1).join(' ')}`
    : words[0];

  const handlePress = () => {
    if (readOnly) return;
    Alert.alert(player.name, `${player.team} · ${player.role.toUpperCase()}`, [
      { text: isCap ? '★ Captain (set)' : 'Set Captain (C)',            onPress: () => onSetCaptaincy('captain') },
      { text: isVC  ? '★ Vice-Captain (set)' : 'Set Vice-Captain (VC)', onPress: () => onSetCaptaincy('vice_captain') },
      { text: 'Remove',  style: 'destructive', onPress: onRemove },
      { text: 'Cancel',  style: 'cancel' },
    ]);
  };

  return (
    <Pressable
      style={({ pressed }) => [styles.tile, !readOnly && pressed && styles.tilePressed]}
      onPress={handlePress}
    >
      {/* C / VC badge — top-right corner */}
      {(isCap || isVC) && (
        <View style={[styles.capBadge, isCap ? styles.capBadgeC : styles.capBadgeVC]}>
          <Text style={styles.capBadgeText}>{isCap ? 'C' : 'VC'}</Text>
        </View>
      )}

      <View style={[
        styles.avatar,
        { backgroundColor: player.teamColor ?? ROLE_COLOR[player.role] },
        (isCap || isVC) && styles.avatarHighlight,
      ]}>
        <Text style={styles.avatarInitial}>
          {player.name.charAt(0).toUpperCase()}
        </Text>
      </View>

      <Text style={styles.tileName} numberOfLines={1}>{shortName}</Text>
      <Text style={styles.tileTeam} numberOfLines={1}>{player.team}</Text>

      {/* Booster icon badges — one per active booster that applies to this tile */}
      {tileBoosts.length > 0 && (
        <View style={styles.boostRow}>
          {tileBoosts.map(b => (
            <View key={b.id} style={styles.boostBadge}>
              <Text style={styles.boostIcon}>{b.icon}</Text>
            </View>
          ))}
        </View>
      )}
    </Pressable>
  );
}

// ─── Role zone ────────────────────────────────────────────────────────────────

interface ZoneProps {
  role:           PlayerRole;
  flex:           number;
  players:        SelectedPlayer[];
  onSetCaptaincy: (id: string, role: CaptaincyRole) => void;
  onRemove:       (id: string) => void;
  isCenter?:      boolean;
  readOnly?:      boolean;
}

function RoleZone({ role, flex, players, onSetCaptaincy, onRemove, isCenter, readOnly }: ZoneProps) {
  return (
    <View style={[
      styles.zone,
      { flex },
      isCenter && styles.zoneCenter,
    ]}>
      {/* Role chip */}
      <View style={styles.chipRow}>
        <View style={styles.chipLine} />
        <View style={[styles.chip, { borderColor: ROLE_CHIP_COLOR[role] + '66', backgroundColor: ROLE_CHIP_COLOR[role] + '22' }]}>
          <Text style={[styles.chipText, { color: ROLE_CHIP_COLOR[role] }]}>
            {ROLE_LABEL[role]}
          </Text>
        </View>
        <View style={styles.chipLine} />
      </View>

      {/* Tiles — flex-1 each so they fill the row regardless of count */}
      {players.length > 0 && (
        <View style={styles.tilesRow}>
          {players.map(p => (
            <PlayerTile
              key={p.id}
              player={p}
              onSetCaptaincy={(r) => onSetCaptaincy(p.id, r)}
              onRemove={() => onRemove(p.id)}
              readOnly={readOnly}
            />
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  players:        SelectedPlayer[];
  onSetCaptaincy: (id: string, role: CaptaincyRole) => void;
  onRemove:       (id: string) => void;
  readOnly?:      boolean;
}

export default function CricketPitch({ players, onSetCaptaincy, onRemove, readOnly }: Props) {
  const wk   = players.filter(p => p.role === 'wk');
  const bat  = players.filter(p => p.role === 'bat');
  const ar   = players.filter(p => p.role === 'ar');
  const bowl = players.filter(p => p.role === 'bowl');

  return (
    <View style={styles.field}>
      {/* Oval grass field */}
      <View style={styles.fieldOval} pointerEvents="none" />

      {/* Vertical sandy pitch strip (center) */}
      <View style={styles.pitchStrip} pointerEvents="none" />

      {/* Crease lines */}
      <View style={styles.creaseTop}    pointerEvents="none" />
      <View style={styles.creaseBottom} pointerEvents="none" />

      <RoleZone role="wk"   flex={1}   players={wk}   onSetCaptaincy={onSetCaptaincy} onRemove={onRemove} readOnly={readOnly} />
      <RoleZone role="bat"  flex={1.8} players={bat}  onSetCaptaincy={onSetCaptaincy} onRemove={onRemove} readOnly={readOnly} />
      <RoleZone role="ar"   flex={1.4} players={ar}   onSetCaptaincy={onSetCaptaincy} onRemove={onRemove} isCenter readOnly={readOnly} />
      <RoleZone role="bowl" flex={1.8} players={bowl} onSetCaptaincy={onSetCaptaincy} onRemove={onRemove} readOnly={readOnly} />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  field: {
    flex:              1,
    backgroundColor:   FIELD_BG,
    paddingHorizontal: 6,
    paddingVertical:   4,
    overflow:          'hidden',
  },

  // Oval green grass — narrower left/right insets so it stays portrait-shaped
  fieldOval: {
    position:        'absolute',
    top:             '1%',
    bottom:          '1%',
    left:            '12%',
    right:           '12%',
    backgroundColor: FIELD_OVAL,
    borderRadius:    1000,
    borderWidth:     1,
    borderColor:     'rgba(255,255,255,0.04)',
  },

  // Vertical sandy pitch strip
  pitchStrip: {
    position:        'absolute',
    left:            '42%',
    right:           '42%',
    top:             '20%',
    bottom:          '20%',
    backgroundColor: PITCH_SANDY,
    borderRadius:    6,
    opacity:         0.55,
  },

  // Batting crease lines
  creaseTop: {
    position:        'absolute',
    left:            '42%',
    right:           '42%',
    top:             '26%',
    height:          1.5,
    backgroundColor: CREASE_LINE,
  },
  creaseBottom: {
    position:        'absolute',
    left:            '42%',
    right:           '42%',
    bottom:          '26%',
    height:          1.5,
    backgroundColor: CREASE_LINE,
  },

  // Zone (one per role)
  zone: {
    justifyContent: 'center',
    borderTopWidth: 1,
    borderTopColor: DIVIDER,
    paddingVertical: 2,
    gap:             4,
  },
  zoneCenter: {
    borderTopWidth:    0,
    marginHorizontal: -6,
    paddingHorizontal: 6,
  },

  // Role chip label
  chipRow: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            6,
  },
  chipLine: {
    flex:            1,
    height:          1,
    backgroundColor: DIVIDER,
  },
  chip: {
    borderWidth:      1,
    borderRadius:     20,
    paddingHorizontal: 8,
    paddingVertical:   1,
    backgroundColor:  'rgba(0,0,0,0.25)',
  },
  chipText: {
    fontSize:      9,
    fontWeight:    '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // Tiles row — centred so a single tile (e.g. lone WK) stays compact
  tilesRow: {
    flexDirection:     'row',
    justifyContent:    'center',
    flexWrap:          'wrap',
    gap:               4,
    paddingHorizontal: 2,
  },

  // Individual tile — fixed width so it never inflates to fill the row
  tile: {
    width:           56,
    alignItems:      'center',
    justifyContent:  'center',
    gap:             2,
    paddingVertical: 5,
    paddingHorizontal: 2,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius:    10,
    borderWidth:     1,
    borderColor:     'rgba(0,0,0,0.1)',
    position:        'relative',
  },
  tilePressed: {
    backgroundColor: 'rgba(201,168,76,0.2)',
    borderColor:     'rgba(201,168,76,0.5)',
    transform:       [{ scale: 0.96 }],
  },

  // Avatar
  avatar: {
    width:          34,
    height:         34,
    borderRadius:   17,
    alignItems:     'center',
    justifyContent: 'center',
  },
  avatarHighlight: {
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.65)',
  },
  avatarInitial: {
    color:      '#fff',
    fontSize:   15,
    fontWeight: '800',
  },

  // Name / team text
  tileName: {
    color:         '#1C1F26',
    fontSize:      9,
    fontWeight:    '700',
    textAlign:     'center',
    letterSpacing: 0.2,
  },
  tileTeam: {
    color:         'rgba(28,31,38,0.55)',
    fontSize:      8,
    textAlign:     'center',
    letterSpacing: 0.3,
    fontWeight:    '500',
  },

  // Booster icon row — sits at the bottom of the tile
  boostRow: {
    flexDirection:  'row',
    gap:             2,
    justifyContent: 'center',
    flexWrap:        'wrap',
    marginTop:       1,
  },
  boostBadge: {
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderRadius:     4,
    paddingHorizontal: 2,
    paddingVertical:   0,
    borderWidth:      1,
    borderColor:      'rgba(0,0,0,0.1)',
  },
  boostIcon: {
    fontSize:   9,
    lineHeight: 13,
  },

  // C / VC badge
  capBadge: {
    position:       'absolute',
    top:             3,
    right:           3,
    width:           16,
    height:          16,
    borderRadius:    8,
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          10,
  },
  capBadgeC:  { backgroundColor: '#C9A84C' },
  capBadgeVC: { backgroundColor: '#7A7060' },
  capBadgeText: {
    color:      '#1C1F26',
    fontSize:   8,
    fontWeight: '900',
  },
});
