#!/bin/bash
# Watch Jev play in a real browser: engine (8x) + gateway + live dashboard + controller.
# The browser's own 3D game client is the bot's client (http://localhost:8888/bot?bot=<name>&password=test),
# so the game you see is the game the controller drives. No headless lite client is started.
#
#   agents/jev/live-stack.sh up   <rs-sdk path> [--skill Woodcutting] [--minutes 15] [--policy jev|random|first] [--bot skyvern]
#                                 [--speed 1|2|4|8] [--xprate N] [--mode tick|burst] [--poll-every N] [--burst-ms N] [--jev-timeout-ms N] [--open]
#   agents/jev/live-stack.sh down <rs-sdk path>
#
# `up` prints the dashboard URL, waits until a browser has opened it and the client is in game
# (up to 3 minutes), then starts the controller. TYPESAFE_API_KEY must be set for --policy jev.
# --speed sets the engine tick (400 ms / speed): 1 is real RuneScape speed, 8 is the benchmark's.
# --xprate sets the engine XP multiplier (NODE_XPRATE): 1 is real RuneScape (default here), 25 is rs-sdk's default.
# --mode tick (default here) asks Jev every game tick with a one-tick timeout; burst is the benchmark loop.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH_ROOT="$(cd "$HERE/../.." && pwd)"
CMD="${1:-}"; RS_SDK="$(cd "${2:?rs-sdk path}" && pwd)"; shift 2 || true
SKILL=Woodcutting; MINUTES=15; POLICY=jev; BOT=skyvern; OPEN=0; SPEED=8; BURST_MS=; MODE=tick; JEV_TIMEOUT_MS=; XPRATE=1; POLL_EVERY=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skill) SKILL="$2"; shift 2;;
    --minutes) MINUTES="$2"; shift 2;;
    --policy) POLICY="$2"; shift 2;;
    --bot) BOT="$2"; shift 2;;
    --speed) SPEED="$2"; shift 2;;
    --xprate) XPRATE="$2"; shift 2;;
    --burst-ms) BURST_MS="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    --jev-timeout-ms) JEV_TIMEOUT_MS="$2"; shift 2;;
    --poll-every) POLL_EVERY="$2"; shift 2;;
    --open) OPEN=1; shift;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done
WEB_PORT=8888; GW_PORT=7780; DASH_PORT=7790
STATE_DIR="$RS_SDK/bots/.live"; PID_DIR="$STATE_DIR/pids"; mkdir -p "$PID_DIR"

