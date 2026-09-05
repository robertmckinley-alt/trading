# DoctorTrades NQ Paper Trader

This folder contains:

1. a local CLI paper trader
2. a Vercel-ready Next.js web app
3. a six-bot, paper-only NQ strategy research network

Both are built around the literal flow spoken in the DoctorTrades clip: at `9:00 AM` New York time, mark the `Asia` and `London` highs/lows, wait for one of those pools to get swept, drop to the `1m` chart, take the `FVG` reversal back to the other side, set the stop at the swing extreme, and target the next draw on liquidity.

This is still not a live broker integration. It is a paper-trading sandbox for planning, replaying, detecting, and journaling the setup.

The live mode now adds:

- automatic `Asia` and `London` range detection from incoming `1m` candles
- automatic post-`9AM` sweep detection
- automatic `1m` `FVG` reversal signal generation
- one persistent Databento Live API stream shared by all six watchers (no Historical API polling or fallback)
- six isolated paper strategy watchers sharing that one live stream: the two original setups, a 90-minute opening-range breakout, EMA 20/60 momentum, bar-volume POC reversion, and a 15-minute opening-range break-and-retest
- a versioned learning loop that updates after every closed paper trade, records rolling expectancy, profit factor, average R, drawdown, and streaks, and keeps an audit log of any next-trade risk adjustment
- bounded adaptive controls that classify market regime and pause new trades at the daily-loss or account-floor limits; the approved risk range is `$250` to `$500` per paper trade, and no adaptive decision can exceed the `$500` cap
- locked entry rules: the learning loop can recommend an offline review, but it cannot silently rewrite a strategy or move it to live money
- a shared `$2,500` simultaneous open-risk cap across all six paper accounts plus smaller correlated-strategy family caps, enforced before a strategy can reserve a new plan
- an advisory-only research council that records feed health, setup evidence, market regime, risk-veto status, and post-trade learning without changing entry rules or gaining order authority
- always-on monitoring that keeps one live paper trade open at a time and journals the close
- a research scorecard that requires sample size, trading-day, profit-factor, expectancy, average-R, and drawdown gates before labeling any strategy a paper candidate

See [STRATEGY_RESEARCH.md](./STRATEGY_RESEARCH.md) for source provenance, license decisions, rejected candidates, and the limits of every adaptation.

The account model is seeded at `50,000 USD` with a fixed `10%` max drawdown, so the account floor is `45,000 USD`. New plans automatically size off the smaller of your per-trade risk cap and the drawdown room left above that floor.

## Strategy Contract

This version now follows the spoken recording rather than the earlier inferred model:

- `NQ` / Nasdaq futures
- wake up at `9AM New York time`
- mark `Asia` and `London` highs/lows
- liquidity sweep first
- bullish or bearish reaction after the sweep
- drop to the `1m` chart
- `FVG` reversal entry back to the other side
- stop at the swing low/high
- target the next draw on liquidity instead of blindly fixing profit at `1:2`

## Files

- [paper-trader.cjs](/data/.openclaw/workspace/lucid-nq-paper-trader/paper-trader.cjs)
- [lib/trader-core.cjs](/data/.openclaw/workspace/lucid-nq-paper-trader/lib/trader-core.cjs)
- [config.json](/data/.openclaw/workspace/lucid-nq-paper-trader/config.json)
- [examples/lucid-sweep-short.setup.json](/data/.openclaw/workspace/lucid-nq-paper-trader/examples/lucid-sweep-short.setup.json)
- [examples/sample-nq-1m.csv](/data/.openclaw/workspace/lucid-nq-paper-trader/examples/sample-nq-1m.csv)
- [app/page.js](/data/.openclaw/workspace/lucid-nq-paper-trader/app/page.js)
- [app/api/plan/route.js](/data/.openclaw/workspace/lucid-nq-paper-trader/app/api/plan/route.js)
- [app/api/replay/route.js](/data/.openclaw/workspace/lucid-nq-paper-trader/app/api/replay/route.js)
- [components/trader-dashboard.js](/data/.openclaw/workspace/lucid-nq-paper-trader/components/trader-dashboard.js)
- [package.json](/data/.openclaw/workspace/lucid-nq-paper-trader/package.json)

