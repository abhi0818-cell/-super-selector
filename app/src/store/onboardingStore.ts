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
}));
