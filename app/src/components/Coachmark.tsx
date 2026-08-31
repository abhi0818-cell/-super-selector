import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Dimensions, LayoutChangeEvent } from 'react-native';

export type CoachmarkTarget = { x: number; y: number; width: number; height: number };

interface CoachmarkProps {
  visible: boolean;
  target: CoachmarkTarget | null;
  variant: 'tour' | 'tip';
  title: string;
  body: string;
  stepIndex?: number;
  stepCount?: number;
  chipLabel?: string;
  primaryLabel: string;
  onPrimary: () => void;
  onSkip?: () => void;
  skipLabel?: string;
}

const PAD = 6;
const TOOLTIP_WIDTH = 288;
const MARGIN = 16;
const GAP = 14;

export default function Coachmark({
  visible,
  target,
  variant,
  title,
  body,
  stepIndex,
  stepCount,
  chipLabel,
  primaryLabel,
  onPrimary,
  onSkip,
  skipLabel,
}: CoachmarkProps) {
  const [tooltipHeight, setTooltipHeight] = useState<number | null>(null);
  const { width: screenW, height: screenH } = Dimensions.get('window');

  if (!visible || !target) return null;

  const spot = {
    x: target.x - PAD,
    y: target.y - PAD,
    width: target.width + PAD * 2,
    height: target.height + PAD * 2,
  };

  const placeBelow = spot.y + spot.height < screenH * 0.62;
  const measuredH = tooltipHeight ?? 0;

  let tooltipTop = placeBelow ? spot.y + spot.height + GAP : spot.y - GAP - measuredH;
  tooltipTop = Math.max(MARGIN, Math.min(tooltipTop, screenH - MARGIN - measuredH));

  let tooltipLeft = target.x + target.width / 2 - TOOLTIP_WIDTH / 2;
  tooltipLeft = Math.max(MARGIN, Math.min(tooltipLeft, screenW - MARGIN - TOOLTIP_WIDTH));

  const defaultChip =
    variant === 'tour'
      ? `Step ${stepIndex ?? 1} of ${stepCount ?? 1}`
      : 'Quick tip';

  const onTooltipLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h && h !== tooltipHeight) setTooltipHeight(h);
  };

  return (
    <View style={[StyleSheet.absoluteFill, styles.overlayRoot]} pointerEvents="box-none">
      {/* dimming: 4 rectangles around the spotlight cutout */}
      <View style={[styles.dim, { top: 0, left: 0, right: 0, height: Math.max(0, spot.y) }]} pointerEvents="auto" />
      <View
        style={[
          styles.dim,
          { top: spot.y + spot.height, left: 0, right: 0, bottom: 0 },
        ]}
        pointerEvents="auto"
      />
      <View
        style={[
          styles.dim,
          { top: spot.y, left: 0, width: Math.max(0, spot.x), height: spot.height },
        ]}
        pointerEvents="auto"
      />
      <View
        style={[
          styles.dim,
          { top: spot.y, left: spot.x + spot.width, right: 0, height: spot.height },
        ]}
        pointerEvents="auto"
      />

      {/* highlight ring around the spotlighted element */}
      <View
        pointerEvents="none"
        style={[
          styles.ring,
          { top: spot.y, left: spot.x, width: spot.width, height: spot.height },
        ]}
      />

      <View
        onLayout={onTooltipLayout}
        style={[
          styles.tip,
          {
            top: tooltipTop,
            left: tooltipLeft,
            width: TOOLTIP_WIDTH,
            opacity: tooltipHeight ? 1 : 0,
          },
        ]}
      >
        <View style={styles.chip}>
          <Text style={styles.chipText}>{chipLabel ?? defaultChip}</Text>
        </View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
        <View style={styles.actions}>
          {onSkip ? (
            <Pressable onPress={onSkip} hitSlop={8}>
              <Text style={styles.skip}>{skipLabel ?? 'Skip'}</Text>
            </Pressable>
          ) : (
            <View />
          )}
          <Pressable onPress={onPrimary} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}>
            <Text style={styles.primaryBtnText}>{primaryLabel}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Android draws by `elevation`, not JSX/paint order — any sibling
  // screen content with its own elevation (card shadows, an "open"
  // tile, etc. — several screens use elevation 8-12) can render ON TOP
  // of this overlay even though it's the last thing mounted, silently
  // hiding the whole coachmark. A very high elevation here forces this
  // overlay to always win. zIndex alongside it for iOS/Fabric.
  overlayRoot: { elevation: 9999, zIndex: 9999 },
  dim: { position: 'absolute', backgroundColor: 'rgba(20,22,28,0.64)' },
  ring: {
    position: 'absolute',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#C9A84C',
  },
  tip: {
    position: 'absolute',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D6CFA8',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#1C1F26',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.22,
    shadowRadius: 20,
    elevation: 10,
  },
  chip: {
    alignSelf: 'flex-start',
    backgroundColor: '#EDD98A',
    borderRadius: 9999,
    paddingHorizontal: 9,
    paddingVertical: 3,
    marginBottom: 10,
  },
  chipText: { fontSize: 11, fontWeight: '700', color: '#1C1F26', letterSpacing: 0.3 },
  title: { fontSize: 16, fontWeight: '700', color: '#1C1F26', marginBottom: 6 },
  body: { fontSize: 13, lineHeight: 19, color: '#4A4438', marginBottom: 14 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  skip: { fontSize: 12, fontWeight: '600', color: '#7A7060' },
  primaryBtn: { backgroundColor: '#C9A84C', borderRadius: 9999, paddingHorizontal: 18, paddingVertical: 9 },
  primaryBtnText: { fontSize: 13, fontWeight: '700', color: '#1C1F26' },
});