## Web App

The web app is designed for Vercel:

- stateless server routes handle `plan` and `replay`
- the journal always works in browser `localStorage` and can optionally synchronize to serverless Postgres
- cloud journal access is protected by a server-verified operator session
- the same shared core logic powers both the CLI and the web app

Run it locally:

```bash
cd lucid-nq-paper-trader
npm install
npm run dev
```

Build it for production:

```bash
cd lucid-nq-paper-trader
npm run build
```

Deploy to Vercel:

1. keep this folder as its own Git repo
2. push that repo to GitHub
3. import the repo into Vercel
4. deploy as a standard Next.js app

Important persistence note:

- browser journal history remains the zero-configuration fallback
- when `DATABASE_URL` and `TRADING_ADMIN_TOKEN` are configured, an authenticated operator can synchronize journal history across devices
- the CLI still writes durable local trades into `state.json`
- the always-on live watcher should run on your VPS, not inside Vercel
- the main page shows all six strategy accounts plus outcomes, but Vercel needs a live status bridge to read the VPS watchers

## Setup Format

```json
{
  "symbol": "NQ",
  "date": "2026-08-24",
  "session": "9AM New York",
  "side": "short",
  "entry": 23215.25,
  "stop": 23224.75,
  "targets": [23202.75, 23195.25, 23184.75],
  "thesis": "At 9AM New York, mark the Asia and London highs/lows, wait for the session high sweep, then short the 1-minute fair value gap reversal back to the other side while targeting the next draw on liquidity.",
  "setup": {
    "liquiditySweep": true,
    "reaction": "bearish",
    "marketStructureShift": false,
    "cisd": false,
    "displacement": false,
    "entryModel": "session-sweep-fvg-reversal",
    "gapType": "fvg",
    "entryTimeframe": "M1",
    "activationTime": "09:00 America/New_York",
    "referenceSessions": ["asia", "london"],
    "stopPlacement": "swing-high",
    "higherTimeframeBias": "neutral-to-bearish",
    "liquidityPool": "london-or-asia-high",
    "liquidityLabel": "Asia / London session high",
    "drawOnLiquidity": ["vwap", "intraday-sell-side", "current-week-low"]
  }
}
```

## Commands

Preview the trade plan:

```bash
node lucid-nq-paper-trader/paper-trader.cjs plan lucid-nq-paper-trader/examples/lucid-sweep-short.setup.json
```

Replay that plan against `1m` candles:

```bash
node lucid-nq-paper-trader/paper-trader.cjs replay \
  lucid-nq-paper-trader/examples/lucid-sweep-short.setup.json \
  lucid-nq-paper-trader/examples/sample-nq-1m.csv
```

Replay and persist the result into a local journal:

```bash
node lucid-nq-paper-trader/paper-trader.cjs journal \
  lucid-nq-paper-trader/examples/lucid-sweep-short.setup.json \
  lucid-nq-paper-trader/examples/sample-nq-1m.csv
```

Watch a setup against a CSV feed every second:

```bash
node lucid-nq-paper-trader/paper-trader.cjs watch \
  lucid-nq-paper-trader/examples/lucid-sweep-short.setup.json \
  lucid-nq-paper-trader/examples/sample-nq-1m.csv \
  --interval=1000
```

Print the running journal summary:

```bash
node lucid-nq-paper-trader/paper-trader.cjs report
```

Generate a live plan from the configured live feed:

```bash
cd lucid-nq-paper-trader
node paper-trader.cjs live-plan
```

Run the always-on live watcher:

```bash
cd lucid-nq-paper-trader
node paper-trader.cjs watch-live
```

Run the live watcher against the bundled mock full-session fixture:

```bash
cd lucid-nq-paper-trader
node paper-trader.cjs watch-live --provider=mock
```

Equivalent npm shortcuts:

```bash
cd lucid-nq-paper-trader
npm run trader:plan
npm run trader:watch
npm run trader:watch:mock
npm run trader:watch:start
npm run trader:watch:status
npm run trader:watch:stop
```

