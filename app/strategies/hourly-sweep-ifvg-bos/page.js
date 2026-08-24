import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import LiveStrategyBoard from '../../../components/live-strategy-board';
import TraderDashboard from '../../../components/trader-dashboard';
import { getStrategySnapshots } from '../../../lib/live-status.cjs';
import { normalizeConfig } from '../../../lib/trader-core.cjs';

function readFile(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

export default async function HourlySweepIfvgBosPage() {
  const config = normalizeConfig(JSON.parse(readFile('config.json')));
  const sampleSetup = readFile('examples/hourly-sweep-ifvg-bos.setup.json');
  const sampleCsv = readFile('examples/sample-nq-1m.csv');
  const liveStatus = await getStrategySnapshots();

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">1H Sweep + iFVG + 1M BOS</p>
          <h1>Package the new clip as its own public route.</h1>
          <p className="hero-lede">
            This setup is different from the live 9AM Asia or London build. It starts from 1-hour highs and lows, drops into
            5 minutes for the sweep and fair value gap, then waits for 1-minute structure to break back in the original direction before entry.
          </p>
          <div className="hero-badges">
            <span>Fresh {config.startingBalanceUsd.toLocaleString()} USD bankroll</span>
            <span>{config.maxAccountDrawdownPercent}% max drawdown</span>
            <span>Built from the new clip</span>
          </div>
          <div className="hero-actions">
            <Link className="ghost-link" href="/">
              Back to homepage lab
            </Link>
            <Link className="secondary-link" href="/strategies/live-9am-sweep">
              Compare 9AM live route
            </Link>
          </div>
        </div>
        <div className="hero-card">
          <p className="eyebrow">Clip sequence</p>
          <ul className="hero-list">
            <li>Mark 1-hour highs and lows</li>
            <li>Scale into the 5-minute chart</li>
            <li>Wait for the sweep of high or low</li>
            <li>Mark the fair value gap and inverse reaction</li>
            <li>Wait for 1-minute BOS confirmation</li>
            <li>Enter back in the original direction toward liquidity</li>
          </ul>
        </div>
      </section>

      <section className="strategy-strip">
        <article className="strategy-card">
          <p className="eyebrow">What changed</p>
          <h2>Less session-specific, more structure-specific.</h2>
          <p className="strategy-copy">
            The 9AM watcher depends on Asia and London levels plus a timed activation window. This route is broader: hourly liquidity first, then multi-timeframe confirmation.
          </p>
        </article>
        <article className="strategy-card strategy-card-accent">
          <p className="eyebrow">Current scope</p>
          <h2>Public route now, automation logic next if needed.</h2>
          <p className="strategy-copy">
            This route ships with its own sample setup JSON and now keeps its own browser-local paper account, so its bankroll and journal stay separate from the homepage and 9AM route.
          </p>
        </article>
      </section>

      <LiveStrategyBoard initialData={liveStatus} />

      <TraderDashboard
        initialConfig={config}
        initialSetupText={sampleSetup}
        initialCsvText={sampleCsv}
        storageKey="lucid-nq-paper-trader-hourly-sweep-ifvg-bos-journal-v1"
      />
    </main>
  );
}
