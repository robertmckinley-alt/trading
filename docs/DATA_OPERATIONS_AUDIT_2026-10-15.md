# Data and operations audit — 2026-10-15

## Confirmed defects repaired

- Historical cache and market clocks used an obsolete 16:15–16:30 New York equity halt. CME's June 11, 2021 regulatory filing eliminated it effective June 28, 2021, explicitly listing NQ and MNQ. These minutes are now REQUIRED in all supported 2025/26 NQ, MNQ, GC, and MGC cache days. A complete 1,380-minute weekday is accepted without deleting any observations. A day missing those 15 open minutes is incomplete. The real 17:00–18:00 maintenance break and weekend closures remain excluded. Unsupported symbols and unreviewed holiday hours fail closed.
- The operations monitor used the ORB/NQ closure flag for all strategies. Each strategy now exposes its own `watcher.marketClosed`; the monitor uses it. The obsolete afternoon closure was also removed from the market clock, so neither NQ nor Gold feed outages are excused during that open interval.
- A cache day or cash session with every timestamp but malformed OHLC values could pass completeness. Both now reject invalid prices, invalid minute boundaries, and duplicate timestamps.
- Backtest provenance omitted `dmc-atr.cjs` from its code hash. It is included now, so ATR helper changes invalidate the old code fingerprint.
- Current-cache comparison disclosed the actual last candle but lacked a structured persisted-day coverage report at startup. It now writes `cache-coverage.json`, includes missing/incomplete dates in its frozen input metadata, and emits an explicit incomplete-coverage warning.
- Enabled entry-research experiments now have independent heartbeat/error checks. A healthy parent profit worker no longer masks a stale nested research report.

## Historical tail evidence

The VPS diagnostic found October 1 and 2 NQ cache files containing all mandatory open minutes plus 15 records at 20:15–20:30 UTC that the obsolete policy incorrectly called unexpected. Those files are valid under the corrected 2025/26 schedule. October 5–9 and 12–14 files were absent. The obsolete gate explains rejection of observed complete files; it does not recreate absent files or establish that every missing day was downloaded. The rolling 4,800-candle live cache is a different store.

Primary source: [CME regulatory filing 20-244, filed with the CFTC](https://www.cftc.gov/sites/default/files/filings/orgrules/21/06/rule061421cmedcm001.pdf), page 2 effective-date and halt-elimination paragraphs, and Exhibit A listing NQ/MNQ. Some older CME marketing pages still describe the former halt. The dated regulatory change supersedes them for 2025/26.

The diagnostic identifies missing files, checksum failures, missing or unexpected minutes, duplicates, and invalid prices without fetching data or modifying histories. Missing files require historical retrieval. The existing daily backtest worker can retry those dates using the configured provider; this diagnostic does not download or invent candles.

Run on the VPS:

```sh
node scripts/diagnose-historical-cache.cjs 2026-10-01T00:00:00Z 2026-10-15T00:00:00Z
```

Omit both dates to audit the saved backtest report's requested window. End is exclusive. Current partial UTC days intentionally have no persisted cache file. Holiday schedules remain explicitly unreviewed. A missing cache file does not establish that the provider lacks the data, and this command makes no paid API calls.

Existing comparison remains available with `node scripts/compare-execution-backtests.cjs --current-cache`. It uses the same frozen candles for both engines, includes incomplete input for controlled comparison, and must not be represented as covering missing dates. No trades, cache files, or journals are synthesized or deleted.

## Activation

Restart the status server after pulling so its snapshots expose per-strategy closure flags. Copy the updated `scripts/operations-monitor.py` to `/usr/local/sbin/trading-operations-monitor.py`, preserving mode 700. Use `python3 /usr/local/sbin/trading-operations-monitor.py --dry-run` to verify the deployed monitor. Existing host cron remains unchanged.

## Verification

Regression tests cover complete/missing/corrupt UTC cache days, malformed OHLC, duplicates, unreviewed holidays, corrected post-2021 equity/Gold hours, preservation of persisted files, and stale Gold/entry-research detection. Historical request availability, existing cache reuse, execution repair, and full backtest integration tests also passed. No market-data download or production mutation was performed for this audit.
