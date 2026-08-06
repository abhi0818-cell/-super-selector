-- ─────────────────────────────────────────────────────────────────────────────
-- Super Selector — Migration v42: Tournament domestic-double icon
--
-- Companion to migration_v40 (tournaments.domestic_label). The domestic-double
-- booster ("indian_double" key, legacy name from IPL) was hardcoded everywhere
-- as "US Double" 🇺🇸, even for tournaments where "domestic" means something
-- else entirely (Caribbean for CPL, Indian for IPL, South African for SA20,
-- etc.). domestic_label already lets each tournament rename it; this adds a
-- matching icon.
--
-- Stores either a plain emoji ('🇺🇸', '🏏') or a data:image/... URI, for
-- groups with no single accurate Unicode flag emoji (e.g. "West Indies" /
-- "Caribbean" isn't a country — there's no flag codepoint for it). NULL falls
-- back to a generic cricket-bat emoji in the app (see DOMESTIC_ICON_FALLBACK
-- in index.html) rather than defaulting to any one country's flag.
--
-- Paste into Supabase SQL Editor → Run.
-- ─────────────────────────────────────────────────────────────────────────────

alter table tournaments
  add column if not exists domestic_icon text default null;

comment on column tournaments.domestic_icon is
  'Icon for the domestic-double booster badge — emoji or data:image/... URI. NULL = generic cricket-bat fallback in the app.';
