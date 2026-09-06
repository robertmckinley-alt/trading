# ORB forward paper accounts

Nine independent accounts use the existing nine ORB close-confirmation detectors. Each eligible order simulates one NQ contract, with the structural stop, whole-contract target exits, commission and slippage. Dollar risk budgets, shared portfolio limits and accumulated loss cutoffs do not restrict these isolated experiments. The original seven watchers and their journals are unchanged. No broker orders or alerts are sent by this runner.

Run inside the trading repository on the VPS container:

```sh
node scripts/orb-forward-paper.cjs --enable
```

This command is repeatable. One process manages all nine accounts. The updated status server checks the enabled runner every minute and restarts it if stopped. The status server itself must be running; the container's restart policy alone does not restart manually launched status-server processes. Enable does not restart the shared Databento feed.

State and journal: `runtime/orb-forward/state.json`. Logs: `runtime/orb-forward/runner.log`. Live warmup: `runtime/orb-forward/candles.json`. Checked historical candles are read locally from the same instrument's historical cache, with no download. ATR/relative-volume variants wait for sufficient complete prior cash sessions.

Signals are accepted only from newly observed, completed confirmation bars. Startup establishes a cursor and does not backfill historical orders. The entry is at the next unseen minute open, not an open that already happened before the runner observed the signal. Orders expire after two minutes. Stops/targets use conservative stop-first ordering on ambiguous bars. Open trades are closed at the first available bar at/after 16:00 New York. Missing bars during open trades flag results for review; those trades do not count toward the data-complete forward checkpoint.

Existing pending orders and open trades survive restart. Duplicate completed bars do not duplicate trades. The journal stores a hash of rules/configuration; changed execution rules stop the experiment for review rather than silently mixing versions. Do not delete the state to upgrade an active experiment. Archive/reconcile any open paper position before deliberately creating a new version.

The dashboard and ORB page show separate journals, realized/open P&L, closed-trade drawdown and minute-close marked drawdown. These do not measure every intraminute excursion. Historical trades never count toward the 50-forward-trade review checkpoint. Fifty observations alone do not establish profitability. No automatic strategy promotion or rule mutation occurs.
