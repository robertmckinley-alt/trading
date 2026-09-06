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

export default function OrbLearningPanel({ result }) {
  const learning = result.learning;
  const [selected, setSelected] = useState('nq-15m-orb-close-confirmation');
  const [mode, setMode] = useState('research');
  const [month, setMonth] = useState('');
  if (!learning) return <aside className="backtest-disclosure">This saved report predates the ORB learning engine. The new comparisons will appear after an updated VPS run completes.</aside>;
  const trial = learning.trials.find((item) => item.slug === selected) || learning.trials[0];
  const strategy = result.strategies.find((item) => item.slug === trial?.slug);
  if (!trial || !strategy) return null;
  const allTrades = mode === 'research' ? strategy.research?.trades || [] : strategy.trades || [];
  const filtered = allTrades.filter((trade) => !month || trade.date?.startsWith(month));
  const metrics = mode === 'research' ? trial.fixedRisk : strategy.metrics;
  const candidate = learning.trials.find((item) => item.slug === learning.candidate?.slug);
  const sequence = learning.sequenceRisk;
  return <section className="orb-lab panel" aria-labelledby="orb-learning-title">
    <div className="section-heading">
      <div><span className="section-kicker">Versioned experiments · daily evaluation</span><h2 id="orb-learning-title">ORB Learning Lab</h2></div>
      <span>{learning.trials.length} recorded trials</span>
    </div>
    <p>{candidate ? `Research candidate: ${candidate.name}. Freeze its rules before starting a new forward paper test.` : 'No candidate has cleared all research checks yet. Every trial and its results remain visible below.'}</p>
    <p className="backtest-fill-note">2025 and 2026 comparisons are retrospective. Historical trades do not count toward the 50 verified forward-paper trades. Running strategies are not changed automatically.</p>
    {learning.blockers.length > 0 && <details><summary>What still needs evidence ({learning.blockers.length})</summary><ul>{learning.blockers.map((item) => <li key={item}>{item}</li>)}</ul></details>}
    <div className="orb-controls">
      <label>Experiment<select value={trial.slug} onChange={(e) => setSelected(e.target.value)}>{learning.trials.map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>)}</select></label>
      <label>Curve<select value={mode} onChange={(e) => setMode(e.target.value)}><option value="research">Fixed-risk research</option><option value="account">Account with drawdown guard</option></select></label>
    </div>
    <p>{mode === 'research' ? 'Shows eligible trades throughout history using the same risk ceiling, even after an account would have reached its loss limit.' : 'Shows this strategy’s separate account with the drawdown guard enforced. This is not a combined portfolio.'}</p>
    {Object.keys(strategy.research?.filterChecks || {}).length > 0 && <details><summary>Filtered breakout checks and missing warmup</summary><ul>{Object.entries(strategy.research.filterChecks).map(([reason, count]) => <li key={reason}>{count} checks: {reason}</li>)}</ul><p>Counts are confirmation checks, not unique trading days.</p></details>}
    <dl className="backtest-metrics">
      <div><dt>Simulated net P&amp;L</dt><dd>{money(metrics?.netPnlUsd)}</dd></div>
      <div><dt>Closed-trade drawdown</dt><dd>{money(metrics?.maxDrawdownUsd)}</dd></div>
      <div><dt>Simulated trades</dt><dd>{metrics?.trades || 0}</dd></div>
      <div><dt>Research P&amp;L at double costs</dt><dd>{money(trial.doubledCosts?.netPnlUsd)}</dd></div>
    </dl>
    <EquityChart trades={allTrades} dates={result.provenance?.tradingDates || []} label={mode === 'research' ? 'Fixed-risk research' : 'Guarded account'} />
    <div className="orb-table-wrap"><table><caption>Separate annual research results</caption><thead><tr><th>Year</th><th>Trades</th><th>Net P&amp;L</th><th>Drawdown</th><th>Worst month</th></tr></thead><tbody>{trial.annual.map((year) => <tr key={year.year}><th>{year.year}{year.completeCalendarYear ? '' : ' (partial)'}</th><td>{year.trades}</td><td>{money(year.netPnlUsd)}</td><td>{money(year.maxDrawdownUsd)}</td><td>{money(year.worstMonthPnlUsd)}</td></tr>)}</tbody></table></div>
    <details><summary>Monthly selection: train six months, test the next month</summary>
      <p>Each choice uses only its preceding training period. These are retrospective comparisons; earlier research has already influenced the trial definitions.</p>
      <div className="orb-table-wrap"><table><thead><tr><th>Test month</th><th>Chosen experiment</th><th>Trades</th><th>Net P&amp;L</th><th>Double costs</th></tr></thead><tbody>{learning.walkForward.folds.map((fold) => <tr key={fold.testStart}><th>{fold.testStart.slice(0, 7)}</th><td>{learning.trials.find((item) => item.slug === fold.selectedSlug)?.name || 'No qualifying choice'}</td><td>{fold.test.trades}</td><td>{money(fold.test.netPnlUsd)}</td><td>{money(fold.doubledCosts?.netPnlUsd)}</td></tr>)}</tbody></table></div>
      {sequence?.status === 'retrospective-resampling' && <p>Across 250 resampled scenarios, median drawdown was {money(sequence.maxDrawdownUsd.p50)} and the 95th-percentile drawdown was {money(sequence.maxDrawdownUsd.p95)}. These scenarios describe sequence risk, not a forecast or a loss limit.</p>}
    </details>
    <details><summary>Inspect simulated trades</summary>
      <label className="orb-month">Filter by month<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
      <div className="orb-table-wrap"><table><thead><tr><th>Date</th><th>Side</th><th>Contracts</th><th>Entry</th><th>Exit</th><th>Net P&amp;L</th></tr></thead><tbody>{filtered.map((trade) => <tr key={trade.id}><th>{trade.date}</th><td>{trade.side}</td><td>{trade.contracts}</td><td>{trade.entry}</td><td>{trade.exitReason}</td><td>{money(trade.realizedPnlUsd)}</td></tr>)}</tbody></table></div>
      {!filtered.length && <p>No simulated trades in this selection.</p>}
    </details>
    <details><summary>Data coverage and research version</summary><p>Run {result.generatedAt}. Trial fingerprint {learning.manifestHash.slice(0, 12)}. {learning.coverage.scope}</p><ul>{learning.coverage.issues.map((item, index) => <li key={index}>{item}</li>)}</ul><p>Research summaries are saved on the VPS for comparison across daily runs.</p></details>
  </section>;
}
