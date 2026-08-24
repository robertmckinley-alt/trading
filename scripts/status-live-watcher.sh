#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${PID_FILE:-/tmp/lucid-nq-paper-trader-watch.pid}"
LOG_FILE="${LOG_FILE:-/tmp/lucid-nq-paper-trader-watch.log}"

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

echo "Repo: $ROOT_DIR"
echo "DATABENTO_API_KEY=$([[ -n "${DATABENTO_API_KEY:-}" ]] && echo set || echo missing)"
echo "LIVE_DATA_PROVIDER=${LIVE_DATA_PROVIDER:-auto}"

watcher_pid="$(find_existing_watcher_pid)"
echo "PID file: $PID_FILE"
if [[ -n "$watcher_pid" ]] && kill -0 "$watcher_pid" 2>/dev/null; then
  echo "PID: $watcher_pid"
  ps -fp "$watcher_pid"
else
  echo "PID: not running"
fi

echo "State:"
node <<'EOF'
const fs = require('fs');
const path = require('path');
const statePath = path.join(process.cwd(), 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
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

if [[ -f "$LOG_FILE" ]]; then
  echo "Recent log:"
  tail -n 20 "$LOG_FILE"
else
  echo "Log file missing: $LOG_FILE"
fi
