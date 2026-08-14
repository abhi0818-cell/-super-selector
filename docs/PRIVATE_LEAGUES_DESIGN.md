# Private Leagues — Current State, Gaps & Proposed Workflow

_Written: Aug 2026 | Scope: Season Long private leagues (admin-managed + user-managed)_

---

## 1. The two private-league types, as specified

| | **Admin league** | **User (friends) league** |
|---|---|---|
| Who creates it | Admin, from the Contests admin panel | Any signed-in user, from Leagues tab |
| Rules / boosters | Fully custom per league (admin picks scoring overrides + which boosters, with per-booster use counts) | Locked to the main SL contest's rules and boosters — no override UI is exposed to the user |
| Joining | Invite code (admin sets a member cap) | Invite code — capped at 3 members by default; only admin can raise it (Admin tab) |
| Late join, history | Not addressed by your spec — presumably starts fresh, since rules can differ from SL | **Must show history from M1**, not just from the match they joined |

This matches a real, already-built distinction in the codebase — it's not two competing ideas, it's two paths that already exist side by side. Below is what's actually implemented for each, then where it falls short of #2 above.

---

## 2. What's already built (verified against the current code)

### Data model
`contests` table carries `is_private`, `invite_code`, `scoring_rules` (JSONB, per-format override), `max_members`, and `available_boosters` (JSONB). A private league is just a `season_long` contest row with `is_private = true`. `user_squads` carries `primary_squad_id` — nullable; when set, this squad is a **mirror** of another squad's XI rather than an independently-picked one.

### "Standard" vs "custom" is derived, not stored
`isSharedXI(contest)` (index.html) returns true only when the contest has **neither** a scoring override **nor** a custom booster set. That single check is what decides whether a joining squad becomes a shared/mirrored squad (`primary_squad_id` set to the user's main SL squad) or an independent one that must pick its own XI.

### Admin-created league (custom rules/boosters) — ✅ built
Contests admin panel → "+ New Private League": name, optional member cap, a booster grid (checkbox + uses-per-member for each booster), and an optional per-format scoring-rules editor that starts as a copy of the tournament defaults and only persists the fields that were actually changed. `db.createPrivateLeague()` writes the contest row and generates a unique invite code. Because this almost always sets `scoring_rules` and/or `available_boosters`, these leagues are **independent** by construction — each member picks their XI separately for this league, every match.

### User-created league (standard rules) — ✅ built, and correctly locked down
Leagues tab ("Create a private league"): name, member cap, team name — that's it. `createPrivateLeague()` is called with `scoringRules: null` and no boosters, so the resulting contest is always `isSharedXI = true`. Confirms your #2: **a user genuinely cannot set custom rules/boosters here** — the option isn't in the UI and isn't passed to the write. Good — this is already enforced correctly, not just by convention.

### Shared XI mechanism — ✅ built, but only goes forward
When a squad is shared (`primary_squad_id` set), the XI is never picked independently for that squad. Instead, at the moment each match **locks** for the primary squad, `lock-matches` (Edge Function) also copies that match's `user_match_xi` rows into every squad currently pointing at it via `primary_squad_id` (`propagateXIToSharedSquads`). This is what makes "one pick, many leagues" work without extra data entry — you pick once for your main SL squad, and it silently reappears in every standard-rule private league you're in.

### Joining flow — ✅ built
`joinLeagueByCode(inviteCode, squadName, primarySquadId)`: validates the code, checks membership, checks the member cap, inserts the `user_squads` row (with `primary_squad_id` set only for shared leagues). Both create-and-auto-join and join-by-code go through this.

### Mobile — confirmed web-only, as you said
The RN app's `LeagueSelector.tsx` only lets a user **pick among leagues they're already a member of** — it renders whatever `contestStore` already pulled from Supabase. There's no create-league or join-by-code form anywhere in `app/src`. `RulesScreen.tsx` even tells the mobile user outright: _"Ask the league creator for the invite code. Go to Home → Season Long → Leagues → Join with code."_ — i.e. the mobile app's own help text sends people to the web app. This is a deliberate, already-documented gap, not an oversight.

---

## 3. The gap: "join late, still get history from M1" is not actually implemented

This is the one place the current build doesn't match the spec, and it's worth being precise about why.

`propagateXIToSharedSquads` / the shared-squad block in `lock-matches` only fires **at the moment a match locks**, and only for squads that have `primary_squad_id` set **at that moment**. It loops over "squads that currently point at me" — it has no concept of "and also backfill everything that already happened."

Concretely: your main SL squad has been playing since M1. A friend joins your private league (standard rules) at M10. `joinLeagueByCode` creates their squad with `primary_squad_id` = your main squad's id — but that only affects **future** lock events, starting at whichever match is still upcoming when they join. Matches M1–M9 already locked and already ran `propagateXIToSharedSquads` for the squads that existed at the time — your friend's squad didn't exist yet, so it was never included. There is no retroactive step anywhere in the codebase that goes back and fills in M1–M9 for a squad created after the fact.

**Net effect today:** a friend joining at M10 would show 0 points (or simply no rows) for M1–M9 in that league's leaderboard, and a season total that only reflects M10 onward — the opposite of what you've specified. Since the whole point of a shared-XI league is "same picks as my main squad," and your main squad's M1–M9 picks are sitting right there in the database, this is a backfill gap, not a scoring-logic gap — the source data to backfill from already exists.

### Scope — confirmed
Does "history from M1" apply only to **standard** (shared-XI) leagues, or also to **admin custom-rule** leagues? For standard leagues there's an obvious backfill source (the primary squad's real picks). For a custom-rule admin league, squads are independent by design — there's no primary squad to backfill from, so a late joiner joining an independent league has no XI to retroactively apply for M1–M9 unless the admin wants to force-share their SL picks anyway (contradicting "independent"). **Confirmed: the M1-backfill requirement is scoped to shared/standard leagues only**, where a source of truth already exists to backfill from. The design below is scoped accordingly.

