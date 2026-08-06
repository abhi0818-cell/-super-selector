# Super Selector — Database Setup

This guide gets the app talking to a Supabase Postgres database in about 5 minutes.

## 1. Create a Supabase project

1. Go to https://supabase.com and sign in (or sign up — free tier is fine for this prototype).
2. Click **New project**. Pick any name (e.g. `super-selector`) and a strong database password.
3. Choose the closest region. Wait ~2 minutes for the project to provision.

## 2. Run the schema

1. In the Supabase dashboard, open the **SQL Editor** (left sidebar).
2. Click **New query**.
3. Open `schema.sql` from this folder, paste the entire contents into the editor.
4. Click **Run**. You should see "Success. No rows returned" and a few "rows affected" lines for the seed inserts.

Verify by opening **Table Editor** — you should see `teams`, `players`, `user_teams`, `user_team_players`, `matches`, `player_match_stats`, `user_team_match_scores`, plus the views `user_team_xi` and `user_team_history`. The `teams` table should have 8 rows and `players` should have 30 rows.

## 3. Grab your credentials

1. Go to **Project Settings → API** in the sidebar.
2. Copy these two values:
   - **Project URL** — looks like `https://abcdefghijk.supabase.co`
   - **anon public** key — long JWT string starting with `eyJ…`

## 4. Connect the app

1. Open `index.html` (double-click it).
2. In the right panel, expand **Settings**.
3. Paste the Project URL into "Supabase project URL".
4. Paste the anon key into "Supabase anon key".
5. Click **Connect to database**.

The pill in the header should turn green and read "database connected". Your players will now load from the DB. Saved teams and match history will persist.

## 5. Test it

1. Draft a valid XI (11 players, budget OK, captain + VC picked).
2. Type a team name in the "Name this XI" box, click **Save XI**. It should appear under "Saved teams".
3. Click **Start mock match**, let it run 30 seconds.
4. Click **Save match**, add an optional note. The match should appear under "Match history" with your total points.
5. Reload the page. Your team and history should still be there.

## Security note (single-user prototype)

The anon key sits in your browser. Anyone who can see your `index.html` can read and write to your tables. That's fine for a personal-use prototype.

**Before sharing this app with anyone else**, you need to:
1. Enable [Row Level Security](https://supabase.com/docs/guides/auth/row-level-security) on every table.
2. Add a `user_id uuid references auth.users` column to `user_teams` and `matches`.
3. Add RLS policies like `using (user_id = auth.uid())`.
4. Wire up Supabase Auth in the UI (the SDK has email/magic-link/Google login built in).

## Going back to local mode

To disconnect, open the browser console and run:

```js
localStorage.removeItem('ss_supabase_url');
localStorage.removeItem('ss_supabase_key');
location.reload();
```

The app falls back to the built-in 30-player mock pool.

## Troubleshooting

- **"Could not connect" toast** — Check the URL doesn't have a trailing slash and the anon key is the full JWT. Make sure you ran `schema.sql` first.
- **Players show but saves fail** — Open browser devtools → Network tab → look for the failing request. Often it's RLS being enabled with no permissive policy. For prototype use, leave RLS off (the default after running this schema).
- **CORS error** — Supabase allows browser requests by default. If you see CORS errors, check Supabase project settings → API → confirm "Anonymous access" is enabled.
