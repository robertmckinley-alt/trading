# London Strategic Edge source review

Reviewed 2026-09-21 from London Strategic Edge's public API reference, live public catalogue, terms, and official `lse-data` client. No account was created, no API key was obtained, and no authenticated data was downloaded.

## Decision

Use London Strategic Edge (LSE) only as a secondary research and comparison source. Do not replace Databento or an exchange-specific crypto feed with it. The provider exposes a useful, documented API, but the public material does not disclose enough about futures rolls, crypto venues, raw tick provenance, or revision vintages to treat its series as equivalent to primary-market data.

An authenticated validation pull remains blocked until an `lse_live_...` key is supplied through the environment. The public catalogue can be browsed without a key; REST data and export calls require one.

## Primary sources

- API reference: <https://londonstrategicedge.com/docs/api.md>
- Rendered API page: <https://londonstrategicedge.com/api-documentation/>
- Public catalogue: <https://londonstrategicedge.com/data/>
- Terms: <https://londonstrategicedge.com/terms/>
- Official Python client: <https://github.com/londonstrategicedge/lse-data>

## Verified API contract

Base URL:

```text
https://api.londonstrategicedge.com/vault
```

Authentication is the `x-api-key: <your-key>` header. The docs identify user keys by the `lse_live_` prefix. Missing/invalid, inactive/expired, and rate/allowance errors are documented as HTTP 401, 403, and 429 respectively. A direct unauthenticated request from this environment was rejected and returned no catalogue or price data.

Discovery endpoints:

| Method | Path | Documented purpose |
|---|---|---|
| GET | `/catalog` | One row per dataset and symbol, including tick count and history span |
| GET | `/meta` | Datasets, candle classes, timeframes, reference sets, and access map |
| GET | `/reference` | Reference dataset row counts and date spans |
| GET | `/usage` | Current account byte, export, history, call, and row limits |

The docs say `/catalog` and `/meta` are the source of truth. Code should discover coverage from them after authentication instead of hardcoding symbols or plan limits.

### Candles

`GET /candles` accepts:

