# DMC level-to-level paper experiments

Research date: September 29, 2026. Sources are historical creator lessons and current Discord posts, not verified trading performance. These are independent implementations, not Hunter's proprietary signal-bot code. No community executable or source file was downloaded or run.

## Existing and new accounts

| Account | Strategy | Status |
| --- | --- | --- |
| H | `nq-dmc-market-open` | Existing rules preserved; see DMC_METHOD.md |
| K | `nq-dmc-failed-level-reversal` | New first-test rejection hypothesis |
| L | `nq-dmc-gain-retest` | New close-through and retest hypothesis |

K and L inherit the dashboard's existing simulated-account and risk configuration. These settings are not an assumption about the user's real balance or risk tolerance. Each has its own journal, shares portfolio/family risk guards, and may record at most one filled trade per New York date. Neither connects to a broker or submits real orders.

## Frozen K/L contract: dmc-hourly-levels-m15-v1

- Instrument: NQ, using completed one-minute OHLCV from the existing feed.
- Context: 18–24 complete prior H1 bars; no incomplete hourly candles. H1 open/close prices at confirmed three-bar body pivots define levels.
- Freshness: no intervening one-minute touch after the pivot bar. The confirmation candle must make the first subsequent test. Missing or inconsistent OHLCV means NO TRADE.
- Confirmations: completed M15 bars available from 09:45 through 11:15 New York, on supported cash-session dates. Positive confirmation volume is required; no claim of relative-volume strength is made.
- Volatility: confirmation range 0.35–2 times prior 14-bar M15 ATR. Entry must be within one M15 ATR of the confirmation close.
- K long: opens on/above a fresh pivot-low body price, trades at least one tick below, closes at least one tick above. Short reverses the conditions at a pivot-high. Two completed hours pointing against the trade veto it; neutral context is allowed.
- L long: prior M15 close and current open are on/below a fresh pivot-high body price; current close is at least one tick above. Short reverses the conditions at a pivot-low. Two completed adjacent hourly candles must point with the trade, and the confirmation body must occupy at least half its range.
- Conflicting long and short candidates mean NO TRADE. Otherwise use the closest qualifying level to the confirmation close, breaking ties by the more recent pivot.
- Entry: exact-level limit-touch simulation, only after confirmation and live observation. Never award an earlier retest as a fill.
- Expiry: 15 minutes after confirmation availability, and never later than 11:30 New York. An unfilled order at the deadline expires.
- Stop: one tick beyond the confirmation wick; structural distance must be 2–22 NQ points.
- Target: nearest untouched opposing hourly body pivot. A level already touched by confirmation is not a target. Full exit at that one target; no forced distant target.
- Cost-adjusted minimum reward/risk: 1.5. NQ point value = tick value / tick size. Modeled loss/contract = stop distance × point value + configured round-trip commission + one configured exit-slippage allowance. Modeled reward deducts those same costs.
- Sizing: existing adaptive paper risk budget, daily/account drawdown guards, and shared portfolio/family caps. No averaging down. Stop-first when one bar could hit both stop and target.
- Flat by 15:59 New York, or 12:59 on supported early-close days. Stop gaps can lose more than the nominal modeled stop.
- News: existing manual `live.dmcMarketOpen.blackoutDates`; an automatic economic calendar is NOT connected. Empty blackout dates are not evidence that a day is news-free.

The body-pivot definition, windows, ATR bands, stop band, strict hourly-direction filter, hard stops, and 1.5R cost gate are our frozen implementation choices. They are not asserted to be Hunter's exact rules. The current short feed cache does not implement his full daily/weekly/monthly map.

## Source review and bot distinction

Reviewed transcripts for all 15 entries in the linked free-course playlist, all 20 entries in the linked examples playlist (three overlap), and four bot videos: 36 unique videos. This is transcript review with selected chart inspection, not a claim to have watched every frame or every Discord livestream.

- [Free course](https://www.youtube.com/playlist?list=PLtfjD7dzYgl2pxX01F_wKsw-t_VJVo05m)
- [Trade examples](https://www.youtube.com/playlist?list=PLtfjD7dzYgl2WRv8w9_3_WBmiHl2Zik9u)
- [September levels lesson](https://www.youtube.com/watch?v=kE76NlmKmY8): prioritize meaningful fresh body levels and first reactions.
- [Updated strategy](https://www.youtube.com/watch?v=4A64MZuTDsU): exact entries supersede older averaging-down descriptions.
- [September bot results](https://www.youtube.com/watch?v=rYsTHZKO6NQ): chart-reading signals in Discord; costs, longer testing, and human management complicate headline performance.
- [August bot video](https://www.youtube.com/watch?v=XAynkl5rRw4): a separate cycle-based bot, not a disclosed complete DMC specification. Headline win rates are unverified.
- [July bot video](https://www.youtube.com/watch?v=vix092r7gAY): a different automated experiment. Not a downloadable verified strategy contract.
- [2022 free-bot announcement](https://www.youtube.com/watch?v=WwFjPWYjzbc): an old future promise is not proof of a current available download.
- [Hunter's current signal channel](https://discord.com/channels/654376264760557606/1547302122763067482): observed Signal bot posts, predictions and modeled results. Signals are not the same as verified fills or a bot install package.

No confirmed public download or installation invite for Hunter's original bot was found in the inspected official channels. Community MT5/Pine attachments exist in coding, but authorship, safety, licensing, and performance were not verified. The user's exact Instagram post is still unidentified.

## Evidence gate

Implementation tests establish mechanical behavior, not trading edge. K/L have no independently established win rate, expected probability, or profitability. Keep paper-only. Before considering any real-money workflow, require chronological holdout testing after realistic fees/slippage, a stable parameter neighborhood, sufficient independent trades, acceptable drawdown, unchanged-rule forward results, and separately supplied real-account risk limits. Thin volume, wider spreads, feed gaps, release times, and correlated positions can invalidate modeled execution.
