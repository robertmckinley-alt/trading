'use client';

import { useState } from 'react';

const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);

function EquityChart({ trades, dates, label }) {
  const daily = new Map(dates.map((date) => [date, 0]));
  for (const trade of trades) daily.set(trade.date, (daily.get(trade.date) || 0) + Number(trade.realizedPnlUsd || 0));
  const series = [{ date: 'Start', value: 0 }];
  for (const [date, pnl] of [...daily].sort(([a], [b]) => a.localeCompare(b))) series.push({ date, value: series.at(-1).value + pnl });
  const cumulative = series.at(-1).value;
  const low = Math.min(0, ...series.map((p) => p.value));
  const high = Math.max(1, ...series.map((p) => p.value));
  const y = (v) => 22 + (high - v) / (high - low) * 180;
  const points = series.map((p, i) => `${72 + i / Math.max(1, series.length - 1) * 710},${y(p.value)}`).join(' ');
  return <figure className="orb-equity">
    <figcaption>{label} · closed-trade cumulative net P&amp;L</figcaption>
    <svg viewBox="0 0 810 240" role="img" aria-label={`${label}. Net P&L ${money(cumulative)}. ${trades.length} simulated trades.`}>
      {[high, 0, ...(low < 0 ? [low] : [])].map((value, index) => <g key={index}>
        <line x1="72" x2="782" y1={y(value)} y2={y(value)} stroke="var(--line)" />
        <text x="65" y={y(value) + 4} textAnchor="end" fill="var(--muted)" fontSize="12">{money(value)}</text>
      </g>)}
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      <text x="72" y="230" fill="var(--muted)" fontSize="12">{series[1]?.date || 'No sessions'}</text>
      <text x="782" y="230" textAnchor="end" fill="var(--muted)" fontSize="12">{series.at(-1).date}</text>
    </svg>
  </figure>;
}

