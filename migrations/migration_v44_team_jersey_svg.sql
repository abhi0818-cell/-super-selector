-- Adds an optional custom jersey design per team. When set, the app renders
-- this raw SVG markup instead of the default two-color (color/color2)
-- jersey fill — everywhere a team's jersey appears (player pool, pitch view,
-- history/leaderboard breakdowns, and the mobile app).
--
-- Expected content: the INNER markup of an SVG document targeting the app's
-- shared jersey shape (viewBox "0 0 141 179", 4 fill regions: body, left
-- sleeve, right sleeve, collar — see pitchJerseyHtml() in index.html for the
-- canonical path data). Store the full <svg>...</svg> string (defs/paths/
-- groups included); the render layer strips/ignores any fixed width/height
-- so it always scales to whatever size it's shown at. No external references
-- (fonts, hrefs) — must be fully self-contained since it's rendered both in
-- a browser DOM and via react-native-svg's SvgXml on mobile.
--
-- NULL (the default) means "no custom design" — falls back to the existing
-- color/color2 fill behavior. No backfill needed; this is purely additive.

alter table teams
  add column if not exists jersey_svg text default null;

comment on column teams.jersey_svg is
  'Optional raw SVG markup (viewBox 0 0 141 179) for a custom jersey design. NULL falls back to color/color2 fill rendering.';
