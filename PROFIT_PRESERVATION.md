# Profit preservation release

Paper only. No performance claim or automatic live promotion. Existing parent accounts, balances, journals and exit rules are retained. New VWAP orders reject less than 1:1 remaining reward/risk after modeled exit costs, or adverse entry movement greater than 25% of original structural risk. These thresholds are frozen research choices, not proven optimal values.

Generic three-minute deadlines remain anchored to original signal availability, even after observation rebinding. DMC level retests retain their explicit fifteen-minute window and earlier session cutoffs. Fresh Retest retains its one-future-minute observation window. New trade journals retain origin, observation, earliest fill time, expiry, policy version and fill guards. The read-only order timing audit distinguishes actual deadline violations from old trades missing deadline evidence; it cannot retroactively certify the reported October 5 delayed fill.

## Matched forward paper tests

Four parents: 9AM sweep, VWAP, POC and hourly sweep. Three arms each:

- Control: unchanged exits, with the same new entry corrections as other arms.
- Profit lock: after a completed close reaches 1 initial price-risk unit, tighten the next bar's stop to entry plus modeled exit slippage and round-trip commission. From 2R, trail one initial price-risk unit behind the best completed close. Never widen the stop.
- Partial + trail: the same stop rules, plus a half-position target at 1R when it precedes the existing first target. Round to whole contracts; one contract exits entirely. Do not increase size to enable a partial exit.

POC and hourly each add separate trend-only and reversal-only arms. Trend: last completed close and SMA20 aligned with SMA60. Reversal: last completed candle closes in the trade direction beyond the prior candle's high/low. Both use a contiguous 60-minute history completed before parent observation; insufficient history rejects the filter arm. These are explicit hypotheses, not claims of discovered edge.

Sixteen independent $50,000 accounts are created as their parents first signal. All arms share future observation, entry engine and conservative minimum size allowed by their independent risk caps. No original portfolio risk is consumed. A parent cohort waits until every arm has finished before another signal is admitted. Filters and execution rejections are recorded, never converted into synthetic winning trades. Comparisons use only terminal matched pairs and show both improved P&L and sacrificed P&L. The scope is admitted parent signals, not all possible signals.

Stops are based on completed closes, apply next candle, and model gaps and slippage. Intrabar favorable excursion is not a guaranteed obtainable profit. A limit order cannot use its entry candle to tighten its stop. Parent histories are never rewritten. Restarted workers retain their saved candle paths and cannot silently reset corrupt experiment state.

## Activation

Run `bash scripts/activate-profit-preservation.sh` inside the project container after pulling main. It reads the historical timing audit, reloads existing watchers with saved plans intact, enables the new worker and restarts the status bridge. It does not restart market feeds or the ORB worker. The watcher reload is appropriate for this additive release: guards and profit exits live on new setup objects; existing plans keep their original fields.

The existing status server and watchdog supervise the enabled experiment. Update the host monitor by copying `scripts/operations-monitor.py` over `/usr/local/sbin/trading-operations-monitor.py`; retain its existing config and cron. No new credentials are needed. Its next scheduled pass checks the new worker as well.

Verify `runtime/profit-experiment/report.json` heartbeat and dashboard's Profit preservation panel. Before the first signal an empty account list is expected. A fresh heartbeat proves worker operation, not profitability or live readiness. To stop new copying, set settings `enabled` to false; retain all state and reports. Do not delete journals or remove protection rules from open experiment plans.