## Live Feed Config

The live watcher reads its feed settings from `config.json` plus environment variables.

Key live fields:

- `live.provider`: `databento-live`, `mock`, or legacy `polygon-futures` (`databento` is accepted as a live-only compatibility alias)
- `live.ticker`: futures symbol to stream, for example `NQ.v.0` for the front-month continuous Nasdaq contract on Databento
- `live.mockCsvPath`: fixture path used in mock mode
- `live.apiKeyEnv`: env var name that stores the real market-data key
- `live.dataset`: Databento dataset, default `GLBX.MDP3`
- `live.schema`: Databento bar schema, default `ohlcv-1m`
- `live.stypeIn`: Databento symbology type, default `continuous`
- `live.pythonBin`: Python binary used for the Databento live-stream process
- `live.liveCachePath`: atomic JSON cache written by the one shared live-feed process
- `live.maxLiveCandleAgeMinutes`: fail-closed freshness limit for new live bars
- `live.baseUrl`: legacy Polygon market-data API base URL
- `live.lookbackBars`: recent `1m` candles pulled per scan
- `live.pollIntervalMs`: scan interval
- `live.sessionWindows`: `Asia` and `London` time windows used for range detection

For a real feed, the API key must have an active live license for `GLBX.MDP3`:

```bash
python3 -m pip install -r requirements-live.txt
export DATABENTO_API_KEY=your_rotated_clean_key
cd lucid-nq-paper-trader
npm run trader:feed
npm run trader:watch
```

Use `npm run trader:watch:mock` when you want to replay the bundled fixture instead of querying Databento.

For a managed detached watcher on the VPS:

```bash
python3 -m pip install -r requirements-live.txt
export DATABENTO_API_KEY=your_rotated_clean_key
cd lucid-nq-paper-trader
npm run trader:watch:start
npm run trader:watch:status
```

Expose the live watcher to the website:

```bash
npm run trader:status:server
```

This serves `GET /api/live-status` from the VPS on port `3210` by default. To let the Vercel app read that live data, set:

```bash
LIVE_STATUS_SOURCE_URL=http://YOUR_VPS_PUBLIC_IP:3210/api/live-status
```

in the Vercel project environment, then redeploy. Without that bridge URL, the Vercel app can only show local/manual state.

For a private bridge, set the same long random `LIVE_STATUS_TOKEN` value on the VPS and in Vercel. The website then sends it as a bearer token. `GET /healthz` remains available for uptime checks without exposing strategy or account data.

The same status service also prepares a 2026 year-to-date NQ backtest when it starts and refreshes the cached report every 24 hours. Historical candles are requested from Databento in 30-day chunks, merged, and deduplicated before replay. It uses the VPS `DATABENTO_API_KEY`, exposes the protected report at `GET /api/backtest-results`, and lets the Vercel `/backtests` page display results without allowing public visitors to start paid historical-data requests. Set `BACKTEST_YEAR` to change the research year. Set `BACKTEST_REFRESH_MS` only when a different refresh interval is required; values shorter than one hour are rejected.

## Daily Reliability

The shared feed streams continuously while each watcher evaluates its live cache once per minute, persists a health heartbeat after every scan, writes state atomically, and preserves open trades and consumed signals across ordinary restarts. Use `RESET_LIVE_STATE=1` only when you intentionally want to clear transient signal state.

For a Linux VPS, the service templates in `deploy/systemd` keep both watchers and the status bridge alive across crashes and reboots. Adjust `/opt/doctortrades/trading` if your checkout lives elsewhere, create a private `/etc/doctortrades/trading.env` file outside the repository, then install and enable:

```bash
sudo cp deploy/systemd/doctortrades-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now doctortrades-feed
sudo systemctl enable --now doctortrades-watcher@live-9am-sweep
sudo systemctl enable --now doctortrades-watcher@hourly-sweep-ifvg-bos
sudo systemctl enable --now doctortrades-watcher@nq-opening-range-breakout
sudo systemctl enable --now doctortrades-watcher@ema-20-60-momentum
sudo systemctl enable --now doctortrades-watcher@volume-poc-reversion
sudo systemctl enable --now doctortrades-watcher@nq-15m-opening-range-retest
sudo systemctl enable --now doctortrades-status
```

