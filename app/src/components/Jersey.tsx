/**
 * Jersey — cricket-jersey-shaped player/team avatar.
 *
 * Ports web's `jerseyHtml()` (player pool, index.html ~L7073) and
 * `pitchJerseyHtml()` (pitch views, index.html ~L13752) to native SVG via
 * react-native-svg. Same path data, same viewBox (141x179), same
 * length-based font auto-shrink, same `-W` suffix-stripping rule for
 * women's team codes on the overlaid label.
 *
 * Two variants (both use the same luminance-aware label color — readable
 * against light jersey colors like TSK's, not just dark ones; 'pool' used
 * to hardcode white unconditionally, which is the bug this fixed):
 *   - 'pool'  — player pool rows & the C/VC picker grid. Larger base font.
 *               Mirrors jerseyHtml().
 *   - 'pitch' — the pitch map. Smaller base font, plus an optional thick
 *               gold ring when a booster is active on this tile.
 *               Mirrors pitchJerseyHtml().
 */

import React, { useId } from 'react';
import { View } from 'react-native';
import Svg, { Path, Text as SvgText, SvgXml, Image as SvgImage, ClipPath, Circle, Defs } from 'react-native-svg';

export interface JerseyProps {
  code:      string | null | undefined; // team short code, e.g. 'CSK' or 'AUS-W'
  color1?:   string | null;             // primary/body color (teams.color)
  color2?:   string | null;             // secondary/sleeve color (teams.color2)
  jerseySvg?: string | null;            // optional custom design (teams.jersey_svg) — takes over from color1/color2 when set
  size?:     number;                    // rendered width in px; height follows the 141:179 aspect ratio
  variant?: 'pool' | 'pitch';
  boosted?: boolean;                   // 'pitch' only — active booster on this tile
  // Background-removed, head-and-neck-cropped player photo (players.photo_url —
  // see migration_v45). Jersey itself doesn't check the show_player_photos
  // kill switch (migration_v46) — teamStore.loadPlayers() already nulls this
  // out on every Player object when the switch is off (gated once, upstream,
  // rather than in every Jersey call site), so callers can just pass
  // player.photoUrl straight through.
  // When absent, falls back to today's plain jersey (no head) rather than a
  // generic silhouette — a real "no-photo" placeholder design was discussed
  // but never finalized (see the CPL photo-sourcing conversation), so v1
  // deliberately doesn't ship one to avoid reusing one real player's face as
  // a stand-in for everyone without a photo.
  photoUrl?: string | null;
}

const VIEWBOX_W = 141;
const VIEWBOX_H = 179;

const BODY_PATH     = 'M 48,8 L 82.5,8.3 L 89.5,16.8 L 42.5,15.8 L 82,8 L 90,18 L 115,32 L 127.5,70.3 L 107.5,78.8 L 98.5,61.8 L 105,165 L 65.5,166.3 L 25,166 L 31.5,59.8 L 21.5,78.3 L 3,65 L 14,32 L 42,16 Z';
const L_SLEEVE_PATH = 'M 3,65 L 21.5,78.3 L 31.5,59.8 L 42,16 L 14,32 Z';
const R_SLEEVE_PATH = 'M 127.5,70.3 L 107.5,78.8 L 98.5,61.8 L 90,18 L 115,32 Z';
const COLLAR_PATH   = 'M 48,8 L 82.5,8.3 L 89.5,16.8 L 42.5,15.8 Z';

// Same rule as web's jerseyHtml/pitchJerseyHtml/pitchTeamLabel: drop a
// trailing '-W' (women's team suffix) from the label shown ON the jersey
// only — the full code with '-W' is still shown elsewhere in meta text.
function jerseyLabel(code: string | null | undefined): string {
  return (code || '??').replace(/-W$/, '').toUpperCase().slice(0, 6);
}

// Ports web's injectJerseyLabel() (index.html, jerseyHtml/pitchJerseyHtml) —
// inserts a <text> element right before the pasted SVG's closing tag, in
// the same viewBox units the app's own jersey paths use. White fill + a
// dark stroke keeps it legible against whatever colors the custom design
// happens to use, since we can't compute luminance against markup we don't
// parse.
function injectJerseyLabel(svgMarkup: string, label: string, fontSizeViewboxUnits: number): string {
  const textEl = `<text x="65" y="118" text-anchor="middle" alignment-baseline="middle" font-family="Arial Black,Arial,sans-serif" font-size="${fontSizeViewboxUnits}" font-weight="900" fill="#fff" stroke="rgba(0,0,0,.65)" stroke-width="2" paint-order="stroke" opacity=".95">${label}</text>`;
  const idx = svgMarkup.lastIndexOf('</svg>');
  if (idx === -1) return svgMarkup;
  return svgMarkup.slice(0, idx) + textEl + svgMarkup.slice(idx);
}

// Mirrors pitchJerseyHtml's luminance check — picks readable text against
// light jersey colors instead of always assuming a dark one.
function readableTextColor(hex: string): string {
  const h = (hex + '000000').replace('#', '');
  const r = parseInt(h.substr(0, 2), 16) || 0;
  const g = parseInt(h.substr(2, 2), 16) || 0;
  const b = parseInt(h.substr(4, 2), 16) || 0;
  return (r * 299 + g * 587 + b * 114) / 1000 > 145 ? '#111111' : '#ffffff';
}

