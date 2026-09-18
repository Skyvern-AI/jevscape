#!/bin/bash
# Bring up (or tear down) a local game stack for ad-hoc diagnostics:
# engine (8x) + gateway + one headless lite bot with the benchmark save.
#
#   agents/jev/dev-stack.sh up   <rs-sdk path> [botname]
#   agents/jev/dev-stack.sh down <rs-sdk path>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH_ROOT="$(cd "$HERE/../.." && pwd)"
CMD="$1"; RS_SDK="$(cd "$2" && pwd)"; BOT="${3:-agent1}"
STATE_DIR="$RS_SDK/bots/.devstack"; mkdir -p "$STATE_DIR"

if [[ "$CMD" == "down" ]]; then
  for f in "$STATE_DIR"/*.pid; do [[ -f "$f" ]] || continue; kill "$(cat "$f")" 2>/dev/null || true; done
  sleep 2
  for f in "$STATE_DIR"/*.pid; do [[ -f "$f" ]] || continue; kill -9 "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done
  for port in 8888 7780; do for pid in $(lsof -ti tcp:"$port" 2>/dev/null || true); do kill -9 "$pid" 2>/dev/null || true; done; done
  echo "stack down"; exit 0
fi

mkdir -p "$RS_SDK/server/engine/data/players/main"
# The engine checkpoints online players into data/market.sqlite and prefers that over the .sav file.
# The benchmark image starts clean, so reset it here too.
rm -f "$RS_SDK/server/engine/data/market.sqlite" "$RS_SDK/server/engine/data/market.sqlite-shm" "$RS_SDK/server/engine/data/market.sqlite-wal"
cp "$BENCH_ROOT/shared/agent.sav" "$RS_SDK/server/engine/data/players/main/$BOT.sav"
mkdir -p "$RS_SDK/bots/jev" "$RS_SDK/bots/$BOT"
cp "$HERE"/*.ts "$RS_SDK/bots/jev/"
printf 'BOT_USERNAME=%s\nPASSWORD=test\nSERVER=localhost:8888\nGATEWAY_URL=ws://localhost:7780\nSHOW_CHAT=false\nTELEMETRY=false\n' "$BOT" > "$RS_SDK/bots/$BOT/bot.env"

(cd "$RS_SDK/server/engine" && exec env BUILD_VERIFY=false NODE_TICKRATE=50 bun run src/app.ts) > "$STATE_DIR/engine.log" 2>&1 &
echo $! > "$STATE_DIR/engine.pid"
for i in $(seq 1 120); do grep -q "World ready" "$STATE_DIR/engine.log" 2>/dev/null && curl -sf -o /dev/null http://localhost:8888/crc && break; sleep 1; done
(cd "$RS_SDK/server/gateway" && exec bun run gateway.ts) > "$STATE_DIR/gateway.log" 2>&1 &
echo $! > "$STATE_DIR/gateway.pid"
for i in $(seq 1 30); do curl -sf -o /dev/null http://localhost:7780/status && break; sleep 1; done
(cd "$RS_SDK/server/webclient" && exec bun src/lite/runner.ts "$BOT") > "$STATE_DIR/lite-$BOT.log" 2>&1 &
echo $! > "$STATE_DIR/lite-$BOT.pid"
for i in $(seq 1 60); do curl -s "http://localhost:7780/status/$BOT" | grep -q '"inGame": *true' && break; sleep 1; done
curl -s "http://localhost:7780/status/$BOT"
echo; echo "stack up: engine $(cat "$STATE_DIR/engine.pid"), gateway $(cat "$STATE_DIR/gateway.pid"), lite $(cat "$STATE_DIR/lite-$BOT.pid")"