The dashboard treats a heartbeat older than three polling intervals as stale and keeps the last good remote snapshot for up to 15 minutes when the bridge briefly fails.

## Cloud Journal and Operator Access

The protected cloud journal uses any Neon-compatible serverless Postgres connection. Add these environment values to the Vercel project and redeploy:

```bash
DATABASE_URL=postgresql://...
TRADING_ADMIN_TOKEN=a-long-random-passcode-at-least-20-characters
```

The table is created lazily by the app; `deploy/sql/001_cloud_journal.sql` is also provided for an explicit migration. Operator sessions use an HTTP-only, secure, same-site cookie, and every journal route repeats authorization close to the database operation. The passcode is never stored in browser JavaScript.

## Monitoring and Alerts

- `GET /api/health` returns `200` only when the bridge and all watchers are healthy, otherwise `503` for an uptime monitor.
- Vercel Web Analytics and Speed Insights are included in the root layout.
- API routes emit structured request logs without setup or candle payloads.
- Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to `.env.local` (or the VPS environment file) to receive only filled-trade and trade-closed alerts directly in Telegram. A detected setup does not alert until its paper entry actually fills. The close alert includes the new learning version and next-trade risk ceiling; feed failures, recoveries, idle scans, and rejected/unfilled signals stay in private logs/dashboard state. `TELEGRAM_CHANNEL_ID` can be used instead of `TELEGRAM_CHAT_ID`; forum topics can also set `TELEGRAM_MESSAGE_THREAD_ID`.
- The watcher automatically loads `.env.local`, while the managed launcher also exports it before startup. Populated environment files are ignored by Git and the token is never written to watcher logs.
- All `.env` and `*.example` files are ignored by Git. Keep populated local and VPS environment files private and configure Vercel secrets in Project Settings.

The managed starter refuses to launch a fake "live" process when `DATABENTO_API_KEY` is missing. If you intentionally want fixture replay mode, use:

```bash
cd lucid-nq-paper-trader
ALLOW_MOCK=1 npm run trader:watch:start
```

The live feed uses Databento's streaming client and rejects caches not explicitly marked `mode: live`; it never falls back to the Historical API. Each live tick:

1. pulls the latest `1m` candles
2. computes the `Asia` and `London` highs/lows
3. waits until `9:00 AM America/New_York`
4. detects a sweep of one of those pools
5. confirms a `1m` `FVG` reversal
6. builds the paper-trade plan from the `50k` / `10%` drawdown model
7. runs the market-regime, performance, and risk-guard bots; risk is bounded to 50–100% of the configured cap and the daily loss/account floor can pause new paper trades
8. keeps tracking the trade until stop or targets finish it, then journals the result into `state.json`

## Git Launch

Initialize this folder as its own repo:

```bash
cd lucid-nq-paper-trader
git init
git add .
git commit -m "Initial commit"
```

Then connect GitHub and push:

```bash
cd lucid-nq-paper-trader
git remote add origin <your-github-repo-url>
git branch -M main
git push -u origin main
```

After that, import the GitHub repo into Vercel and deploy it as a normal Next.js project.

## CSV Format

Use a simple candle file with:

```text
timestamp,open,high,low,close
```

Price columns must be numeric. Timestamps are used only for reporting.

## What Gets Tracked

- balance after each journaled trade
- starting bankroll, drawdown floor, and remaining drawdown room
- realized PnL
- R-multiple
- maximum favorable and adverse excursion for new replayed/journaled trades
- whether the setup passed the `9AM` / session-reference / liquidity-sweep / reaction / `1m FVG` rule check
- which targets filled
- whether the stop or end-of-data closed the trade

## State File

- `state.json` is intentionally ignored by Git so your local paper journal does not get shipped with the web app
- the deployed Vercel app keeps browser-side journal state in `localStorage`

## Next Useful Upgrade

Add a managed identity provider such as Clerk when the dashboard needs multiple operators, role-based access, password recovery, or MFA. The built-in operator session is intentionally scoped to a single trusted operator.
