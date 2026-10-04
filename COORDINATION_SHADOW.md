# Lifetime dashboard and observational coordination

The home page groups accounts by lifetime realized journal P&L: profitable,
losing, breakeven (if applicable), and no closed trades yet. Date selection and
history bars open one chronological daily recap with winners and losers together.
Filters apply to the lifetime groups, history and daily recap. Coordination is
explicitly portfolio-wide and has its own all-account totals.

## Timestamps

The live-status projection now passes `exitedAt`, `recordedAt`, signal observation
time and MAE/MFE through from the journal. Exit timestamps refer to a one-minute
candle, not an exact tick. `createdAt` is journal-write time and is never substituted
for an exit time. Old records without an exit timestamp display Not recorded.
A bridge process still running old code must reload to expose these fields.

## Observation controller v1

No strategy entry/stop/target changes. No account writes, order placement or real
exit requests. Reads registered watcher accounts, their persisted lifecycles and
local candle caches every five seconds. The independent ORB Lab runner is not in
this first version; its accounts are not evaluated by this controller.

Rules fixed before collection:
- Source must be a completed stop-loss with a known exit candle and journal time.
- Same-direction exit hypothesis: different account, same symbol, recent loss
  within 30 minutes, source stop within one tick of a named target thesis level
  (hourly/session/opening high or low, POC or VWAP), and a completed close at least
  one tick beyond that level. Target must still be open with a fresh heartbeat.
- Whipsaw hypothesis: two different accounts stop out in opposite directions on
  the same symbol within 30 minutes. Observe a proposed 30-minute entry pause
  from detection. Only newly submitted, still-unfilled orders seen during that
  pause qualify. Existing positions are not flattened by the pause.
- Gold and NQ cannot trigger each other. Missing/stale information never qualifies.

Proposals are recorded before their counterfactual prices are observed. Exit
simulation uses the next full minute open after observation, adverse slippage,
commissions and the original scale-out lifecycle. Earlier normal stops/targets
remain effective. Missing minute paths or contract changes produce insufficient
information, not an invented fill. This is a modeled fill, not a guaranteed
executable market price. Polling can miss very short-lived orders; coverage is
limited to observed orders and local cache retention.

Each target order gets at most one proposal. Reports compare the resolved trade's
unchanged baseline P&L with the shadow P&L (zero for a skipped entry). Positive
difference is benefit; negative difference is cost, including sacrificed profits.
Pending and insufficient-data cases are not counted as savings. Aggregate deltas
are paired per-order estimates, not a fully resimulated adaptive portfolio: changed
sizing, later eligibility and alternate future trades are not modeled. Do not use
these totals as a portfolio backtest or enable execution based on a small sample.

## VPS rollout

From the host:

```sh
docker exec openclaw-anwx-openclaw-1 sh -lc '
cd /data/.openclaw/workspace/lucid-nq-paper-trader || exit 1
git pull --ff-only origin main &&
node scripts/coordination-shadow.cjs --start
'
```

Check `runtime/coordination-shadow/report.json` for an advancing `updatedAt` and
`accountsObserved`; a launch PID alone does not confirm readiness. See
`runtime/coordination-shadow/worker.log` for failures. No API downloads are used.
The process is independent of trading watchers. `--start` is idempotent while it
is alive; use the existing VPS supervisor for restart after host/container reboot.

The dashboard reads this report through the live-status bridge. Reload that bridge
using `node scripts/restart-status-server.cjs` only after the authenticated,
loopback reverse-proxy rollout in EXECUTION_REPAIRS.md is configured. That restart
validates LIVE_STATUS_TOKEN before stopping the old process. It does not change
strategy journals. Until the bridge reloads, the web UI reports Awaiting VPS
controller and old exit times remain unavailable.

No historical October 2 shadow results are fabricated. Collection begins when
this worker starts. Inspection of old trades remains available through daily recaps.
