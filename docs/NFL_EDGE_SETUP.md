# NFL EDGE monitoring setup

NFL EDGE is paper-only. The ParlayAPI key is configured in the Vercel project as PARLAY_API_KEY. Do not commit secrets.

## Activation
1. Configure a long random NFL_MONITOR_SECRET in the trading Vercel project (production and preview).
2. Configure the identical value as a GitHub Actions secret named NFL_MONITOR_SECRET in robertmckinley-alt/trading.
3. Optional: configure NFL_TELEGRAM_BOT_TOKEN and NFL_TELEGRAM_CHAT_ID as GitHub Actions secrets.
4. Merge the reviewed PR to main, deploy the trading Vercel project, and run the NFL EDGE hourly monitor workflow manually once. Confirm HTTP 200 and actual line counts.
5. Verify the 1,000-credit free allowance: one ParlayAPI props request costs 3 credits, hourly polling uses roughly 2,160 credits over 30 days. Reduce to 3-hour polling or upgrade before enabling sustained hourly use. GitHub Actions runs only on the default branch.
6. Monitor endpoint /api/nfl/monitor requires Authorization: Bearer <NFL_MONITOR_SECRET> and returns a limited sample of live lines plus aggregate health metrics.

## Current limitations
No historical persistence, verified player IDs, backtesting, injury/news ingestion, probabilistic models, CLV, automated simulated positions or real-money betting. Differences in American odds are not proven expected value. ParlayAPI player names are display names, not stable athlete IDs. DFS app synthetic odds must not be compared as equivalent to sportsbook odds. The API adapter has not yet been tested against the authenticated live provider.
