#!/usr/bin/env node
/**
 * Tiny CORS proxy for CricAPI.
 *
 * The browser blocks direct calls to api.cricapi.com from a localhost page
 * (CORS). This proxy listens on http://localhost:8081 and forwards any request
 * under /cricapi/<path> to https://api.cricapi.com/v1/<path>, adding the CORS
 * headers your page needs.
 *
 * Usage from the browser (or fetch):
 *   GET http://localhost:8081/cricapi/match_scorecard?apikey=KEY&id=MATCH_ID
 *
 * Run with: node proxy.js
 * Or let start.command launch it for you automatically.
 */

import http         from 'node:http';
import https        from 'node:https';
import { spawn }   from 'node:child_process';

const PORT          = Number(process.env.PROXY_PORT || 8081);
const CACHE_TTL_MS  = Number(process.env.PROXY_CACHE_TTL_MS || 60_000); // 1 min
const UPSTREAM      = 'https://api.cricapi.com/v1';
const CRICSHEET_URL = 'https://cricsheet.org';
const ESPNCI_URL    = 'https://hs-consumer-api.espncricinfo.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age'      : '86400',
};

// In-memory response cache keyed by full upstream URL (apikey included).
// Saves CricAPI quota on quick reconnects, accidental polls, or multiple tabs.
const cache = new Map(); // url -> { ts, status, contentType, body: Buffer }
function cacheGet(url) {
  const e = cache.get(url);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(url); return null; }
  return e;
}
function cacheSet(url, status, contentType, body) {
  cache.set(url, { ts: Date.now(), status, contentType, body });
}

