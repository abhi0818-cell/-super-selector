/**
 * pushNotifications — device registration for admin-triggered push
 *
 * Registers the device for push, upserts the Expo push token into
 * push_tokens (keyed on the token itself — see migration_v36), and sets
 * the foreground notification behavior. Sending is entirely server-side:
 * the send-push-notification Edge Function reads push_tokens and calls
 * Expo's push API directly — this file never sends anything.
 *
 * Call registerPushToken(userId) once a session exists (App.tsx). Safe to
 * call on every launch/login — it's just an upsert.
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { supabase } from './supabase';

// Foreground behavior — show the banner/list entry and play a sound even
// while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList:   true,
    shouldPlaySound:  true,
    shouldSetBadge:   false,
  }),
});

async function getExpoPushToken(): Promise<string | null> {
  // Push tokens require a physical device — simulators/emulators have no
  // APNs/FCM registration and getExpoPushTokenAsync() will throw.
  if (!Device.isDevice) {
    console.log('[pushNotifications] Skipping — simulator/emulator has no push capability');
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') {
    console.log('[pushNotifications] Permission not granted');
    return null;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  const tokenResponse = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  return tokenResponse.data;
}

/**
 * Registers this device's push token for `userId`. Silently no-ops if
 * permission is denied or running on a simulator — never blocks app launch.
 */
export async function registerPushToken(userId: string): Promise<void> {
  try {
    const token = await getExpoPushToken();
    if (!token) return;

    const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

    const { error } = await supabase.from('push_tokens').upsert(
      {
        user_id:    userId,
        token,
        platform,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'token' },
    );
    if (error) console.warn('[pushNotifications] token upsert failed:', error.message);
  } catch (e) {
    console.warn('[pushNotifications] registration failed:', (e as Error).message);
  }
}
