# Historical pattern matching, v1

Status: implemented, shadow-only. No edge or profitability claimed. No trade entries, exits, risk limits, or sizing rules change. This is a transparent nearest-neighbor model, not an LLM reading chart screenshots.

Each setup gets eight measurements from 61 consecutive completed one-minute candles: direction-adjusted 5/30/60-minute moves divided by ATR14, path efficiency, recent/prior volatility ratio, recent/prior volume ratio, and sine/cosine encoding of New York time. Missing bars, invalid OHLCV, and contract changes within the feature window reject the feature vector. The signal candle counts only after it has closed.

Historical analogs must match instrument, exact strategy slug, and side. They must have entered AND exited more than 24 hours before the query. The search window is two years. There must be at least 50 eligible trades. Distances use RMS feature differences scaled by each eligible pool's interquartile range (floor 0.1); no future observations affect scaling. At least 20 analogs must fall within the fixed distance threshold 2.5. Otherwise the output explicitly reports insufficient history or no close match. Parameters are fixed starting assumptions, not optimized or proven.

Outputs: 20 closest analogs, distances, net R outcomes, historical mean/median net R and win rate. Net R uses realized P&L divided by actual initial dollar risk, incorporating costs already present in the source replay. These are descriptive historical statistics, not calibrated probabilities. Examples within the same session can be correlated; trade count is not an independent-sample count.

The report chronologically replays scores and compares subsequent outcomes in positive-mean and nonpositive-mean neighborhoods against all scored examples. Unscored setups remain explicit. It uses research trades only when present; guarded-account duplicates are not added. This is retrospective evaluation of already-developed strategies, NOT an untouched holdout. The subsets do not simulate changed sizing, account constraints, or skipped-trade portfolio effects. No automatic selection, retraining optimization or live promotion is enabled.

## Integration

Normal NQ backtests add `patternMatching` to the cached report and write `runtime/pattern-model-NQ.json` on the VPS. The standalone gold replay writes a distinct MGC model and adds scores to its separate report. Gold is never pooled with NQ. The Patterns website page reads the NQ report via the existing read-only backtest endpoint. It shows an explicit empty state until the VPS produces a model.

The regular watcher attaches the advisory to signal metadata; the ORB supervisor attaches it to submitted plans. Both persist it in `signalContext.patternMatching` in journals. Missing models or errors yield model-unavailable and leave trading decisions unchanged. Frozen discovery variants with unique slugs need their own evidence; they do not borrow the baseline's scores.

No existing strategy implementation files used by frozen-candidate hashing were modified for this feature. Historical source quality and the assumptions of the original backtest still limit every result. Models are rebuilt from completed backtests, not automatically trained on unreviewed live outcomes.

## VPS

After pulling the code, build the NQ report from cached days with no downloads:

```sh
node scripts/build-pattern-model.cjs
```

A partial day absent from the cache is not invented or fetched; its unmatched trades are excluded. This command updates the saved report with a new pattern report and saves the model. Do not run it concurrently with a backtest refresh: it checks whether the report changed before saving. The usual daily refresh also builds the model.

Restart the regular paper watchers and ORB supervisor when ready to collect forward advisory scores. Preserve all account states and journals. Restart the status server to load the updated daily backtest pipeline. Viewing the new Patterns page requires no changes to trade rules.

Before enabling any score as a trading filter, freeze a model version, collect prospective scores with unchanged trades, and evaluate sample size, net expectancy, drawdown, coverage and stability across periods. Historical visual similarity alone is not proof of an edge.
