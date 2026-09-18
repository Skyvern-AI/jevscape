#!/bin/bash
# Jev (TypeSafe System One, typesafe/jev-latest) through Harbor, via
# agents/jev_adapter.py. Produces the `jev` row (pricing.ts key `jev`).
#
# Jev is not a coding agent: the adapter uploads agents/jev/ (a Bun controller)
# into the sandbox and Jev picks macro-actions from a typed catalog. See
# agents/jev/README.md for the design and the comparability caveats.
#
# Usage:
#   scripts/run-jev.sh                       # all 16 skills, 15m horizon
#   scripts/run-jev.sh firemaking prayer     # specific skills only
#   JEV_HORIZON=30m scripts/run-jev.sh       # 30m horizon
#   JEV_POLICY=random scripts/run-jev.sh     # catalog floor: uniform random policy, same actuators
#   JEV_HARBOR_ENV=docker scripts/run-jev.sh # run on a machine with Docker instead of Modal
#
# Needs TYPESAFE_API_KEY in .env (never commit it).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

set -a; source .env 2>/dev/null || true; set +a
: "${TYPESAFE_API_KEY:?TYPESAFE_API_KEY missing from .env}"
export TYPESAFE_API_KEY

MODEL="${JEV_MODEL:-typesafe/jev-latest}"
HORIZON="${JEV_HORIZON:-15m}"
POLICY="${JEV_POLICY:-jev}"
HARBOR_ENV="${JEV_HARBOR_ENV:-modal}"
LABEL="jev"
[ "$POLICY" != "jev" ] && LABEL="jev-${POLICY}"

# Preflight: one cheap System One call so 16 sandboxes never wait on a bad key.
PROBE=$(curl -s -X POST https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" -H "Content-Type: application/json" \
  -d "{\"state\":\"preflight\",\"model\":\"${MODEL#typesafe/}\",\"questions\":{\"ok\":{\"type\":\"noul\",\"instructions\":\"Is this a preflight check?\"}}}")
if ! grep -q '"answers"' <<<"$PROBE"; then
  echo "Preflight TypeSafe probe failed:" >&2; echo "$PROBE" >&2; exit 1
fi
echo "Preflight OK ($MODEL)"

if [ "$#" -gt 0 ]; then
  SKILLS="$*"
else
  SKILLS="attack defence strength hitpoints ranged prayer magic woodcutting fishing mining cooking fletching crafting smithing firemaking thieving"
fi

TASK_FLAGS=()
for s in $SKILLS; do
  TASK_FLAGS+=(-i "${s}-xp-${HORIZON}")
done

bun generate-tasks.ts >/dev/null

TS=$(date +%Y%m%d-%H%M%S)
JOB="skills-${HORIZON}-${LABEL}-${TS}"
echo "JOB=$JOB (model=$MODEL policy=$POLICY env=$HARBOR_ENV)"

case "$HORIZON" in
  30m) SANDBOX_TIMEOUT=7200 ;;
  *)   SANDBOX_TIMEOUT=3600 ;;
esac

PYTHONPATH="$REPO_ROOT/agents:${PYTHONPATH:-}" harbor run \
  -p tasks \
  "${TASK_FLAGS[@]}" \
  --agent-import-path 'jev_adapter:JevSystemOne' \
  -m "$MODEL" \
  --ak "policy=${POLICY}" \
  --job-name "$JOB" \
  --env "$HARBOR_ENV" \
  --ek "sandbox_timeout_secs=${SANDBOX_TIMEOUT}" \
  -n 8 -k 1 2>&1 | tee "/tmp/harbor-${JOB}.log"
