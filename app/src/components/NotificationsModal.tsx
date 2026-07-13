/**
 * NotificationsModal — full history behind the HomeScreen ticker
 *
 * Opened by tapping NotificationTicker. Lists every notification in
 * notifications_log (newest first), unread ones highlighted. Read state is
 * cleared for all of them the moment this opens (notificationsStore.markAllRead),
 * same as the ticker disappearing once there's nothing unread left.
 */

import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NotificationItem } from '../store/notificationsStore';
import { fontSize, radius, spacing } from '../theme';

const G = {
  bg:    ['#F5F0E0', '#EDE8D5', '#E8E2CE'] as const,
  modal: ['rgba(245,240,224,0.99)', 'rgba(237,232,213,0.99)'] as const,
};

const C = {
  text:   '#1C1F26',
  muted:  '#7A7060',
  accent: '#C9A84C',
  border: 'rgba(201,168,76,0.25)',
};

interface Props {
  visible: boolean;
  items:   NotificationItem[];
  loading: boolean;
  onClose: () => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function NotificationsModal({ visible, items, loading, onClose }: Props) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.root}>
        <LinearGradient colors={G.bg} style={StyleSheet.absoluteFill} />
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>

          <LinearGradient colors={G.modal} style={styles.header}>
            <Pressable style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
            <Text style={styles.headerTitle}>🔔 Notifications</Text>
          </LinearGradient>

          {!loading && items.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>No notifications yet.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
              {items.map(n => (
                <View key={n.id} style={[styles.row, !n.read && styles.rowUnread]}>
                  {!n.read && <View style={styles.unreadDot} />}
                  <View style={{ flex: 1 }}>
                    <View style={styles.rowHeader}>
                      <Text style={styles.rowTitle}>{n.title}</Text>
                      <Text style={styles.rowTime}>{formatTime(n.createdAt)}</Text>
                    </View>
                    <Text style={styles.rowBody}>{n.body}</Text>
                  </View>
                </View>
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
  headerTitle:  { color: C.text, fontSize: fontSize.lg, fontWeight: '800' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { color: C.muted, fontSize: fontSize.base, textAlign: 'center' },

  body: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },

  row: {
    flexDirection: 'row', gap: spacing.sm,
    padding: spacing.md, borderRadius: radius.lg,
    borderWidth: 1, borderColor: C.border,
    backgroundColor: 'rgba(255,255,255,0.6)',
  },
  rowUnread: { backgroundColor: 'rgba(201,168,76,0.1)', borderColor: 'rgba(201,168,76,0.4)' },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.accent, marginTop: 6, flexShrink: 0 },

  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  rowTitle:  { color: C.text, fontSize: fontSize.base, fontWeight: '700', flex: 1 },
  rowTime:   { color: C.muted, fontSize: fontSize.xs, flexShrink: 0 },
  rowBody:   { color: C.text, fontSize: fontSize.sm, marginTop: 2, opacity: 0.85 },
});