| Parameter | Verified values or meaning |
|---|---|
| `symbol` | Required; exact catalogue symbol |
| `timeframe` | `1s`, `5s`, `15s`, `30s`, `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, `1w`, `1mo` |
| `start`, `end` | ISO date or datetime bounds on bar-open time |
| `order` | `asc` or `desc` |
| `limit` | Rows in one page, capped by plan |
| `dataset` | Optional class pin: `stocks`, `etf`, `fx`, `crypto`, `index`, `commodity`, `futures`, `volatility`, `interest_rates`, `currency_index` |

The documented JSON row is:

```json
{
  "ts": "2026-07-02 00:00:00.000000",
  "symbol": "AAPL",
  "open": 296.02,
  "high": 309.28,
  "low": 293.7,
  "close": 308.48,
  "volume": 25934709
}
```

The official Python client renames `ts` to `timestamp`. Its source states that vault row timestamps are UTC and normalises timestamp strings to ISO 8601 with `Z`. The public API JSON example itself has no offset, and the catalogue preview labels times as `Time (local)`. Raw Parquet/Arrow timezone metadata is not documented. A file importer should therefore require or record an explicit timezone unless the file contains an offset or timezone-aware type; it should not infer local time from the UI.

The official client fills missing candle volume with `0.0`; the API docs state FX has no consolidated volume. Downstream validation should distinguish absent volume from real zero volume.

### Bulk exports and raw ticks

Submit `POST /export`, poll `GET /export/{job_id}`, then download `GET /export/{job_id}/download`. The documented body fields are `dataset`, `symbol`, `timeframe`, `start`, `end`, and `format`. `timeframe: "tick"` requests the raw tape; candle resolutions are also accepted. The API reference documents `parquet` and `arrow` formats. Jobs can be `queued`, `running`, `ready`, `failed`, or `expired`; artifacts last 48 hours and downloads support HTTP Range resume.

The raw historical tick row schema is not documented. The official client's *live* `Tick` object has `symbol`, `price`, `bid`, `ask`, `volume`, `timestamp`, `name`, and `replay`, but that does not prove the bulk raw-tick file uses the same columns. An importer must inspect the downloaded schema and reject unmapped fields rather than assume equivalence.

The marketing/catalogue page says CSV or Parquet and advertises 10 downloads per hour with up to 1,000,000 rows. The live catalogue UI says downloads are Parquet. The API reference documents Parquet or Arrow export jobs and gives a sample `/usage` response with 2 exports/hour, 100 calls/minute, 5,000 synchronous rows, and a 50 GiB monthly cap. These statements describe different surfaces or plans. Query `/usage` and `/meta` at runtime; do not encode those sample limits as contractual constants.

## Instrument coverage observed in the live public catalogue

These are public catalogue labels observed on 2026-09-21, not authenticated file contents:

| Search/class | Catalogue identity | Public label | Displayed coverage |
|---|---|---|---|
| `NQ`, Futures | `NQ.F` | `Nasdaq 100 Futures`; `United States / 1 minute` | `103.3M` data points; `1y`; updated `2026-09-18` |
| `MGC`, Futures | none | `0 datasets` / `No datasets match.` | none |
| `GC`, Futures | `GC.F` | `Gold Futures`; `United States / 1 minute` | `30.7M` data points; `1y`; updated `2026-09-18` |
| `BTC`, Crypto | `BTC/USD` | `Bitcoin`; `1 minute` | `4.14B` data points; `9.1y`; updated `2026-09-20` |

Expanding `GC.F` exposed `tick` plus all 14 candle resolutions. The catalogue and API reference do not identify a contract month, exchange, roll rule, adjustment method, or root-to-contract mapping for `NQ.F` or `GC.F`. Nothing public establishes that `NQ.F` is a CME NQ contract, that it is a CFD, or that it is interchangeable with MNQ. Nothing establishes that `GC.F` is MGC. Treat `.F` symbols as vendor continuous/derived identities until an authenticated sample and provider metadata prove otherwise. Validate prices, sessions, gaps, volumes, rolls, and basis against Databento before any research use.

The public data page states: "Displayed prices are the output of our proprietary derivation algorithms, applied to independently sourced inputs." This reinforces the need to keep source identity separate.

For `BTC/USD`, neither the documented candle row nor the catalogue example contains exchange, venue, market type, quote convention beyond the symbol, or aggregation methodology. Do not label it Coinbase, Binance, spot, perpetual, or consolidated without further evidence. Compare it with the intended primary venue feed before use.

The public ETF catalogue reported 25 datasets. Visible examples included SPY, QQQ, IWM, GLD, SLV, VOO, IBIT, and leveraged funds; the displayed intraday history on the visible rows was about `0.4y`. The API docs say stock and ETF candles are **split adjusted**. They do not say dividend adjusted or total-return adjusted. Dividends are exposed separately at `/ref/dividends`. A buy-and-hold total-return benchmark must incorporate distributions independently and document its adjustment method.

## Macro and event data

`GET /series` returns only `(symbol, date, value)` observations. The documented example has no release timestamp, ingestion timestamp, vintage, revision sequence, or as-of field. It covers macro series and bond yields, but its final historical values cannot safely be assumed to be point-in-time values.

`GET /ref/economic_calendar` ranges on `datetime` and supports `region`, event substring, and `released=1`. The official client describes `released_only` as events whose `actual` value has printed. Public docs do not promise immutable first-release values or revision history.

Safe research use:

- Use the economic calendar as a candidate release schedule only after timestamp/timezone checks.
- Do not join a macro observation to prior bars merely by its observation `date`.
- For point-in-time features, capture releases prospectively or use a provider with explicit realtime/vintage data.
- Persist retrieval time, provider series ID, event datetime, actual/forecast/previous when available, and raw payload hash.
- Conservatively lag any non-vintage series and keep it out of claims that require revision-safe backtests.

## ML Studio reproducibility

The public ML Studio screen exposes dataset, timeframe, start/end, prediction horizon, test split, model hyperparameters, and selected feature groups. For the visible XGBoost model it exposed parameters such as tree count, depth, learning rate, minimum child weight, subsample, column sample, L1/L2 regularisation, and early stopping.

No random seed, package/model version, exact data snapshot/hash, code export, model export, or result download control was visible before running. Running or verifying post-run persistence would require a sign-in and a training job, which was not performed. The public surface is therefore insufficient for reproducible research on its own. If the Studio is explored later, save the entire configuration plus data hash, train/test boundaries, feature definitions, random seed, dependency versions, output metrics, and fitted artifact externally. Do not use its headline score as validation for frozen strategies.

## Licensing and operational restrictions

The terms were last updated 19 January 2026. They permit use of the data in one's own research, trading, models, or internal work, including commercial purposes, free of charge. They prohibit redistribution or resale and operating a competing feed, download service, or API sourced from LSE. They also prohibit circumventing API-key limits, rate limits, or usage allowances. Redistribution or enterprise licensing requires contacting the provider.

The terms say market data is provided as-is, without warranty, and the service may be modified, suspended, or discontinued. Store provider provenance and hashes, but do not check downloaded source data into a public repository or ship it in reports.

## Validation gate before strategy use

1. Obtain a key outside source control and expose it through an environment variable.
2. Call `/usage`, `/meta`, and `/catalog`; persist the raw discovery responses and retrieval time.
3. Pull small overlapping samples only: NQ.F, GC.F, BTC/USD, and chosen ETFs at 1m and daily, plus raw tick samples where useful.
4. Inspect actual Parquet/Arrow schemas, nullability, timezone metadata, duplicate keys, sorting, and interval boundaries.
5. Compare with Databento or the primary exchange feed for timestamp alignment, OHLC, volume, missing bars, sessions, halts, rolls, and price basis.
6. Reject MGC substitution: the public catalogue had no MGC dataset.
7. Keep raw provider files and normalized outputs source-tagged and separate.
8. Run frozen strategies on older history without fitting thresholds to LSE results. Report discrepancies and sensitivity; do not splice sources silently.

