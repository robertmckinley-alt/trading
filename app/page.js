import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import TraderDashboard from '../components/trader-dashboard';
import { normalizeConfig } from '../lib/trader-core.cjs';

function readFile(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

export default function HomePage() {
  const config = normalizeConfig(JSON.parse(readFile('config.json')));
  const sampleSetup = readFile('examples/lucid-sweep-short.setup.json');
  const sampleCsv = readFile('examples/sample-nq-1m.csv');

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">DoctorTrades NQ Sandbox</p>
          <h1>Ship the clip strategy to Vercel without losing the trading logic.</h1>
          <p className="hero-lede">
            This web build keeps the exact paper-trader contract: 9:00 AM New York, mark Asia and London highs or lows,
            wait for the sweep, drop to 1 minute, take the FVG reversal, stop at the swing extreme, and aim for the next draw on liquidity.
          </p>
          <div className="hero-badges">
            <span>Bankroll {config.startingBalanceUsd.toLocaleString()} USD</span>
            <span>Max drawdown {config.maxAccountDrawdownPercent}%</span>
            <span>Per-trade cap {config.maxRiskPerTradeUsd} USD</span>
          </div>
          <div className="hero-actions">
            <Link className="primary-link" href="/strategies/live-9am-sweep">
              Open live strategy build
            </Link>
            <Link className="secondary-link" href="/strategies/hourly-sweep-ifvg-bos">
              Open 1H sweep route
            </Link>
          </div>
        </div>
        <div className="hero-card">
          <p className="eyebrow">Deploy shape</p>
          <ul className="hero-list">
            <li>Next.js app router</li>
            <li>Stateless server routes for plan and replay</li>
            <li>Browser-local journal for Vercel-safe persistence</li>
            <li>Same validated config and sample data from the CLI build</li>
          </ul>
        </div>
      </section>

      <section className="strategy-strip">
        <article className="strategy-card">
          <p className="eyebrow">Manual lab</p>
          <h2>Replay and journal the clip setup.</h2>
          <p className="strategy-copy">
            Use the JSON and CSV editors below to validate entries, replay candles, and keep a browser-local paper journal.
          </p>
        </article>
        <article className="strategy-card strategy-card-accent">
          <p className="eyebrow">Always-on route</p>
          <h2>Spin out the live watcher as its own page.</h2>
          <p className="strategy-copy">
            The live strategy page mirrors the same 9AM Asia or London sweep logic, but frames it around the VPS watcher and auto-detected signals.
          </p>
          <Link className="secondary-link" href="/strategies/live-9am-sweep">
            View live strategy page
          </Link>
        </article>
        <article className="strategy-card">
          <p className="eyebrow">New clip route</p>
          <h2>Break out the 1H sweep plus iFVG entry model.</h2>
          <p className="strategy-copy">
            The latest video uses hourly highs and lows, a 5-minute sweep, and a 1-minute BOS confirmation. This route keeps that flow separate from the 9AM session watcher.
          </p>
          <Link className="secondary-link" href="/strategies/hourly-sweep-ifvg-bos">
            View 1H sweep route
          </Link>
        </article>
      </section>

      <TraderDashboard
        initialConfig={config}
        initialSetupText={sampleSetup}
        initialCsvText={sampleCsv}
        storageKey="lucid-nq-paper-trader-home-journal-v1"
      />
    </main>
  );
}
