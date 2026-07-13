/**
 * Notifications Store — Zustand
 *
 * In-app inbox for admin-sent push notifications (migration_v36/v37).
 * notifications_log is the shared broadcast history (all users read the same
 * rows — every send today targets 'all'); notification_reads tracks each
 * user's own read state so the HomeScreen bell badge shows an accurate
 * unread count. A notification with no matching notification_reads row for
 * the current user is unread.
 */

import { create } from 'zustand';
import { supabase } from '../lib/supabase';

export interface NotificationItem {
  id:        string;
  title:     string;
  body:      string;
  createdAt: string;
  read:      boolean;
}

interface NotificationsState {
  items:         NotificationItem[];
  unreadCount:   number;
  loading:       boolean;
  currentUserId: string | null;

  setCurrentUser: (uid: string | null) => void;
  loadNotifications: (userId: string) => Promise<void>;
  markAllRead:       (userId: string) => Promise<void>;
}

const LIMIT = 50;

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  items:         [],
  unreadCount:   0,
  loading:       false,
  currentUserId: null,

  setCurrentUser: (uid) => set({ currentUserId: uid }),

  loadNotifications: async (userId: string) => {
    if (!userId) return;
    set({ loading: true });
    try {
      const [{ data: log, error: logErr }, { data: reads, error: readErr }] = await Promise.all([
        supabase
          .from('notifications_log')
          .select('id, title, body, created_at')
          .order('created_at', { ascending: false })
          .limit(LIMIT),
        supabase
          .from('notification_reads')
          .select('notification_id')
          .eq('user_id', userId),
      ]);

      if (logErr) throw logErr;
      if (readErr) console.warn('[notificationsStore] read-state lookup failed:', readErr.message);

      const readIds = new Set((reads ?? []).map((r: any) => r.notification_id));

      const items: NotificationItem[] = (log ?? []).map((n: any) => ({
        id:        n.id,
        title:     n.title,
        body:      n.body,
        createdAt: n.created_at,
        read:      readIds.has(n.id),
      }));

      set({
        items,
        unreadCount: items.filter(i => !i.read).length,
      });
    } catch (err) {
      console.warn('[notificationsStore] loadNotifications failed:', err);
    } finally {
      set({ loading: false });
    }
  },

  // Marks every currently-loaded notification as read for this user — called
  // when the inbox modal opens. Upsert so re-opening is a harmless no-op.
  markAllRead: async (userId: string) => {
    const { items } = get();
    const unread = items.filter(i => !i.read);
    if (!userId || unread.length === 0) return;

    // Optimistic — the badge should clear the instant the inbox opens.
    set(state => ({
      items:       state.items.map(i => ({ ...i, read: true })),
      unreadCount: 0,
    }));

    try {
      const rows = unread.map(i => ({ user_id: userId, notification_id: i.id }));
      const { error } = await supabase
        .from('notification_reads')
        .upsert(rows, { onConflict: 'user_id,notification_id' });
      if (error) console.warn('[notificationsStore] markAllRead upsert failed:', error.message);
    } catch (err) {
      console.warn('[notificationsStore] markAllRead failed:', err);
    }
  },
}));
