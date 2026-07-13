// send-push-notification — Supabase Edge Function
//
// Sends an admin-authored push notification to every registered device via
// Expo's push service (https://exp.host/--/api/v2/push/send). Triggered
// directly from AdminScreen.tsx's "Send Notification" section via
// supabase.functions.invoke(), same pattern as lock-matches / poll-cricapi.
//
// Auth: this function is deployed WITH JWT verification (no --no-verify-jwt),
// so Supabase has already confirmed the caller holds a valid session before
// the request reaches this code. On top of that we independently check the
// caller's email against ADMIN_EMAIL — matching the client-side gate in
// AdminScreen.tsx (ADMIN_EMAIL constant) and the is_admin() SQL helper used
// by the push_tokens/notifications_log RLS policies (migration_v36).
//
// Flow:
//   1. Verify caller is admin.
//   2. Read title/body from the request body.
//   3. Pull every row from push_tokens (target = 'all' for now).
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
    // ── 1. Verify caller is admin ──────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    if (!jwt) return jsonResponse({ ok: false, error: 'Missing Authorization header' }, 401)

    const { data: { user }, error: userErr } = await sb.auth.getUser(jwt)
    if (userErr || !user) return jsonResponse({ ok: false, error: 'Invalid session' }, 401)
    if (user.email !== ADMIN_EMAIL) return jsonResponse({ ok: false, error: 'Admin access only' }, 403)

    // ── 2. Parse payload ────────────────────────────────────────────────────
    const body = await req.json().catch(() => ({})) as { title?: string; body?: string; data?: Record<string, unknown> }
    const title = (body.title ?? '').trim()
    const message = (body.body ?? '').trim()
    if (!title || !message) return jsonResponse({ ok: false, error: 'title and body are required' }, 400)

    // ── 3. Load recipient tokens ────────────────────────────────────────────
    const { data: tokenRows, error: tokErr } = await sb
      .from('push_tokens')
      .select('token')

    if (tokErr) return jsonResponse({ ok: false, error: tokErr.message }, 500)

    const tokens = Array.from(new Set((tokenRows ?? []).map(r => r.token).filter(Boolean)))

    if (tokens.length === 0) {
      await sb.from('notifications_log').insert({
        title, body: message, target: 'all', sent_by: user.id, sent_count: 0, failed_count: 0,
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
      title, body: message, target: 'all', sent_by: user.id,
      sent_count: sentCount, failed_count: failedCount,
    })

    return jsonResponse({ ok: true, sent: sentCount, failed: failedCount, pruned: deadTokens.length })
  } catch (err) {
    console.error('[send-push-notification]', err)
    return jsonResponse({ ok: false, error: (err as Error).message }, 500)
  }
})
