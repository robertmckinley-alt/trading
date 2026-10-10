# NFL EDGE monitoring setup

NFL EDGE is paper-only. The primary automated source is ParlayAPI. Configure its key as `PARLAY_API_KEY`; never commit credentials.

## Data-source policy

- **ParlayAPI:** permitted API integration for current NFL moneylines, spreads, game totals, player props, source freshness, injury tags and source-native prediction-market discovery.
- **LineMate:** manual personal-research reference only. Its published terms prohibit automated/non-human access, systematic retrieval, data mining and scraping. NFL EDGE must not log in, crawl the site, call undocumented endpoints or schedule browser extraction.
- **LineMate imports:** only manually transcribed observations for personal, non-commercial research, or a provider export covered by written permission. They remain non-actionable context. The adapter rejects imports without collection and permission metadata.
- **Prediction markets:** discovery leads only. Keep Kalshi, Polymarket and Novig prices source-native. Do not blend or treat a text match as arbitrage until settlement rules, bid/ask spread, depth and tradability are verified.

## Activation

1. Configure a long random `NFL_MONITOR_SECRET` in the trading Vercel project for production and preview.
2. Configure the identical value as a GitHub Actions secret named `NFL_MONITOR_SECRET` in `robertmckinley-alt/trading`.
3. Confirm `PARLAY_API_KEY` is the Pro key. The user reports a 100,000-credit monthly plan. Verify the response headers after the first production request rather than assuming the quota.
4. Optional: set `NFL_PREDICTION_MARKETS_ENABLED=true`. This enables the sport-specific NFL contract endpoint for Kalshi and Polymarket. Set `NFL_PREDICTION_MARKET_QUERY` only for a specific special-market topic; broad `NFL` search is intentionally disabled because it returns unrelated offseason markets. Both paths remain discovery-only.
5. Optional: configure `NFL_DATABASE_URL`, `DATABASE_URL` or `POSTGRES_URL`. Successful monitor runs then persist the full normalized snapshot. Without a database, monitoring still works and reports persistence as disabled.
6. Optional: configure `NFL_TELEGRAM_BOT_TOKEN` and `NFL_TELEGRAM_CHAT_ID` as GitHub Actions secrets.
7. Merge the reviewed PR, deploy the trading Vercel project, and run the NFL EDGE hourly workflow manually once. Confirm HTTP 200, nonzero line counts, freshness, completeness, request cost and remaining credits.

The monitor endpoint is `/api/nfl/monitor`. It requires `Authorization: Bearer <NFL_MONITOR_SECRET>`, disables HTTP caching, returns at most 100 sample lines, and persists the full snapshot only when a database is configured.

## Credit and completeness controls

- The monitor issues one 10,000-row request for each of the six supported full-game markets. This avoids the provider's cross-market serving cap while preserving selection IDs, effective DFS pricing and a 60-minute maximum age.
- The game board calls `/odds` once with `h2h,spreads,totals`. It calculates the best listed moneyline, a cross-book median spread and total, and a two-way de-vigged market probability for each team. The higher probability is labeled **market leader**, not an independent pick.
- Current ParlayAPI documentation prices each `/props` request at 3 credits, the three-market `/odds` request by markets served, and the sport-specific prediction-market request at 1 credit. With current observed costs, one full refresh is about 22 credits and an hourly monitor is about 15,840 credits over 30 days. The scheduled monitor retries only failed prop markets once; if all six fail and retry every hour, that adds up to 12,960 credits. The public page has a separate 15-minute server cache and does not use the retry; continuous traffic at every cache boundary can add about 63,360 credits over 30 days. The combined worst-case estimate is therefore about 92,160 of the reported 100,000-credit plan. Provider pricing can change; trust the aggregated live `x-requests-last` or `x-credits-cost` values.
- The adapter reads both current `x-requests-*` and legacy `x-credits-*` quota headers.
- `x-result-has-more`, `x-result-truncated`, `x-result-truncated-hint` and `x-result-degraded` are preserved. A truncated or degraded board returns `checked_incomplete`, not a false success.
- DFS projections, exchanges and sportsbooks are classified separately. Only sportsbook rows can enter provisional price-gap diagnostics.

## Decision gate

NFL EDGE publishes a **PLAY** only when its required price, freshness and matching evidence is current. A raw price gap is not expected value. A LineMate hit rate is not a probability model. Prediction-market volume, a large trade or price movement is not directional proof.

The production board now separates model output into explicit decision classes:

- **PREDICTION:** a straight-up winner call from de-vigged cross-book consensus, but the offered price does not clear the value gate.
- **PLAY:** a current price or line beats a leave-one-book-out benchmark or the cross-book median by the configured minimum.
- **PASS:** required freshness, source count, price edge, injury status or exact-match evidence is missing.

Game parlays use one sportsbook and distinct games. Player-prop plays require an exact canonical event, player display name, market, side and line match across at least four sportsbooks including the offered quote. Player parlays use one sportsbook and different games; same-game combinations are excluded until correlation is measured. All combined parlay prices are estimates that must be verified in the sportsbook betslip.

Before any paper position is created, require:

- verified athlete identity across sources;
- exact fixture, market family, period, side and line match;
- fresh, non-truncated and non-degraded source data;
- confirmed injury/news and game status;
- executable price, spread and liquidity;
- a documented probability method, entry, stop/invalidation, targets and risk limit.

## Current limitations

- ParlayAPI player names are display names, not universal athlete IDs. A displayed player setup requires the same canonical event, exact normalized name, market, side and line across books. Injury flags block publication, and no setup creates an automated position.
- The optional prediction-market search is beta. Its clusters are text matches, not proof of equivalent contracts.
- Straight-up calls are consensus market projections, not an independent team-strength or injury-adjusted model. They remain **PREDICTION** unless an executable price also clears the value gate.
- Saved snapshots support future research but do not create a validated backtest by themselves. Coverage varies by source, market and date.
- No automated paper entries, real-money betting, averaging down or account-size assumptions are implemented.
- Database persistence remains optional and is reported as disabled when no database is configured. Scheduled monitoring and live provider payloads were deployment-verified on 2026-10-10.
- Position size remains blank until bankroll and maximum risk are supplied. Dashboard risk/reward is normalized to a one-unit maximum loss.

## Timeout and degradation behavior

The six player-prop markets are fetched independently. One slow prop market no longer discards current game moneylines, spreads and totals or causes the hourly job to report a total outage. The protected scheduled endpoint retries only failed prop markets once within the Vercel time limit; the public page does not retry. The monitor returns `checked_incomplete`, names any market that still failed and continues to fail closed for that missing market. If the game-market endpoint is unavailable, the monitor still fails.
