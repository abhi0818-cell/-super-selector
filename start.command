#!/bin/bash
# Super Selector — local launcher.
# Starts the static site server AND the CORS proxy.
# Press Ctrl+C to stop both, then close the window.

cd "$(dirname "$0")"
APP_PORT=8080
PROXY_PORT=8081

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install it from https://www.python.org/downloads/"
  echo "Press any key to exit."; read -n 1; exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Warning: node not found — the proxy won't start."
  echo "Install Node.js from https://nodejs.org if you want live scoring to work."
  echo "Continuing without the proxy..."
  NODE_OK=0
else
  NODE_OK=1
fi

# ── Kill any stale processes from a previous session ──────────────────────────
echo "Cleaning up old processes..."
# Kill any node proxy.js already running
pkill -f "node proxy.js" 2>/dev/null
# Kill any python http.server on our ports
lsof -ti TCP:$APP_PORT   -sTCP:LISTEN | xargs kill -9 2>/dev/null
lsof -ti TCP:$PROXY_PORT -sTCP:LISTEN | xargs kill -9 2>/dev/null
sleep 0.5   # give the OS a moment to release the ports

# ── Start proxy ───────────────────────────────────────────────────────────────
PROXY_PID=""
if [ "$NODE_OK" = "1" ]; then
  PROXY_PORT=$PROXY_PORT node proxy.js &
  PROXY_PID=$!
fi

# ── Clean shutdown on Ctrl+C ──────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "Shutting down..."
  if [ -n "$PROXY_PID" ]; then kill $PROXY_PID 2>/dev/null; fi
  exit 0
}
trap cleanup INT TERM

( sleep 1 && open "http://localhost:$APP_PORT" ) &

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Super Selector  →  http://localhost:$APP_PORT"
[ "$NODE_OK" = "1" ] && echo "  Proxy           →  http://localhost:$PROXY_PORT"
echo "  Press Ctrl+C to stop."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

python3 -m http.server "$APP_PORT"
