# Match Lock / Delay / Abandon — Admin Playbook

_Written: August 2026. Covers the toss → delay → restart / abandon decision tree for
the admin Schedule tab, and how it interacts with SL squad locking (`lock-matches`),
daily teams, transfers, and boosters._

## The one rule everything else follows

**Once a match's lock gate fires, there is no recourse.** `lock-matches` runs every
minute; the instant `effectiveLockTime(m)` (`lock_time ?? start_time`) is in the past,
it locks every SL squad's XI, logs transfers, reconciles boosters, and flips the match
to `live`. Nothing in the admin panel reverses that cleanly:

- **Revert Lock** deletes the locked `user_match_xi` rows (all squads, blanket, not
  per-squad) so editing reopens — it does **not** restore a prior team, and does
  **not** touch `user_transfers` or `user_booster_activations`. Whatever was spent
  stays spent.
- **Revert Daily Lock** only clears the "Locked" badge (cosmetic). The actual RLS
  gate still checks `lock_time`/`start_time`, so it does nothing by itself.
- Nothing anywhere reconciles boosters after the fact, ever.

So the entire strategy below is built around **never letting the gate fire while a
match's status is still in doubt.** Every scenario is really the same question asked
at a different moment: *is lock_time still safely in the future, yes or no?*

## The state model, in one picture

```
status:      scheduled ──────► delayed ──────► live ──────► completed
                 │                 │                            ▲
                 │                 └──(revert)──► scheduled     │
                 │                                               │
                 └──────────────────► abandoned ◄─────────────────
                                    (also reachable from delayed)
```

Gate (`effectiveLockTime`):
- `scheduled` → gate = `lock_time ?? start_time`
- `delayed` **with** `lock_time` set → gate = `lock_time`
- `delayed` **without** `lock_time` set → **no gate at all** (never auto-locks —
  see Trap 1 below)
- `abandoned` / `cancelled` / `completed` → excluded from gating entirely, excluded
  from "next match" resolution, excluded from history/leaderboards

`lock-matches` only queries two buckets: `status IN ('scheduled','in_progress') AND
start_time <= now`, or `status = 'delayed' AND lock_time IS NOT NULL AND lock_time <=
now`. A `delayed` match with a null `lock_time` matches neither query — it will sit
untouched indefinitely.

---

## Scenario 1 — Toss delayed, new start time known, well ahead of lock_time

**Situation:** Rain/covers, but the broadcaster/officials have announced a firm
restart time, and it's comfortably before the current `lock_time`.

**Action:** None required. The gate hasn't moved and doesn't need to — the match
will lock at the original time as scheduled. Optionally mark it `delayed` for
visibility on the admin board, but there's no functional need to.

---

## Scenario 2 — Toss delayed, new start time known, but it's past the current lock_time

**Situation:** The real restart is later than what's currently set as the lock gate.
If you do nothing, the gate fires at the old time and locks squads into XIs picked
before anyone knew about the delay.

**Action (must happen before the old gate fires):**
1. Click 🌧 Delay if not already delayed (auto-promotes `scheduled` → `delayed` the
   first time a lock_time changes too, so this step is sometimes automatic).
2. Set the lock gate to the real new time:
   - If `lock_time` already had a value, the **+15m/+30m** buttons push it forward
     — repeat as needed, or type an exact value into the `lock_time` field directly.
   - If `lock_time` was **never set** on this match, +15/+30 will silently push
     `start_time` instead and leave `lock_time` null (Trap 1) — **type the real
     restart time directly into the `lock_time` input**, not the quick-push buttons.
3. Confirm the badge still reads 🌧 Delayed with a `lock_time` populated (check the
   raw field, not just the badge) before walking away.

**Outcome:** No squads/daily teams touched. Users keep editing normally until the
new gate.

---

## Scenario 3 — Toss delayed, no restart time known yet (open-ended)

**Situation:** Ground's underwater, no ETA. You don't have a real time to set.

**Action:** Mark it `delayed` and push `lock_time` (or set it manually) far enough
out to be safe — e.g., a few hours ahead, or to the last realistic cutoff for that
match format — then revisit and push again as the picture clarifies. Repeat
Scenario 2's mechanics each time new information arrives. This is safe indefinitely
as long as you keep the gate ahead of "now."

The one thing to avoid: setting `delayed` with **no** `lock_time` at all and assuming
that's "safe by default." It is safe (no gate = never locks), but it also means the
match will never lock on its own even once play resumes — you must eventually set a
real `lock_time` yourself, or it stays open forever and squads never get scored.

---

## Scenario 4 — You catch the delay too late, gate has already passed

**Situation:** `lock-matches` already ran — status is `live`, XIs are locked,
transfers/boosters processed — before you had a chance to push the time.

**Action:** Per the base rule, there's no clean recourse. Your only lever is
Revert Lock (reopens editing) + Revert Daily Lock + pushing `lock_time` forward so
the match can lock again *correctly* later. This does **not** undo the transfers or
boosters already recorded from the bad lock — those are sunk. If the match relocks
again later (once the pushed `lock_time` passes), `lock-matches` will recompute and
overwrite `user_transfers` for that squad+match fresh — so transfers can end up
correct after a second real lock, but boosters never get reconciled regardless.

