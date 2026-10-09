# Execution and risk audit repairs

New plans use `bounded-fill-v1`. Existing saved plans replay under their original model; completed journals are never rewritten.

- Conservative limit fills still require a one-tick trade-through, but fill at the limit. Entry slippage is zero for limits; exit slippage and round-trip commissions remain. New limit sizing includes those costs.
- New risk-budget market orders resize or reject before filling when gap risk exceeds the smaller of account budget and the already committed portfolio reservation. No post-fill increase of the shared reservation is needed. The explicitly isolated one-contract research mode is outside shared portfolio admission.
- Older pending/open plans reserve their full budget (or higher recorded actual risk), so new entries cannot use their previously understated risk allowance. Their execution paths stay unchanged.
- Corrupt or invalid account state and corrupt challenger manifests block new shared-risk admissions. The watcher no longer silently replaces a corrupt journal with an empty account. Missing state with watcher artifacts also blocks admission. Uninitialized accounts without artifacts remain supported.
- New profit/HMM experiment accounts are separated from legacy cohorts. Existing positions settle with their old plan model. Paired reporting only compares outcomes within the same execution cohort; experiment dollars are not the original account's recovered profits.
- The status API now exposes stored execution provenance and actual entry risk. The operations monitor alerts on unreadable risk state. Status-server startup verification now allows 20 seconds.

## Activation on the VPS host

```bash
docker exec openclaw-anwx-openclaw-1 sh -lc '
cd /data/.openclaw/workspace/lucid-nq-paper-trader &&
git pull --ff-only origin main &&
node scripts/activate-audit-fixes.cjs
' &&
docker cp openclaw-anwx-openclaw-1:/data/.openclaw/workspace/lucid-nq-paper-trader/scripts/operations-monitor.py /usr/local/sbin/trading-operations-monitor.py &&
chmod 700 /usr/local/sbin/trading-operations-monitor.py &&
flock -n /run/lock/trading-operations-monitor.lock python3 /usr/local/sbin/trading-operations-monitor.py
```

The activation preflights state, backs up active parent journals, reloads existing watchers and enabled experiment workers, and restarts the status server. It retains existing plans, feeds, configurations, and history. Stop and inspect any reported state error; do not delete journals to unblock admission. An in-progress backtest may restart with the status server.

## Verification and limits

238 Node tests and 6 Python monitor tests passed. Regressions cover long/short limits, legacy plan replay, gap rejection/resizing, aggregate reservations, corrupt account/manifest admission, and cohort separation. The dashboard production build passed with webpack. A pre-existing NFL CSS Modules selector was scoped to that page to make the production build valid.

These are execution/accounting repairs, not evidence of profitability. Stop gaps can still exceed initial modeled risk. The same-candle historical old/new comparison still requires the VPS candle cache (`node scripts/compare-execution-backtests.cjs`). No market data was purchased for these repairs. Operational recovery must be confirmed from fresh VPS heartbeats after activation; local tests do not prove remote worker health.

## Saved report / current cache mismatch

A report may contain an uncached partial UTC day. Updated cache files can also differ from its original input. Strict reproduction still rejects any fingerprint mismatch.

For a new comparison using available local candles, run `node scripts/compare-execution-backtests.cjs --current-cache`. This makes no network/data-provider requests. It validates cache checksums and identity, freezes the candles and config once, and runs BOTH engines against that same array. The output explicitly says it is a new cache replay, not reproduction of the published report. The published backtest and trading journals are untouched.

Each run retains its original report, frozen candles, config, input manifest and both results under `runtime/execution-audit/run-<time>-<pid>/`. Only a completed comparison updates the dashboard comparison pointer. Inspect the before/after coverage issues before drawing conclusions: missing cached sessions are not silently filled. The original report window is retained to expose missing-session coverage.
