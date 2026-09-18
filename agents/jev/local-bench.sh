#!/bin/bash
# Run the skill-XP benchmark against a LOCAL rs-sdk checkout with no Docker
# and no Chromium. Every task gets its own isolated world, like one benchmark
# container: engine (8x tick rate) + gateway + headless lite client + the
# shared skill tracker + the Jev controller, then the same peak-rate verifier
# arithmetic as tasks/*/tests/check_skill_xp.ts.
#
#   agents/jev/local-bench.sh --rs-sdk /path/to/rs-sdk --out runs/jev-$(date +%s) \
#       --skills "Woodcutting Fishing Mining" [--minutes 15] [--policy jev|random|first] [--parallel 4]
#
# Up to --parallel tasks run at once, each in its own engine on its own ports
# (slot i: web 9000+i, game 43600+i, management 9100+i, gateway 7800+i).
# TYPESAFE_API_KEY must be exported for policy=jev.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH_ROOT="$(cd "$HERE/../.." && pwd)"

RS_SDK=""
OUT=""
SKILLS=""
MINUTES=15
POLICY="jev"
PARALLEL=1
BURST_MS=20000
TICKRATE=50
MIN_TPS=${MIN_TPS:-15}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rs-sdk) RS_SDK="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --skills) SKILLS="$2"; shift 2 ;;
    --minutes) MINUTES="$2"; shift 2 ;;
    --policy) POLICY="$2"; shift 2 ;;
    --parallel) PARALLEL="$2"; shift 2 ;;
    --burst-ms) BURST_MS="$2"; shift 2 ;;
    --tickrate) TICKRATE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$RS_SDK" && -n "$OUT" && -n "$SKILLS" ]] || { echo "need --rs-sdk, --out, --skills" >&2; exit 2; }
if [[ "$POLICY" == "jev" && -z "${TYPESAFE_API_KEY:-}" ]]; then echo "TYPESAFE_API_KEY not set" >&2; exit 2; fi

RS_SDK="$(cd "$RS_SDK" && pwd)"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
ENGINE_DIR="$RS_SDK/server/engine"
PLAYERS_DIR="$ENGINE_DIR/data/players/main"
SAVE_SRC="$BENCH_ROOT/shared/agent.sav"
[[ -f "$SAVE_SRC" ]] || { echo "missing $SAVE_SRC" >&2; exit 2; }

log() { echo "[local-bench $(date +%H:%M:%S)] $*"; }

