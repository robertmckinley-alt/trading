import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import TraderDashboard from '../../../components/trader-dashboard';
import { normalizeConfig } from '../../../lib/trader-core.cjs';

function readFile(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

export default function LiveNineAmSweepPage() {
  const config = normalizeConfig(JSON.parse(readFile('config.json')));
  const sampleSetup = readFile('examples/lucid-sweep-short.setup.json');
  const liveFixture = readFile('examples/live-signal-nq-1m.csv');

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Live 9AM Sweep Strategy</p>
          <h1>Separate the always-on strategy from the replay lab.</h1>
          <p className="hero-lede">
            This route is the live-facing version of the same NQ playbook: build Asia and London session ranges,
            wait for the 9:00 AM New York sweep, confirm the 1-minute FVG reversal, and map targets into the next draw on liquidity.
          </p>
          <div className="hero-badges">
            <span>Watcher loop ready</span>
            <span>Same {config.startingBalanceUsd.toLocaleString()} USD model</span>
            <span>{config.maxAccountDrawdownPercent}% max drawdown</span>
          </div>
          <div className="hero-actions">
            <Link className="ghost-link" href="/">
              Back to homepage lab
            </Link>
          </div>
        </div>
        <div className="hero-card">
          <p className="eyebrow">Strategy shape</p>
          <ul className="hero-list">
            <li>Auto-detect Asia and London highs or lows</li>
            <li>Activate only after 9:00 AM America/New_York</li>
            <li>Confirm the sweep with a 1-minute FVG reversal</li>
            <li>Keep one paper trade alive until stop or liquidity target</li>
          </ul>
        </div>
      </section>

      <section className="strategy-strip">
        <article className="strategy-card">
          <p className="eyebrow">Why this page exists</p>
          <h2>Cleaner public link from the same Vercel app.</h2>
          <p className="strategy-copy">
            You can now send people the homepage for the manual sandbox or this strategy route for the live auto-detection version without splitting repos.
          </p>
        </article>
        <article className="strategy-card strategy-card-accent">
          <p className="eyebrow">Fixture mode</p>
          <h2>Loaded with the live-signal session sample.</h2>
          <p className="strategy-copy">
            The editor below starts from the full-session mock fixture that was built for the VPS watcher, so this route reflects the live loop more closely than the homepage sample.
          </p>
        </article>
      </section>

      <TraderDashboard
        initialConfig={config}
        initialSetupText={sampleSetup}
        initialCsvText={liveFixture}
        storageKey="lucid-nq-paper-trader-live-9am-sweep-journal-v1"
      />
    </main>
  );
}
