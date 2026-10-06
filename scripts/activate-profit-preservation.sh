#!/usr/bin/env bash
# Run INSIDE the project container after pulling the release.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/audit-order-timing.cjs
node scripts/restart-execution-watchers.cjs --profit-preservation
node scripts/profit-paper.cjs --enable
node scripts/restart-status-server.cjs
printf '%s\n' 'Activated prospective fill guards and separate profit-preservation paper accounts. Verify runtime/profit-experiment/report.json and the dashboard heartbeat.'
