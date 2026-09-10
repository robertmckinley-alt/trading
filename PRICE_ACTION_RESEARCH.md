# Price-action research experiments

These are independent mechanical interpretations of the supplied cheat sheet, not verified implementations of its author's methods or evidence of profitability.

Three separate backtest entries:
- `nq-15m-orb-qm-retest`: confirmed low/high/lower-low sequence, closing break above the intervening high, then bullish retest of the first low. Shorts mirror this. Each pivot requires one completed bar on each side; outside bars are excluded. Stop beyond the swept extreme by one tick.
- `nq-15m-orb-sr-flip`: five-minute candle breaks the first 15-minute cash range, with at least 50% directional body, followed by a separate directional retest. An intervening close more than one tick inside invalidates the attempt. Stop beyond the retest extreme or range edge by one tick.
- `nq-15m-orb-compression`: same breakout/retest, preceded by four bars with non-increasing highs and strictly increasing lows. Final range is at most 60% of the first, and its high is within 25% of opening-range width of the breakout edge. Shorts mirror this.

All require complete five-minute bars from 09:30 New York, confirm through 11:29, expire after six bars from the break, target 2R from the signal price, and use the existing next-bar fill model with configured costs. Gaps can change realized R. One entry per session, scheduled cash-session flattening, one NQ contract in unrestricted historical research. Accumulated losses do not stop research. Missing session candles reject a pattern.

The 2025-to-present run includes all three. Screening uses 2025 training and 2026 chronological retrospective comparison: complete coverage, 50/20 trades, positive training/test/doubled-cost expectancy, test profit factor at least 1.2, and better test net P&L than baseline. This is reused historical data, not untouched out-of-sample proof.

Qualifying candidates are frozen under `runtime/price-action/`, with separate $50,000 forward paper accounts managed by the ORB supervisor. Failed candidates stay historical-only. No brokerage orders. Existing account histories remain. Implementation changes pause previously frozen research candidates for review; they do not reset their journals or silently retune them.

After pulling main inside the existing VPS container, restart the ORB supervisor with `node scripts/orb-forward-paper.cjs --restart` and the status server with `node scripts/restart-status-server.cjs`. The refreshed historical report must finish before any new candidate can qualify. Reuse cached candles; download only missing history. Review progress and results before claiming any performance improvement.
