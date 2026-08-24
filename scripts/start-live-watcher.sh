#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/runtime}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.pid}"
LOG_FILE="${LOG_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.log}"
INTERVAL_MS="${INTERVAL_MS:-1000}"
RESET_LIVE_STATE="${RESET_LIVE_STATE:-1}"
ALLOW_MOCK="${ALLOW_MOCK:-0}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"

find_existing_watcher_pid() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  pgrep -f "node paper-trader.cjs watch-live" | head -n 1 || true
}

cd "$ROOT_DIR"
mkdir -p "$RUNTIME_DIR"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

provider="${LIVE_DATA_PROVIDER:-}"
if [[ -z "$provider" ]]; then
  if [[ -n "${DATABENTO_API_KEY:-}" ]]; then
    provider="databento"
  elif [[ "$ALLOW_MOCK" == "1" ]]; then
    provider="mock"
  else
    echo "Refusing to start fake live watcher: DATABENTO_API_KEY is not set." >&2
    echo "Set DATABENTO_API_KEY for real live futures data, or set ALLOW_MOCK=1 for fixture replay mode." >&2
    exit 1
  fi
fi

if [[ "$provider" == "databento" && -z "${DATABENTO_API_KEY:-}" ]]; then
  echo "LIVE_DATA_PROVIDER=databento but DATABENTO_API_KEY is not set." >&2
  exit 1
fi

existing_pid="$(find_existing_watcher_pid)"
if [[ -n "$existing_pid" ]]; then
  echo "Stopping existing watcher PID $existing_pid"
  kill "$existing_pid"
  sleep 1
fi
rm -f "$PID_FILE"

if [[ "$RESET_LIVE_STATE" == "1" ]]; then
  node <<'EOF'
const fs = require('fs');
const path = require('path');
const statePath = path.join(process.cwd(), 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.live = {
  ...(state.live || {}),
  openSignalKey: null,
  openPlan: null,
  openTriggeredAt: null,
  signalHistory: []
};
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
EOF
fi

touch "$LOG_FILE"
nohup node paper-trader.cjs watch-live --provider="$provider" --interval="$INTERVAL_MS" >>"$LOG_FILE" 2>&1 &
watcher_pid=$!
echo "$watcher_pid" > "$PID_FILE"

echo "Started watcher PID $watcher_pid"
echo "Provider: $provider"
echo "Log: $LOG_FILE"
