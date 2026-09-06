# Hunter DMC Market-Open Translation

This repository implements a deterministic, paper-only translation of the Hunter DMC educational method. Creator performance claims are not treated as verified results.

## Frozen strategy contract

- Strategy slug: `nq-dmc-market-open`
- Instrument: NQ continuous futures data
- Paper window: 09:30–10:30 `America/New_York`
- Higher-timeframe context: 18–24 strictly complete one-hour candles
- Bias candle: final complete hour before the Nasdaq cash open
- Levels: fresh candle-body prices at confirmed hourly pivot highs and lows
- Confirmation: a strictly complete five-minute candle that touches and holds the level in the expected direction
- Entry: limit order at the body level, submitted only after confirmation closes
- Expiration: 10:30 New York; no retest means no fill
- Stop: one tick beyond the pre-open hourly invalidation extreme, restricted to 2–22 NQ points
- Target: next fresh hourly body level or recent hourly swing, requiring at least 1.5R
- Scale plan: 1R, midpoint, structural target
- Frequency: no more than one DMC trade per date; never average down

The pre-open hour must express exactly one direction through a gain, loss, failure to gain, or failure to lose. The strategy rejects conflicting direction, excessive wick, a range outside 0.35–2.0 times prior hourly ATR, incomplete five-minute data, weak confirmation bodies, excessive adverse wick, range lock, excessive confirmation distance, inadequate stop width, or inadequate structural reward.

`live.dmcMarketOpen.blackoutDates` is a manual list of high-impact-news dates. The normal paper-account, daily-loss, correlated-family, and portfolio risk guards remain active.

## Research status

This is an unvalidated hypothesis for historical replay and forward paper trading. It is not approved for live-money execution. Reconsideration requires positive locked-holdout expectancy after costs, sufficient sample size, stable parameter sensitivity, acceptable drawdown, and a separate unchanged-rule forward-paper sample.

Source translation supplied by the user from the Hunter DMC course, trade examples, exact-entry lesson, and market-open lesson. No third-party source code was copied.
