import fs from 'fs';
import path from 'path';
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

      <TraderDashboard
        initialConfig={config}
        initialSetupText={sampleSetup}
        initialCsvText={sampleCsv}
      />
    </main>
  );
}
