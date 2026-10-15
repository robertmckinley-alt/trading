# Futures research and learning review — October 15, 2026

Scope: source inspection of the futures paper-trading repository. This is not a fresh VPS runtime attestation or an audit of crypto or NFL. The previous `/tmp/loss-audit.json` snapshot was unavailable in this task, so this review makes no new trade-count or current heartbeat claims.

## Findings and repairs

1. **Fixed: challenger discovery mixed evidence sources.** A lifetime count of 50 explicitly forward-paper trades unlocked discovery, but the actual losing 20-trade window could contain historical replay or unlabelled legacy trades. Conversely, replay wins could hide forward losses. Discovery and recommendations now use explicitly forward-paper records only. Existing account history and conservative risk reductions remain unchanged. The profile separately reports forward evidence and excluded records. Already-created challenger accounts are not deleted or retrospectively regraded.
2. **Fixed: research lab overstated its holdout and provenance.** Its 70/30 split is recalculated each call. Nothing seals the newest trades or freezes the split. The UI no longer calls this locked or untouched validation. Forward-review metrics now exclude legacy/replay outcomes, while preserving all-journal metrics and showing the excluded count. Historical backtest review is explicitly descriptive and cannot authorize live promotion.
3. **Fixed: the separate strategy scorecard mixed provenance in candidate gates.** `strategy-evaluation.cjs` now uses explicitly labelled forward trades for sample, days, risk and profitability gates. All-account totals and watchlist classification remain unchanged, with separate forward evidence and an explicit no-live-promotion field.

## What the existing bots actually do

| Component | Actual behavior | What it does not establish |
|---|---|---|
| Strategy learning | Rolling statistics, risk reductions, one catalog-based segment-exclusion recommendation | Independent research, new signal discovery, causal proof a losing segment should be removed |
| Automatic challengers | Up to two accounts per parent, frozen side/regime exclusion, separate paper balances | Automatic promotion, unbiased selection, reliable evidence from five segment trades |
| Research council | Deterministic summaries of detector, regime and risk metadata | Independent debating agents, web research, independent feed validation |
| Coordination observer | Counterfactual exit/pause proposals with resolved-baseline accounting | Active protection of parent accounts |
| HMM experiment | Frozen model, forward filtering, separate control/filter/sizing accounts | Calibrated win probabilities, demonstrated profitability, nightly autonomous optimization |
| Profit experiment | Separate prospectively observed control and modified-exit accounts | Evidence that the main strategy already uses those exits |

The council's feed-health role currently checks provider and ticker presence, not timestamp freshness. Operational heartbeat/feed checks must remain the source of health evidence.

## Validation safeguards observed

- HMM standardization fits training data only; candidate selection uses a later validation period; the last 20% is labelled sealed and is not scored by training code.
- Runtime HMM decisions use filtering rather than full-sequence smoothed/Viterbi labels. Gaps and instrument changes reset warm-up.
- Experiment cohorts freeze models and risk configurations; execution-version cohorts separate legacy fills from bounded fills.
- Regime and profit experiments copy admitted parent signals. They cannot establish what would have happened for signals a parent rejected before capture.
- Coordination comparisons require a complete minute path and matching baseline entry/contracts, and count costs as well as benefits.
- No reviewed component automatically promotes a paper strategy to funded live execution.

## Prioritized follow-up experiments

1. Freeze a strategy/config/execution version and prospective start time for each research hypothesis. Record every tried hypothesis, including rejected ones. Do not repeatedly reuse the same chronological tail as an untouched test.
2. Test the smallest plausible change against a concurrent control: minimum stop versus recent volatility; entry aging/reconfirmation; directional regime filter; close-confirmed profit lock. Each requires evidence from both missed winners and avoided losers.
3. Report constant-risk returns and paired comparisons alongside dollar outcomes. Adaptive sizing and independently timed account admissions can otherwise disguise signal-quality differences.
4. Keep a fixed future evaluation window before selecting winners. Fifty trades or a positive profit factor alone cannot establish a durable edge, especially across correlated strategies and many tested variants.
5. Reconcile the worker status, feed freshness, admitted/rejected signal counts, pending-order ages and journal reconciliation separately from profitability. A healthy process is not a profitable strategy.

## Additional integration questions sent to the execution owner

- The main watcher explicitly bypasses adaptive risk admission/sizing for VWAP and Gold. Verify the complete daily-loss path before saying every guard applies uniformly. Account-floor sizing remains in the common plan builder.
- Regime-worker fallback capture uses the base config while main watchers capture per-strategy configs. Because capture IDs omit config, inspect whether repeated fallback capture can overwrite queued per-strategy risk settings.
- Stop/target intrabar order and excursion ambiguity require separate execution review. Candle highs/lows are not proof of attainable profit before a stop.

## Verification

`node --test test/strategy-learning-provenance.test.cjs test/trading.test.cjs test/research-loss-limits.test.cjs test/execution-repairs.test.cjs`: 75 tests passed. Coverage includes legacy losses improperly nominating challengers, replay wins hiding forward losses, preservation of account history, exclusion of unlabelled outcomes from forward claims, and honest unsealed validation metadata.