function sendError(res, code, msg) {
  res.writeHead(code, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

const server = http.createServer((req, res) => {
  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Health probe
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, upstream: UPSTREAM, port: PORT,
      cacheTtlMs: CACHE_TTL_MS, cachedEntries: cache.size,
    }));
    return;
  }

  // Cache flush — useful for testing
  if (req.url === '/cache/flush') {
    const n = cache.size; cache.clear();
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, flushed: n }));
    return;
  }

  // Route: /cricsheet/* → https://cricsheet.org/*
  if (req.url.startsWith('/cricsheet/')) {
    const cricsheetPath = req.url.slice('/cricsheet'.length); // e.g. /matches/1529306.json
    const upstreamUrl   = CRICSHEET_URL + cricsheetPath;
    const hit = cacheGet(upstreamUrl);
    if (hit) {
      res.writeHead(hit.status, { ...CORS_HEADERS, 'Content-Type': hit.contentType, 'X-Cache': 'HIT' });
      res.end(hit.body);
      return;
    }
    const reqOpts = { method: req.method, headers: { 'User-Agent': 'super-selector-proxy/1.0', Accept: 'application/json' } };
    const upReq = https.request(upstreamUrl, reqOpts, upstream => {
      const contentType = upstream.headers['content-type'] || 'application/json';
      const chunks = [];
      upstream.on('data', c => chunks.push(c));
      upstream.on('end', () => {
        const body   = Buffer.concat(chunks);
        const status = upstream.statusCode || 502;
        if (status >= 200 && status < 500) cacheSet(upstreamUrl, status, contentType, body);
        res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': contentType, 'X-Cache': 'MISS' });
        res.end(body);
      });
      upstream.on('error', err => sendError(res, 502, `Cricsheet upstream error: ${err.message}`));
    });
    upReq.on('error', err => sendError(res, 502, `Cricsheet upstream error: ${err.message}`));
    req.pipe(upReq);
    return;
  }

  // Route: /espncricinfo/* → https://hs-consumer-api.espncricinfo.com/*
  // Uses curl --http2 instead of Node's https so the TLS fingerprint matches a
  // real browser. Node's OpenSSL stack is reliably detected and blocked by Akamai;
  // curl on macOS uses LibreSSL + HTTP/2 which passes the bot check.
  if (req.url.startsWith('/espncricinfo/')) {
    const ePath = req.url.slice('/espncricinfo'.length);
    const eUrl  = ESPNCI_URL + ePath;
    const hit   = cacheGet(eUrl);
    if (hit) {
      res.writeHead(hit.status, { ...CORS_HEADERS, 'Content-Type': hit.contentType, 'X-Cache': 'HIT' });
      res.end(hit.body);
      return;
    }

    // curl appends "ESPN_STATUS:<code>" after the body so we can parse status
    // without needing a temp file or header parsing.
    const curlArgs = [
      '--silent', '--http2', '--location', '--max-time', '20',
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      '-H', 'Accept: application/json, text/plain, */*',
      '-H', 'Accept-Language: en-US,en;q=0.9',
      '-H', 'Referer: https://www.espncricinfo.com/',
      '-H', 'Origin: https://www.espncricinfo.com',
      '-H', 'sec-ch-ua: "Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      '-H', 'sec-ch-ua-mobile: ?0',
      '-H', 'sec-ch-ua-platform: "macOS"',
      '-H', 'sec-fetch-dest: empty',
      '-H', 'sec-fetch-mode: cors',
      '-H', 'sec-fetch-site: same-site',
      '-w', 'ESPN_STATUS:%{http_code}',
      eUrl,
    ];

    const curl     = spawn('curl', curlArgs);
    const chunks   = [];
    const errChunks = [];

    curl.stdout.on('data', c => chunks.push(c));
    curl.stderr.on('data', e => errChunks.push(e));

    curl.on('close', exitCode => {
      if (exitCode !== 0 && chunks.length === 0) {
        const msg = Buffer.concat(errChunks).toString().trim();
        return sendError(res, 502, `ESPN curl failed (exit ${exitCode}): ${msg}`);
      }

      // Split body from appended status marker
      const raw    = Buffer.concat(chunks);
      const marker = Buffer.from('ESPN_STATUS:');
      const sepIdx = raw.lastIndexOf(marker);
      const status = sepIdx >= 0 ? parseInt(raw.slice(sepIdx + marker.length).toString('ascii')) : 502;
      const body   = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
      const contentType = 'application/json';

      if (status >= 200 && status < 500) cacheSet(eUrl, status, contentType, body);
      res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': contentType, 'X-Cache': 'MISS' });
      res.end(body);
    });

    curl.on('error', err => sendError(res, 502,
      `curl not found or failed: ${err.message}. Ensure curl is installed (it ships with macOS).`));
    return;
  }

  if (!req.url.startsWith('/cricapi/')) {
    return sendError(res, 404, 'Routes: /cricapi/<endpoint>, /cricsheet/<path>, or /espncricinfo/<path>');
  }

  // Forward to CricAPI
  const upstreamPath = req.url.slice('/cricapi'.length); // leading slash + query
  const upstreamUrl  = UPSTREAM + upstreamPath;

  // Cache check (only GET — POSTs are uncommon for CricAPI and may carry bodies)
  if (req.method === 'GET' || req.method === undefined) {
    const hit = cacheGet(upstreamUrl);
    if (hit) {
      res.writeHead(hit.status, {
        ...CORS_HEADERS,
        'Content-Type': hit.contentType,
        'X-Cache'       : 'HIT',
        'X-Cache-Age-Ms': String(Date.now() - hit.ts),
      });
      res.end(hit.body);
      return;
    }
  }

  const reqOpts = {
    method: req.method,
    headers: { 'User-Agent': 'super-selector-proxy/1.0', Accept: 'application/json' },
  };

  const upstreamReq = https.request(upstreamUrl, reqOpts, upstream => {
    const contentType = upstream.headers['content-type'] || 'application/json';
    const chunks = [];
    upstream.on('data', c => chunks.push(c));
    upstream.on('end', () => {
      const body = Buffer.concat(chunks);
      const status = upstream.statusCode || 502;
      // Only cache successful-ish JSON responses
      if (req.method === 'GET' && status >= 200 && status < 500) {
        cacheSet(upstreamUrl, status, contentType, body);
      }
      res.writeHead(status, {
        ...CORS_HEADERS,
        'Content-Type': contentType,
        'X-Cache'     : 'MISS',
      });
      res.end(body);
    });
    upstream.on('error', err => sendError(res, 502, `Upstream error: ${err.message}`));
  });

  upstreamReq.on('error', err => sendError(res, 502, `Upstream error: ${err.message}`));
  req.pipe(upstreamReq);
});

server.listen(PORT, () => {
  console.log(`Super Selector proxy listening on http://localhost:${PORT}`);
  console.log(`  /cricapi/*      → ${UPSTREAM}/*`);
  console.log(`  /cricsheet/*    → ${CRICSHEET_URL}/*`);
  console.log(`  /espncricinfo/* → ${ESPNCI_URL}/*`);
  console.log(`  Cache TTL: ${CACHE_TTL_MS}ms — set PROXY_CACHE_TTL_MS to change`);
});

// Clean shutdown on Ctrl+C
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
  console.log(`\nProxy shutting down (${sig}).`);
  server.close(() => process.exit(0));
}));
