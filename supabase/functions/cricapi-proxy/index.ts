// cricapi-proxy — Supabase Edge Function
// Forwards requests to CricAPI, adding CORS headers so the browser app
// on GitHub Pages can call it without being blocked.
//
// Deploy via Supabase Dashboard → Edge Functions → New function
// or: supabase functions deploy cricapi-proxy --no-verify-jwt

const CRICAPI_BASE = 'https://api.cricapi.com/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const incoming = new URL(req.url);

    // Strip the Edge Function prefix to get the CricAPI path + query
    // Works regardless of the function name (cricapi-proxy, swift-task, etc.)
    // e.g. /functions/v1/swift-task/match_scorecard?apikey=…&id=…
    //   → https://api.cricapi.com/v1/match_scorecard?apikey=…&id=…
    const stripped = incoming.pathname.replace(
      /^\/functions\/v1\/[^/]+\/?/,
      ''
    );
    const target = `${CRICAPI_BASE}/${stripped}${incoming.search}`;

    console.log('[cricapi-proxy] target:', target);

    const upstream = await fetch(target, {
      headers: { 'Accept': 'application/json' },
    });

    const body = await upstream.text();
    console.log('[cricapi-proxy] upstream status:', upstream.status, '| body[:200]:', body.slice(0, 200));

    return new Response(body, {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cricapi-proxy] fetch error:', msg);
    return new Response(JSON.stringify({ status: 'failure', reason: msg, hint: 'Check Edge Function logs in Supabase Dashboard' }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
