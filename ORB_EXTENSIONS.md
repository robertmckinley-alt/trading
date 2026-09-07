# ORB fade and exit experiments

Implemented September 7, 2026 as three historical research candidates. These are independent, explicit hypotheses inspired by @bennnytrades' public ORB research themes. They are not copies of his proprietary scripts, and no profitability is claimed.

## Existing work retained

The repository already has normalized opening-range ATR, same-slot relative volume, their combination, a wick filter, historical walk-forward selection and nine locked forward-paper accounts. This change adds complementary experiments rather than relabeling those existing filters.

## Frozen rules

| Candidate | Entry and stop | Exit |
| --- | --- | --- |
| `nq-15m-orb-exit-1r` | Exactly the baseline close-confirmation detector and structural stop | Entire position at planned 1R |
| `nq-15m-orb-exit-3r` | Exactly the same entry and stop as the 1R candidate | Entire position at planned 3R |
| `nq-15m-orb-failed-breakout-fade` | Completed 15-minute candle breaches one opening-range edge by at least one tick, then closes strictly inside the range, toward its midpoint. Stop one tick beyond the rejection candle's extreme. | Entire position at the opening-range midpoint, provided planned reward is at least 1R |

R is measured from the signal close to its structural stop, before execution costs. Actual fill gaps, slippage and commissions change realized R. Targets stay anchored to the signal and are not retrospectively moved to preserve advertised R.

The exit pair shares signal timestamps, not necessarily filled trades: an opening gap through the nearer 1R target can reject that order while leaving the 3R order eligible. Compare rejected-fill counts as well as P&L.

All three use the 09:30–09:45 America/New_York opening range. Eligible completed confirmation bars end from 09:59 through 11:29. Historical entry occurs at the following minute's open with adverse slippage. Missing or duplicated minute bars cannot form a complete range or confirmation. Existing one-trade-per-day, stop-first conflict, stop-gap and session-closing conventions apply.

The fade is a single-bar sweep-and-reclaim hypothesis, not a requirement for an earlier candle to have closed outside. A high sweep requires a bearish rejection candle and produces a short; a low sweep requires a bullish rejection candle and produces a long. Reject candles sweeping both sides because OHLC cannot reveal the order. Require body/range >= 25% and the wick toward the intended trade direction <= 25%. Reject if the midpoint is behind entry or offers less than 1R. These thresholds are our unvalidated choices, not settings recovered from the creator.

The exit pair intentionally adds no ATR/RVOL filters or trailing/break-even logic. The entry and stop remain fixed so historical differences measure exit behavior. Both exit all contracts at their single target, including in the separate risk-budget account diagnostic. Baseline scale-outs remain as before. Since the existing one-contract research baseline exits at its first 1.5R target, that curve provides an intermediate exit reference.

## Integration and deployment boundary

- Total historical definitions: 26. ORB learning trials: 12.
- Next complete backtest includes all three automatically, their signal audit and serialized rule metadata.
- Learning counts the added trials in its existing multiple-testing assessment and retrospective walk-forward comparison.
- The fade receives all-strategy validation but is excluded from the breakout parameter-neighborhood count because its entry model is different.
- The existing nine-account forward experiment keeps its definition set and rules hash. New candidates have `forwardPaperEligible: false` and are not accepted by the production strategy registry.
- No watchers, broker orders, environment variables or deployed runtime state were changed.
- Existing cached reports remain historical records; a new backtest is necessary to obtain results for these candidates.

These are independent experiments, not a portfolio whose profits can be summed. A fade may still lose on the same day as a breakout. Cross-strategy loss correlation requires measurement.

## Validation

The automated tests cover long/short symmetry, complete-minute requirements, stale signals, daily caps, New York daylight-saving changes, insufficient midpoint reward, ambiguous two-sided sweeps, full multi-contract exits, adverse entry gaps and stop-first conflicts. Synthetic integration exercises the real detector, sizing, execution and historical-learning path. Synthetic fixtures validate behavior, not expected profitability.

Run `npm test` for the suite. Historical market data and credentials are required for a real performance comparison; none are included in this checkout. Use the existing backtest controls after deployment, then review net P&L, drawdown, trade count, cost sensitivity and chronological held-out results before starting a separate forward-paper experiment.

## Sources and attribution

- [Six ORB variations and regime dependence](https://www.instagram.com/bennnytrades/reel/DctzntfvpV6/): motivation for comparing exit styles.
- [Testing ORB fades](https://www.instagram.com/bennnytrades/reel/Dcjo1lyPupN/): motivates a separate rejection hypothesis; the caption did not disclose numerical rules.
- [Price and volume around the opening range](https://www.instagram.com/bennnytrades/reel/Dc4D_XKp6l8/): supports examining the already-implemented volume/volatility filters.
- [Cash-account stock system versus intraday strategies](https://www.instagram.com/bennnytrades/reel/Dc1rrtyPReI/): the claimed 3.5-year Schwab record concerns stock trend-following and does not validate these futures candidates.

No PIVOTS clone is included because the exact pivot formula and entry parameters were not recovered. Further work should define an independent pivot hypothesis if desired.