function OrbTrial({ result, trial, strategy }) {
  const [month, setMonth] = useState('');
  const allTrades = strategy.research?.trades || [];
  const filtered = allTrades.filter((trade) => !month || trade.date?.startsWith(month));
  const metrics = trial.fixedRisk;
  const research = strategy.research || {};
  const oneContract = research.mode === 'fixed-contract';
  const curveLabel = oneContract ? 'One-contract research' : 'Previous risk-capped research';
  return <article className="orb-lab panel orb-trial" id={trial.slug} aria-labelledby={`${trial.slug}-title`}>
    <div className="section-heading"><div><span className="section-kicker">Separate ORB experiment</span><h2 id={`${trial.slug}-title`}>{trial.name}</h2></div><a href="#orb-learning-title">Back to comparison ↑</a></div>
    <p>{oneContract ? 'One NQ contract per eligible signal. No dollar risk cap and no accumulated loss cutoff. Actual stops, slippage and commissions apply. The entire contract exits at the first target; dollar risk varies with stop width.' : 'Previous risk-capped run: the $500 sizing ceiling rejected wide-stop setups. These results do not represent the new one-contract test.'}</p>
    <dl className="backtest-metrics">
      <div><dt>Signals found</dt><dd>{research.signals ?? strategy.signals}</dd></div>
      <div><dt>Sizing rejections</dt><dd>{research.rejectedSignals || 0}</dd></div>
      <div><dt>Unfilled orders</dt><dd>{research.notFilled || 0}</dd></div>
      <div><dt>Dates with research trades</dt><dd>{metrics.daysWithTrades}</dd></div>
    </dl>
    {research.rejectedSignals > 0 && <p className="backtest-disclosure">{research.rejectedSignals} of {research.signals} detected signals could not pass position sizing and risk limits. A small trade count does not mean that history was not processed. This saved result used a dollar sizing cap. An updated VPS run is required to evaluate these setups with one contract.</p>}
    {Object.keys(strategy.research?.filterChecks || {}).length > 0 && <details><summary>Filtered breakout checks and missing warmup</summary><ul>{Object.entries(strategy.research.filterChecks).map(([reason, count]) => <li key={reason}>{count} checks: {reason}</li>)}</ul><p>Counts are confirmation checks, not unique trading days.</p></details>}
    <dl className="backtest-metrics">
      <div><dt>Simulated net P&amp;L</dt><dd>{money(metrics?.netPnlUsd)}</dd></div>
      <div><dt>Closed-trade drawdown</dt><dd>{money(metrics?.maxDrawdownUsd)}</dd></div>
      <div><dt>Simulated trades</dt><dd>{metrics?.trades || 0}</dd></div>
      <div><dt>Research P&amp;L at double costs</dt><dd>{money(trial.doubledCosts?.netPnlUsd)}</dd></div>
    </dl>
    <EquityChart trades={allTrades} dates={result.provenance?.tradingDates || []} label={`${trial.name}: ${curveLabel}`} />
    <div className="orb-table-wrap"><table><caption>Separate annual research results</caption><thead><tr><th>Year</th><th>Trades</th><th>Net P&amp;L</th><th>Drawdown</th><th>Worst month</th></tr></thead><tbody>{trial.annual.map((year) => <tr key={year.year}><th>{year.year}{year.completeCalendarYear ? '' : ' (partial)'}</th><td>{year.trades}</td><td>{money(year.netPnlUsd)}</td><td>{money(year.maxDrawdownUsd)}</td><td>{money(year.worstMonthPnlUsd)}</td></tr>)}</tbody></table></div>

    <div className="orb-account-summary"><strong>Separate account with drawdown guard</strong><p>{strategy.metrics.trades} trades · net P&amp;L {money(strategy.metrics.netPnlUsd)} · closed-trade drawdown {money(strategy.metrics.maxDrawdownUsd)} · {strategy.rejectedSignals || 0} signals rejected by risk limits.</p></div>
    <details><summary>View guarded account curve</summary><EquityChart trades={strategy.trades || []} dates={result.provenance?.tradingDates || []} label={`${trial.name}: guarded account`} /></details>
    {Object.keys(research.unfilledReasons || {}).length > 0 && <details><summary>Why orders did not fill</summary><ul>{Object.entries(research.unfilledReasons).map(([reason, count]) => <li key={reason}>{count}: {reason}</li>)}</ul></details>}
    {research.signalAudit && <details><summary>Audit every detected signal ({research.signalAudit.length})</summary><div className="orb-table-wrap"><table><thead><tr><th>Date</th><th>Side</th><th>Signal entry</th><th>Structural stop</th><th>Stop width</th><th>Outcome</th><th>Net P&amp;L</th></tr></thead><tbody>{research.signalAudit.map((signal) => <tr key={`${signal.date}-${signal.detectedAt}`}><th>{signal.date}</th><td>{signal.side}</td><td>{signal.entry}</td><td>{signal.stop}</td><td>{signal.stopDistancePoints.toFixed(2)} pts</td><td>{signal.status}: {signal.reason}</td><td>{signal.status === 'not-filled' ? 'Unfilled' : money(signal.netPnlUsd)}</td></tr>)}</tbody></table></div></details>}
    <details><summary>Inspect simulated trades</summary>
      <label className="orb-month">Filter by month<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
      <div className="orb-table-wrap"><table><thead><tr><th>Date</th><th>Side</th><th>Contracts</th><th>Entry</th><th>Exit</th><th>Net P&amp;L</th></tr></thead><tbody>{filtered.map((trade) => <tr key={trade.id}><th>{trade.date}</th><td>{trade.side}</td><td>{trade.contracts}</td><td>{trade.entry}</td><td>{trade.exitReason}</td><td>{money(trade.realizedPnlUsd)}</td></tr>)}</tbody></table></div>
      {!filtered.length && <p>No simulated trades in this selection.</p>}
    </details>
  </article>;
}

