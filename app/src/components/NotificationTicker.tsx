/**
 * NotificationTicker — scrolling marquee banner for HomeScreen
 *
 * Shows the admin's most recent broadcast notifications as a single
 * continuously-scrolling line (classic news-ticker effect), so a push the
 * user dismissed or missed is still impossible to miss once they open the
 * app. Tapping it opens NotificationsModal (full history) and marks
 * everything as read (clears the unread badge — doesn't affect this
 * component). Visibility itself is time-based (ticker_hours per
 * notification, migration_v38) and computed by the caller via
 * isTickerActive() — this component just renders whatever `items` it's
 * handed. The ✕ button calls onDismiss to hide the current items for the
 * rest of this app session only (not persisted — a fresh launch, or the
 * ticker_hours window simply elapsing, are the only ways it stays hidden
 * for good).
 *
 * Pulls from notificationsStore, which already backs the send-push-
 * notification → notifications_log / notification_reads pipeline
 * (migration_v36/v37/v38) — this component adds no new data fetching of its own.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { NotificationItem } from '../store/notificationsStore';
import { fontSize, radius, spacing } from '../theme';

const C = {
  text:   '#1C1F26',
  accent: '#C9A84C',
  bg:     'rgba(201,168,76,0.12)',
  border: 'rgba(201,168,76,0.35)',
};

// Roughly constant scroll speed regardless of message length.
const PX_PER_MS = 0.055;
const TICKER_HEIGHT = 32;

interface Props {
  items:     NotificationItem[];
  onPress:   () => void;
  onDismiss: () => void;
}

export default function NotificationTicker({ items, onPress, onDismiss }: Props) {
  const translateX       = useRef(new Animated.Value(0)).current;
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth]           = useState(0);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  // Most recent notifications first, joined into one loopable line. Capped
  // at 5 — a ticker showing 50 items would take minutes to cycle once.
  //
  // Body text is free-form multiline input (the admin's Message field is a
  // multiline TextInput, and that's correct for the push notification itself
  // and the inbox modal) — but RN's Text renders literal "\n" as a real line
  // break with no equivalent to CSS's `white-space: nowrap` collapsing it, so
  // any newline here would break the single-line marquee. Collapse all
  // whitespace runs (including newlines) to a single space before display.
  const singleLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  const message = items
    .slice(0, 5)
    .map(i => `🔔 ${singleLine(i.title)} — ${singleLine(i.body)}`)
    .join('     •     ');

  // Reset the measured width whenever the message changes — otherwise a
  // shorter new message briefly renders at the previous (wrong) width.
  useEffect(() => { setTextWidth(0); }, [message]);

  useEffect(() => {
    animRef.current?.stop();
    if (!containerWidth || !textWidth || !message) return;

    translateX.setValue(containerWidth);
    const distance = containerWidth + textWidth;
    const duration = distance / PX_PER_MS;

    const anim = Animated.loop(
      Animated.timing(translateX, {
        toValue:        -textWidth,
        duration,
        easing:          Easing.linear,
        useNativeDriver: true,
      }),
    );
    animRef.current = anim;
    anim.start();

    return () => anim.stop();
  }, [containerWidth, textWidth, message]);

  if (!message) return null;

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.85 }]}
      >
        <View
          style={styles.container}
          onLayout={e => setContainerWidth(e.nativeEvent.layout.width)}
        >
          {/* Only render the real scrolling copy once we know its true
              unwrapped width (from the offscreen probe below) — giving it
              an explicit width is what actually stops it from wrapping or
              being clipped to the container's width; position/alignSelf
              tricks alone aren't reliably honored by Yoga for text sizing. */}
          {textWidth > 0 && (
            <Animated.Text
              style={[styles.text, { width: textWidth, transform: [{ translateX }] }]}
              numberOfLines={1}
            >
              {message}
            </Animated.Text>
          )}
        </View>
      </Pressable>
      <Pressable
        onPress={onDismiss}
        hitSlop={8}
        style={({ pressed }) => [styles.dismissBtn, pressed && { opacity: 0.6 }]}
      >
        <Text style={styles.dismissText}>✕</Text>
      </Pressable>

      {/* Offscreen measuring probe — rendered with no width/wrap constraint
          so onLayout reports the message's true single-line content width,
          which the visible copy above then uses as its explicit width. */}
      <Text
        style={[styles.text, styles.probe]}
        numberOfLines={1}
        pointerEvents="none"
        onLayout={e => setTextWidth(e.nativeEvent.layout.width)}
      >
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:            spacing.xs,
    marginBottom:   spacing.xs,
  },
  container: {
    flex:            1,
    height:          TICKER_HEIGHT,
    borderRadius:    radius.lg,
    borderWidth:      1,
    borderColor:      C.border,
    backgroundColor:  C.bg,
    overflow:         'hidden',
    justifyContent:   'center',
  },
  dismissBtn: {
    width:            24,
    height:           24,
    borderRadius:     radius.full,
    backgroundColor:  'rgba(0,0,0,0.06)',
    alignItems:       'center',
    justifyContent:   'center',
    flexShrink:       0,
  },
  dismissText: {
    fontSize:   11,
    color:      C.text,
    fontWeight: '700',
  },
  text: {
    position:   'absolute',
    top:         0,
    left:        0,
    // Vertically centers a single line of text within a fixed-height box,
    // reliably on both platforms (unlike `top:0` + `textAlignVertical`,
    // which is Android-only — iOS silently ignores it and stays top-aligned).
    height:      TICKER_HEIGHT,
    lineHeight:  TICKER_HEIGHT,
    color:       C.text,
    fontSize:    fontSize.sm,
    fontWeight:  '700',
  },
  // Invisible, laid out with no width constraint purely so onLayout reports
  // the message's true single-line width — see the probe comment above.
  probe: {
    opacity:        0,
    top:            -9999,
    left:           -9999,
  },
});
