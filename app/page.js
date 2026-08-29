import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import LiveStrategyBoard from '../components/live-strategy-board';
import TraderDashboard from '../components/trader-dashboard';
import { getStrategySnapshots } from '../lib/live-status.cjs';
import { normalizeConfig } from '../lib/trader-core.cjs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HomePage() {
  const config = normalizeConfig(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')));
  const sampleSetup = fs.readFileSync(path.join(process.cwd(), 'examples', 'lucid-sweep-short.setup.json'), 'utf8');
  const sampleCsv = fs.readFileSync(path.join(process.cwd(), 'examples', 'sample-nq-1m.csv'), 'utf8');
  const liveStatus = await getStrategySnapshots();

  return (
    <main className="page-shell" id="main-content">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">DT</span>
          <div>
            <strong>DoctorTrades</strong>
            <span>NQ paper trading</span>
          </div>
        </div>
        <nav className="app-nav" aria-label="Strategy navigation">
          <Link href="/strategies/live-9am-sweep">9AM sweep</Link>
          <Link href="/strategies/hourly-sweep-ifvg-bos">Hourly iFVG</Link>
        </nav>
      </header>

      <section className="dashboard-intro">
        <div>
          <p className="eyebrow">Automated NQ paper strategies</p>
          <h1>Trading performance, risk, and live status in one place.</h1>
          <p>
            Monitor both strategy accounts, inspect daily outcomes, and drill into every journaled trade without leaving the dashboard.
          </p>
        </div>
        <dl className="risk-guardrails" aria-label="Account risk guardrails">
          <div><dt>Allocated capital</dt><dd>${(config.startingBalanceUsd * 2).toLocaleString()}</dd></div>
          <div><dt>Max drawdown</dt><dd>{config.maxAccountDrawdownPercent}% per account</dd></div>
          <div><dt>Trade risk cap</dt><dd>${config.maxRiskPerTradeUsd.toLocaleString()}</dd></div>
        </dl>
      </section>

      <LiveStrategyBoard initialData={liveStatus} />

      <section className="manual-workspace" aria-labelledby="manual-workspace-title">
        <div className="section-heading manual-workspace-head">
          <div>
            <span className="section-kicker">Replay lab</span>
            <h2 id="manual-workspace-title">Validate a setup against one-minute candles</h2>
          </div>
          <p>Plans and journal entries stay in this browser.</p>
        </div>
        <TraderDashboard
          initialConfig={config}
          initialSetupText={sampleSetup}
          initialCsvText={sampleCsv}
          storageKey="lucid-nq-paper-trader-live-9am-sweep-journal-v1"
        />
      </section>
    </main>
  );
}
