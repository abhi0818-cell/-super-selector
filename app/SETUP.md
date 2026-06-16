# Super Selector — Mobile App Setup

React Native (Expo) app. Phase 1: Player Picker + My XI.

## Prerequisites

- Node.js 18+
- Expo Go on your phone (iOS or Android) — install from the App Store / Play Store

## First run (one time)

```bash
cd "Super Selector/app"
npm install
npx expo start
```

Scan the QR code in Expo Go to open the app on your phone instantly.

## Run on specific platform

```bash
npx expo start --ios       # iOS Simulator (requires Xcode on Mac)
npx expo start --android   # Android Emulator
npx expo start --web       # Browser (React Native Web)
```

## Project structure

```
app/
  App.tsx                         ← Root entry point
  src/
    types/index.ts                ← All TypeScript types (Player, MatchFormat, etc.)
    theme/index.ts                ← Colors, spacing, typography (matches index.html)
    data/mockPlayers.ts           ← Same 30-player IPL pool as the web app
    engine/cricketScoringEngine.ts ← TypeScript port of cricketScoringEngine.js
    store/teamStore.ts            ← Zustand state (selected XI, validation, captaincy)
    components/
      PlayerCard.tsx              ← Tappable player tile
      SquadRow.tsx                ← Row in My XI list with C/VC buttons
      BudgetBar.tsx               ← Credits spent / remaining progress bar
      RoleStats.tsx               ← WK·BAT·AR·BOWL count grid
      RoleTag.tsx                 ← Coloured role badge
    screens/
      PlayerPickerScreen.tsx      ← FlatList of players with search + role filters
      MyXIScreen.tsx              ← Squad list with validation and captaincy
    navigation/
      TabNavigator.tsx            ← Bottom tab bar (Pick / My XI)
```

## Wiring up Supabase (Phase 2)

Replace the mock data with live Supabase queries:

1. Add your credentials to `app.json` → `expo.extra`:
   ```json
   "supabaseUrl": "https://xxxx.supabase.co",
   "supabaseAnonKey": "your-anon-key"
   ```

2. Create `src/lib/supabase.ts`:
   ```ts
   import 'react-native-url-polyfill/auto';
   import AsyncStorage from '@react-native-async-storage/async-storage';
   import { createClient } from '@supabase/supabase-js';
   import Constants from 'expo-constants';

   const { supabaseUrl, supabaseAnonKey } = Constants.expoConfig!.extra!;

   export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
     auth: {
       storage: AsyncStorage,
       autoRefreshToken: true,
       persistSession: true,
       detectSessionInUrl: false,
     },
   });
   ```

3. In `teamStore.ts`, replace `setPlayers(MOCK_PLAYERS)` with a Supabase query:
   ```ts
   const { data } = await supabase.from('players').select('*');
   if (data) useTeamStore.getState().setPlayers(data);
   ```

## Adding Phase 2 screens (Scorecard, Leaderboard)

Add new screens to `src/screens/` and register them in `TabNavigator.tsx`:
```ts
<Tab.Screen name="Live" component={ScorecardScreen} ... />
<Tab.Screen name="Leaderboard" component={LeaderboardScreen} ... />
```
