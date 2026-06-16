# Super Selector — Mobile Strategy & Way Forward

_Written: May 2026 | Stack context: vanilla HTML/JS + Supabase_

---

## Where you're starting from

Super Selector is currently a **single `index.html` file** with inline vanilla JS, served statically. The business logic lives in two standalone modules — `cricketScoringEngine.js` and `cricketApiAdapter.js` — which are pure JavaScript with no framework dependency. The backend is Supabase (PostgreSQL + Edge Functions). There is no bundler, no build step, no existing framework investment to protect.

This is actually the ideal moment to make a mobile technology decision. The codebase is small enough that migrating is cheap, and the business logic (the hardest part) is already framework-agnostic.

---

## Why mobile matters here specifically

Your own roadmap says it plainly: **phones are ~80% of fantasy sports usage in India**. Dream11, My11Circle, and MPL are all mobile-first products. A web-only experience — even a well-optimised one — won't let you compete in this market at scale. The question isn't *whether* to go mobile, it's *which path* gives you the best single codebase to maintain.

---

## The four realistic options

### Option A — React Native + Expo with React Native Web ⭐ Recommended

**What it is:** Write your UI in React (components instead of raw HTML). Expo compiles those components to native iOS and Android. React Native Web renders the same components in a browser. One codebase, three targets.

**Why it fits Super Selector:**

- Your scoring engine and API adapter are pure JS files — they import directly into React Native with zero changes. The hardest intellectual work is already portable.
- Supabase has a first-class React Native client (`@supabase/supabase-js` works identically in RN as it does on web). Auth, Realtime subscriptions, Edge Function calls — all the same API.
- The player picker, squad grid, captain/VC toggles, and live score panel are well-suited to React Native components (FlatList for the player grid, bottom sheet for filters, etc.) and will feel genuinely native on phone — not like a web page in a wrapper.
- Expo's managed workflow handles the iOS/Android build pipeline, code signing, and OTA updates without requiring Xcode/Android Studio expertise for day-to-day development.
- This is the dominant stack for Indian fantasy sports apps. You'll find abundant community resources, libraries, and hiring talent.

**The migration effort:**

1. `cricketScoringEngine.js` — import as-is. No changes.
2. `cricketApiAdapter.js` + `LiveMatchPoller` — import as-is. No changes.
3. Supabase queries in `db.js` — copy the query logic; the client initialisation is one line change.
4. The UI (HTML/CSS in `index.html`) — this is the actual rewrite. Roughly 5–7 days to rebuild the existing screens as React Native components. The logic is unchanged; only the rendering layer is new.

**Rough timeline to first working RN build:** 1–2 weeks for someone already comfortable with JavaScript. React itself has a shallow learning curve if you know JS.

**Codebase structure after migration:**

```
/src
  /components       ← shared UI (PlayerCard, SquadRow, LiveBar, etc.)
  /screens          ← PlayerPicker, MyXI, Scorecard, Leaderboard
  /engine           ← cricketScoringEngine.js (unchanged)
  /api              ← cricketApiAdapter.js (unchanged)
  /lib              ← supabase.js (unchanged logic)
  /web              ← any web-specific layout overrides (minimal)
App.tsx             ← entry point
app.json            ← Expo config
```