# Sync the controller into the rs-sdk checkout so its relative sdk imports resolve.
mkdir -p "$RS_SDK/bots/jev"
cp "$HERE"/*.ts "$RS_SDK/bots/jev/"
# Tracker copy with the container-only import path and lock file rewritten.
sed -e "s#'/app/sdk/index'#'../../sdk/index'#" \
    -e "s#const LOCK_FILE = '/tmp/skill_tracker.lock';#const LOCK_FILE = process.env.LOCK_FILE || '/tmp/skill_tracker.lock';#" \
    "$BENCH_ROOT/shared/skill_tracker.ts" > "$RS_SDK/bots/jev/_skill_tracker.ts"

PIDS_TO_KILL=()
cleanup() {
  log "cleanup"
  for p in "${PIDS_TO_KILL[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS_TO_KILL[@]:-}"; do [[ -n "$p" ]] && kill -9 "$p" 2>/dev/null || true; done
  # Stale stacks from a previous run on the same ports.
  local port pid
  for port in $(all_ports); do
    for pid in $(lsof -ti tcp:"$port" 2>/dev/null || true); do kill -9 "$pid" 2>/dev/null || true; done
  done
}
trap cleanup EXIT

slot_ports() { # slot -> "web game mgmt gateway"
  local i="$1"
  echo "$((9000 + i)) $((43600 + i)) $((9100 + i)) $((7800 + i))"
}
all_ports() {
  local i
  for ((i = 1; i <= PARALLEL; i++)); do slot_ports "$i"; done | tr ' ' '\n'
}

free_ports() {
  local port pid
  for port in $(all_ports); do
    for pid in $(lsof -ti tcp:"$port" 2>/dev/null || true); do kill "$pid" 2>/dev/null || true; done
  done
  sleep 2
  for port in $(all_ports); do
    for pid in $(lsof -ti tcp:"$port" 2>/dev/null || true); do kill -9 "$pid" 2>/dev/null || true; done
  done
  sleep 1
  for port in $(all_ports); do
    if lsof -ti tcp:"$port" >/dev/null 2>&1; then log "port $port is still in use; aborting"; exit 1; fi
  done
}

wait_http() { # url, seconds
  local url="$1" secs="$2" i
  for ((i = 0; i < secs; i++)); do
    if curl -sf -o /dev/null "$url"; then return 0; fi
    sleep 1
  done
  return 1
}

# One isolated world per task. Runs in the background; writes everything under task_dir.
run_task() { # slot skill
  local slot="$1" skill="$2"
  local bot="agent$slot"
  read -r web game mgmt gw <<< "$(slot_ports "$slot")"
  local gateway_url="ws://localhost:$gw"
  local task_dir="$OUT/$(echo "$skill" | tr 'A-Z' 'a-z')-xp-${MINUTES}m"
  mkdir -p "$task_dir/agent" "$task_dir/tracking" "$task_dir/verifier" "$task_dir/world"
  local tlog="$task_dir/task.log"
  tl() { echo "[$(date +%H:%M:%S) $skill] $*" >> "$tlog"; }
  local pids=()
  stop_task() {
    local p
    for p in "${pids[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
    sleep 2
    for p in "${pids[@]:-}"; do [[ -n "$p" ]] && kill -9 "$p" 2>/dev/null || true; done
  }

  # Fresh benchmark save + a fresh (empty) player checkpoint store for this world.
  # The engine checkpoints online players into its market store and prefers that
  # over the .sav file, so each world gets its own store under task_dir.
  mkdir -p "$PLAYERS_DIR"
  cp "$SAVE_SRC" "$PLAYERS_DIR/$bot.sav"
  rm -f "$task_dir/world/market.sqlite" "$task_dir/world/market.sqlite-shm" "$task_dir/world/market.sqlite-wal"

  (cd "$ENGINE_DIR" && exec env BUILD_VERIFY=false NODE_TICKRATE="$TICKRATE" WEB_PORT="$web" NODE_PORT="$game" \
      WEB_MANAGEMENT_PORT="$mgmt" HISCORES_WEB_PORT="$((mgmt + 100))" GE_DATABASE="$task_dir/world/market.sqlite" \
      bun run src/app.ts) > "$task_dir/world/engine.log" 2>&1 &
  local engine_pid=$!; pids+=("$engine_pid")
  tl "engine starting (pid $engine_pid, web $web, game $game, tickrate ${TICKRATE}ms)"
  local i ready=0
  for ((i = 0; i < 240; i++)); do
    if grep -q "World ready" "$task_dir/world/engine.log" 2>/dev/null && curl -sf -o /dev/null "http://localhost:$web/crc"; then ready=1; break; fi
    if ! kill -0 "$engine_pid" 2>/dev/null; then break; fi
    sleep 1
  done
  if [[ $ready != 1 ]]; then tl "engine did not become ready"; tail -20 "$task_dir/world/engine.log" >> "$tlog"; stop_task; return 1; fi

  (cd "$RS_SDK/server/gateway" && exec env AGENT_PORT="$gw" bun run gateway.ts) > "$task_dir/world/gateway.log" 2>&1 &
  local gateway_pid=$!; pids+=("$gateway_pid")
  wait_http "http://localhost:$gw/status" 30 || { tl "gateway not ready"; stop_task; return 1; }

  mkdir -p "$RS_SDK/bots/$bot"
  printf 'BOT_USERNAME=%s\nPASSWORD=test\nSERVER=localhost:%s\nGATEWAY_URL=%s\nSHOW_CHAT=false\nTELEMETRY=false\n' "$bot" "$web" "$gateway_url" > "$RS_SDK/bots/$bot/bot.env"
  (cd "$RS_SDK/server/webclient" && exec bun src/lite/runner.ts "$bot") > "$task_dir/lite.log" 2>&1 &
  local lite_pid=$!; pids+=("$lite_pid")
  local ok=0
  for ((i = 0; i < 90; i++)); do
    if curl -s "http://localhost:$gw/status/$bot" | grep -q '"inGame": *true'; then ok=1; break; fi
    sleep 1
  done
  if [[ $ok != 1 ]]; then tl "lite client did not connect"; tail -20 "$task_dir/lite.log" >> "$tlog"; stop_task; return 1; fi
  tl "$bot in game (world web $web, gateway $gw)"

  # Record the real game speed of this world. Peak XP/min is normalized by 8x, so a
  # starved engine (ticks/s well under 20 at NODE_TICKRATE=50) makes the score wrong.
  # Startup of neighbouring worlds causes short dips, so measure up to 3 times.
  local tps="" attempt
  for attempt in 1 2 3; do
    tps="$(cd "$RS_SDK" && timeout 60 bun bots/jev/tickrate.ts "$gateway_url" "$bot" 6 2>/dev/null | sed -n 's/.*: \([0-9.]*\) ticks\/s.*/\1/p')"
    tl "game speed check $attempt: ${tps:-?} ticks/s (expected $(( 1000 / TICKRATE )))"
    if [[ -n "$tps" ]] && (( $(printf '%.0f' "$tps") >= MIN_TPS )); then break; fi
    sleep 6
  done
  echo "${tps:-?}" > "$task_dir/world/ticks_per_second.txt"
  if [[ -z "$tps" ]] || (( $(printf '%.0f' "$tps") < MIN_TPS )); then
    tl "engine too slow (${tps:-?} ticks/s < ${MIN_TPS}); aborting this task"
    stop_task; return 1
  fi
  # Keep sampling game speed for the whole task so the report can show min/mean.
  (cd "$RS_SDK" && exec bun bots/jev/tickrate.ts "$gateway_url" "$bot" 15 "$task_dir/world/ticks.jsonl") > /dev/null 2>&1 &
  pids+=("$!")

  (cd "$RS_SDK" && exec env BOT_NAME="$bot" BOT_PASSWORD=test GATEWAY_URL="$gateway_url" SAMPLE_INTERVAL_MS=15000 \
      TRACKING_FILE="$task_dir/tracking/skill_tracking.json" LOCK_FILE="$task_dir/tracking/tracker.lock" \
      bun bots/jev/_skill_tracker.ts) > "$task_dir/tracking/skill_tracker.log" 2>&1 &
  local tracker_pid=$!; pids+=("$tracker_pid")
  sleep 2

  local started=$(date +%s)
  (cd "$RS_SDK" && exec bun bots/jev/run.ts --skill "$skill" --minutes "$MINUTES" --log-dir "$task_dir/agent" \
      --policy "$POLICY" --burst-ms "$BURST_MS" --bot "$bot" --password test --gateway "$gateway_url") \
      > "$task_dir/agent/controller.out" 2>&1 &
  local ctrl_pid=$!
  tl "controller started (pid $ctrl_pid)"
  wait "$ctrl_pid" || tl "controller exited non-zero"
  tl "controller finished after $(( $(date +%s) - started ))s"
  sleep 3

  (cd "$RS_SDK" && SKILL_NAME="$skill" BOT_NAME="$bot" BOT_PASSWORD=test GATEWAY_URL="$gateway_url" \
      TRACKING_FILE="$task_dir/tracking/skill_tracking.json" OUT_DIR="$task_dir/verifier" \
      bun bots/jev/local-verify.ts > "$task_dir/verifier/verify.log" 2>&1) || tl "verifier failed"
  tl "reward: $(cat "$task_dir/verifier/reward.txt" 2>/dev/null || echo '?') XP/min"

  # Graceful engine stop first so its logs flush, then hard kill.
  kill -INT "$engine_pid" 2>/dev/null || true
  for ((i = 0; i < 10; i++)); do kill -0 "$engine_pid" 2>/dev/null || break; sleep 1; done
  stop_task
  return 0
}

