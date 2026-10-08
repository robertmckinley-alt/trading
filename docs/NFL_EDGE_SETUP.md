# NFL EDGE monitoring setup

NFL EDGE is paper-only. The primary automated source is ParlayAPI. Configure its key as `PARLAY_API_KEY`; never commit credentials.

## Data-source policy

- **ParlayAPI:** permitted API integration for current NFL props, source freshness, injury tags, exchange/prediction-market rows and optional prediction-market discovery.
- **LineMate:** manual personal-research reference only. Its published terms prohibit automated/non-human access, systematic retrieval, data mining and scraping. NFL EDGE must not log in, crawl the site, call undocumented endpoints or schedule browser extraction.
- **LineMate imports:** only manually transcribed observations for personal, non-commercial research, or a provider export covered by written permission. They remain non-actionable context. The adapter rejects imports without collection and permission metadata.
- **Prediction markets:** discovery leads only. Keep Kalshi, Polymarket and Novig prices source-native. Do not blend or treat a text match as arbitrage until settlement rules, bid/ask spread, depth and tradability are verified.

## Activation

1. Configure a long random `NFL_MONITOR_SECRET` in the trading Vercel project for production and preview.
2. Configure the identical value as a GitHub Actions secret named `NFL_MONITOR_SECRET` in `robertmckinley-alt/trading`.
3. Confirm `PARLAY_API_KEY` is the Pro key. The user reports a 100,000-credit monthly plan. Verify the response headers after the first production request rather than assuming the quota.
4. Optional: set `NFL_PREDICTION_MARKETS_ENABLED=true`. Set `NFL_PREDICTION_MARKET_QUERY` to a specific NFL topic when broad `NFL` discovery is too noisy. This endpoint is beta and remains discovery-only.
5. Optional: configure `NFL_DATABASE_URL`, `DATABASE_URL` or `POSTGRES_URL`. Successful monitor runs then persist the full normalized snapshot. Without a database, monitoring still works and reports persistence as disabled.
6. Optional: configure `NFL_TELEGRAM_BOT_TOKEN` and `NFL_TELEGRAM_CHAT_ID` as GitHub Actions secrets.
7. Merge the reviewed PR, deploy the trading Vercel project, and run the NFL EDGE hourly workflow manually once. Confirm HTTP 200, nonzero line counts, freshness, completeness, request cost and remaining credits.

The monitor endpoint is `/api/nfl/monitor`. It requires `Authorization: Bearer <NFL_MONITOR_SECRET>`, disables HTTP caching, returns at most 100 sample lines, and persists the full snapshot only when a database is configured.

## Credit and completeness controls

- The props query asks for one 10,000-row page, full-game markets, selection IDs where available, effective DFS pricing and a 60-minute maximum age.
- Current ParlayAPI documentation prices `/props` at 3 credits. Hourly polling is about 2,160 credits over 30 days. Provider pricing can change; trust `x-requests-last` or `x-credits-cost` from the live response.
- The adapter reads both current `x-requests-*` and legacy `x-credits-*` quota headers.
- `x-result-has-more`, `x-result-truncated`, `x-result-truncated-hint` and `x-result-degraded` are preserved. A truncated or degraded board returns `checked_incomplete`, not a false success.
- DFS projections, exchanges and sportsbooks are classified separately. Only sportsbook rows can enter provisional price-gap diagnostics.

## Decision gate

NFL EDGE produces **NO TRADE** unless all required evidence is current and verified. A price gap is not expected value. A LineMate hit rate is not a probability model. Prediction-market volume, a large trade or price movement is not directional proof.

Before any paper position is created, require:

- verified athlete identity across sources;
- exact fixture, market family, period, side and line match;
- fresh, non-truncated and non-degraded source data;
- confirmed injury/news and game status;
- executable price, spread and liquidity;
- a documented probability method, entry, stop/invalidation, targets and risk limit.

## Current limitations

- ParlayAPI player names are display names, not universal athlete IDs. Cross-book matches are marked `display_name_only`, non-actionable and excluded from automated positions.
- The optional prediction-market search is beta. Its clusters are text matches, not proof of equivalent contracts.
- Saved snapshots support future research but do not create a validated backtest by themselves. Coverage varies by source, market and date.
- No automated paper entries, real-money betting, averaging down or account-size assumptions are implemented.
- Production credentials, database persistence, scheduled workflow behavior and live provider payloads still require one deployment-time verification run.