// Head placement, in the same 141x179 viewBox units as BODY_PATH/COLLAR_PATH
// above (these numbers were tuned visually against real player photos in the
// PIL-mockup prototyping pass before any of this was written — see the CPL
// photo-sourcing conversation for the iteration history, e.g. why the head
// sits slightly overlapping the collar rather than flush above it).
const HEAD_RADIUS = 24;
const HEAD_CX = 65.25; // collar's horizontal center — matches the label's x
const HEAD_CY = 8 - HEAD_RADIUS + 10; // collar top (y=8) minus radius, +10 overlap onto the collar for a neck join

export default function Jersey({
  code,
  color1,
  color2,
  jerseySvg,
  size = 44,
  variant = 'pool',
  boosted = false,
  photoUrl,
}: JerseyProps) {
  const bodyColor   = color1 || '#888888';
  const sleeveColor = color2 || '#333333';
  const label       = jerseyLabel(code);
  const isPool      = variant === 'pool';

  // Same breakpoints as web, scaled per-variant (pool base 36, pitch base 26).
  const fontSize = isPool
    ? label.length <= 2 ? 36 : label.length <= 3 ? 30 : label.length <= 4 ? 24 : 19
    : label.length <= 2 ? 26 : label.length <= 3 ? 22 : label.length <= 4 ? 18 : 14;

  // Luminance-aware label color for both variants — this used to hardcode
  // white for 'pool' unconditionally (mirroring web's old jerseyHtml()),
  // which is unreadable against light jersey colors (e.g. TSK): the pitch
  // view already computed this correctly, the pool view didn't. Same
  // formula everywhere now so a team's jersey text color is consistent
  // between the player pool and Pick 11.
  const textColor   = readableTextColor(bodyColor);
  const boostActive = !isPool && boosted;
  const strokeColor = boostActive ? '#FFD23F' : 'rgba(17,17,17,0.2)';
  const strokeWidth = boostActive ? 6 : 1.5;
  const height      = size * (VIEWBOX_H / VIEWBOX_W);
  const rawClipId   = useId();
  // useId() can return characters (colons) that are invalid in an SVG/CSS id
  // — strip them so url(#...) references reliably resolve on every platform
  // (this bit RN Web specifically; native react-native-svg is more lenient).
  const clipId      = `jerseyHeadClip-${rawClipId.replace(/[^a-zA-Z0-9]/g, '')}`;

  // The circular-clipped photo, layered ON TOP of the collar (real photo
  // sits fully in front of the jersey, unlike a silhouette placeholder,
  // which would sit behind it — see the CPL photo-sourcing conversation for
  // why photo vs. silhouette are layered in opposite orders). Shared between
  // both render branches below since head placement is identical either way.
  const photoLayer = photoUrl ? (
    <>
      <Defs>
        <ClipPath id={clipId}>
          <Circle cx={HEAD_CX} cy={HEAD_CY} r={HEAD_RADIUS} />
        </ClipPath>
      </Defs>
      <SvgImage
        href={{ uri: photoUrl }}
        x={HEAD_CX - HEAD_RADIUS}
        y={HEAD_CY - HEAD_RADIUS}
        width={HEAD_RADIUS * 2}
        height={HEAD_RADIUS * 2}
        preserveAspectRatio="xMidYMid slice"
        clipPath={`url(#${clipId})`}
      />
    </>
  ) : null;

  // Custom per-team design (teams.jersey_svg) takes over from the color-fill
  // rendering below. The team-code label is injected as a real <text>
  // element INTO the pasted SVG's own viewBox coordinate space (same trick
  // as web's injectJerseyLabel()) rather than an overlaid RN <Text> — an
  // overlay would need to independently duplicate the SVG's exact rendered
  // size to line up, and a first pass that computed its font size in real
  // pixels (instead of viewBox units) rendered wildly oversized on the
  // player-pool tile. Living inside the SVG scales for free with whatever
  // `size` this instance is given, exactly like the color-fill path below.
  if (jerseySvg) {
    const withLabel = injectJerseyLabel(jerseySvg, label, fontSize);
    return (
      <View style={{ width: size, height, position: 'relative' }}>
        <SvgXml xml={withLabel} width={size} height={height} />
        {photoUrl && (
          <Svg
            width={size}
            height={height}
            viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
            style={{ position: 'absolute', left: 0, top: 0 }}
          >
            {photoLayer}
          </Svg>
        )}
        {boostActive && (
          <Svg
            width={size}
            height={height}
            viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
            style={{ position: 'absolute', left: 0, top: 0 }}
          >
            <Path d={BODY_PATH} fill="none" stroke="#FFD23F" strokeWidth={6} strokeLinejoin="round" />
          </Svg>
        )}
      </View>
    );
  }

  return (
    <Svg width={size} height={height} viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}>
      <Path
        d={BODY_PATH}
        fill={bodyColor}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <Path d={L_SLEEVE_PATH} fill={sleeveColor} opacity={0.9} />
      <Path d={R_SLEEVE_PATH} fill={sleeveColor} opacity={0.9} />
      <Path d={COLLAR_PATH} fill={sleeveColor} opacity={0.92} />
      <Path
        d={BODY_PATH}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      {photoLayer}
      <SvgText
        x={65}
        y={118}
        textAnchor="middle"
        alignmentBaseline="middle"
        fontFamily="Arial Black, Arial, sans-serif"
        fontSize={fontSize}
        fontWeight="900"
        fill={textColor}
        opacity={0.92}
      >
        {label}
      </SvgText>
    </Svg>
  );
}
