#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/runtime}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.pid}"
RESET_LIVE_STATE="${RESET_LIVE_STATE:-1}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"

mkdir -p "$RUNTIME_DIR"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

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

watcher_pid="$(find_existing_watcher_pid)"
if [[ -n "$watcher_pid" ]] && kill -0 "$watcher_pid" 2>/dev/null; then
  kill "$watcher_pid"
  echo "Stopped watcher PID $watcher_pid"
else
  echo "No running watcher found"
fi

rm -f "$PID_FILE"

if [[ "$RESET_LIVE_STATE" == "1" ]]; then
  cd "$ROOT_DIR"
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
  echo "Cleared transient live signal state"
fi
