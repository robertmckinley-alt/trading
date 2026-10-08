# NFL EDGE hourly monitoring
This feature is PAPER ONLY. No live feeds are active until credentials are configured.
The hourly GitHub Actions workflow calls the Vercel endpoint; it does not place wagers.
1. Set Vercel production environment variables ODDS_API_KEY (licensed The Odds API subscription with NFL player props), NFL_MONITOR_SECRET (long random secret).
2. Set GitHub Actions secret NFL_MONITOR_SECRET to the same value. Optional secrets NFL_TELEGRAM_BOT_TOKEN and NFL_TELEGRAM_CHAT_ID for anomaly alerts.
3. Optional GitHub Actions variable NFL_MONITOR_URL to override the production endpoint.
4. Merge and deploy, then manually run the workflow to validate authentication and provider entitlements.
5. Review provider rate limits and market availability; the endpoint currently uses one request per check and does not persist historical odds.
6. Linemate API, injury feeds, historical persistence, model probabilities, CLV and backtesting are NOT implemented.
The endpoint compares same-event, same-market, same-player, same-side and same-point lines across books. It flags stale timestamps and large price gaps; price differences are NOT automatically profitable bets.
