# RUNNER — candidate NQ paper strategy

Status: SPECIFICATION ONLY; NOT ENABLED. No orders or simulated fills should be generated until implementation and validation.

Source: user-provided @diegotradez trading video, reviewed October 22, 2026. The visible long/short overlays, stop zones, TP1/TP2 and claimed 3.2R runner do not reveal reproducible indicator rules. Do not invent or backfit the entry signal.

## Proposed experiment
- Strategy display name: RUNNER; ID: `runner`.
- Independent simulated starting equity: $50,000. Never mix its P&L into existing strategy accounts before verified activation.
- Instrument: NQ futures; both long and short, only after objective non-repainting signal rules are recovered.
- Record the signal timestamp, signal candle close, entry order, initial stop, initial R, TP1, TP2, runner stop adjustment and exit reason for each trade.
- Test partial exits against fixed exits; include commission, spread, slippage, missed fills and contract sizing.
- No lookahead: only use candles available at the decision timestamp; confirm on bar close, and test for repainting.
- Enforce existing risk caps, daily loss limits, session filters, watchdog and order expiration controls.
- Backtest across multiple market regimes with an out-of-sample period; compare expectancy, drawdown, profit factor, fill rate and stability to existing NQ strategies.
- Paper activation gate: documented precise indicator/entry rules, deterministic tests, clean historical replay, non-repainting proof, risk review and dashboard verification.

## Open dependency
Obtain the original TradingView indicator/script or a complete set of objective entry and exit conditions. The video alone is insufficient to code a faithful strategy. The cited 3.2R runner is a creator claim, not verified expectancy.
