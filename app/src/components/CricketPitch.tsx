/**
 * CricketPitch
 * Renders the selected XI on a cricket field — no scrolling.
 * The four role zones (WK / BAT / AR / BOWL) each take a proportional
 * slice of the available height via flex. Tiles are flex-stretched
 * so any number of players in a row always fills the width.
 */

import React, { useState } from 'react';
import {
  Image,
  LayoutChangeEvent,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Svg, {
  Defs,
  RadialGradient,
  LinearGradient,
  Stop,
  ClipPath,
  Ellipse,
  Rect,
  Line,
  G,
} from 'react-native-svg';
import { CaptaincyRole, MatchFormat, PlayerRole, SelectedPlayer } from '../types';
import { useBoosterStore, getTileBoosterDecor } from '../store/boosterStore';
import { useTeamStore, RULES } from '../store/teamStore';
import Jersey from './Jersey';

// True only when this tournament/format actually enforces an overseas cap —
// mirrors web's osCapApplies(). A cap of 0 or 11+ means "no restriction", so
// the overseas ✈️ badge on pitch jerseys is only worth showing when it does.
function osCapApplies(format: MatchFormat): boolean {
  const cap = RULES.maxOverseas[format] ?? 11;
  return cap > 0 && cap < 11;
}

// ─── Per-tile role icon — mirrors web's ROLE_ICON_P / .pitch-role-icon ────────
// Same PNGs web embeds as base64 (WK_IMG_P/BAT_IMG_P/AR_IMG_P/BALL_IMG_P in
// index.html), decoded to real files so mobile shows the identical artwork.

const ROLE_ICON: Record<PlayerRole, number> = {
  wk:   require('../../assets/role-icons/wk.png'),
  bat:  require('../../assets/role-icons/bat.png'),
  ar:   require('../../assets/role-icons/ar.png'),
  bowl: require('../../assets/role-icons/bowl.png'),
};

// ─── Field palette ────────────────────────────────────────────────────────────
// Mirrors web's #pitchXiWrap / .pitch-oval exactly: a flat dark-turf backdrop
// behind an SVG-drawn elliptical field (radial-gradient green, repeating
// mowing-stripe overlay, dashed outline, sandy pitch strip, creases) — see
// <FieldBackground> below. CSS radial/repeating gradients and clip-path
// ellipses have no Views-only equivalent in React Native, hence react-native-svg.

const WRAP_BG      = '#1a5c1a';   // outer turf backdrop, mirrors #pitchXiWrap/#slPitchXiWrap
const DIVIDER      = 'rgba(0,0,0,0.08)';

// ─── Adaptive jersey sizing ────────────────────────────────────────────────────
// Mirrors web's fitHistOval: jerseys shrink to fit a crowded row (many players
// sharing the same width) but never grow past a sensible ceiling even when a
// row (e.g. a lone WK) has plenty of room to spare — a single tile blown up to
// fill all available width would look comically oversized, not "well-fit".
// Previously every tile used one fixed 32px size regardless of row density,
// which read as uniformly too small — most rows had room to spare that a
// fixed size could never take advantage of.

const TSZ_MIN = 26;
const TSZ_MAX = 44;
const TILE_GAP    = 4;  // tilesRow's gap between tiles
const TILE_ROWPAD = 4;  // tilesRow's paddingHorizontal, both sides
// Fraction of a tile's own width taken up by the jersey itself (the rest is
// side breathing room for the C/VC and OS badges, which protrude slightly
// past the jersey's edges) — matches the previous fixed 32px jersey inside a
// 56px tile (32/56 ≈ 0.57), rounded to a cleaner constant.
const JERSEY_FRACTION = 0.6;

function fitTileSize(availWidth: number, count: number): number {
  if (count <= 0 || availWidth <= 0) return TSZ_MAX;
  const perTile = (availWidth - TILE_ROWPAD - TILE_GAP * (count - 1)) / count;
  const jerseySize = perTile * JERSEY_FRACTION;
  return Math.min(TSZ_MAX, Math.max(TSZ_MIN, Math.floor(jerseySize)));
}

// ─── Player tile ─────────────────────────────────────────────────────────────

interface TileProps {
  player:         SelectedPlayer;
  onSetCaptaincy: (role: CaptaincyRole) => void;
  onRemove:       () => void;
  onTilePress:    (player: SelectedPlayer) => void;
  readOnly?:      boolean;
  boosterKey:     string | null;
  tsz:            number;
}

function PlayerTile({ player, onSetCaptaincy, onRemove, onTilePress, readOnly, boosterKey, tsz }: TileProps) {
  const isCap = player.captaincy === 'captain';
  const isVC  = player.captaincy === 'vice_captain';

  const decor = getTileBoosterDecor(player.captaincy, player.overseas, boosterKey);

  const format = useTeamStore(s => s.format);
  const showOsBadge = player.overseas && osCapApplies(format);

  // "Virat Kohli" → "V. Kohli"
  const words     = player.name.trim().split(' ');
  const shortName = words.length > 1
    ? `${words[0][0]}. ${words.slice(1).join(' ')}`
    : words[0];

  const handlePress = () => {
    if (readOnly) return;
    onTilePress(player);
  };

  // Every badge/icon/font dimension below scales off this tile's fitted
  // jersey size (tsz) — same calc(var(--tsz)*N) relationships web's CSS uses
  // (see FieldBackground/fitTileSize comments), just computed in JS instead
  // of read from a CSS custom property.
  const badgeSize     = tsz * 0.44;
  const capTopOffset  = -tsz * 0.15;  // web's .pitch-cbadge: top factor differs from right
  const sideOffset    = -tsz * 0.18;  // web's .pitch-cbadge right / .pitch-os-badge / .pitch-usd-badge
  const capFontSize   = Math.max(7, tsz * 0.24);
  const sideFontSize  = Math.max(8, tsz * 0.3);
  const tileWidth     = tsz / JERSEY_FRACTION;
  const nameFontSize  = Math.max(8, tsz * 0.26);

  return (
    <Pressable
      style={({ pressed }) => [styles.tile, { width: tileWidth }, !readOnly && pressed && styles.tilePressed]}
      onPress={handlePress}
    >
      <View style={styles.avatarWrap}>
        {/* C / VC badge — top-right corner, letter swapped for a booster icon
            (⚡ Triple Captain, 👥 Dual Captain) exactly like web's pitch-cbadge */}
        {(isCap || isVC) && (
          <View style={[
            styles.capBadge,
            isCap ? styles.capBadgeC : styles.capBadgeVC,
            { width: badgeSize, height: badgeSize, borderRadius: badgeSize / 2, top: capTopOffset, right: sideOffset },
          ]}>
            <Text style={[styles.capBadgeText, isCap ? styles.capBadgeTextC : styles.capBadgeTextVC, { fontSize: capFontSize }]}>
              {decor.badgeIcon ?? (isCap ? 'C' : 'VC')}
            </Text>
          </View>
        )}

        {/* Overseas badge — top-left, mirrors web's .pitch-os-badge */}
        {showOsBadge && (
          <View style={[styles.osBadge, { width: badgeSize, height: badgeSize, top: sideOffset, left: sideOffset }]}>
            <Text style={{ fontSize: sideFontSize }}>✈️</Text>
          </View>
        )}

        {/* US Double badge — bottom-left, mirrors web's .pitch-usd-badge */}
        {decor.bottomLeftIcon && (
          <View style={[styles.bottomLeftBadge, { width: badgeSize, height: badgeSize, left: sideOffset }]}>
            <Text style={{ fontSize: sideFontSize }}>{decor.bottomLeftIcon}</Text>
          </View>
        )}

        <Jersey
          code={player.team}
          color1={player.teamColor}
          color2={player.teamColor2}
          size={tsz}
          variant="pitch"
          boosted={decor.boosted}
        />

        {/* Role icon — bottom-right of the jersey, mirrors web's .pitch-role-icon
            (WK/BAT/AR/BOWL artwork). Team-code text used to sit below the name
            here instead; it's redundant once the jersey already carries the
            team label, so it's gone and this takes its corner instead. */}
        <Image
          source={ROLE_ICON[player.role]}
          style={[styles.roleIcon, { width: badgeSize, height: badgeSize, right: sideOffset }]}
          resizeMode="contain"
        />
      </View>

      <Text style={[styles.tileName, { fontSize: nameFontSize }]} numberOfLines={1}>{shortName}</Text>
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
  onTilePress:    (player: SelectedPlayer) => void;
  isCenter?:      boolean;
  readOnly?:      boolean;
  boosterKey:     string | null;
  contentWidth:   number;
}

function RoleZone({ role, flex, players, onSetCaptaincy, onRemove, onTilePress, isCenter, readOnly, boosterKey, contentWidth }: ZoneProps) {
  const tsz = fitTileSize(contentWidth, players.length);
  return (
    <View style={[styles.zone, { flex }, isCenter && styles.zoneCenter]}>
      {players.length > 0 && (
        <View style={styles.tilesRow}>
          {players.map(p => (
            <PlayerTile
              key={p.id}
              player={p}
              onSetCaptaincy={(r) => onSetCaptaincy(p.id, r)}
              onRemove={() => onRemove(p.id)}
              onTilePress={onTilePress}
              readOnly={readOnly}
              boosterKey={boosterKey}
              tsz={tsz}
            />
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Field background (SVG) ───────────────────────────────────────────────────
// Single SVG standing in for web's two-layer field (.pitch-oval's CSS
// radial-gradient + repeating-linear-gradient background, plus the overlaid
// viewBox="0 0 304 460" accent SVG with the dashed outline / sandy pitch
// strip / crease lines / stump marks) — React Native has no CSS gradient or
// clip-path equivalent for Views, so both layers are merged into vector shapes
// here. preserveAspectRatio="none" matches web exactly: the 304x460 coordinate
// space stretches non-uniformly to fill whatever the tile's real aspect ratio is.

const MOW_STRIPE_Y: number[] = [];
for (let y = 0; y < 460; y += 48) MOW_STRIPE_Y.push(y);

function FieldBackground() {
  return (
    <Svg
      viewBox="0 0 304 460"
      preserveAspectRatio="none"
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    >
      <Defs>
        {/* Approximates web's radial-gradient(ellipse 80% 88% at 50% 50%, ...):
            true per-axis elliptical gradients aren't expressible in SVG/RNSVG
            without a gradientTransform, so this uses a single radius sized to
            the ellipse's longer (vertical) axis — the sides fade a shade
            lighter than web's exact edge tone, which is a minor, low-stakes
            difference given both ends are already near-black green. */}
        <RadialGradient id="fieldGrad" cx="152" cy="230" r="220" gradientUnits="userSpaceOnUse">
          <Stop offset="0%"   stopColor="#4ec94e" />
          <Stop offset="22%"  stopColor="#3aad3a" />
          <Stop offset="45%"  stopColor="#2b8f2b" />
          <Stop offset="65%"  stopColor="#1d6e1d" />
          <Stop offset="85%"  stopColor="#0f470f" />
          <Stop offset="100%" stopColor="#09300d" />
        </RadialGradient>
        <LinearGradient id="pitchGrad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%"   stopColor="#b8893a" />
          <Stop offset="40%"  stopColor="#d4a85a" />
          <Stop offset="60%"  stopColor="#d4a85a" />
          <Stop offset="100%" stopColor="#b8893a" />
        </LinearGradient>
        <ClipPath id="fieldClip">
          <Ellipse cx="152" cy="230" rx="148" ry="226" />
        </ClipPath>
      </Defs>

      {/* Green field ellipse — mirrors .pitch-oval's radial-gradient fill,
          inscribed edge-to-edge like clip-path:ellipse(50% 50% at 50% 50%). */}
      <Ellipse cx="152" cy="230" rx="148" ry="226" fill="url(#fieldGrad)" />

      {/* Mowing stripes — mirrors .pitch-oval::before's repeating-linear-gradient,
          clipped to the same ellipse. */}
      <G clipPath="url(#fieldClip)">
        {MOW_STRIPE_Y.map(y => (
          <Rect key={y} x="0" y={y + 24} width="304" height="24" fill="rgba(255,255,255,0.035)" />
        ))}
      </G>

      {/* Dashed ellipse outline, sandy pitch strip + crease + stump marks —
          mirrors the accent SVG overlay used identically across web's Daily,
          SL, and history pitch views. */}
      <Ellipse cx="152" cy="230" rx="145" ry="220" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={2} strokeDasharray="7 5" />
      <Rect x="134" y="140" width="36" height="180" rx="5" fill="url(#pitchGrad)" opacity={0.72} />
      <Line x1="120" y1="165" x2="184" y2="165" stroke="rgba(255,255,255,0.6)" strokeWidth={2} />
      <Line x1="120" y1="295" x2="184" y2="295" stroke="rgba(255,255,255,0.6)" strokeWidth={2} />
      <Line x1="147" y1="155" x2="147" y2="167" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <Line x1="152" y1="155" x2="152" y2="167" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <Line x1="157" y1="155" x2="157" y2="167" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <Line x1="147" y1="293" x2="147" y2="305" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <Line x1="152" y1="293" x2="152" y2="305" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <Line x1="157" y1="293" x2="157" y2="305" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
    </Svg>
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

  const boosters   = useBoosterStore(s => s.boosters);
  const boosterKey = boosters.find(b => b.status === 'active' || b.status === 'pending')?.id ?? null;

  const [fieldWidth, setFieldWidth]     = useState(0);
  const [activePlayer, setActivePlayer] = useState<SelectedPlayer | null>(null);
  const onFieldLayout = (e: LayoutChangeEvent) => setFieldWidth(e.nativeEvent.layout.width);
  const contentWidth = Math.max(0, fieldWidth - 12);

  const isCap = activePlayer?.captaincy === 'captain';
  const isVC  = activePlayer?.captaincy === 'vice_captain';

  return (
    <View style={styles.field} onLayout={onFieldLayout}>
      <FieldBackground />

      <RoleZone role="wk"   flex={1}   players={wk}   onSetCaptaincy={onSetCaptaincy} onRemove={onRemove} onTilePress={setActivePlayer} readOnly={readOnly} boosterKey={boosterKey} contentWidth={contentWidth} />
      <RoleZone role="bat"  flex={1.8} players={bat}  onSetCaptaincy={onSetCaptaincy} onRemove={onRemove} onTilePress={setActivePlayer} readOnly={readOnly} boosterKey={boosterKey} contentWidth={contentWidth} />
      <RoleZone role="ar"   flex={1.4} players={ar}   onSetCaptaincy={onSetCaptaincy} onRemove={onRemove} onTilePress={setActivePlayer} isCenter readOnly={readOnly} boosterKey={boosterKey} contentWidth={contentWidth} />
      <RoleZone role="bowl" flex={1.8} players={bowl} onSetCaptaincy={onSetCaptaincy} onRemove={onRemove} onTilePress={setActivePlayer} readOnly={readOnly} boosterKey={boosterKey} contentWidth={contentWidth} />

      {/* Player action sheet — one instance at field root, always visible, cross-platform */}
      <Modal
        transparent
        visible={activePlayer !== null}
        animationType="fade"
        onRequestClose={() => setActivePlayer(null)}
      >
        <Pressable style={styles.sheetOverlay} onPress={() => setActivePlayer(null)}>
          <View style={styles.sheetCard}>
            <Text style={styles.sheetPlayerName}>{activePlayer?.name}</Text>
            <Text style={styles.sheetMeta}>{activePlayer?.team} · {activePlayer?.role.toUpperCase()}</Text>
            <View style={styles.sheetDivider} />
            <TouchableOpacity style={styles.sheetBtn} onPress={() => { if (activePlayer) onSetCaptaincy(activePlayer.id, 'captain'); setActivePlayer(null); }}>
              <Text style={styles.sheetBtnText}>{isCap ? '★ Captain (set)' : 'Set Captain (C)'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetBtn} onPress={() => { if (activePlayer) onSetCaptaincy(activePlayer.id, 'vice_captain'); setActivePlayer(null); }}>
              <Text style={styles.sheetBtnText}>{isVC ? '★ Vice-Captain (set)' : 'Set Vice-Captain (VC)'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetBtn} onPress={() => { if (activePlayer) onRemove(activePlayer.id); setActivePlayer(null); }}>
              <Text style={[styles.sheetBtnText, styles.sheetBtnRemove]}>Remove</Text>
            </TouchableOpacity>
            <View style={styles.sheetDivider} />
            <TouchableOpacity style={styles.sheetBtn} onPress={() => setActivePlayer(null)}>
              <Text style={styles.sheetBtnCancel}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  field: {
    flex:              1,
    backgroundColor:   WRAP_BG,
    paddingHorizontal: 6,
    paddingVertical:   4,
    overflow:          'hidden',
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

  // Tiles row — centred so a single tile (e.g. lone WK) stays compact
  tilesRow: {
    flexDirection:     'row',
    justifyContent:    'center',
    flexWrap:          'wrap',
    gap:               4,
    paddingHorizontal: 2,
  },

  // Individual tile — no card/border, matches web's borderless floating
  // token (.pitch-player): just the jersey + name sitting on the green field.
  // width is always overridden per-tile (see PlayerTile's tileWidth, derived
  // from that row's fitted jersey size) — no static fallback needed since
  // CricketPitch always passes a real tsz down before first paint.
  tile: {
    alignItems:      'center',
    justifyContent:  'center',
    gap:             2,
    paddingVertical: 5,
    paddingHorizontal: 2,
    position:        'relative',
  },
  tilePressed: {
    opacity:   0.75,
    transform: [{ scale: 0.96 }],
  },

  // Jersey wrapper — relatively positioned so the C/VC and US-Double badges
  // can sit just outside its corners (mirrors web's .pitch-jwrap).
  avatarWrap: {
    position: 'relative',
  },

  // Name / team text — white with a shadow for legibility directly against
  // the green field, since there's no card background behind it anymore
  // (mirrors web's .pitch-nametag).
  tileName: {
    color:           '#ffffff',
    fontSize:        9,
    fontWeight:      '700',
    textAlign:       'center',
    letterSpacing:   0.2,
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset:{ width: 0, height: 1 },
    textShadowRadius: 3,
  },
  // Role icon (WK/BAT/AR/BOWL artwork) — bottom-right of the jersey, mirrors
  // web's .pitch-role-icon. bottom is fixed (web's is too — bottom:2px);
  // right/width/height scale with tsz, always passed in per-tile below.
  roleIcon: {
    position: 'absolute',
    bottom:   2,
    zIndex:   10,
  },

  // C / VC badge — top-right corner of the jersey, letter swapped for a
  // booster icon when one applies (see getTileBoosterDecor). Mirrors web's
  // .pitch-cbadge. Position/size scale with tsz (always passed in per-tile);
  // only the non-scaling visual properties live here.
  capBadge: {
    position:       'absolute',
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          10,
    shadowColor:     '#000',
    shadowOffset:    { width: 0, height: 1 },
    shadowOpacity:   0.5,
    shadowRadius:    2,
    elevation:       3,
  },
  capBadgeC:  { backgroundColor: '#C9A84C' },
  capBadgeVC: { backgroundColor: '#ffffffee' },
  capBadgeText: {
    fontWeight: '900',
  },
  capBadgeTextC:  { color: '#1C1F26' },
  capBadgeTextVC: { color: '#7a5500' },

  // Overseas badge — top-left of the jersey, mirrors web's .pitch-os-badge.
  // Position/size scale with tsz (always passed in per-tile).
  osBadge: {
    position:       'absolute',
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          10,
  },

  // US Double badge — bottom-left of the jersey, mirrors web's .pitch-usd-badge.
  // bottom is fixed (web's is too — bottom:2px); left/width/height scale with
  // tsz (always passed in per-tile).
  bottomLeftBadge: {
    position:       'absolute',
    bottom:          -2,
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          10,
  },

  // ── Player action sheet ──────────────────────────────────────────────────
  sheetOverlay: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent:  'flex-end',
  },
  sheetCard: {
    backgroundColor: '#fff',
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    paddingTop:      20,
    paddingBottom:   36,
    paddingHorizontal: 0,
  },
  sheetPlayerName: {
    fontSize:    18,
    fontWeight:  '700',
    color:       '#1C1F26',
    textAlign:   'center',
    paddingHorizontal: 24,
  },
  sheetMeta: {
    fontSize:   13,
    color:      '#7A7060',
    textAlign:  'center',
    marginTop:  4,
    marginBottom: 8,
    paddingHorizontal: 24,
  },
  sheetDivider: {
    height:          1,
    backgroundColor: '#e0d9c8',
    marginVertical:  4,
  },
  sheetBtn: {
    paddingVertical:   16,
    paddingHorizontal: 24,
  },
  sheetBtnText: {
    fontSize:   16,
    color:      '#00897B',
    fontWeight: '600',
    textAlign:  'center',
  },
  sheetBtnRemove: {
    color: '#C0392B',
  },
  sheetBtnCancel: {
    fontSize:   16,
    color:      '#7A7060',
    fontWeight: '700',
    textAlign:  'center',
  },
});
