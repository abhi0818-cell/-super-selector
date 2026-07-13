/**
 * NotificationTicker — scrolling marquee banner for HomeScreen
 *
 * Shows the admin's most recent broadcast notifications as a single
 * continuously-scrolling line (classic news-ticker effect), so a push the
 * user dismissed or missed is still impossible to miss once they open the
 * app. Tapping it opens NotificationsModal (full history) and marks
 * everything as read.
 *
 * Pulls from notificationsStore, which already backs the send-push-
 * notification → notifications_log / notification_reads pipeline
 * (migration_v36/v37) — this component adds no new data fetching of its own.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
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

interface Props {
  items:   NotificationItem[];
  onPress: () => void;
}

export default function NotificationTicker({ items, onPress }: Props) {
  const translateX       = useRef(new Animated.Value(0)).current;
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth]           = useState(0);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  // Most recent notifications first, joined into one loopable line. Capped
  // at 5 — a ticker showing 50 items would take minutes to cycle once.
  const message = items
    .slice(0, 5)
    .map(i => `🔔 ${i.title} — ${i.body}`)
    .join('     •     ');

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
    <Pressable onPress={onPress} style={({ pressed }) => pressed && { opacity: 0.85 }}>
      <View
        style={styles.container}
        onLayout={e => setContainerWidth(e.nativeEvent.layout.width)}
      >
        <Animated.Text
          style={[styles.text, { transform: [{ translateX }] }]}
          numberOfLines={1}
          onLayout={e => setTextWidth(e.nativeEvent.layout.width)}
        >
          {message}
        </Animated.Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    height:          32,
    borderRadius:    radius.lg,
    borderWidth:      1,
    borderColor:      C.border,
    backgroundColor:  C.bg,
    overflow:         'hidden',
    justifyContent:   'center',
    marginBottom:     spacing.xs,
  },
  text: {
    position:    'absolute',
    color:        C.text,
    fontSize:     fontSize.sm,
    fontWeight:   '700',
  },
});
