// send-push-notification — Supabase Edge Function
//
// Sends an admin-authored push notification to every registered device via
// Expo's push service (https://exp.host/--/api/v2/push/send). Triggered
// directly from AdminScreen.tsx's "Send Notification" section via
// supabase.functions.invoke(), same pattern as lock-matches / poll-cricapi.
//
// Auth: two ways in.
//   (a) A normal admin session JWT — Supabase has already confirmed the
//       caller holds a valid session before the request reaches this code;
//       on top of that we independently check the caller's email against
//       ADMIN_EMAIL, matching the client-side gate in AdminScreen.tsx
//       (ADMIN_EMAIL constant) and the is_admin() SQL helper used by the
//       push_tokens/notifications_log RLS policies (migration_v36).
//   (b) The service role key, same trusted-system-caller pattern lock-matches
//       and poll-cricapi already use for their own cron triggers — added so
//       check-toss (migration_v55/v56) can alert the admin about a possible
//       match delay without a human session in the loop. A service-role call
//       MUST set target:'admin' — it is never allowed to broadcast to 'all',
//       so a bug in a future cron job can't turn into a blast to every user.
//
// Flow:
//   1. Verify caller is admin (session) or the service role (system, admin-only).
//   2. Read title/body/target from the request body.
//   3. Load recipient tokens — every row in push_tokens for target:'all', or
//      just the admin account's own tokens for target:'admin'.
//   4. POST to Expo's push API in batches of 100 (its documented limit).
//   5. Any token Expo reports as DeviceNotRegistered gets deleted from
//      push_tokens — keeps the table from accumulating dead installs.
//   6. Write a row to notifications_log for the admin's send history.
//
// Deploy:
//   supabase functions deploy send-push-notification
//
// Required env vars (Supabase dashboard → Edge Functions → Secrets):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ADMIN_EMAIL               = 'abhi0818@gmail.com'
const EXPO_PUSH_URL             = 'https://exp.host/--/api/v2/push/send'
const BATCH_SIZE                = 100

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Browser admin panel calls this directly, so it needs CORS.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface ExpoTicket {
  status: 'ok' | 'error'
  message?: string
  details?: { error?: string }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

  try {
    // ── 1. Verify caller is admin (session) or the service role (system) ────
    const authHeader = req.headers.get('Authorization') ?? ''
    const isServiceRoleCaller = authHeader.includes(SUPABASE_SERVICE_ROLE_KEY)

    let callerUserId: string | null = null
    if (!isServiceRoleCaller) {
      const jwt = authHeader.replace(/^Bearer\s+/i, '')
      if (!jwt) return jsonResponse({ ok: false, error: 'Missing Authorization header' }, 401)

      const { data: { user }, error: userErr } = await sb.auth.getUser(jwt)
      if (userErr || !user) return jsonResponse({ ok: false, error: 'Invalid session' }, 401)
      if (user.email !== ADMIN_EMAIL) return jsonResponse({ ok: false, error: 'Admin access only' }, 403)
      callerUserId = user.id
    }

    // ── 2. Parse payload ────────────────────────────────────────────────────
    const body = await req.json().catch(() => ({})) as {
      title?: string; body?: string; data?: Record<string, unknown>; tickerHours?: number; target?: string
    }
    const title = (body.title ?? '').trim()
    const message = (body.body ?? '').trim()
    if (!title || !message) return jsonResponse({ ok: false, error: 'title and body are required' }, 400)

    // A service-role caller (a cron job, not a human) may only ever target
    // the admin's own devices — never 'all'.
    const target = body.target === 'admin' ? 'admin' : 'all'
    if (isServiceRoleCaller && target !== 'admin') {
      return jsonResponse({ ok: false, error: "Service-role callers must set target:'admin'" }, 403)
    }

    // How long this stays on the HomeScreen ticker, independent of read
    // state (migration_v38). Clamped to a sane range — 0.25h (15min) to
    // 72h — so a bad client value can't leave something stuck for weeks.
    const rawTickerHours = Number(body.tickerHours)
    const tickerHours = Number.isFinite(rawTickerHours)
      ? Math.min(72, Math.max(0.25, rawTickerHours))
      : 6

    // ── 3. Load recipient tokens ────────────────────────────────────────────
    let tokenQuery = sb.from('push_tokens').select('token')
    if (target === 'admin') {
      // push_tokens.user_id references auth.users(id). The auth schema isn't
      // exposed over PostgREST by default, so we resolve the admin's user id
      // via the GoTrue admin API (service-role authorized) instead of a
      // direct table query — works regardless of the project's "Exposed
      // schemas" setting.
      const { data: userList, error: adminErr } = await sb.auth.admin.listUsers({ perPage: 1000 })
      const adminUser = userList?.users?.find(u => u.email === ADMIN_EMAIL) ?? null
      if (adminErr || !adminUser) {
        return jsonResponse({ ok: false, error: adminErr?.message ?? 'Admin account not found' }, 500)
      }
      tokenQuery = tokenQuery.eq('user_id', adminUser.id)
    }

    const { data: tokenRows, error: tokErr } = await tokenQuery
    if (tokErr) return jsonResponse({ ok: false, error: tokErr.message }, 500)

    const tokens = Array.from(new Set((tokenRows ?? []).map(r => r.token).filter(Boolean)))

    if (tokens.length === 0) {
      await sb.from('notifications_log').insert({
        title, body: message, target, sent_by: callerUserId, sent_count: 0, failed_count: 0,
        ticker_hours: tickerHours,
      })
      return jsonResponse({ ok: true, message: 'No registered devices', sent: 0, failed: 0 })
    }

    // ── 4. Send in batches ──────────────────────────────────────────────────
    let sentCount = 0
    let failedCount = 0
    const deadTokens: string[] = []

    for (const batch of chunk(tokens, BATCH_SIZE)) {
      const messages = batch.map(token => ({
        to: token,
        title,
        body: message,
        sound: 'default',
        data: body.data ?? {},
      }))

      try {
        const res = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(messages),
        })

        const json = await res.json().catch(() => null) as { data?: ExpoTicket[] } | null
        const tickets = json?.data ?? []

        tickets.forEach((ticket, i) => {
          if (ticket.status === 'ok') {
            sentCount++
          } else {
            failedCount++
            if (ticket.details?.error === 'DeviceNotRegistered') {
              deadTokens.push(batch[i])
            }
          }
        })

        // Expo returned something unexpected (e.g. rate limited) — count the
        // whole batch as failed rather than silently dropping it.
        if (!tickets.length) failedCount += batch.length
      } catch (e) {
        console.error('[send-push-notification] batch send failed:', (e as Error).message)
        failedCount += batch.length
      }
    }

    // ── 5. Prune dead tokens ────────────────────────────────────────────────
    if (deadTokens.length) {
      await sb.from('push_tokens').delete().in('token', deadTokens)
    }

    // ── 6. Log the send ─────────────────────────────────────────────────────
    await sb.from('notifications_log').insert({
      title, body: message, target, sent_by: callerUserId,
      sent_count: sentCount, failed_count: failedCount,
      ticker_hours: tickerHours,
    })

    return jsonResponse({ ok: true, sent: sentCount, failed: failedCount, pruned: deadTokens.length })
  } catch (err) {
    console.error('[send-push-notification]', err)
    return jsonResponse({ ok: false, error: (err as Error).message }, 500)
  }
})
