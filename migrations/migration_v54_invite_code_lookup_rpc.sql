-- migration_v54: RPC for invite-code lookup, broken by migration_v53's RLS fix
-- Run in Supabase SQL editor.
--
-- migration_v53 (previous fix) correctly closed the leak where any signed-in
-- user could SELECT every contest row, including private leagues' invite
-- codes, by requiring the caller to already have a `user_squads` row in a
-- private contest to read it. That's exactly right for browsing/listing —
-- but it also silently broke the ONE place a non-member is SUPPOSED to read
-- a private contest row: looking it up by invite code to join it in the
-- first place. A brand-new joiner has no user_squads row yet (that's the
-- whole point of joining), so getContestByInviteCode (db.js) and
-- previewLeagueByCode/joinLeagueByCode's own internal lookup (mobile's
-- contestStore.ts) now get zero rows back from Postgres before their own
-- .eq('invite_code', ...) filter even matters — surfacing as "Invalid
-- invite code" for a code that's completely correct. This is what broke
-- joining the just-created "Same Rules" league with a valid code (VP7WCA).
--
-- RLS can't fix this with another USING clause: a row policy is evaluated
-- per-row against session context (auth.uid(), auth.jwt()), not against the
-- client's WHERE-clause values, so there's no way to write "readable if you
-- supplied the matching invite_code" as a row policy without effectively
-- reopening every private contest row to any authenticated SELECT (v53's
-- exact bug) — the policy has no way to know the query even filtered on
-- invite_code at all, let alone with which value.
--
-- Fix: a narrow SECURITY DEFINER RPC that does its own equality lookup,
-- bypassing the contests SELECT policy entirely but only ever returning a
-- SINGLE row that matches an EXACT invite_code — same shape and security
-- model as a real "redeem this code" endpoint. It can't be used to browse
-- or enumerate private leagues (no listing capability, no fuzzy match), so
-- it doesn't reopen the leak v53 closed. Both getContestByInviteCode's
-- preview call and joinLeagueByCode's own internal re-lookup (web AND
-- mobile — both had this exact duplicated pattern) now call this instead of
-- a raw `.from('contests').select(...)`.

CREATE OR REPLACE FUNCTION get_contest_by_invite_code(p_invite_code TEXT)
RETURNS SETOF contests AS $$
BEGIN
  IF auth.role() <> 'authenticated' THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  RETURN QUERY
    SELECT * FROM contests
    WHERE invite_code = upper(trim(p_invite_code))
      AND is_private   = true
      AND is_active    = true
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
