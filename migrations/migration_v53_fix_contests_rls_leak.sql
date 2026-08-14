-- migration_v53: fix contests RLS — private leagues were readable by anyone
-- Run in Supabase SQL editor.
--
-- Discovered while investigating Phase 4 (mobile parity for private
-- leagues): migration_v11 added a correctly-scoped SELECT policy on
-- `contests` — "contests: read own or public" — that only allows a private
-- contest row to be read by someone with a `user_squads` row in it (or by
-- anyone, if the contest is public). migration_v17 (written later, for a
-- different purpose — public read access for teams/tournaments/etc.) added
-- a SECOND permissive SELECT policy on the SAME table, "contests_public_read",
-- with `USING (true)`. It drops a policy of that exact name first (which
-- didn't exist yet at that point in the migration history) — not v11's
-- differently-named policy. Postgres ORs multiple permissive policies on the
-- same table together, so ever since v17 ran, the net effect has been:
-- `is_private = false OR is_member OR true` — always true. v11's restriction
-- has been silently neutralized the whole time.
--
-- Confirmed directly by reading both migration files, not just inferred:
-- migration_v11_private_leagues.sql lines 22-34 (the scoped policy) and
-- migration_v17_rls.sql lines 38-41 (the blanket one that overrides it).
--
-- Real-world impact: any signed-in user can currently SELECT every contest
-- row, including private leagues' `invite_code` — the whole point of an
-- invite-code gate. This is what let mobile's ContestPicker (built well
-- after v17, never knowing the intended restriction was already broken)
-- list every private league in the tournament with no membership check, and
-- let tapping into any of them walk straight into NameSquadModal →
-- teamStore.ensureSquad(), creating a real squad row with no invite-code
-- check at all. Decided not to rotate existing leagues' invite codes after
-- this fix ships — small invite-only friend-group app, low risk anything
-- was actually exploited.
--
-- Fix: drop the blanket policy, replace it with a scoped one that restores
-- v11's intent (public contests readable by all; private ones only by
-- members) and additionally lets the admin account read everything — needed
-- because the Contests admin panel (admin.js's renderContestsAdmin) lists
-- every private league in the tournament, including ones the admin never
-- personally joined (most user-created leagues), and has no other way to
-- distinguish "the admin" from "any authenticated user" at the DB layer.
-- Uses the same abhi0818@gmail.com check index.html / admin.js /
-- TabNavigator.tsx already all use for admin-only UI — just enforcing it at
-- the RLS layer for the first time, not only in app code.

DROP POLICY IF EXISTS "contests_public_read" ON contests;

CREATE POLICY "contests: read own, public, or admin"
  ON contests FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (
      is_private = false
      OR EXISTS (
        SELECT 1 FROM user_squads us
        WHERE us.contest_id = contests.id
          AND us.user_id    = auth.uid()
      )
      OR (auth.jwt() ->> 'email') = 'abhi0818@gmail.com'
    )
  );

-- migration_v11's original "contests: read own or public" policy is now
-- redundant with this one (identical logic minus the admin clause) — left
-- in place rather than dropped. Multiple permissive policies that all
-- evaluate correctly are harmless; only the blanket USING (true) one above
-- was the actual bug.
