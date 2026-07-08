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
  Image,
  Pressable,
  StyleSheet,
  Text,
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

// ─── Player tile ─────────────────────────────────────────────────────────────

interface TileProps {
  player:         SelectedPlayer;
  onSetCaptaincy: (role: CaptaincyRole) => void;
  onRemove:       () => void;
  readOnly?:      boolean;
  /** Effective (pending-or-committed) booster for this match, or null — lifted
   *  up to CricketPitch so every tile in the XI reads the same single value. */
  boosterKey:     string | null;
}

function PlayerTile({ player, onSetCaptaincy, onRemove, readOnly, boosterKey }: TileProps) {
  const isCap = player.captaincy === 'captain';
  const isVC  = player.captaincy === 'vice_captain';

  // Mirrors web's pitchBoosterDecor exactly — same badge-icon-swap / jersey-ring
  // / bottom-left-badge rules, id by id, instead of a separate icon row.
  const decor = getTileBoosterDecor(player.captaincy, player.overseas, boosterKey);

  // Overseas ✈️ badge, top-left of the jersey — mirrors web's .pitch-os-badge.
  // Mobile never rendered this at all, so there was no way to SEE which
  // players os_double/indian_double actually applied to (they just looked
  // like every tile lit up the same, since nothing distinguished them).
  const format = useTeamStore(s => s.format);
  const showOsBadge = player.overseas && osCapApplies(format);

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
      <View style={styles.avatarWrap}>
        {/* C / VC badge — top-right corner, letter swapped for a booster icon
            (⚡ Triple Captain, 👥 Dual Captain) exactly like web's pitch-cbadge */}
        {(isCap || isVC) && (
          <View style={[styles.capBadge, isCap ? styles.capBadgeC : styles.capBadgeVC]}>
            <Text style={[styles.capBadgeText, isCap ? styles.capBadgeTextC : styles.capBadgeTextVC]}>
              {decor.badgeIcon ?? (isCap ? 'C' : 'VC')}
            </Text>
          </View>
        )}

        {/* Overseas badge — top-left, mirrors web's .pitch-os-badge */}
        {showOsBadge && (
          <View style={styles.osBadge}>
            <Text style={styles.osBadgeText}>✈️</Text>
          </View>
        )}

        {/* US Double badge — bottom-left, mirrors web's .pitch-usd-badge */}
        {decor.bottomLeftIcon && (
          <View style={styles.bottomLeftBadge}>
            <Text style={styles.bottomLeftBadgeText}>{decor.bottomLeftIcon}</Text>
          </View>
        )}

        <Jersey
          code={player.team}
          color1={player.teamColor}
          color2={player.teamColor2}
          size={32}
          variant="pitch"
          boosted={decor.boosted}
        />

        {/* Role icon — bottom-right of the jersey, mirrors web's .pitch-role-icon
            (WK/BAT/AR/BOWL artwork). Team-code text used to sit below the name
            here instead; it's redundant once the jersey already carries the
            team label, so it's gone and this takes its corner instead. */}
        <Image source={ROLE_ICON[player.role]} style={styles.roleIcon} resizeMode="contain" />
      </View>

      <Text style={styles.tileName} numberOfLines={1}>{shortName}</Text>
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
  boosterKey:     string | null;
}

function RoleZone({ role, flex, players, onSetCaptaincy, onRemove, isCenter, readOnly, boosterKey }: ZoneProps) {
  return (
    <View style={[
      styles.zone,
      { flex },
      isCenter && styles.zoneCenter,
    ]}>
      {/* Role-row label (WK/BAT/AR/BOWL chip) is hidden here — mirrors web's
          .pitch-role-lbl { display:none }. Team Double's 🚀 used to show once
          per row on this label instead of repeating per tile; it now renders
          on every tile via getTileBoosterDecor's bottomLeftIcon instead. */}

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
              boosterKey={boosterKey}
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

  // Single source of truth for "the booster in effect right now" — shared by
  // every tile so they can never disagree.
  const boosters = useBoosterStore(s => s.boosters);
  const boosterKey = boosters.find(b => b.status === 'active' || b.status === 'pending')?.id ?? null;

  return (
    <View style={styles.field}>
      <FieldBackground />

      <RoleZone role="wk"   flex={1}   players={wk}   onSetCaptaincy={onSetCaptaincy} onRemove={onRemove} readOnly={readOnly} boosterKey={boosterKey} />
      <RoleZone role="bat"  flex={1.8} players={bat}  onSetCaptaincy={onSetCaptaincy} onRemove={onRemove} readOnly={readOnly} boosterKey={boosterKey} />
      <RoleZone role="ar"   flex={1.4} players={ar}   onSetCaptaincy={onSetCaptaincy} onRemove={onRemove} isCenter readOnly={readOnly} boosterKey={boosterKey} />
      <RoleZone role="bowl" flex={1.8} players={bowl} onSetCaptaincy={onSetCaptaincy} onRemove={onRemove} readOnly={readOnly} boosterKey={boosterKey} />
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
  tile: {
    width:           56,
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
  // web's .pitch-role-icon (bottom:2px; right:calc(var(--tsz)*-0.18);
  // width/height:calc(var(--tsz)*0.44), scaled here off the jersey's 32px size).
  roleIcon: {
    position: 'absolute',
    bottom:   2,
    right:    -6,
    width:    14,
    height:   14,
    zIndex:   10,
  },

  // C / VC badge — top-right corner of the jersey, letter swapped for a
  // booster icon when one applies (see getTileBoosterDecor). Mirrors web's
  // .pitch-cbadge, including its slightly-protruding offset.
  capBadge: {
    position:       'absolute',
    top:             -5,
    right:           -6,
    width:           16,
    height:          16,
    borderRadius:    8,
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
    fontSize:   8,
    fontWeight: '900',
  },
  capBadgeTextC:  { color: '#1C1F26' },
  capBadgeTextVC: { color: '#7a5500' },

  // Overseas badge — top-left of the jersey, mirrors web's .pitch-os-badge.
  osBadge: {
    position:       'absolute',
    top:             -5,
    left:            -6,
    width:           16,
    height:          16,
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          10,
  },
  osBadgeText: {
    fontSize: 10,
  },

  // US Double badge — bottom-left of the jersey, mirrors web's .pitch-usd-badge.
  bottomLeftBadge: {
    position:       'absolute',
    bottom:          -2,
    left:            -6,
    width:           16,
    height:          16,
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          10,
  },
  bottomLeftBadgeText: {
    fontSize: 10,
  },
});
