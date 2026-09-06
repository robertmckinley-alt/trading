# ORB learning algorithm

This version adds a reproducible research loop. It does not claim a profitable edge or reproduce undisclosed TradeX V1–V4 rules.

## Rules and execution

- Freeze the 09:30–09:45 America/New_York opening range using all 15 complete one-minute candles.
- Evaluate complete 15-minute breakout bars. A 09:45–09:59 bar becomes actionable at 10:00, never at its opening timestamp.
- Require a directional close outside the range, baseline body fraction at least 0.50, and breakout-side wick fraction at most 0.25.
- Enter at the next eligible one-minute open with adverse slippage. Preserve the actual structural stop. Reject a gap beyond the stop or a target, or a position that cannot meet the risk ceiling with one contract.
- Stops that gap execute at the adverse opening price plus slippage. Commission is the configured round-trip amount per contract. Target exits also receive conservative adverse slippage.
- Position sizing uses whole contracts. A single contract exits fully at the first target. The first qualifying signal per day is tested; an unfilled/risk-rejected first signal does not retry later that day.
- Existing paper state files are preserved. Existing running watchers retain their loaded code until restarted separately.

## Nine ORB trials

The baseline, delayed confirmation, no-Monday, 50–80% body and focused-time experiments remain separate. Four new backtest-only candidates add:

| Trial | Preregistered research rule |
|---|---|
| ATR | Opening-range width / prior-session ATR between 0.05 and 0.30 |
| Relative volume | Confirmation volume at least 1.2 times comparable prior-session volume |
| ATR + relative volume | Both preceding filters |
| Wick | Breakout-side wick fraction at most 0.15 |

These are initial, unvalidated hypotheses, not optimized recommendations. ATR is a simple mean of 14 prior complete cash-session true ranges (not Wilder smoothing). Relative volume uses the same 15-minute slot in the last 20 complete cash sessions, with at least 10 valid observations. Complete cash sessions require 390 unique consecutive minutes. Half days are excluded from feature warmup. Current-day future candles cannot contribute to either historical baseline.

All 21 platform tests run in the common backtest, including the nine ORB trials. Feature context is prepared once and reused. Complete historical daily candle files are reused from `runtime/historical-candles`; missing or corrupt files are fetched again. NQ bars are not a substitute for MNQ execution data or transaction-level order flow.

## What learning means

Every successful daily run records the code hash, configuration hash, candle fingerprint, date window, finite trial definitions and evaluation settings. Summaries are archived in `runtime/research-history`; the current result remains `runtime/backtest-results.json`.

Each ORB has two separate curves:

1. Fixed-risk research: the same dollar risk ceiling throughout history, without the accumulated account drawdown lock.
2. Guarded account: a separate account enforcing its actual loss floor. Independent strategy accounts must not be summed and called a portfolio.

The evaluator compares each complete six-month training period, selects a qualifying trial using training net profit / maximum closed-trade drawdown (deterministic slug tie break), then evaluates the following month. Months without a qualifying selection remain zero-trade periods. It records all trials, annual/monthly results, loss streaks and doubled-cost stress. A deterministic 250-run five-session block bootstrap describes sequence risk on the retrospectively selected daily series. Its percentiles are scenarios, not forecasts, confidence bounds or hard loss limits.

Training requires at least 50 simulated trades, positive expectancy and profit factor at least 1.2. Aggregate selected test periods require at least 15 simulated trades and the same profitability criteria. Both must survive doubled execution costs. These gates are research filters, not statistical proof.

2025/2026 have already influenced the trial definitions. The walk-forward results are therefore labeled retrospective. No historical trade counts as a verified forward-paper trade. No module automatically changes live strategy rules or raises live risk. A qualifying nomination remains a candidate for a separately frozen forward-paper test. The existing forward risk controls can hold or reduce paper risk as new outcomes arrive.

## Coverage limits

Coverage audits flag absent weekdays and shortened/missing cash-session minutes. Until an exchange calendar resolves those flags, the engine does not assume every gap is a holiday and does not nominate a candidate. This conservative block is shown alongside all calculated results; it does not hide trades or replace missing data with invented candles. The current release does not include an exchange-calendar reconciliation workflow.

Closed-trade drawdown does not measure all intratrade mark-to-market losses. One-minute OHLCV cannot reveal exact same-minute touch order; ambiguous bars use the configured conservative stop-first assumption. Wider stops may sharply reduce affordable NQ trades, which is reported as risk rejection.

## VPS rollout

From the VPS host terminal:

```sh
docker exec openclaw-anwx-openclaw-1 sh -lc 'cd /data/.openclaw/workspace/lucid-nq-paper-trader && git pull --ff-only origin main && node scripts/restart-status-server.cjs'
```

This stops only this checkout's status server and restarts any in-progress historical calculation with the new code. It keeps saved candles, completed results, the Databento feed and live watcher processes. It does not upgrade already-running watcher execution rules; those require a separate controlled restart after reviewing open paper positions.

The script checks module loading before stopping the server and refuses to start a duplicate if the old server will not exit. The status server starts its daily worker automatically. The website queues manual starts and polls progress instead of holding an hours-long HTTP request open.

Read progress without restarting:

```sh
docker exec openclaw-anwx-openclaw-1 cat /data/.openclaw/workspace/lucid-nq-paper-trader/runtime/backtest-results.json.progress.json
```

`phase: completed` and a new report timestamp confirm completion. A heartbeat, high CPU usage or health check alone does not.

## Full-history research view

The ORB page is `/orb`; all nine close-confirmation experiments have separate visible sections, followed by the other opening-range tests. `/backtests` shows the remaining strategies. Research results are the default for every strategy. Each signal receives an independent sizing state so accumulated losses cannot stop or shrink later research trades. The configured per-trade risk ceiling, whole-contract sizing, costs, entry windows and one-signal-per-day rule still apply. An optional guarded account view retains the original account-floor simulation. The research reviewer measures drawdown but does not reject a strategy merely for crossing the account's $5,000 floor. Saved reports without `researchVersion: all-strategy-fixed-risk-v1` require an updated VPS run for non-ORB research results; the UI does not relabel their old account results as research.