kill_pidfiles() {
  for f in "$PID_DIR"/*.pid; do [[ -f "$f" ]] || continue; kill "$(cat "$f")" 2>/dev/null || true; done
  sleep 2
  for f in "$PID_DIR"/*.pid; do [[ -f "$f" ]] || continue; kill -9 "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done
  for port in $WEB_PORT $GW_PORT $DASH_PORT; do for pid in $(lsof -ti tcp:"$port" 2>/dev/null || true); do kill -9 "$pid" 2>/dev/null || true; done; done
}

if [[ "$CMD" == "down" ]]; then kill_pidfiles; echo "live stack down"; exit 0; fi
[[ "$CMD" == "up" ]] || { echo "usage: $0 up|down <rs-sdk path> [options]" >&2; exit 2; }
if [[ "$POLICY" == "jev" && -z "${TYPESAFE_API_KEY:-}" ]]; then echo "TYPESAFE_API_KEY is not set" >&2; exit 2; fi

case "$SPEED" in 1|2|4|8) ;; *) echo "--speed must be 1, 2, 4 or 8" >&2; exit 2;; esac
TICKRATE=$((400 / SPEED))
kill_pidfiles >/dev/null 2>&1 || true
RUN="$STATE_DIR/$(date +%Y%m%d-%H%M%S)-$SKILL-$POLICY-${SPEED}x-$MODE"; mkdir -p "$RUN/agent"
echo "run dir: $RUN"

# Fresh benchmark character: the engine prefers its market-store checkpoint over the .sav file.
mkdir -p "$RS_SDK/server/engine/data/players/main"
rm -f "$RS_SDK/server/engine/data/market.sqlite" "$RS_SDK/server/engine/data/market.sqlite-shm" "$RS_SDK/server/engine/data/market.sqlite-wal"
cp "$BENCH_ROOT/shared/agent.sav" "$RS_SDK/server/engine/data/players/main/$BOT.sav"
mkdir -p "$RS_SDK/bots/jev" "$RS_SDK/bots/$BOT"
cp "$HERE"/*.ts "$HERE"/*.html "$RS_SDK/bots/jev/"
# rs-sdk's walkTo has no cancellation; tick mode needs one so a switched action stops walking.
if ! grep -q "Walk cancelled en route" "$RS_SDK/sdk/actions.ts"; then
  (cd "$RS_SDK" && patch -p0 -N --silent < "$HERE/patches/rs-sdk-walkto-cancel.patch") && echo "applied patches/rs-sdk-walkto-cancel.patch to $RS_SDK/sdk/actions.ts"
fi
# rs-sdk levels players on a 2^(level/10) curve; real RuneScape (and the dashboard's XP table) use 2^(level/7).
if ! grep -q "level / 7.0" "$RS_SDK/server/engine/src/engine/entity/Player.ts"; then
  (cd "$RS_SDK" && patch -p1 -N --silent < "$HERE/patches/rs-sdk-real-level-curve.patch") && echo "applied patches/rs-sdk-real-level-curve.patch to $RS_SDK/server/engine/src/engine/entity/Player.ts"
fi
printf 'BOT_USERNAME=%s\nPASSWORD=test\nSERVER=localhost:%s\nGATEWAY_URL=ws://localhost:%s\nSHOW_CHAT=false\nTELEMETRY=false\n' "$BOT" "$WEB_PORT" "$GW_PORT" > "$RS_SDK/bots/$BOT/bot.env"

echo "game speed ${SPEED}x (NODE_TICKRATE=$TICKRATE), XP rate ${XPRATE}x (NODE_XPRATE=$XPRATE), bot $BOT"
(cd "$RS_SDK/server/engine" && exec env BUILD_VERIFY=false NODE_TICKRATE="$TICKRATE" NODE_XPRATE="$XPRATE" bun run src/app.ts) > "$RUN/engine.log" 2>&1 &
echo $! > "$PID_DIR/engine.pid"
for i in $(seq 1 120); do grep -q "World ready" "$RUN/engine.log" 2>/dev/null && curl -sf -o /dev/null "http://localhost:$WEB_PORT/crc" && break; sleep 1; done
curl -sf -o /dev/null "http://localhost:$WEB_PORT/crc" || { echo "engine did not come up; see $RUN/engine.log" >&2; exit 1; }
(cd "$RS_SDK/server/gateway" && exec bun run gateway.ts) > "$RUN/gateway.log" 2>&1 &
echo $! > "$PID_DIR/gateway.pid"
for i in $(seq 1 30); do curl -sf -o /dev/null "http://localhost:$GW_PORT/status" && break; sleep 1; done

CLIENT_URL="http://localhost:$WEB_PORT/bot?bot=$BOT&password=test"
(cd "$RS_SDK/bots/jev" && exec bun live.ts --log-dir "$RUN/agent" --port "$DASH_PORT" --bot "$BOT" --client "$CLIENT_URL" --gateway "http://localhost:$GW_PORT") > "$RUN/live.log" 2>&1 &
echo $! > "$PID_DIR/live.pid"
for i in $(seq 1 20); do curl -sf -o /dev/null "http://localhost:$DASH_PORT/config" && break; sleep 0.5; done
DASH_URL="http://localhost:$DASH_PORT/"
echo "dashboard: $DASH_URL"
[[ "$OPEN" == 1 ]] && open "$DASH_URL" || true

echo "waiting for the browser game client to log in as $BOT (open $DASH_URL) ..."
for i in $(seq 1 180); do curl -s "http://localhost:$GW_PORT/status/$BOT" | grep -q '"inGame": *true' && break; sleep 1; done
curl -s "http://localhost:$GW_PORT/status/$BOT" | grep -q '"inGame": *true' || { echo "no game client in game after 3 minutes; the stack stays up, start the controller by hand" >&2; exit 1; }

BURST_ARGS=(--mode "$MODE"); [[ -n "$BURST_MS" ]] && BURST_ARGS+=(--burst-ms "$BURST_MS"); [[ -n "$JEV_TIMEOUT_MS" ]] && BURST_ARGS+=(--jev-timeout-ms "$JEV_TIMEOUT_MS"); [[ -n "$POLL_EVERY" ]] && BURST_ARGS+=(--poll-every "$POLL_EVERY")
(cd "$RS_SDK" && exec env BOT_NAME="$BOT" GAME_SPEED="$SPEED" bun bots/jev/run.ts --skill "$SKILL" --minutes "$MINUTES" --log-dir "$RUN/agent" --policy "$POLICY" --bot "$BOT" --gateway "ws://localhost:$GW_PORT" ${BURST_ARGS[@]+"${BURST_ARGS[@]}"}) > "$RUN/controller.log" 2>&1 &
echo $! > "$PID_DIR/controller.pid"
sleep 2; kill -0 "$(cat "$PID_DIR/controller.pid")" 2>/dev/null || { echo "controller exited at once; see $RUN/controller.log" >&2; exit 1; }
echo "controller started (pid $(cat "$PID_DIR/controller.pid")): $SKILL, $MINUTES min, policy $POLICY, speed ${SPEED}x, mode $MODE"
echo "logs: $RUN  (tail -f $RUN/controller.log)"
