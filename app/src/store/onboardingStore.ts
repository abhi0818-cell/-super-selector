import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'onboardingFlags';

/**
 * Onboarding model:
 *  - `walkthroughEnabled` is a master kill switch. When false, nothing in
 *    any section auto-shows, full stop, regardless of the per-section flags
 *    below.
 *  - Each `hasSeenX` flag is "has this section been shown/dismissed" — it's
 *    what actually gates that section firing. Turning it back to false
 *    (Rules -> Walkthrough) re-arms it: it'll show again next time the
 *    person naturally reaches that screen/moment, same as a first-time
 *    user would see it. Nothing force-navigates or jumps anywhere.
 *  - `migrationChecked` guards a ONE-TIME pass (see HomeScreen) that
 *    silently marks a section seen, without ever showing it, for an
 *    account that's clearly already experienced in that area (e.g. already
 *    has a saved XI). This runs at most once per account, ever -- after
 *    that, every hasSeenX flag is purely under manual control via the
 *    toggles, in both directions, forever.
 */
type OnboardingFlags = {
  hasSeenHomeTour: boolean;
  hasSeenPlayerPickerTips: boolean;
  hasSeenBoostersTip: boolean;
  hasSeenCaptainVcTip: boolean;
  walkthroughEnabled: boolean;
  migrationChecked: boolean;
};

const DEFAULT_FLAGS: OnboardingFlags = {
  hasSeenHomeTour: false,
  hasSeenPlayerPickerTips: false,
  hasSeenBoostersTip: false,
  hasSeenCaptainVcTip: false,
  walkthroughEnabled: true,
  migrationChecked: false,
};

interface OnboardingState extends OnboardingFlags {
  hydrated: boolean;
  hydrate: () => Promise<void>;

  completeHomeTour: () => Promise<void>;
  completePlayerPickerTips: () => Promise<void>;
  completeBoostersTip: () => Promise<void>;
  completeCaptainVcTip: () => Promise<void>;

  resetHomeTour: () => Promise<void>;
  resetPlayerPickerTips: () => Promise<void>;
  resetBoostersTip: () => Promise<void>;
  resetCaptainVcTip: () => Promise<void>;

  setWalkthroughEnabled: (enabled: boolean) => Promise<void>;

  /** One-time migration pass (see HomeScreen): suppresses whichever
   * sections apply for an already-experienced account, then marks itself
   * done so it never re-runs and never fights a manual toggle again. */
  runExistingUserMigration: (signals: { anyXI: boolean; slXI: boolean }) => Promise<void>;
  /** Permanently locks out runExistingUserMigration without applying any
   * suppression. Called the moment the person opens Rules -> Walkthrough --
   * the migration is a one-shot guess for someone who hasn't looked yet;
   * once they've actually opened the settings, a delayed guess landing
   * after their own toggle (a real race: the migration waits on async
   * saved-XI lookups, easily ~1s+ on a real device/network) must never be
   * allowed to silently override what they just set. */
  skipMigrationCheck: () => Promise<void>;

  resetAll: () => Promise<void>;
}

async function persist(flags: OnboardingFlags) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  } catch (err) {
    console.warn('[onboardingStore] failed to persist flags:', err);
  }
}

function currentFlags(get: () => OnboardingState): OnboardingFlags {
  const {
    hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip,
    walkthroughEnabled, migrationChecked,
  } = get();
  return { hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip, walkthroughEnabled, migrationChecked };
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  ...DEFAULT_FLAGS,
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        set({
          hasSeenHomeTour: !!parsed.hasSeenHomeTour,
          hasSeenPlayerPickerTips: !!parsed.hasSeenPlayerPickerTips,
          hasSeenBoostersTip: !!parsed.hasSeenBoostersTip,
          hasSeenCaptainVcTip: !!parsed.hasSeenCaptainVcTip,
          // Master switch defaults ON for anyone who never set it explicitly.
          walkthroughEnabled: parsed.walkthroughEnabled === undefined ? true : !!parsed.walkthroughEnabled,
          migrationChecked: !!parsed.migrationChecked,
        });
      }
    } catch (err) {
      console.warn('[onboardingStore] hydrate failed:', err);
    } finally {
      set({ hydrated: true });
    }
  },

  completeHomeTour: async () => {
    set({ hasSeenHomeTour: true });
    await persist(currentFlags(get));
  },
  completePlayerPickerTips: async () => {
    set({ hasSeenPlayerPickerTips: true });
    await persist(currentFlags(get));
  },
  completeBoostersTip: async () => {
    set({ hasSeenBoostersTip: true });
    await persist(currentFlags(get));
  },
  completeCaptainVcTip: async () => {
    set({ hasSeenCaptainVcTip: true });
    await persist(currentFlags(get));
  },

  resetHomeTour: async () => {
    set({ hasSeenHomeTour: false });
    await persist(currentFlags(get));
  },
  resetPlayerPickerTips: async () => {
    set({ hasSeenPlayerPickerTips: false });
    await persist(currentFlags(get));
  },
  resetBoostersTip: async () => {
    set({ hasSeenBoostersTip: false });
    await persist(currentFlags(get));
  },
  resetCaptainVcTip: async () => {
    set({ hasSeenCaptainVcTip: false });
    await persist(currentFlags(get));
  },

  setWalkthroughEnabled: async (enabled: boolean) => {
    set({ walkthroughEnabled: enabled });
    await persist(currentFlags(get));
  },

  runExistingUserMigration: async (signals) => {
    if (get().migrationChecked) return;
    const patch: Partial<OnboardingFlags> = { migrationChecked: true };
    if (signals.anyXI) {
      patch.hasSeenHomeTour = true;
      patch.hasSeenPlayerPickerTips = true;
      patch.hasSeenCaptainVcTip = true;
    }
    if (signals.slXI) {
      patch.hasSeenBoostersTip = true;
    }
    set(patch);
    await persist(currentFlags(get));
  },

  skipMigrationCheck: async () => {
    if (get().migrationChecked) return;
    set({ migrationChecked: true });
    await persist(currentFlags(get));
  },

  resetAll: async () => {
    set({ ...DEFAULT_FLAGS });
    await persist({ ...DEFAULT_FLAGS });
  },
}));
