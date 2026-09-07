import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import AppHeader from '../components/app-header';
import LiveStrategyBoard from '../components/live-strategy-board';
import { getStrategySnapshots } from '../lib/live-status.cjs';
import { STRATEGIES } from '../lib/strategy-registry.cjs';
import { normalizeConfig } from '../lib/trader-core.cjs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HomePage() {
  const config = normalizeConfig(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')));
  const liveStatus = await getStrategySnapshots();

  return (
    <main className="page-shell command-page" id="main-content">
      <AppHeader section="Live paper operations" />

      <section className="command-hero">
        <div>
          <p className="eyebrow">Live operations · eight independent paper accounts</p>
          <h1>See what matters. Act on what changed.</h1>
          <p>
            A focused view of system health, portfolio performance, current risk, and every strategy running on the shared NQ feed.
          </p>
          <div className="hero-actions">
            <Link className="primary-link" href="/orb">Open ORB forward lab</Link>
            <Link className="secondary-link" href="/comparison">Compare historical results</Link>
          </div>
        </div>
        <aside className="command-hero-summary" aria-label="Paper account structure">
          <span>Capital framework</span>
          <strong>${(config.startingBalanceUsd * STRATEGIES.length).toLocaleString()}</strong>
          <p>{STRATEGIES.length} × ${config.startingBalanceUsd.toLocaleString()} independent paper accounts</p>
          <dl>
            <div><dt>Trade cap</dt><dd>${config.maxRiskPerTradeUsd.toLocaleString()}</dd></div>
            <div><dt>Network cap</dt><dd>${config.maxPortfolioOpenRiskUsd.toLocaleString()}</dd></div>
          </dl>
        </aside>
      </section>

      <div id="strategy-network">
        <LiveStrategyBoard compact initialData={liveStatus} />
      </div>

      <section className="workspace-links" aria-labelledby="workspace-links-title">
        <div className="workspace-links-head">
          <div><span className="section-kicker">Research workspaces</span><h2 id="workspace-links-title">Go deeper without crowding the live board.</h2></div>
          <p>Live execution, forward evidence, and retrospective simulations remain clearly separated.</p>
        </div>
        <div className="workspace-link-grid">
          <Link href="/orb"><span>Forward paper</span><strong>ORB Lab</strong><p>Nine isolated $50,000 accounts and their verified-trade progress.</p><i>Open lab →</i></Link>
          <Link href="/backtests"><span>Historical research</span><strong>All Backtests</strong><p>Inspect every strategy, trade count, P&amp;L, and drawdown.</p><i>View results →</i></Link>
          <Link href="/comparison"><span>Benchmarking</span><strong>Strategy Comparison</strong><p>Measure each model against NQ buy-and-hold approximations.</p><i>Compare →</i></Link>
          <Link href="/research"><span>Evidence controls</span><strong>Research Lab</strong><p>Review qualification gates, holdouts, and strategy memory.</p><i>Review evidence →</i></Link>
        </div>
      </section>

      <footer className="command-footer">
        <strong>Paper trading only.</strong>
        <span>Simulated fills, modeled slippage, and historical results do not establish future profitability.</span>
      </footer>
    </main>
  );
}
