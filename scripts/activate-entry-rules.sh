#!/usr/bin/env bash
# Validation only. Deliberately never kills processes or changes journals/config.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
node --test test/consolidation-expansion-entry.test.cjs test/entry-rollout-safety.test.cjs test/dmc-level-bots.test.cjs test/dmc-market-open.test.cjs test/dmc-atr.test.cjs test/fresh-level-retest.test.cjs test/paper-collection.test.cjs test/watcher-observation.test.cjs test/order-windows.test.cjs test/execution-repairs.test.cjs test/bounded-fill-risk.test.cjs test/watcher-process.test.cjs
node --test --test-name-pattern='15-minute opening-range bot|EMA bot detects' test/trading.test.cjs
node scripts/validate-entry-rollout.cjs "$@" --require-validation
cat <<'NOTICE'
Validation passed. Activation was NOT performed.
An active watchdog/supervisor can create an order between a flat check and restart.
Coordinate a flat maintenance window, inhibit only the affected watcher supervisors,
gracefully stop affected watchers, verify plans/lifecycles/positions/pending orders
are still absent, and back up their six state files before loading the new code.
Never reset balances or journals. Leave the feed and unrelated strategies running.
Restart only the previously enabled affected accounts using their existing service
definitions, then verify one process per account, fresh heartbeat, loaded rules
version, preserved account balances/trade counts, and new per-candle diagnostics.
If a position or pending plan exists, allow its current watcher to finish first.
No watcher was stopped or started by this script. No account file was changed.
NOTICE
exit 0
