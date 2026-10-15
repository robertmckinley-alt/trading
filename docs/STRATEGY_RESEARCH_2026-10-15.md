# Forward entry research, October 15, 2026

## Findings and limits

The recorded October 12–15 snapshot contains 24 closed trades, 23 losses, net -$4,834 across independent paper accounts. It is not a complete week. The trade-by-trade evidence is in LOSS_AUDIT_2026-10-15.md. A loss sequence is not sufficient to prove that reversing every signal would work: spreads, costs, exit asymmetry, and correlated entries matter.

| Strategy | Concrete concern | Research response |
|---|---|---|
| VWAP stretch | Source is long-only. A down move beyond two ATR is a mean-reversion hypothesis, not confirmation of a reversal. One observed fill retained only 1.5 points to its stop after a 20-point price improvement. | Test actual remaining structural stop distance. Continue existing matched protection experiment; do not claim its still-negative cohorts are profitable. |
| POC reversion | Baseline and regime challenger share an underlying signal family, so losses are not independent evidence. Existing profit-lock and partial/trail experiments disagree. | Preserve the existing trend and reversal confirmation arms. Test stop distance relative to completed volatility separately, without changing baseline targets. |
| Hourly sweep | An entry-minute loss cannot establish the complete intrabar sequence. Existing protection experiment has not shown an improvement in the supplied snapshot. | Use repaired forward fill semantics and matched entry experiments; do not optimize trailing settings against this small loss sample. |
| Opening-range retest | Two-point NQ stop and seven contracts made a small move consume the risk budget. | Test requested stop distance of at least one completed M1 ATR. Rejected signals stay visible with the unchanged control outcome. No automatic stop widening. |
| DMC failed/gain | One reversal filled about 13 minutes after observation, within the permitted 15 minutes. | Compare maximum three-minute origin age against the unchanged 15-minute deadline. This does not establish that all late fills are bad. |
| Fresh-level retest | Two-point stop loss; original order expiry is shorter than three minutes. | Test stop distance. Freshness arm never extends the existing shorter deadline. |
| Gold opening EMA | Three observed long losses. Source already has a completed-candle trailing model, so saying “no protection” would be wrong. | Do not feed MGC signals NQ candles. Gold research needs its own instrument cache and correct gold tick/value configuration; not included in this NQ worker. |

## Frozen hypotheses

Version: `entry-research-v1-post-fill`. These thresholds are proposed test settings, not optimized winners or evidence of an edge. Each admitted parent event is copied prospectively into separate $50,000 paper accounts:

- `control`: parent signal, targets, stop and expiry under the current execution model.
- `fresh-entry-3m`: earlier of original expiry and original signal availability plus three minutes. Already-expired research entries are recorded as filtered while control continues, avoiding selection bias.
- `stop-room-half`: at actual fill, reject when remaining stop distance is less than half of the original requested stop distance. This tests substantial structural erosion even when the fill price is nominally better.
- `stop-one-atr`: reject requested stop distance below one ATR, measured from the 14 true ranges in 15 contiguous completed M1 bars at parent observation. Missing, malformed, nonpositive or mixed-contract history rejects this arm only.

Each arm changes only its stated variable. Protection changes are not combined with these new entry conditions. Equal quantities and risk budgets are taken from the minimum available cap of participating accounts. All arms wait for the prior matched cohort to finish, so a faster exit does not create extra opportunities. Filtered signals have zero P&L in paired comparisons; lost winners therefore count against the filter. No retrospective fills, re-simulation of old journals, funded orders, or automatic promotion.

The existing profit experiment state remains separate. New intrabar execution accounts carry `post-fill-evidence-v1`; reporting does not pair them with legacy fill semantics. Queue events are immutable after first capture, preventing the worker fallback from overwriting a watcher's correct strategy configuration. Fallback uses the VWAP and Fresh Retest account overrides.

## Evaluation

Review matched deltas, improved dollars, sacrificed dollars, trade count, rejected count and drawdown together. Record every proposed hypothesis, including ones that fail. Do not pick the best-looking arm from a handful of outcomes. Keep a chronological holdout and require independent future observation before promoting any rule. A proposed filter can lose by rejecting winners, and a control can benefit from more trading opportunities outside the matched cohort; this experiment estimates only its explicitly matched opportunity set.

Primary research: Bailey, Borwein, López de Prado and Zhu, *The Probability of Backtest Overfitting*, Journal of Computational Finance, 20(4), 2017. Author-hosted paper: https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf . Its relevant warning is that searching many strategy variants and selecting on the same historical results increases the risk of selecting noise. It does not validate our ATR threshold or promise profitability.

## Activation and verification

Inside the existing container/repository:

```sh
node scripts/profit-paper.cjs --research-enable
node scripts/activate-audit-fixes.cjs
```

The first command opts into the new prospective cohort without altering existing balances. The second restarts enabled workers so they load the new code. The research worker shares the existing five-second profit-worker loop and makes no new market-data API requests. Public reports include `profitExperiment.entryResearch`; accounts also appear in the existing profit panel. Stored files are `runtime/profit-experiment/entry-research-state.json` and `entry-research-report.json`.

Verify `entryResearch.enabled`, current `updatedAt`, and `status: collecting` while the feed is fresh. An empty account list before the first new admitted parent signal is expected. `waiting-for-fresh-feed`, `data-gap`, corrupt state, and version mismatch must be investigated; never delete a state file to clear an error. These tests compare admitted parent signals only, not all detector candidates blocked by baseline account risk.
