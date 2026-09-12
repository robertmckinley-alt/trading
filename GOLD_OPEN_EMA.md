# Gold Open EMA12 — separate $50,000 paper experiment

Strategy: `mgc-open-ema12`. Instrument: **Micro Gold futures (MGC)**, Databento continuous symbol `MGC.v.0`. This is a gold adaptation of the supplied clip, not a verified replication of its advertised return. The clip's displayed historical statistics are not evidence for this gold implementation.

## Source rule and explicit implementation assumptions

The source describes the first five-minute New York opening candle relative to EMA12: above means long; below means short; trail the stop. It does not supply a reproducible initial stop, trailing formula, costs or sizing policy.

This implementation fixes the missing rules before collecting results:

- Operating anchor: 09:30–09:35 America/New_York. This is the US cash-opening anchor, **not a claim that gold futures open at 09:30**. DST follows New York.
- The last minute of that candle must be 09:34. No chasing a missed opening signal later in the day. Orders expire at 09:37 to allow the polling delay.
- EMA12 uses completed five-minute closes, including the opening candle. A fixed 60-bar window uses an initial 12-close SMA seed, followed by the standard 2/13 update. All 300 one-minute source bars must be contiguous and valid; otherwise skip.
- Enter at the next observable minute open after signal availability, with adverse slippage. One opening trade per session, long or short. No equality trade.
- Initial stop: one MGC tick beyond the opposite extreme of the opening candle.
- No fixed profit target. Once a completed five-minute candle closes at least 1R in profit, tighten the stop to one tick beyond that candle's low for longs, or high for shorts. Never loosen it. The new stop becomes effective on the following minute, never retrospectively within the candle used to calculate it.
- Flatten at the cash session close (16:00 normally, 13:00 on the reviewed shortened sessions), at the first observable price. The existing 2025–2026 cash calendar is a conservative operating filter, not the CME metals calendar. Unreviewed years fail closed.
- Independent $50,000 starting balance. Initial paper risk budget $250 per trade (0.5%). Fixed starting-balance floor $47,500; position sizing respects remaining room. Gaps can exceed planned risk, so this is not a guaranteed maximum drawdown.
- Cost assumptions: $2.50 round-trip per contract and two adverse ticks each leg. These are research assumptions, not a broker quotation. MGC is 10 troy ounces; $0.10/ounce minimum tick equals $1 per contract: [CME Chapter 120](https://www.cmegroup.com/rulebook/COMEX/1a/120.pdf).

## Isolation and evidence

Dedicated cache `runtime/databento-gold-live.json`, state `state-mgc-open-ema12.json`, watcher PID/log `runtime/mgc-open-ema12-watch.*`. Cache metadata must identify MGC.v.0 / GLBX.MDP3 / ohlcv-1m; an NQ cache is rejected. Existing NQ and ORB accounts and journals are not reset.

Gold is excluded from shared NQ backtests and their buy-and-hold comparisons. Existing NQ candle downloads cannot validate gold. Run the separate replay with a labeled gold JSON envelope containing `symbol`, `dataset`, `schema`, and `candles`:

```sh
node scripts/backtest-gold.cjs /path/to/gold-candles.json
```

It writes `runtime/gold-backtest-results.json` only. Review coverage, missing sessions, trades, net P&L, drawdown and cost sensitivity before making performance claims. No gold historical run or profitable parameters are claimed by this implementation.

## VPS start

Run inside the existing repository after pulling the commit:

```sh
bash scripts/start-gold-paper.sh
```

This launches a separate MGC feed and watcher idempotently. It needs the existing Databento API key with MGC live entitlement and Python SDK. Logs, not a launch PID alone, establish feed readiness. This launcher is not a reboot supervisor; repeat it after container restarts. A market-closed feed may legitimately have no fresh candles.

Verification:

```sh
pgrep -af '[m]gc-open-ema12|[d]atabento-live-feed.py --symbol MGC'
tail -n 20 runtime/databento-gold-feed.log
tail -n 20 runtime/mgc-open-ema12-watch.log
```

Restart the status service with the repository's existing restart helper to publish the new account on the dashboard. Shared implementation changes can invalidate frozen research candidate hashes; review those normally, never remove their evidence files to bypass the gate.
