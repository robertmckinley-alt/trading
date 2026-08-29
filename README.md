# DoctorTrades NQ Paper Trader

This folder now contains both:

1. a local CLI paper trader
2. a Vercel-ready Next.js web app

Both are built around the literal flow spoken in the DoctorTrades clip: at `9:00 AM` New York time, mark the `Asia` and `London` highs/lows, wait for one of those pools to get swept, drop to the `1m` chart, take the `FVG` reversal back to the other side, set the stop at the swing extreme, and target the next draw on liquidity.

This is still not a live broker integration. It is a paper-trading sandbox for planning, replaying, detecting, and journaling the setup.

The live mode now adds:

- automatic `Asia` and `London` range detection from incoming `1m` candles
- automatic post-`9AM` sweep detection
- automatic `1m` `FVG` reversal signal generation
- always-on polling mode that keeps one live paper trade open at a time and journals the close

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
- the main page can now show both strategy cards plus outcomes, but Vercel needs a live status bridge to read the VPS watcher

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

- `live.provider`: `databento`, `mock`, or legacy `polygon-futures`
- `live.ticker`: futures symbol to poll, for example `NQ.v.0` for the front-month continuous Nasdaq contract on Databento
- `live.mockCsvPath`: fixture path used in mock mode
- `live.apiKeyEnv`: env var name that stores the real market-data key
- `live.dataset`: Databento dataset, default `GLBX.MDP3`
- `live.schema`: Databento bar schema, default `ohlcv-1m`
- `live.stypeIn`: Databento symbology type, default `continuous`
- `live.pythonBin`: Python binary used for the Databento helper
- `live.baseUrl`: legacy Polygon market-data API base URL
- `live.lookbackBars`: recent `1m` candles pulled per scan
- `live.pollIntervalMs`: scan interval
- `live.fetchTimeoutMs`: maximum time allowed for one Databento fetch
- `live.sessionWindows`: `Asia` and `London` time windows used for range detection

For a real feed:

```bash
python3 -m pip install -r requirements-live.txt
export DATABENTO_API_KEY=your_rotated_clean_key
cd lucid-nq-paper-trader
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

## Daily Reliability

The watcher now polls once per minute by default, persists a health heartbeat after every poll, writes state atomically, and preserves open trades and consumed signals across ordinary restarts. Use `RESET_LIVE_STATE=1` only when you intentionally want to clear transient signal state.

For a Linux VPS, the templates in `deploy/systemd` keep both watchers and the status bridge alive across crashes and reboots. Adjust `/opt/doctortrades/trading` if your checkout lives elsewhere, copy the environment example to `/etc/doctortrades/trading.env`, then install and enable:

```bash
sudo cp deploy/systemd/doctortrades-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now doctortrades-watcher@live-9am-sweep
sudo systemctl enable --now doctortrades-watcher@hourly-sweep-ifvg-bos
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
- Set `TRADING_ALERT_WEBHOOK_URL` on the VPS watcher to receive feed-failure, recovery, trade-opened, and trade-closed events. Add `TRADING_ALERT_WEBHOOK_TOKEN` when the receiver expects bearer authentication.
- Example environment values live in `deploy/vercel.env.example`.

The managed starter refuses to launch a fake "live" process when `DATABENTO_API_KEY` is missing. If you intentionally want fixture replay mode, use:

```bash
cd lucid-nq-paper-trader
ALLOW_MOCK=1 npm run trader:watch:start
```

Each live tick:

1. pulls the latest `1m` candles
2. computes the `Asia` and `London` highs/lows
3. waits until `9:00 AM America/New_York`
4. detects a sweep of one of those pools
5. confirms a `1m` `FVG` reversal
6. builds the paper-trade plan from the `50k` / `10%` drawdown model
7. keeps tracking the trade until stop or targets finish it, then journals the result into `state.json`

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