**Practical takeaway:** treat this purely as damage control, not a fix. Communicate
to affected users if the discrepancy matters (e.g., a booster burned on a team that
then got the chance to re-pick).

---

## Scenario 5 — Match called off entirely, before lock_time

**Situation:** Abandoned/no play possible, and the gate hasn't fired yet.

**Action:** Click 🚫 Abandon. Confirm.

**Outcome:** Clean. `status = 'abandoned'` — excluded from `isMatchOver`-gated logic
everywhere (web and mobile both), so no squad ever locks into it, and any user
currently viewing it is automatically pointed at the next scheduled match
(`findNextScheduledMatch` / `findNextUnlockedMatch`). Nothing was ever spent, so
there's nothing to preserve or revert — the match simply never entered the lock
pipeline. It also never appears in history/leaderboards (fails `isMatchPlayed()`),
consistent with never being scored.

---

## Scenario 6 — Match called off entirely, after lock_time

**Situation:** Squads already locked in before the abandonment became clear.

**Action:** Click 🚫 Abandon anyway once you know it's not resuming — it stops the
match from ever locking again and rolls users forward for their *next* pick.

**Outcome:** Per the base rule, this does **not** unwind what already happened.
Locked XIs, spent transfers, and active boosters for that match stay exactly as
recorded. Because the match never reaches `completed`, it's never finalized (no
`player_match_stats`), so it contributes 0 points — but it also disappears from
history/leaderboard views entirely (`isMatchPlayed()` excludes `abandoned`), so a
squad can have a transfer/booster consumed on a match that then vanishes from their
visible history. There is no admin UI action that reconciles this; it would need a
manual database fix if it matters enough to correct.

---

## Scenario 7 — Real-world abandoned match reported by CricAPI (not the admin button)

**Situation:** This is a distinct code path from Scenarios 5/6 and easy to confuse
with them. When CricAPI itself reports a match result as abandoned/no-result/tied/
drawn/etc., `cricStatusToOurs()` maps that text straight to internal
**`status: 'completed'`** — not `'abandoned'`. This is the normal "match finished,
go score it" path: Finalize/Recalc becomes available, and whatever partial
scorecard data exists (e.g., a D/L-adjusted result, or partial-innings stats) gets
scored through the regular pipeline.

**Implication:** if you're relying on "abandoned = never scores," that's only true
for the manual 🚫 Abandon button. A real-world abandoned match that CricAPI reports
with a result will still get finalized and will still count partial points. Don't
manually hit Abandon on a match CricAPI has already resolved to `completed` — that
would suppress legitimate scoring; use Abandon only for matches you're taking out of
the pipeline entirely (no result, no data, not worth tracking).

---

## Scenario 8 — Delay resolved, match restarts and locks normally

**Situation:** You worked Scenario 2/3 correctly — `delayed` with a real `lock_time`
set ahead of the actual restart.

**Action:** None. `lock-matches` picks it up on its normal 1-minute tick once
`lock_time` passes, locks every SL squad against whatever's currently in their
`squad_draft_xi`, logs transfers against the correct baseline, flips status to
`live`. This is the fully-intended path — everything upstream of this document
exists to make sure matches land here instead of Scenario 4 or 6.

---

## Traps to remember

**Trap 1 — "Delayed" with no `lock_time` has no gate at all.** Not "gate pushed to
start_time," not "locks eventually" — it simply never locks until someone types a
real `lock_time` in. The +15/+30 buttons will not create one for you if it didn't
already exist; they push `start_time` instead in that case, silently.

**Trap 2 — the push buttons disappear once locked.** `canPush` excludes `live`/
`in_progress`/`completed`/`abandoned`/`cancelled`. Once the gate fires and status
flips to `live`, you're already in Scenario 4 territory — there's no more pushing,
only reverting.

**Trap 3 — cron runs on a 1-minute tick, not instantly.** Build in buffer. Pushing
the gate at the literal minute it's about to fire is a coin flip against the cron.

**Trap 4 — Revert Lock is blanket, not per-squad.** It deletes locked XIs for
*every* squad on that match, not just one you're troubleshooting.

**Trap 5 — Abandoned matches vanish from history even if they were locked.**
`isMatchPlayed()` only counts `completed`/`in_progress`/`live`. A squad that had a
transfer/booster consumed on a match that later gets abandoned will not see that
match in their match-by-match breakdown at all — the spend is invisible, not just
unscored.

---

## Quick-reference

| Situation | Gate status | Safe action | Recourse if missed |
|---|---|---|---|
| Restart known, before old lock | not yet fired | usually none needed | — |
| Restart known, later than old lock | not yet fired | Delay + push/set `lock_time` to new time | — |
| No restart time yet | not yet fired | Delay, push `lock_time` out repeatedly, must eventually set a real one | — |
| Discovered after gate fired | already fired | Revert Lock + Revert Daily Lock + push `lock_time` forward | Transfers may self-correct on next real lock; boosters never do |
| Called off, before gate | not yet fired | Abandon | — (nothing was ever spent) |
| Called off, after gate | already fired | Abandon (stops further damage only) | None — locked spend is sunk, match drops from history |
| CricAPI reports a real abandoned/no-result match | N/A — maps to `completed` | Let it finalize normally | N/A, this is normal scoring |
