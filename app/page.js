import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import LiveStrategyBoard from '../components/live-strategy-board';
import TraderDashboard from '../components/trader-dashboard';
import { getStrategySnapshots } from '../lib/live-status.cjs';
import { STRATEGIES } from '../lib/strategy-registry.cjs';
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
          <Link href="/research">Research Lab</Link>
          <Link href="/backtests">Backtest Results</Link>
          <Link href="#strategy-network">Strategy network</Link>
          <Link href="#research-method">Research method</Link>
        </nav>
      </header>

      <section className="dashboard-intro">
        <div>
          <p className="eyebrow">Six-bot NQ paper research network</p>
          <h1>Compare strategies under the same risk rules.</h1>
          <p>
            Every bot receives the same live feed, $500 per-trade cap, $2,500 shared open-risk guard, correlated-strategy family limits, daily loss protection, slippage, and commission model. Results stay separated so weak ideas can be retired without hiding their losses.
          </p>
        </div>
        <dl className="risk-guardrails" aria-label="Account risk guardrails">
          <div><dt>Paper allocation</dt><dd>${(config.startingBalanceUsd * STRATEGIES.length).toLocaleString()}</dd></div>
          <div><dt>Max drawdown</dt><dd>{config.maxAccountDrawdownPercent}% per account</dd></div>
          <div><dt>Trade risk cap</dt><dd>${config.maxRiskPerTradeUsd.toLocaleString()}</dd></div>
          <div><dt>Network risk cap</dt><dd>${config.maxPortfolioOpenRiskUsd.toLocaleString()}</dd></div>
        </dl>
      </section>

      <div id="strategy-network">
        <LiveStrategyBoard initialData={liveStatus} />
      </div>

      <section className="research-method" id="research-method" aria-labelledby="research-method-title">
        <div>
          <span className="section-kicker">Research controls</span>
          <h2 id="research-method-title">Promotion is earned with forward paper evidence.</h2>
          <p>
            Repository claims are treated as hypotheses. A bot must collect at least 50 closed paper trades across 20 trading days, maintain positive expectancy and average R, reach a 1.20 profit factor, and keep drawdown within the test limit before it can be labeled a paper candidate.
          </p>
        </div>
        <ol className="research-steps">
          <li><strong>Reproduce</strong><span>Translate only licensed or independently described rules.</span></li>
          <li><strong>Forward test</strong><span>Use the shared live feed and identical cost model.</span></li>
          <li><strong>Keep or retire</strong><span>Score every result; never hide failed strategies.</span></li>
        </ol>
      </section>

      <section className="shadow-research" aria-labelledby="shadow-research-title">
        <div>
          <span className="section-kicker">Shadow research</span>
          <h2 id="shadow-research-title">Power of Three stays observational until its rules are exact.</h2>
          <p>
            The video concept is being treated as accumulation, manipulation, and distribution context—not as an executable strategy. It cannot open trades until trend, confirmation, stop, target, timeframe, and session rules are specified and tested.
          </p>
        </div>
        <dl className="shadow-research-facts">
          <div><dt>Execution</dt><dd>Disabled</dd></div>
          <div><dt>Current use</dt><dd>Context tagging</dd></div>
          <div><dt>Promotion path</dt><dd>Rule spec → replay → forward paper</dd></div>
        </dl>
      </section>

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