### Confirmed: booster activations aren't mirrored either — and this isn't just a late-join issue

You flagged this after checking the admin panel for a user-created league and seeing no boosters selected there. Verified against the code, and it's a real, already-live gap — not hypothetical, and not limited to late joiners:

- A user-created league's contest row always has `available_boosters: null` (the create flow never passes it — see §2). That's expected, since the user-facing form has no booster picker.
- The problem is what `null` actually does at read time. `db.js`'s `activateBooster()` treats a missing `available_boosters` as "no boosters exist in this contest" and throws (`available` is falsy → immediate error) — it doesn't fall back to the primary squad's or the tournament's booster set.
- More importantly, scoring itself is booster-blind for shared squads. `scrape-scorecard/index.ts`'s `scoreXIForMatch()` builds its booster multiplier map with `boosterMap.set(b.squad_id, b.booster)` — keyed strictly on `squad_id`, no fallback through `primary_squad_id`. A shared squad never has its own `user_booster_activations` row (nothing ever writes one for it), so this lookup always comes back empty for it.
- The forward propagation that already exists (`lock-matches`' "Propagate to shared (private-league mirror) squads" block, and the standalone `propagateXIToSharedSquads`) only copies `user_match_xi`, `user_teams`, and `user_team_players`. Neither copies `user_booster_activations`.

**Net effect, today, for every standard-rule private league, regardless of when the member joined:** if you activate a booster (Triple Captain, Dual Captain, etc.) on your main SL squad for a match, your private-league squad's XI for that match is a correct mirror of the players/captain/VC — but it scores **unboosted**, because there's no activation row for the multiplier calc to find. This is the same "unboosted XI" concern flagged in the original draft's open question — confirmed real, and confirmed to already affect live, already-locked matches, not just the M1-backfill scenario in §4c.

**Your framing is the right fix:** a user-created league shouldn't be modeled as a separate contest that happens to have an empty booster configuration — it should be treated as a mirror of the primary squad's actual played state, full stop. Nothing about it (XI, booster, and — worth checking with the same lens — transfer count/penalty state) should be independently configurable or independently tracked. Concretely, this means the propagation logic needs one more table added to what it already copies: extend both the per-match forward propagation (`lock-matches`' shared-squad block) and the historical backfill (§4c) to also copy the primary squad's `user_booster_activations` row for that match, if one exists, under the shared squad's `squad_id`. That closes the gap for new activity going forward *and* gives the backfill in §4c a real source to pull from for already-played matches — the "should we backfill boosters too" question is answered: yes, it's not optional, it's the same bug.

---

## 4. Proposed workflow

### 4a. Admin-created custom league — unchanged, already correct
Create (name, cap, boosters, optional scoring overrides) → invite code → members join independently → each match, each member picks their own XI under this league's rules. No backfill applies since there's no shared source.

### 4b. User-created standard league, joining **before** any match has locked
Unchanged — this already works correctly today, since propagation naturally starts covering the member from the very first match onward, same as everyone else. **Caveat, per the booster finding above:** "correctly" currently means "XI matches" — the score itself will still be wrong for any match where the primary squad uses a booster, even for a member who joined at M1. That's the same fix as §4c's booster copy, just applied going forward instead of retroactively — not a separate problem, but worth not assuming this path is fully clean until that fix lands.

### 4c. User joins a standard league **after** M1 (or several matches) have already locked — the fix
This is the new step, inserted right after `joinLeagueByCode` creates the shared squad:

1. `joinLeagueByCode` creates the `user_squads` row with `primary_squad_id` set, as today.
2. **New:** a backfill call — e.g. `db.backfillSharedSquadHistory(newSquadId, primarySquadId)` — runs immediately after, before returning success to the UI:
   - Finds every match the primary squad already has locked `user_match_xi` for (i.e. every match that's already happened, from the tournament's perspective).
   - For each one, duplicates the primary squad's `user_match_xi` rows under the new squad_id — the exact same copy logic `propagateXIToSharedSquads` already does per-match, just looped over the backlog instead of one match at a time.
   - Also needs to reproduce whatever `lock-matches` does for a live match lock: create the corresponding `user_teams` / `user_team_players` rows for the new squad so the existing scoring pipeline picks it up and writes `user_team_match_scores` the normal way, rather than inventing a second scoring path.
3. This should be a single server-side call (Supabase RPC or Edge Function), not a client-side loop in `db.js` — a join happening while a match is mid-lock is a real race, and you want this atomic/idempotent rather than partially backfilled if the tab closes halfway through. **Runs blocking**, as part of the join call itself — the UI waits for it to complete before reporting success, so the member sees their full M1-onward history the moment they join rather than watching it fill in afterward.
4. UI: the join-success message already distinguishes shared vs independent (`🔗 Your main SL XI will be used here automatically`) — extend that line to say something like _"...including your points from M1–M9"_ so the backfill isn't invisible/surprising.

**Booster usage — confirmed, not optional.** Verified: boosters are looked up strictly by `squad_id` in `user_booster_activations`, with no fallback to `primary_squad_id`, so a shared squad's score is silently unboosted for any match the primary squad boosted. Step 2's backfill must copy the primary squad's `user_booster_activations` row (if any) for each backfilled match alongside the `user_match_xi` copy — see the confirmed finding in §3. This isn't unique to late joiners; it's the same gap §4b's caveat calls out for members who joined on time too, so the fix belongs in the shared propagation logic itself (used by both the forward path and this backfill), not as a backfill-only special case.

**Transfer/budget state — same lens, needs the same check.** Not yet verified as thoroughly as boosters, but worth confirming before building: does anything read a shared squad's own `total_transfers_allowed`/extra-transfer penalty off *its* contest (which defaults to unlimited/null for a user-created league) rather than mirroring the primary squad's real transfer count and any penalty it incurred under the SL contest's actual budget? If so, a shared squad's private-league total could diverge from its SL total even with identical XIs — same "this should be a mirror, not a second independently-tracked contest" problem, just on transfers instead of boosters.

### 4d. Mobile create/join — sequenced after the web flow, decided
Today mobile is deliberately read-only for leagues (confirmed above), and the in-app help text routes users to web. **Decision: sort out the web flow first (the M1 backfill in §4c and the booster-mirroring fix in §3), then port to mobile.** That ordering isn't just convenience — porting create/join to mobile now would mean either shipping the same backfill/booster gaps on a second platform, or building the fix twice in parallel. Once the shared-propagation logic (XI + booster, and whatever the transfer check in §4c turns up) is corrected once, on the web/backend side, mobile's create/join screen is a straightforward port: `createPrivateLeague`, `joinLeagueByCode`, `getContestByInviteCode` are plain Supabase client calls already used by `contestStore.ts` — no new backend work, just the same form (name, cap, team name, invite-code input) as a new mobile screen reusing logic that will by then already be correct. Until that lands, keep the mobile messaging as-is (it already correctly points users to web).

### 4e. Member cap policy — user create UI fixed at 3, admin-adjustable only

**Decided:** the "Create a private league" form (index.html's Leagues tab) currently lets the creator type any cap ≥2 (the `slPlCreateCap` input, defaulting to 5, nominally capped at 100 by the `max` attribute but not enforced server-side). That changes: **the user-facing create UI is fixed at 3 members, not editable by the creator.** If more than 3 are needed, an admin raises it afterward from the Admin tab — which already supports this today (`.pl-cap-input` / `.pl-cap-save` → `updateContestMaxMembers`), so no new admin-side work is required, only the create-flow change:

- Remove (or disable) the `slPlCreateCap` input from the user-facing create form; pass a hardcoded `maxMembers: 3` into `createPrivateLeague()` instead of reading the field.
- Drop the client-side validation branch that currently requires the user to explicitly set a cap ≥2 (`'Set a member limit (minimum 2).'`) — no longer relevant once it's fixed and not user-entered.
- The existing member-cap-full check in `joinLeagueByCode` (`count >= contest.max_members`) needs no change — it already enforces whatever cap is on the row, so it correctly blocks a 4th join until an admin raises it.
- Worth a line of UI copy on the create form itself (e.g. "Up to 3 members — an admin can raise this for you") so the limit isn't a surprise the first time a 4th friend tries to join.

---

## 5. Smaller items noticed while reading the code (not blocking, worth a decision)

- **No duplicate-name guard** on private leagues (already flagged in your own `index.html` comment) — same name can be created twice. Low risk, but confusing at scale.
- **Member-cap check has a race window**: `joinLeagueByCode` reads the current member count, then inserts — two people joining a 1-slot-remaining league at the same instant could both get in. Fine at friends-group scale; worth a DB-level constraint (e.g. a trigger or a unique count check) if leagues grow past casual size.
- **`getContestByInviteCode` preview** happens before the actual join in the web join flow (to decide shared vs independent) — the backfill in 4c should reuse this same preview step rather than adding a second round-trip.

---

## Open questions for you to weigh in on

1. ~~Confirm scope: does "history from M1" apply only to standard/shared leagues, or should custom-rule admin leagues also retroactively force-share history for late joiners?~~ — **resolved:** scoped to standard/shared leagues only. Custom-rule admin leagues stay independent, with no retroactive backfill.
2. ~~Should booster/transfer usage from the primary squad's already-played matches be backfilled alongside XI, or does the scoring pipeline already resolve boosters independently of `user_match_xi`?~~ — **resolved:** confirmed via `scrape-scorecard`'s `boosterMap` (keyed strictly on `squad_id`, no `primary_squad_id` fallback) that booster activations are never mirrored to shared squads, today, for anyone — not just late joiners. Needs to be fixed in the shared propagation logic itself (both the forward path and the backfill), not just the backfill. Transfer/budget state needs the same check — flagged as a likely-related follow-up, not yet verified to the same depth.
3. ~~Mobile parity for create/join — build now, or keep the web-only flow with clearer in-app messaging for the moment?~~ — **resolved:** sort out the web flow (backfill + booster mirroring) first, then integrate into mobile. See §4d.
4. ~~Should the backfill run as a blocking step in the join flow, or as an async job?~~ — **resolved:** blocking. The join call waits for the backfill to finish before returning success, so the user sees full M1-onward history immediately rather than a leaderboard that fills in after the fact.

---

## 6. Phased implementation plan

All decisions above are settled, so this sequences the actual build. Four phases, ordered by dependency and by how much live scoring damage each one is currently doing — the booster bug (Phase 1) is affecting every shared squad's score right now, every time a booster's used, so it outranks the late-join backfill (Phase 2) even though both were raised together.

### Phase 0 — Member cap: fix default, harden the check
No dependency on anything below; safe to ship first and separately.

- Hardcode `maxMembers: 3` in the user-facing create flow; remove the `slPlCreateCap` input and its now-obsolete validation branch (§4e).
- Add the "up to 3 members, admin can raise it" copy to the create form.
- **Bundle in the member-cap race fix from §5 here, not later:** a fixed cap of exactly 3 makes the race window §5 flagged much more likely to actually bite — three friends tapping the same invite link around the same time is the normal case for a 3-cap league, not an edge case. Make the cap check atomic (DB constraint/trigger, or a re-check-after-insert-and-rollback pattern) rather than leaving it as a soft client-side check.
- Bundle in the duplicate-name guard from §5 too — same create-flow file, same size of change, cheap to do alongside.

_Exit check: create a league, confirm it's capped at 3 from the web UI with no way to enter a different number; have 3 accounts join simultaneously via the same code and confirm exactly 3 get in, not more._

### Phase 1 — Fix the live booster-mirroring bug (highest priority)
This is a correctness bug in production today, not a new feature — every standard-rule private league is scoring boosted matches wrong right now.

- Extend the shared-squad propagation (`propagateXIToSharedSquads` and the equivalent block in `lock-matches`) to also copy the primary squad's `user_booster_activations` row for that match, if one exists, to the shared squad.
- Refactor the "mirror one match, primary → shared" logic (XI + `user_teams`/`user_team_players` + booster) into one shared helper — Phase 2's backfill needs to call this exact same per-match step in a loop, so building it twice now just means reconciling two copies later.
- Resolve the transfer/budget question flagged in §4c: confirm whether a shared squad's transfer count or extra-transfer penalty is ever evaluated against *its own* contest (wrong) instead of mirroring the primary squad's real SL transfer state, and fix if so.

_Exit check: activate a booster on a live main-SL squad for an upcoming match that already has a standard-rule private league attached; after lock, confirm the private league's leaderboard shows the same boosted score as SL for that match, not the unboosted total._

### Phase 2 — M1 backfill for late joiners
Depends on Phase 1's per-match mirror helper existing — reuses it in a loop rather than reimplementing.

- Build `backfillSharedSquadHistory(newSquadId, primarySquadId)` as a Supabase RPC/Edge Function: find every match already locked for the primary squad, call Phase 1's helper for each.
- Wire it into `joinLeagueByCode`, blocking, immediately after the shared squad row is inserted and before the join call returns.
- Update the join-success copy (both the create-and-auto-join and join-by-code paths in `index.html`) to surface that history was pulled in.

_Exit check: with a test account that's played and boosted several matches already, join a fresh test league mid-season with a second account; confirm the new squad's season total from M1 exactly matches the primary squad's own total for those same matches, and that the join call doesn't return until that's true._

### Phase 3 — Mobile parity
Deliberately last — sequenced after Phase 0–2 so mobile inherits correct behavior instead of the current bugs (per §4d).

- Port the create-league and join-by-code forms into a new mobile screen, calling the same `createPrivateLeague` / `joinLeagueByCode` / `getContestByInviteCode` already used by `contestStore.ts` — no new backend work.
- Apply Phase 0's fixed-cap-of-3 rule on the mobile create form too (no separate cap input there either).
- Update `RulesScreen.tsx`'s current "go to web" copy once the mobile flow exists.

_Exit check: create and join a standard-rule private league entirely from the mobile app, and confirm history/boosted scores show up correctly with no extra steps — this should require no mobile-side scoring logic at all, since it's inheriting Phase 1–2's fixes through the same backend calls._

---

_Rough sizing, single engineer already familiar with this codebase, not a commitment: Phase 0 ~1 day, Phase 1 ~2–3 days (the transfer investigation is the unknown), Phase 2 ~2 days, Phase 3 ~2–3 days. Phases 1 and 2 are the ones that actually fix wrong scores; 0 and 3 are lower-risk and could slip without hurting correctness._