read -r -a ALL_SKILLS <<< "$SKILLS"
free_ports
wave=0
idx=0
while (( idx < ${#ALL_SKILLS[@]} )); do
  wave=$((wave + 1))
  batch=("${ALL_SKILLS[@]:idx:PARALLEL}")
  log "=== wave $wave: ${batch[*]} ==="
  wave_pids=()
  for ((i = 0; i < ${#batch[@]}; i++)); do
    run_task "$((i + 1))" "${batch[$i]}" &
    wave_pids+=("$!"); PIDS_TO_KILL+=("$!")
    sleep 3
  done
  for p in "${wave_pids[@]}"; do wait "$p" || log "a task in wave $wave failed"; done
  for skill in "${batch[@]}"; do
    d="$OUT/$(echo "$skill" | tr 'A-Z' 'a-z')-xp-${MINUTES}m"
    log "$skill: $(cat "$d/verifier/reward.txt" 2>/dev/null || echo '?') XP/min  (summary: $(cat "$d/agent/summary.json" 2>/dev/null | tr -d '\n' | cut -c1-160))"
  done
  idx=$((idx + PARALLEL))
done

log "=== results ==="
printf '%-14s %10s %8s %8s %12s\n' skill peak_xpm level xp_gain tps_min/mean
for skill in "${ALL_SKILLS[@]}"; do
  d="$OUT/$(echo "$skill" | tr 'A-Z' 'a-z')-xp-${MINUTES}m"
  r="$(cat "$d/verifier/reward.txt" 2>/dev/null || echo '?')"
  lvl="$(bun -e "const s=require('$d/agent/summary.json');console.log(s.level_end+' '+s.xp_gained)" 2>/dev/null || echo '? ?')"
  tps="$(bun -e "const l=require('fs').readFileSync('$d/world/ticks.jsonl','utf8').trim().split('\\n').map(x=>JSON.parse(x).ticks_per_second);console.log(Math.min(...l).toFixed(1)+'/'+(l.reduce((a,b)=>a+b,0)/l.length).toFixed(1))" 2>/dev/null || echo '?')"
  printf '%-14s %10s %8s %8s %12s\n' "$skill" "$r" ${lvl} "$tps"
done
