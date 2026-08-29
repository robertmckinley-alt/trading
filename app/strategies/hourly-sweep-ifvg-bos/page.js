import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import LiveStrategyBoard from '../../../components/live-strategy-board';
import TraderDashboard from '../../../components/trader-dashboard';
import { getStrategySnapshots } from '../../../lib/live-status.cjs';
import { normalizeConfig } from '../../../lib/trader-core.cjs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HourlySweepIfvgBosPage() {
  const config = normalizeConfig(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')));
  const sampleSetup = fs.readFileSync(path.join(process.cwd(), 'examples', 'hourly-sweep-ifvg-bos.setup.json'), 'utf8');
  const sampleCsv = fs.readFileSync(path.join(process.cwd(), 'examples', 'sample-nq-1m.csv'), 'utf8');
  const liveStatus = await getStrategySnapshots();

  return (
    <main className="page-shell" id="main-content">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Strategy B · Hourly iFVG</p>
          <h1>Hourly liquidity with lower-timeframe confirmation.</h1>
          <p className="hero-lede">
            This setup is different from the live 9AM Asia or London build. It starts from 1-hour highs and lows, drops into
            5 minutes for the sweep and fair value gap, then waits for 1-minute structure to break back in the original direction before entry.
          </p>
          <div className="hero-badges">
            <span>{config.startingBalanceUsd.toLocaleString()} USD account</span>
            <span>{config.maxAccountDrawdownPercent}% max drawdown</span>
            <span>Automated watcher</span>
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
          <p className="eyebrow">Entry checklist</p>
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
          <p className="eyebrow">Signal model</p>
          <h2>Less session-specific, more structure-specific.</h2>
          <p className="strategy-copy">
            The 9AM watcher depends on Asia and London levels plus a timed activation window. This route is broader: hourly liquidity first, then multi-timeframe confirmation.
          </p>
        </article>
        <article className="strategy-card strategy-card-accent">
          <p className="eyebrow">Account separation</p>
          <h2>Independent balance, watcher, and journal.</h2>
          <p className="strategy-copy">
            This route keeps its bankroll and journal separate from the 9AM strategy so performance and drawdown remain attributable.
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
