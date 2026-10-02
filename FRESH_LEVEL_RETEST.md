# Fresh Level Retest v1

Unvalidated independent translation of the October 1, 2026 user-supplied video.
No 90% win-rate claim is accepted. No real historical results were available in the development workspace.

- Separate NQ $50,000 paper account, fixed $45,000 floor, $250 maximum planned risk including modeled costs. Portfolio and family vetoes still apply in forward trading.
- First three net winning trades unlock additional trades until a loss or breakeven. Otherwise stop after three total trades or two losses. Reset by New York trading date.
- Confirm strict M5 wick pivots with two complete bars on each side. Earliest overlapping two-tick zones own subsequent overlapping pivots.
- Use a stable context beginning at 00:00 UTC on the preceding calendar date. Require data spanning that anchor; insufficient history fails closed. Levels outside this window expire. Holidays and early closes use the existing calendar.
- First M5 close beyond a confirmed pivot zone arms a 30-minute first-retest opportunity. A subsequent M1 candle must touch and close back beyond the breakout edge. The first touch consumes the opportunity even if entry is rejected. No same-candle breakout/retest. Opposite close invalidates it.
- Entry at next minute open with adverse slippage; expire after that minute. Stop two ticks past the farther of the retest extreme or zone edge. Whole-position target one tick before nearest untouched opposing resistance (long) or support (short). Require 1.5R after costs both before signal and at the actual entry open. No target means no trade.
- Entries 09:35 through before 15:30 New York; flatten 15:55. Early close: stop entries 30 minutes before close, flatten 5 minutes before close.
- Fixed stop, no averaging down, one open position. Stop-first ambiguous OHLC ordering and adverse stop gaps.

## Historical run

On the VPS checkout (with its existing Databento key/cache):

```
node scripts/backtest-fresh-level.cjs
```

Defaults to January 2025 through the available historical endpoint. Override with `FRESH_START_YEAR` if licensed earlier history exists. Results: `runtime/fresh-level-backtest.json`. This standalone report does not overwrite the all-strategy cache.

For integrated dashboard results, update/restart the status server and use **Run from January 2025** on `/backtests`. The all-strategy worker includes Fresh Level Retest and emits the equity, daily-closing drawdown, and monthly net-profit charts. If the prior report lacks this strategy, the UI explicitly shows pending.

The guarded account respects accumulated losses. The separate diagnostic repeats $250 sizing without the accumulated account floor, but retains the same daily win/loss policy. Diagnostic results are not an achievable account return after a failed account. Both are standalone simulations; historical portfolio-wide concurrent vetoes are not reconstructed.

## VPS rollout

```
docker exec openclaw-anwx-openclaw-1 sh -lc '
cd /data/.openclaw/workspace/lucid-nq-paper-trader &&
git pull --ff-only origin main &&
node scripts/restart-status-server.cjs &&
node scripts/strategy-watchdog.cjs
'
```

Existing journals are preserved. The registered watcher uses the same shared feed. No broker or real-money execution is added.
