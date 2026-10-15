# Data and operations audit — 2026-10-15

## Confirmed defects repaired

- Historical cache completeness used NQ's 16:15–16:30 New York halt for every symbol. A complete MGC/GC day with those 15 open minutes failed the cache gate, while a Gold day missing those minutes could pass it. Completeness now distinguishes NQ/MNQ from MGC/GC. Unsupported symbols and unreviewed holiday hours fail closed. CME Micro Gold contract hours list the daily 17:00–18:00 New York maintenance break: https://www.cmegroup.com/markets/metals/precious/e-micro-gold.html .
- The operations monitor used the ORB/NQ closure flag for all strategies. That could hide stale Gold candles during the NQ-specific halt. Each strategy now exposes its own `watcher.marketClosed`; the monitor uses it. Old snapshots cannot excuse Gold feed staleness using NQ's flag.
- A cache day or cash session with every timestamp but malformed OHLC values could pass completeness. Both now reject invalid prices, invalid minute boundaries, and duplicate timestamps.
- Backtest provenance omitted `dmc-atr.cjs` from its code hash. It is included now, so ATR helper changes invalidate the old code fingerprint.
- Current-cache comparison disclosed the actual last candle but lacked a structured persisted-day coverage report at startup. It now writes `cache-coverage.json`, includes missing/incomplete dates in its frozen input metadata, and emits an explicit incomplete-coverage warning.
- Enabled entry-research experiments now have independent heartbeat/error checks. A healthy parent profit worker no longer masks a stale nested research report.

## Historical tail remains unverified on this host

The previously supplied replay ended 2026-10-04 although its requested window extended to October 9. That is not sufficient evidence to blame a specific file, provider cutoff, or cache schedule. The rolling 4,800-candle live cache is a different store. The new diagnostic identifies missing files, checksum failures, missing or unexpected minutes, duplicates, and invalid prices without fetching data or modifying histories.

Run on the VPS:

```sh
node scripts/diagnose-historical-cache.cjs 2026-10-01T00:00:00Z 2026-10-15T00:00:00Z
```

Omit both dates to audit the saved backtest report's requested window. End is exclusive. Current partial UTC days intentionally have no persisted cache file. Holiday schedules remain explicitly unreviewed. A missing cache file does not establish that the provider lacks the data, and this command makes no paid API calls.

Existing comparison remains available with `node scripts/compare-execution-backtests.cjs --current-cache`. It uses the same frozen candles for both engines, includes incomplete input for controlled comparison, and must not be represented as covering missing dates. No trades, cache files, or journals are synthesized or deleted.

## Activation

Restart the status server after pulling so its snapshots expose per-strategy closure flags. Copy the updated `scripts/operations-monitor.py` to `/usr/local/sbin/trading-operations-monitor.py`, preserving mode 700. Use `python3 /usr/local/sbin/trading-operations-monitor.py --dry-run` to verify the deployed monitor. Existing host cron remains unchanged.

## Verification

Regression tests cover complete/missing/corrupt UTC cache days, malformed OHLC, duplicates, unreviewed holidays, distinct NQ/Gold hours, preservation of persisted files, and stale Gold/entry-research detection. Historical request availability, existing cache reuse, execution repair, and full backtest integration tests also passed. No market-data download or production mutation was performed for this audit.
