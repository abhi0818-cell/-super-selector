import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'onboardingFlags';

type OnboardingFlags = {
  hasSeenHomeTour: boolean;
  hasSeenPlayerPickerTips: boolean;
  hasSeenBoostersTip: boolean;
  hasSeenCaptainVcTip: boolean;
};

const DEFAULT_FLAGS: OnboardingFlags = {
  hasSeenHomeTour: false,
  hasSeenPlayerPickerTips: false,
  hasSeenBoostersTip: false,
  hasSeenCaptainVcTip: false,
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
  resetAll: () => Promise<void>;
  /** Transient (not persisted) — set by RulesScreen's "Replay Walkthrough"
   * so the target screen can show its tour/tip even for a user who has
   * already "graduated" past the point where it'd normally auto-suppress
   * (e.g. Home's tour skips itself for anyone who already has a saved XI).
   * Cleared by the screen once it picks the request up. */
  replayRequest: 'home' | 'pickerTips' | 'boosters' | 'captainVc' | null;
  requestReplay: (section: 'home' | 'pickerTips' | 'boosters' | 'captainVc') => Promise<void>;
  clearReplayRequest: () => void;
}

async function persist(flags: OnboardingFlags) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  } catch (err) {
    console.warn('[onboardingStore] failed to persist flags:', err);
  }
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  ...DEFAULT_FLAGS,
  hydrated: false,
  replayRequest: null,

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
    const { hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip } = get();
    await persist({ hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip });
  },
  completePlayerPickerTips: async () => {
    set({ hasSeenPlayerPickerTips: true });
    const { hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip } = get();
    await persist({ hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip });
  },
  completeBoostersTip: async () => {
    set({ hasSeenBoostersTip: true });
    const { hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip } = get();
    await persist({ hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip });
  },
  completeCaptainVcTip: async () => {
    set({ hasSeenCaptainVcTip: true });
    const { hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip } = get();
    await persist({ hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip });
  },

  resetHomeTour: async () => {
    set({ hasSeenHomeTour: false });
    const { hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip } = get();
    await persist({ hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip });
  },
  resetPlayerPickerTips: async () => {
    set({ hasSeenPlayerPickerTips: false });
    const { hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip } = get();
    await persist({ hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip });
  },
  resetBoostersTip: async () => {
    set({ hasSeenBoostersTip: false });
    const { hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip } = get();
    await persist({ hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip });
  },
  resetCaptainVcTip: async () => {
    set({ hasSeenCaptainVcTip: false });
    const { hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip } = get();
    await persist({ hasSeenHomeTour, hasSeenPlayerPickerTips, hasSeenBoostersTip, hasSeenCaptainVcTip });
  },
  resetAll: async () => {
    set({ ...DEFAULT_FLAGS });
    await persist({ ...DEFAULT_FLAGS });
  },

  requestReplay: async (section) => {
    set({ replayRequest: section });
    const resetFn = {
      home:       get().resetHomeTour,
      pickerTips: get().resetPlayerPickerTips,
      boosters:   get().resetBoostersTip,
      captainVc:  get().resetCaptainVcTip,
    }[section];
    await resetFn();
  },
  clearReplayRequest: () => set({ replayRequest: null }),
}));