**Deployment:**
- Mobile: `expo build` → submit to App Store + Play Store
- Web: `npx expo export:web` → deploy to Vercel/Netlify (same as today's static file)

---

### Option B — Capacitor (wrap existing HTML/JS in a native shell)

**What it is:** Capacitor (by the Ionic team) takes your existing web app exactly as it is and wraps it in a native iOS/Android shell (a WKWebView / WebView). You add Capacitor plugins for native features — push notifications, haptics, camera, etc. The browser version continues to work unchanged.

**Why you'd choose it:** You skip the React rewrite entirely. The existing `index.html` becomes your mobile app within a few hours of setup. It's the fastest path to "technically in the App Store."

**The catch:** It's a WebView — your app is still running as a web page inside a browser container. On a modern phone this is imperceptible for simple UIs, but a data-dense fantasy app (player grids, live score rows, real-time leaderboard) will feel noticeably slower and less fluid than a native app. More importantly, Dream11 and its competitors are native. If your users have that as the benchmark, a WebView app will feel second-rate.

**Use this if:** You want to ship to the stores in the next 2–3 weeks with minimal risk, then plan to rewrite in React Native in 3–6 months once the app has users and validated demand. Capacitor is a good bridge, not a long-term home.

---

### Option C — Progressive Web App (PWA) enhancement

**What it is:** Add a `manifest.json` and a service worker to your existing HTML. Users can "Add to Home Screen" from Safari/Chrome. Works offline. Web Push notifications. No app store needed.

**The honest picture for India:**
- Android PWAs can appear in the Play Store via Trusted Web Activity (TWA) — a legitimate and underused path.
- iOS PWAs have improved but still have meaningful limitations: no background sync, Web Push only since iOS 16.4, and no App Store listing.
- In India, most users expect apps to come from the Play Store / App Store. An "add to home screen" flow has significantly lower conversion than a store listing.

**Use this if:** You're deploying for a closed beta with friends who you can instruct manually, and you want to defer the mobile build infrastructure entirely. It's zero extra codebase — just a manifest and service worker on top of what exists. But it's not a production mobile strategy for this market.

---

### Option D — Flutter

**What it is:** A full rewrite in Dart (Google's language). Flutter compiles to genuinely native code for iOS, Android, and web from one codebase. Known for excellent animation performance and pixel-perfect UI consistency.

**Why it's lower priority for Super Selector:**
- Requires learning Dart — there's no reuse of your JS business logic. The scoring engine, adapter, and all Supabase queries would need to be rewritten.
- The Supabase Flutter SDK exists but is less mature than the JS client.
- The JS ecosystem for cricket data (your parsers, `cricsheet-parser.js`, `espncricinfo-parser.js`) would need to be rebuilt or replaced.
- Unless you or your team already know Flutter, the ramp-up cost outweighs the benefits given you're already writing JavaScript.

**Use this if:** You're starting truly from scratch or you have a Flutter developer available. Not recommended here.

---

## Side-by-side comparison

| Criterion | React Native + Expo | Capacitor | PWA | Flutter |
|---|---|---|---|---|
| App Store / Play Store | ✅ Native | ✅ WebView shell | ⚠️ Android only (TWA) | ✅ Native |
| UI feel | Native | Web (WebView) | Web | Native |
| Business logic reuse | ✅ 100% | ✅ 100% | ✅ 100% | ❌ Full rewrite |
| Supabase support | ✅ First-class | ✅ Web SDK | ✅ Web SDK | ✅ SDK exists |
| Migration effort | Medium (1–2 wks UI) | Low (hours) | Very low (1 day) | High (full rewrite) |
| Long-term maintainability | High | Medium | Low (not truly mobile) | High |
| India fantasy app precedent | ✅ Common | Rare | Rare | Rare |
| Recommended for this project | ✅ **Yes** | Bridge only | Beta only | No |

---

## Recommended path

**Phase 1 (now → 2 weeks): Expo setup + core screens**

Start the Expo project alongside the existing HTML file — don't throw it away yet, it's your live reference. Build out:
1. `PlayerPicker` screen — FlatList of player cards, role filter chips, search
2. `MyXI` screen — squad list with captain/VC toggles, budget bar, validation messages
3. `Scorecard` screen — live points, per-player breakdown

Wire these to the existing Supabase backend without changing the schema at all. The scoring engine and API adapter import unchanged.

**Phase 2 (weeks 2–4): Auth + persistence**

Your ROADMAP already has this as the first must-have. Supabase Auth in React Native is straightforward with `@supabase/auth-helpers-react-native` or the bare `supabase.auth` API. Wire up magic link / Google OAuth, add `user_id` to `user_teams`, enable RLS. This is the same work you'd do for the web anyway — doing it during the RN build means you do it once.

**Phase 3 (weeks 4–6): Web parity via React Native Web**

Once the mobile screens are stable, add `react-native-web` and configure Expo to export a web build. Most of your components will render in the browser without changes. You'll add minor web-specific layout adjustments (wider grid columns, keyboard shortcuts) via `Platform.OS === 'web'` guards. Deploy the web build to Vercel.

**Phase 4 (weeks 6–8): App Store submission**

Expo's `eas build` service generates the `.ipa` and `.aab` files. First submission to both stores. Budget 1–2 review cycles (usually 1–3 days each).

---

## Key decisions to make now

**1. Expo managed vs. bare workflow**
Start with managed. You can eject later if you need a native module that Expo doesn't support. For this app, managed covers everything: push notifications (via Expo Notifications), Supabase, deep links, and analytics.

**2. TypeScript from the start**
The scoring engine and adapter are currently plain JS. Adding TypeScript types for `Player`, `MatchEvent`, `ScoringResult`, etc. will save significant debugging time as the codebase grows across three platforms. Expo scaffolds TypeScript by default.

**3. Navigation library**
React Navigation (the standard). Use a bottom tab navigator for the main screens (Pick Team / My XI / Live / Leaderboard) — this maps directly to how Dream11 and competitors lay out their apps.

**4. State management**
Zustand (lightweight, no boilerplate) or React Query (for server state / Supabase queries). Avoid Redux for a project this size. React Query pairs especially well with Supabase's client.

---

## What changes vs. what stays the same

**Stays exactly the same:**
- `cricketScoringEngine.js` — every scoring rule, multiplier, format variation
- `cricketApiAdapter.js` — the normalisation layer and `LiveMatchPoller`
- `schema.sql` and all migrations — database schema is untouched
- Supabase Edge Functions — server-side scoring, CricAPI proxy
- Business rules (Dream11-style selection limits, captain/VC math)

**Changes only the rendering layer:**
- `index.html` CSS → React Native StyleSheet (mostly mechanical translation)
- HTML elements → React Native primitives (`View`, `Text`, `FlatList`, `Pressable`)
- Browser `fetch` → unchanged (RN supports it natively)
- Supabase client → same package, same API, one-line config change

---

## A note on the current `index.html`

Don't delete it during the transition. Keep it as a working reference and fallback. Once the React Native build reaches feature parity (end of Phase 1), you can retire the HTML version or keep it as the web experience via React Native Web. Either way, it's not a liability — it's your spec document.

---

## Summary

The one-codebase answer for Super Selector is **Expo (React Native) + React Native Web**. Your business logic is already portable, your backend requires zero changes, and the UI rewrite is the bounded, manageable part of the work. Capacitor is a viable fast bridge if you need something in the stores within days, but plan to move to React Native within the quarter. The migration path is clear, incremental, and doesn't require throwing anything away.
