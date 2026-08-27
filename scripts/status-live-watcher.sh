#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/runtime}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.pid}"
LOG_FILE="${LOG_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.log}"
HOURLY_PID_FILE="${HOURLY_PID_FILE:-$RUNTIME_DIR/hourly-sweep-ifvg-bos-watch.pid}"
HOURLY_LOG_FILE="${HOURLY_LOG_FILE:-$RUNTIME_DIR/hourly-sweep-ifvg-bos-watch.log}"
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

echo "Repo: $ROOT_DIR"
echo "DATABENTO_API_KEY=$([[ -n "${DATABENTO_API_KEY:-}" ]] && echo set || echo missing)"
echo "LIVE_DATA_PROVIDER=${LIVE_DATA_PROVIDER:-auto}"

print_watcher() {
  local label="$1"
  local strategy="$2"
  local pid_file="$3"
  local log_file="$4"
  local state_path="$5"
  local watcher_pid
  local pattern="node paper-trader.cjs watch-live.*--strategy=$strategy"
  if [[ "$strategy" == "live-9am-sweep" ]]; then
    pattern="node paper-trader.cjs watch-live"
  fi
  watcher_pid="$(find_existing_watcher_pid "$pid_file" "$pattern")"
  echo
  echo "=== $label ==="
  echo "PID file: $pid_file"
  if [[ -n "$watcher_pid" ]] && kill -0 "$watcher_pid" 2>/dev/null; then
    echo "PID: $watcher_pid"
    ps -fp "$watcher_pid"
  else
    echo "PID: not running"
  fi

  echo "State:"
  STATE_PATH="$state_path" node <<'EOF'
const fs = require('fs');
const statePath = process.env.STATE_PATH;
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { balanceUsd: 50000, realizedPnlUsd: 0, trades: [] };
const snapshot = {
  balanceUsd: state.balanceUsd,
  realizedPnlUsd: state.realizedPnlUsd,
  openSignalKey: state.live?.openSignalKey || null,
  openTriggeredAt: state.live?.openTriggeredAt || null,
  signalHistoryCount: Array.isArray(state.live?.signalHistory) ? state.live.signalHistory.length : 0,
  trades: Array.isArray(state.trades) ? state.trades.length : 0
};
console.log(JSON.stringify(snapshot, null, 2));
EOF

  if [[ -f "$log_file" ]]; then
    echo "Recent log:"
    tail -n 20 "$log_file"
  else
    echo "Log file missing: $log_file"
  fi
}

print_watcher "9AM Asia/London Sweep" "live-9am-sweep" "$PID_FILE" "$LOG_FILE" "$ROOT_DIR/state.json"
print_watcher "1H Sweep + iFVG + 1M BOS" "hourly-sweep-ifvg-bos" "$HOURLY_PID_FILE" "$HOURLY_LOG_FILE" "$ROOT_DIR/state-hourly-sweep-ifvg-bos.json"
