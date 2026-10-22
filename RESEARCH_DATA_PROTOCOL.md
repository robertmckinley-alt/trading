# Secondary research data protocol

These tools prepare separate research inputs. They do not replace Databento, change live accounts, enable strategies, or assert improved performance. See `LSE_SOURCE_REVIEW.md` for the verified London Strategic Edge coverage and access limitations.

## Order of work

1. Configure an LSE key outside the repository. Inspect authenticated catalogue, metadata and usage before requesting data. Keep downloaded rows private; do not commit or redistribute them.
2. Start with short overlapping samples. Compare source identity, time boundaries, OHLC, volume, gaps and rolls against the existing primary feed. A matching symbol name alone is insufficient.
3. Freeze strategy code, configuration, source identity and data hashes before replay. Record every tested variant. Older data already inspected during development is not an untouched holdout.
4. Report gross and net results, fees/slippage, trade counts, monthly returns, concentration in the largest winners, closed-trade and mark-to-market drawdown separately. Keep uncapped signal research separate from account-feasibility simulations.
5. Compare strategies and benchmarks over identical dates and capital conventions. Review one-contract futures leverage before interpreting returns from a nominal $50,000 account.
6. Keep the baseline running unchanged while new research is reviewed. Never automatically promote a strategy based on a source import or a model score.

## What this source can and cannot unlock

The public catalogue showed about one year for NQ.F and GC.F, no MGC listing, and 9.1 years for BTC/USD on 2026-09-21. Futures contracts, roll methodology and crypto venue remain unspecified. Consequently, this source is a candidate for crypto historical research and overlapping futures comparisons, not a verified extension of NQ history before 2025. GC.F must not be relabeled as MGC. Any gold simulation needs the correct instrument multiplier, tick size, trading sessions and costs.

Raw tick schemas still need an authenticated sample. Do not simulate bid/ask fills from an assumed tick schema or infer execution sequence from OHLC candles. Candle import support does not establish tick-quality execution evidence.

## Additional offline diagnostics

`node scripts/research-context.cjs MODE input.json output-name.json` writes a new report under `runtime/research-context/`. Existing reports are not overwritten. All outputs are research-only and forbid automatic promotion. Examples below are synthetic schema illustrations, not downloaded observations or trading results.

### Point-in-time economic observations

Run with `MODE=macro` and this input shape:

```json
{
  "decisionTimes": ["2025-02-15T14:30:00Z"],
  "observations": [{
    "series": "EXAMPLE",
    "periodEnd": "2025-01-31T00:00:00Z",
    "availableAt": "2025-02-02T13:30:00Z",
    "vintageId": "first-release",
    "value": 1.2
  }]
}
```

The join uses only releases available by each decision. Later revisions never backfill earlier decisions, and revisions of an old period cannot displace a newer period. Missing features stay absent. Availability and vintage fields must be verified externally: LSE `/series` does not supply them. Do not invent a release timestamp from an observation date. A future economic-release schedule may be used for event-time analysis only when its historical publication timing is known.

### Benchmark calculation

Run with `MODE=benchmark`:

```json
{
  "options": {"startingCapital": 50000, "symbol": "EXAMPLE", "source": "synthetic", "priceBasis": "price-only"},
  "points": [
    {"timestamp": "2025-01-02T21:00:00Z", "value": 100},
    {"timestamp": "2025-01-03T21:00:00Z", "value": 101}
  ]
}
```

`priceBasis` must be `price-only` or `total-return-index`. Total-return mode additionally requires `adjustmentEvidence` documenting an externally constructed/verified series including distributions. The helper does not construct dividend adjustments or verify provider claims. LSE split-adjusted ETF candles are not a total-return index. Calculations assume fractional exposure and exclude costs/tax; drawdown uses the supplied observations, not intrabar extremes. Do not splice it into the production comparison page until its dates and sampling match the strategy curve.

### Forecast evaluation

Run with `MODE=forecasts`:

```json
{
  "rows": [{
    "trainingEnd": "2024-12-31T23:59:00Z",
    "forecastAt": "2025-01-02T14:29:00Z",
    "decisionAt": "2025-01-02T14:30:00Z",
    "targetAt": "2025-01-02T15:30:00Z",
    "reference": 100, "prediction": 102, "actual": 101,
    "modelVersion": "example-frozen-v1", "datasetHash": "replace-with-verified-training-data-sha256"
  }]
}
```

Each frozen model is scored separately against a no-change forecast using RMSE, MAE, direction agreement and relative RMSE skill. Training or forecast timestamps after the decision are rejected. The caller must verify that the reference price and every training feature were available in time. Price accuracy is not trading profitability; evaluate fees, spread and execution separately. No LSE ML Studio or Kronos training job is launched by this helper. Preserve training parameters, seed, feature definitions, package versions and fitted artifacts before trusting a result.

## Current operational boundary

The implementation can be tested without a key using synthetic fixtures. Downloading, comparing real source samples, verifying a Parquet/tick schema and running real source-backed performance studies require authenticated data and, for matched comparisons, access to the primary candle cache. None of those results should be inferred from passing unit tests. Existing audit fixes in trading PR #2 and the separate crypto/Kronos changes remain distinct work; check their merge/deployment state before describing a replay as using corrected production logic.
