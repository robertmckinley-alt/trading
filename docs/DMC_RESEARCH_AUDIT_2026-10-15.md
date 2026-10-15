# DMC and Fresh Retest research audit — 2026-10-15

## Concrete repairs

- Market Open now refuses to reuse the last completed M5 during the following partial M5. Before this change, 09:35–09:38 checks could reuse 09:30–09:34 confirmation. Backtests checked only completed M5, so direct/live detector behavior could disagree. New metadata versions: `dmc-paper-open-v5-fresh-confirmation` and `dmc-market-open-v3-fresh-confirmation`.
- Market Open requires the actual 08:00–08:59 New York H1. Removing that hour previously allowed 07:00–07:59 to stand in as the final pre-open bias, provided earlier context remained contiguous. Winter/summer resolution is tested.
- Market Open rejects invalid/duplicated/unsorted OHLCV, zero confirmation volume, mixed instrument IDs, and a missing preceding M5. Level bots also reject mixed instrument IDs.
- Fresh Retest requires every observed minute from confirmed break to first retest. A missing intermediate minute could contain the true first touch or invalidation. It no longer labels a subsequent touch as the first across such a gap. Version `fresh-level-retest-v3-observed-retest`.

These are correctness changes, not claims that today's losses arose from these defects. Historical journals remain unchanged. Existing valid synthetic setups still pass.

## What the current rules actually mean

The repository's DMC_BOTS.md explicitly labels body-pivot definition, ATR bands, stop band, time windows and directional filter as implementation choices, not Hunter's exact proprietary rules. PAPER_COLLECTION.md describes a later M5 collection profile. Consequently, more frequent creator examples do not establish that this translation should signal every day.

Collection H1 pivots are confirmed only after their right-hand hour closes. Prior-test counting starts after confirmation and uses distinct completed M15 touch episodes. Failure and progression conditions are symmetric for long and short directions. Fresh Retest five-bar pivots become known only after two right-hand M5 bars complete; overlapping zones retain the earlier pivot.

Market Open uses pre-open H1 context, but the collection entry is at a future market bar after the M5 reaction, not at the H1 pivot. The failure/gain accounts use exact-level retest limits with 15-minute deadlines. These are materially different executions and should not be pooled into one DMC win-rate statistic.

## Controlled experiments to run, not assume successful

1. **Order age:** compare unchanged 15-minute DMC level expiry with a three-minute expiry on identical signals/candles/costs. October 12 reversal filled roughly 13 minutes after observation and lost; this is a hypothesis-generating example, not sufficient evidence to shorten all orders. Count skipped winners, skipped losers and fills as well as P&L.
2. **Structural stop relative to volatility:** stratify pre-entry stop distance divided by completed M5 ATR. Freeze candidate thresholds on training data, then compare untouched dates. Do not widen a stop without resizing. Retain unchanged baseline accounts.
3. **Direction filter:** compare current last-completed-H1 direction with an independently labeled neutral/trending regime. Failure reversals and progression breakouts should be separate cohorts; a trend filter that helps progression could remove valid reversals.
4. **Protection:** use the existing next-bar-effective close-based protection mechanism as a separate DMC cohort. Never credit a full minute's high as executable profit before a same-minute stop; require fill sequencing or conservative bounds. Include costs and winners cut short.

One independent change per cohort. Report out-of-sample expectancy, drawdown, trade count, signal acceptance and execution ambiguity. Do not select the winner on this week's losses and call that validation.

## Primary reference and limitations

[CME NQ contract specifications](https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.contractSpecs.html) specifies $20 per index point and 0.25-point minimum tick. Thus a two-point stop is eight ticks and $40 price risk per contract before modeled costs. A five-contract position at a 3.25-point stop risks $325 before costs. Small stops can amplify quantity under a fixed dollar budget; this arithmetic does not prove a stop is inappropriate without volatility and sequence analysis.

Read-only VPS replay already confirmed that the repaired session-aware ATR accepts the actual scheduled gap and that today's Market Open rules yielded zero qualifying signals. The separate historical-cache completeness issue and post-restart worker heartbeats require operational evidence. No external source inspected here discloses a complete, independently verified Hunter DMC algorithm or establishes an edge for these implementations.
