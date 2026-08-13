# Rules Page — Merged Content Draft (for review)

This is a content-only draft of how the "How to Play" material could merge into the
existing Rules tab (mobile `RulesScreen.tsx` + web `index.html` rules modal). Nothing
is implemented yet — this is for you to mark up before I touch code.

**Legend**
- 🆕 NEW — doesn't exist on the Rules page today
- ♻️ EXISTING (reworded) — same data/section that's there today, just adding a short "how it works" line
- ✅ EXISTING (unchanged) — kept exactly as-is, shown here only so you can see it in context

Proposed section order top-to-bottom:

1. 🆕 Getting Started 📝
2. ♻️ Contest (Transfers + Boosters) 🏆
3. ♻️ Scoring 🏏
4. 🆕 Ground Rules 📜
5. ✅ Private Leagues 🔒

---

## 1. Getting Started 📝 🆕

*(New top-level section, placed first — everything here is static, no DB-driven content.)*

**Intro line:**
> New to Maestro? Here's the flow from joining a contest to your squad locking in for a match.

### Join a Contest
- Pick the tournament you want to play from the **Home** tab.
- **Season Long** is the main contest — one squad, scored across the whole tournament.
- Playing with friends? Go to **Home → Season Long → Leagues → Join with code** to enter a **Private League**. Your XI is shared across the public contest and every private league you're in — you only pick once.

### Draft Your Squad
Build your 11 from the full player pool. Limits while you pick:

| Rule | Limit |
|---|---|
| Budget | 100 credits total |
| Squad size | Exactly 11 players |
| Players from one real team | Max 7 |
| Overseas players | Set per tournament — see this tournament's cap below in **Contest** |

Role composition required in your final XI:

| Role | Required count |
|---|---|
| Wicketkeeper (WK) | 1 – 4 |
| Batter (BAT) | 3 – 6 |
| All-rounder (AR) | 1 – 4 |
| Bowler (BOWL) | 3 – 6 |

*Note: the player pool won't let you make a pick that makes a valid XI impossible — so you can't build an invalid squad in the first place.*

### Captain & Vice-Captain
- **Captain** — scores 2× their base points.
- **Vice-Captain** — scores 1.5× their base points.

*(This is now the single source for the 2×/1.5× line — dropped from Scoring's intro below, which instead points back up here.)*

### Save Your XI & Match Lock
1. Review your picks, Captain/VC, and booster, then tap **Save XI**.
2. Every match has a **lock time** — normally kickoff, though admins can push it earlier/later or mark a match **delayed**.
3. Right up until the lock time, you can keep editing — transfers, Captain/VC, and booster choice all stay open.
4. Once the lock passes, that match's XI, Captain/VC, and booster are frozen. Editing re-opens for the **next** match.
5. If a match is delayed, the lock moves with it — you're free to keep editing until the new lock time.

---

## 2. Contest 🏆 ♻️

*(Existing header/data — unchanged tables, just proposing one new sentence at the top of each subsection.)*

### Transfers
🆕 **Added intro line:** *Transfers swap players in and out of your squad between matches. Your exact allowance is set for this contest below.*

✅ **Existing (unchanged), example of current live rendering:**
> **League Phase:** [N] transfers for the [N] league matches — unlimited until your first match locks, then the cap applies.
> **Playoffs:** [N] transfers for the [N] playoff matches — unlimited until Qualifier 1 match locks, then the cap applies.

### Boosters
🆕 **Added intro line:** *Boosters are optional, once-per-season power-ups. Only one can be active for any given match.*

✅ **Existing (unchanged):** live list of this contest's available boosters with icon, name, use-count, and description — e.g. Triple Captain, Dual Captain, Team 2x, Free Hit, Wildcard, OS 2x, Domestic 2x, Super Captain, Super Vice-Captain.

---

## 3. Scoring 🏏 ♻️ — one-line change

Batting / Bowling / Fielding point tables pulled from this tournament's `scoring_rules` stay exactly as they render today — no changes there.

The intro line above the tables changes: drop the Captain 2×/VC 1.5× detail (now owned by **Getting Started → Captain & Vice-Captain**) and instead point up to it.

🆕 **Proposed new intro line:**
> Each player earns points based on their in-match performance. Your XI total is the sum of all 11 players — see **Getting Started** for how Captain and Vice-Captain multipliers work.

✅ *(Was: "…Your XI total is the sum of all 11 players, with Captain earning 2× and Vice-Captain 1.5× their base points." — removed.)*

---

## 4. Ground Rules 🆕

*(New static section, hardcoded copy — same for every tournament/contest, at least for now. Split into two match-outcome rules below after verifying against the actual match-status handling in `poll-cricapi/index.ts`, `scrape-scorecard/index.ts`, and `index.html`: a proactive admin cancellation and a mid-match rain-out/abandonment behave differently in the app today, so they needed separate copy rather than one blanket "abandoned matches don't count" statement. A fourth rule was added after confirming the app has no cleanup path for transfers/boosters on an abandoned match — `abandon()` in `AdminScreen.tsx` only patches `matches.status`; it never touches `user_transfers` or `user_booster_activations`, and neither table's usage-counting logic filters by match status. Decision: document this as known behavior rather than change it in code.)*

> **No points for the Super Over**
> Maestro only scores the main innings of a match. If a game is tied and goes to a Super Over, nobody gains or loses fantasy points for it — the result stands for the tournament table, but it has no effect on your squad's score.

> **A fixture called off before it locks doesn't count**
> If a match is cancelled or pulled from the schedule before its lock time, it's skipped entirely — it never locks, and everyone simply rolls forward to the next scheduled match. No points, transfers, or booster usage are affected.

> **A match abandoned or rained off after it's started is scored on the play that happened**
> If a match is interrupted or called off partway through (rain, bad light, etc.), it's scored from whatever overs/wickets were actually completed before it was called off — same scoring rules as a full match, just on a shorter innings. It is not excluded and does not get replayed for fantasy purposes, even if the real-world result is a "no result."

> **Transfers and boosters used for an abandoned match are not refunded**
> If your team had already locked for a match — even if it's later marked abandoned with no ball bowled — any transfer or booster you spent on that match stays spent. It still counts against your season/playoff transfer cap and your booster's once-per-season use, exactly as if the match had been played. There's no automatic refund for this today.

---

## 5. Private Leagues 🔒 ✅ — unchanged

No changes proposed. Kept exactly as it renders today (shared XI, custom base rules, configurable boosters, joining via invite code).

---

## Open questions for you to weigh in on

1. ~~Captain/VC duplication~~ — **resolved:** single source lives in "Getting Started"; "Scoring" now just points up to it (see change above).
2. ~~Ground Rules scope~~ — **resolved:** staying hardcoded (not an editable per-tournament field) for now. Also caught and fixed a real accuracy bug during verification: "abandoned/rain-affected" was one blanket rule, but the app actually treats a pre-lock cancellation and a mid-match rain-out differently (see the two split rules above) — the original single-rule text would have been wrong for the more common case.
3. ~~Section order~~ — **resolved:** "Getting Started" stays first, as proposed.
4. ~~Icons~~ — **resolved:** 🎯 was already taken (it's the default/fallback booster icon in `boosterStore.ts`), so "Getting Started" went to 🧭, then swapped again to 📝 (memo/pen-and-paper) per feedback. 📜 for "Ground Rules" confirmed as-is.
