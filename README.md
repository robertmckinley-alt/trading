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
- the journal is stored in browser `localStorage`, not the server filesystem
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

- the deployed Vercel app keeps journal history in the browser, so trades persist per browser/profile
- the CLI still writes durable local trades into `state.json`
- the always-on live watcher should run on your VPS, not inside Vercel

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
```

## Live Feed Config

The live watcher reads its feed settings from `config.json` plus environment variables.

Key live fields:

- `live.provider`: `mock` or `polygon-futures`
- `live.ticker`: futures contract to poll, for example `NQU6`
- `live.mockCsvPath`: fixture path used in mock mode
- `live.apiKeyEnv`: env var name that stores the real market-data key
- `live.baseUrl`: market-data API base URL
- `live.lookbackBars`: recent `1m` candles pulled per scan
- `live.pollIntervalMs`: scan interval
- `live.sessionWindows`: `Asia` and `London` time windows used for range detection

For a real feed:

```bash
export LIVE_DATA_API_KEY=your_rotated_clean_key
cd lucid-nq-paper-trader
npm run trader:watch
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
- whether the setup passed the `9AM` / session-reference / liquidity-sweep / reaction / `1m FVG` rule check
- which targets filled
- whether the stop or end-of-data closed the trade

## State File

- `state.json` is intentionally ignored by Git so your local paper journal does not get shipped with the web app
- the deployed Vercel app keeps browser-side journal state in `localStorage`

## Next Useful Upgrade

The fastest next step would be one of these:

1. expose the VPS watcher state to the Vercel UI through a small external store or webhook
2. add TradingView export compatibility if your CSV format differs
3. add alert delivery when a live setup triggers
