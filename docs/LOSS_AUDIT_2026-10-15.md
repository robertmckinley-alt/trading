# Paper loss audit: October 12–15, 2026

Snapshot: 2026-10-15T17:57:59.800Z; source: remote-bridge; collected October 15 before the session finished. Not a full five-day week. All closed trades in these dates across the returned strategy journals; independent paper accounts, not one funded portfolio.

## Verified results

24 closed trades, 1 win, 23 losses; net $-4834.00. 7 trades entered and exited in the same minute. 0 missing/violated recorded expiry deadlines. 0 fills exceeded their recorded reserved risk. All trades use bounded-fill-v1.

| Date ET | Strategy | Side | Entry | Initial stop | Contracts | Minutes held | Net USD |
|---|---|---|---:|---:|---:|---:|---:|
| 2026-10-12 | hourly-sweep-ifvg-bos | short | 31184.75 | 31192 | 1 | 0 | -154.50 |
| 2026-10-12 | mgc-open-ema12 | long | 4196.7 | 4193.1 | 5 | 19 | -202.50 |
| 2026-10-12 | nq-vwap-stretch-reversion | long | 30894.25 | 30892.75 | 1 | 0 | -39.50 |
| 2026-10-12 | live-9am-sweep | long | 30912 | 30897.25 | 1 | 2 | -304.50 |
| 2026-10-12 | nq-vwap-stretch-reversion | long | 30927.5 | 30918.25 | 1 | 0 | -194.50 |
| 2026-10-12 | volume-poc-reversion | long | 30927.25 | 30919 | 1 | 16 | -174.50 |
| 2026-10-12 | nq-dmc-failed-level-reversal | long | 30918.75 | 30915.5 | 5 | 5 | -372.50 |
| 2026-10-12 | volume-poc-reversion-x-market-regime-balanced-4519a709 | long | 30884 | 30876.25 | 2 | 16 | -329.00 |
| 2026-10-12 | nq-fresh-level-retest | short | 30872 | 30879.5 | 1 | 5 | -159.50 |
| 2026-10-12 | nq-opening-range-breakout | short | 30857.25 | 30867.25 | 1 | 25 | -209.50 |
| 2026-10-12 | nq-fresh-level-retest | short | 30860.25 | 30865.25 | 2 | 12 | -219.00 |
| 2026-10-13 | mgc-open-ema12 | long | 4210.3 | 4206.9 | 6 | 5 | -231.00 |
| 2026-10-13 | nq-fresh-level-retest | long | 30771 | 30762.75 | 1 | 5 | -174.50 |
| 2026-10-13 | nq-15m-opening-range-retest | long | 30791.75 | 30789.75 | 7 | 0 | -346.50 |
| 2026-10-13 | nq-dmc-gain-retest | long | 30762.25 | 30743.75 | 1 | 4 | -379.50 |
| 2026-10-13 | nq-vwap-stretch-reversion | long | 30697.25 | 30687.25 | 1 | 30 | -209.50 |
| 2026-10-13 | volume-poc-reversion-x-market-regime-balanced-4519a709 | short | 30731.5 | 30745 | 1 | 9 | -279.50 |
| 2026-10-13 | nq-fresh-level-retest | short | 30746 | 30748 | 2 | 0 | -99.00 |
| 2026-10-13 | volume-poc-reversion | short | 30787 | 30794.25 | 1 | 4 | 340.50 |
| 2026-10-14 | nq-vwap-stretch-reversion | long | 30478.75 | 30469 | 1 | 0 | -204.50 |
| 2026-10-14 | volume-poc-reversion | long | 30226.25 | 30214.25 | 1 | 2 | -249.50 |
| 2026-10-15 | mgc-open-ema12 | long | 4175.8 | 4171.5 | 5 | 30 | -237.50 |
| 2026-10-15 | volume-poc-reversion-x-market-regime-balanced-4519a709 | short | 29991.75 | 30005.75 | 1 | 2 | -289.50 |
| 2026-10-15 | nq-fresh-level-retest | long | 30066 | 30060.75 | 1 | 0 | -114.50 |