export default function OrbLearningPanel({ result }) {
  const learning = result.learning;
  if (!learning) return <aside className="backtest-disclosure">This saved report predates the ORB learning engine. Comparisons will appear after an updated VPS run completes.</aside>;
  const trials = learning.trials.map((trial) => ({ trial, strategy: result.strategies.find((item) => item.slug === trial.slug) })).filter((item) => item.strategy);
  const candidate = learning.trials.find((item) => item.slug === learning.candidate?.slug);
  const sequence = learning.sequenceRisk;
  return <div className="orb-trials">
    {result.orbResearchVersion !== 'one-contract-v1' && <aside className="backtest-disclosure"><strong>ORB correction awaiting a new VPS run.</strong> The previous $500 sizing cap excluded most valid setups. The results below are explicitly the old capped experiment. New research will test one NQ contract per eligible signal with no dollar loss cap.</aside>}
    <section className="orb-lab panel" aria-labelledby="orb-learning-title">
      <div className="section-heading"><div><span className="section-kicker">All experiments visible</span><h2 id="orb-learning-title">ORB comparison</h2></div><span>{trials.length} close-confirmation trials</span></div>
      <p>{candidate ? `Research candidate: ${candidate.name}. Freeze its rules before starting a new forward paper test.` : 'No candidate has cleared all research checks yet. The simulation is complete; qualification is a separate decision.'}</p>
      <p>Historical simulations do not count toward 50 verified forward-paper trades. Each row is an independent experiment, so their profits must not be added together as a portfolio.</p>
      <div className="orb-table-wrap"><table><caption>{result.orbResearchVersion === 'one-contract-v1' ? 'One-contract research results' : 'Previous risk-capped results'} · Select a name to jump to its chart and trades.</caption><thead><tr><th>Experiment</th><th>Signals</th><th>Risk rejected</th><th>Trades</th><th>Net P&amp;L</th><th>Win rate</th><th>Drawdown</th></tr></thead><tbody>{trials.map(({ trial, strategy }) => <tr key={trial.slug}><th><a href={`#${trial.slug}`}>{trial.name}</a></th><td>{strategy.research?.signals ?? strategy.signals}</td><td>{strategy.research?.rejectedSignals || 0}</td><td>{trial.fixedRisk.trades}</td><td>{money(trial.fixedRisk.netPnlUsd)}</td><td>{trial.fixedRisk.trades ? `${trial.fixedRisk.winRate}%` : 'No trades'}</td><td>{money(trial.fixedRisk.maxDrawdownUsd)}</td></tr>)}</tbody></table></div>
      {learning.blockers.length > 0 && <details><summary>Why no candidate qualified ({learning.blockers.length})</summary><ul>{learning.blockers.map((item) => <li key={item}>{item}</li>)}</ul></details>}
    <details><summary>Monthly selection: train six months, test the next month</summary>
      <p>Each choice uses only its preceding training period. These are retrospective comparisons; earlier research has already influenced the trial definitions.</p>
      <div className="orb-table-wrap"><table><thead><tr><th>Test month</th><th>Chosen experiment</th><th>Trades</th><th>Net P&amp;L</th><th>Double costs</th></tr></thead><tbody>{learning.walkForward.folds.map((fold) => <tr key={fold.testStart}><th>{fold.testStart.slice(0, 7)}</th><td>{learning.trials.find((item) => item.slug === fold.selectedSlug)?.name || 'No qualifying choice'}</td><td>{fold.test.trades}</td><td>{money(fold.test.netPnlUsd)}</td><td>{money(fold.doubledCosts?.netPnlUsd)}</td></tr>)}</tbody></table></div>
      {sequence?.status === 'retrospective-resampling' && <p>Across 250 resampled scenarios, median drawdown was {money(sequence.maxDrawdownUsd.p50)} and the 95th-percentile drawdown was {money(sequence.maxDrawdownUsd.p95)}. These scenarios describe sequence risk, not a forecast or a loss limit.</p>}
    </details>
    <details><summary>Data coverage and research version</summary><p>Run {result.generatedAt}. Trial fingerprint {learning.manifestHash.slice(0, 12)}. {learning.coverage.scope}</p><ul>{learning.coverage.issues.map((item, index) => <li key={index}>{item}</li>)}</ul><p>Research summaries are saved on the VPS for comparison across daily runs.</p></details>
    </section>
    {trials.map(({ trial, strategy }) => <OrbTrial key={trial.slug} result={result} trial={trial} strategy={strategy} />)}
  </div>;
}
