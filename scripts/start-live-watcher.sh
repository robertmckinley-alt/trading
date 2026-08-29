#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/runtime}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.pid}"
LOG_FILE="${LOG_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.log}"
HOURLY_PID_FILE="${HOURLY_PID_FILE:-$RUNTIME_DIR/hourly-sweep-ifvg-bos-watch.pid}"
HOURLY_LOG_FILE="${HOURLY_LOG_FILE:-$RUNTIME_DIR/hourly-sweep-ifvg-bos-watch.log}"
INTERVAL_MS="${INTERVAL_MS:-60000}"
HOURLY_INTERVAL_MS="${HOURLY_INTERVAL_MS:-60000}"
RESET_LIVE_STATE="${RESET_LIVE_STATE:-0}"
ALLOW_MOCK="${ALLOW_MOCK:-0}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"

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

reset_state() {
  local state_path="$1"
  STATE_PATH="$state_path" node <<'EOF'
const fs = require('fs');
const statePath = process.env.STATE_PATH;
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { startingBalanceUsd: 50000, balanceUsd: 50000, realizedPnlUsd: 0, trades: [] };
state.live = {
  ...(state.live || {}),
  openSignalKey: null,
  openPlan: null,
  openTriggeredAt: null,
  signalHistory: []
};
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
EOF
}

start_watcher() {
  local label="$1"
  local strategy="$2"
  local pid_file="$3"
  local log_file="$4"
  local state_path="$5"
  local interval_ms="$6"
  local pattern="node paper-trader.cjs watch-live.*--strategy=$strategy"
  if [[ "$strategy" == "live-9am-sweep" ]]; then
    pattern="node paper-trader.cjs watch-live"
  fi
  local existing_pid
  existing_pid="$(find_existing_watcher_pid "$pid_file" "$pattern")"
  if [[ -n "$existing_pid" ]]; then
    echo "Stopping existing $label watcher PID $existing_pid"
    kill "$existing_pid"
    sleep 1
  fi
  rm -f "$pid_file"
  if [[ "$RESET_LIVE_STATE" == "1" ]]; then
    reset_state "$state_path"
  fi
  touch "$log_file"
  nohup node paper-trader.cjs watch-live --provider="$provider" --interval="$interval_ms" --strategy="$strategy" >>"$log_file" 2>&1 &
  local watcher_pid=$!
  echo "$watcher_pid" > "$pid_file"
  echo "Started $label watcher PID $watcher_pid"
  echo "Provider: $provider"
  echo "Log: $log_file"
}

start_watcher "9AM" "live-9am-sweep" "$PID_FILE" "$LOG_FILE" "$ROOT_DIR/state.json" "$INTERVAL_MS"
start_watcher "hourly" "hourly-sweep-ifvg-bos" "$HOURLY_PID_FILE" "$HOURLY_LOG_FILE" "$ROOT_DIR/state-hourly-sweep-ifvg-bos.json" "$HOURLY_INTERVAL_MS"