## What the evidence establishes

1. **DMC Market Open has a software defect in ATR continuity.** The previous implementation required every H1 timestamp to be exactly 60 minutes apart, even across scheduled maintenance. Missing data and valid closures both became zero ATR, then misleadingly appeared as an ATR-range rejection. The new implementation validates missing minutes against reviewed regular closures and actual raw data. It still refuses missing open-market minutes, duplicate gap data, and unreviewed holiday schedules. Synthetic regression reproduces the blocked setup and passes after repair. The actual VPS cache must still be checked with scripts/diagnose-dmc.cjs. This explains blocked signals; it does not explain every losing filled trade or prove missed setups would win.

2. **Several stops are small relative to minute-bar uncertainty.** The October 13 opening-range retest used a two-point NQ stop with seven contracts and stopped in its entry minute. Fresh retest also lost with a two-point stop. The DMC failed-level trade used a 3.25-point stop with five contracts. These are valid under current sizing rules, but highly sensitive to noise and fill sequencing. Do not widen stops without resizing or assume bigger stops improve expectancy. A minimum stop-distance/volatility experiment should be isolated from the unchanged baseline.

3. **A favorable price change can still mean a stale setup.** The October 12 VWAP requested 30914.25 and entered at 30894.25, just 1.5 points above its 30892.75 stop. The adverse-chasing guard does not reject this favorable-price move. It lost within that minute. Revalidating the setup at entry is a separate experiment from fixing order-expiry bugs.

4. **The recorded favorable excursion is not realizable profit.** The engine uses whole-candle highs/lows, including entry and exit candles whose internal sequence is unknown. Twelve losers show MFE at least their initial dollar risk, but that does not establish that a trailing stop could have captured it. New execution records explicitly label the convention. Historical journals and P&L are not rewritten.

5. **The existing exit experiment is mixed, not a universal cure.** In bounded VWAP cohorts, control is -$648, close-confirmed profit lock -$438, and partial/trail -$248. Protection reduced losses in that cohort but all remain negative. POC profit lock improved cumulative cohort P&L by $350, while partial/trail reduced it by $75. Those experiment lifetimes are not necessarily this audit's date window. Do not merge legacy cohorts or promote a rule based on a few trades.

6. **DMC losses need separate treatment from the blocked Market Open bot.** Failed-level reversal lost $372.50; gain/retest lost $379.50. The reversal filled about 13 minutes after observation, within its recorded 15-minute deadline. It is an aging-entry candidate, not proof of an expiry violation. A shorter deadline might skip that loss but can also skip winners.

## Repair scope and next evidence

- Repair session-aware DMC ATR, retain actual feed-gap rejection, and distinguish ATR-unavailable from range-filter failures. No forced trades or fabricated history.
- Add read-only DMC replay showing cache extent, old continuity failure, repaired ATR, and every current rejection reason. Replay uses only candles available at each check; repeated signals are not separate executed trades.
- Mark new MFE/MAE records as full-candle estimates with unknown intrabar sequence.
- Retain historical journals, quantities, stops, entry filters, and paper-only operation. Profitability changes require matched replay on the same data and forward cohorts; a healthy process monitor does not establish trading edge.
- Actual intrabar reconstruction requires tick/sub-minute data around the seven immediate losses. This audit does not download paid data or pretend OHLC establishes event ordering.
- Previously reported historical comparison cache ended October 4 although its requested window extended to October 9. That comparison cannot validate this week's trades. This patch does not claim to restore absent cache files.

## Deploy and verify

Pull main, run node scripts/diagnose-dmc.cjs on the VPS, then restart execution watchers. An ATR valid:true result plus advancing watcher heartbeats is required; a passing source test alone is not production verification. Diagnostic exit 2 means insufficient/invalid evidence and must be investigated. Run the host operations monitor after restart.
