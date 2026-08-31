#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/runtime}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.pid}"
HOURLY_PID_FILE="${HOURLY_PID_FILE:-$RUNTIME_DIR/hourly-sweep-ifvg-bos-watch.pid}"
FEED_PID_FILE="${FEED_PID_FILE:-$RUNTIME_DIR/databento-live-feed.pid}"
RESET_LIVE_STATE="${RESET_LIVE_STATE:-0}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"

mkdir -p "$RUNTIME_DIR"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

find_existing_watcher_pid() {
  local pid_file="$1"
  local pattern="$2"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  pgrep -f "$pattern" | head -n 1 || true
}

stop_watcher() {
  local label="$1"
  local strategy="$2"
  local pid_file="$3"
  local watcher_pid
  local pattern="node paper-trader.cjs watch-live.*--strategy=$strategy"
  if [[ "$strategy" == "live-9am-sweep" ]]; then
    pattern="node paper-trader.cjs watch-live"
  fi
  watcher_pid="$(find_existing_watcher_pid "$pid_file" "$pattern")"
  if [[ -n "$watcher_pid" ]] && kill -0 "$watcher_pid" 2>/dev/null; then
    kill "$watcher_pid"
    echo "Stopped $label watcher PID $watcher_pid"
  else
    echo "No running $label watcher found"
  fi
  rm -f "$pid_file"
}

stop_watcher "9AM" "live-9am-sweep" "$PID_FILE"
stop_watcher "hourly" "hourly-sweep-ifvg-bos" "$HOURLY_PID_FILE"

feed_pid="$(find_existing_watcher_pid "$FEED_PID_FILE" "python3 scripts/databento-live-feed.py")"
if [[ -n "$feed_pid" ]] && kill -0 "$feed_pid" 2>/dev/null; then
  kill "$feed_pid"
  echo "Stopped Databento live feed PID $feed_pid"
else
  echo "No running Databento live feed found"
fi
rm -f "$FEED_PID_FILE"

if [[ "$RESET_LIVE_STATE" == "1" ]]; then
  cd "$ROOT_DIR"
  node <<'EOF'
const fs = require('fs');
const path = require('path');
for (const filename of ['state.json', 'state-hourly-sweep-ifvg-bos.json']) {
  const statePath = path.join(process.cwd(), filename);
  if (!fs.existsSync(statePath)) continue;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.live = {
    ...(state.live || {}),
    openSignalKey: null,
    openPlan: null,
    openTriggeredAt: null,
    signalHistory: []
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}
EOF
  echo "Cleared transient live signal state"
fi
