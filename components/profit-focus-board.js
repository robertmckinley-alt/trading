'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import styles from '../app/focus/focus.module.css';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const stamp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const statusLabels = { collecting: 'Collecting evidence', qualified: 'Paper criteria met', 'not-qualified': 'Criteria not met', stopped: 'Trial stopped', blocked: 'Validation blocked', invalidated: 'Rules changed' };

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function money(value) { return finite(value) ? usd.format(value) : 'Unavailable'; }
function number(value) { return finite(value) ? decimal.format(value) : 'Unavailable'; }
function risk(value) { return finite(value) ? `${decimal.format(value)}R` : 'Unavailable'; }
function percent(value) { return finite(value) ? `${decimal.format(value)}%` : 'Unavailable'; }
function when(value) { const date = new Date(value || ''); return Number.isFinite(date.getTime()) ? stamp.format(date) : 'Unavailable'; }
function tone(value) { return finite(value) ? value > 0 ? styles.positive : value < 0 ? styles.negative : '' : styles.muted; }

function Status({ status, blocked }) {
  const value = status === 'invalidated' ? status : blocked ? 'blocked' : status;
  const kind = value === 'qualified' ? styles.statusPassed : ['stopped', 'invalidated', 'blocked'].includes(value) ? styles.statusBlocked : styles.statusCollecting;
  return <span className={`${styles.status} ${kind}`}><i aria-hidden="true" />{statusLabels[value] || 'Awaiting evidence'}</span>;
}

function Metric({ label, value, className = '', note }) {
  return <div className={styles.metric}><dt>{label}</dt><dd className={className}>{value}</dd>{note && <span>{note}</span>}</div>;
}

function Metrics({ metrics = {}, prospective = false }) {
  return <dl className={styles.metrics}>
    <Metric label="Realized paper P&L" value={money(metrics.netPnlUsd)} className={tone(metrics.netPnlUsd)} />
    <Metric label="Net result / initial risk" value={risk(metrics.netR)} />
    <Metric label="Profit factor · net USD" value={number(metrics.profitFactor)} />
    <Metric label="Expectancy / trade" value={risk(metrics.expectancyR)} />
    <Metric label="Win rate" value={percent(metrics.winRate)} />
    <Metric label="Maximum drawdown" value={risk(metrics.maxDrawdownR)} note={prospective ? 'Includes recorded adverse excursion' : money(metrics.maxDrawdownUsd)} />
  </dl>;
}

function SegmentTable({ title, rows = [] }) {
  return <div className={styles.segment}>
    <h4>{title}</h4>
    {rows.length ? <div className={styles.tableScroll} role="region" aria-label={`${title} breakdown`} tabIndex={0}>
      <table className={styles.segmentTable}>
        <thead><tr><th scope="col">Recorded group</th><th scope="col">Trades</th><th scope="col">Net P&L</th><th scope="col">Avg. R</th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={`${row.label}-${index}`}>
          <th scope="row">{row.label || 'Unknown'}{!row.enoughEvidence && <small>Small sample</small>}</th>
          <td>{number(row.trades)}</td><td className={tone(row.netPnlUsd)}>{money(row.netPnlUsd)}</td><td>{risk(row.expectancyR)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p className={styles.emptySmall}>No recorded groups available.</p>}
  </div>;
}

function Gates({ gates = [] }) {
  return <div className={styles.gates}>
    <h4>Frozen pass criteria</h4>
    {gates.length ? <ul>{gates.map(gate => <li key={gate.key || gate.label}>
      <span className={gate.passed ? styles.gatePass : styles.gatePending} aria-label={gate.passed ? 'Met' : 'Not met'}>{gate.passed ? '✓' : '—'}</span>
      <span>{gate.label}<small>Required: {number(gate.required)}</small></span>
      <strong>{number(gate.current)}</strong>
    </li>)}</ul> : <p className={styles.emptySmall}>Pass criteria are unavailable for this snapshot.</p>}
  </div>;
}

function CountedTrades({ trades = [], blocked, label = 'Counted closed trades', showStrategy = true }) {
  return <section className={styles.tradeAudit} aria-label={label}>
    <div className={styles.auditHeading}><h3>{label}</h3><p>Only admitted new closed trades before each strategy’s trial ended. Open positions and historical selection trades are excluded.</p></div>
    {blocked && <p className={styles.auditWarning}>Source verification is unavailable. Listed identities are diagnostic context; financial values and current trial counts are unavailable.</p>}
    {trades.length ? <div className={styles.tableScroll} role="region" aria-label={`${label}; scroll horizontally for execution details`} tabIndex={0}>
      <table className={styles.auditTable}>
        <caption>Recorded net P&amp;L already includes the original modeled commissions and slippage. Times are New York time.</caption>
        <thead><tr>{showStrategy && <th scope="col">Selected strategy</th>}<th scope="col">Trade ID</th><th scope="col">Entry / close</th><th scope="col">Side / contracts</th><th scope="col">Entry / exit price</th><th scope="col">Actual risk</th><th scope="col">Realized net P&amp;L</th><th scope="col">Net R</th></tr></thead>
        <tbody>{trades.map(trade => <tr key={`${trade.slug}:${trade.id}`}>
          {showStrategy && <th scope="row">{trade.name || trade.slug}</th>}<td className={styles.tradeId}>{trade.id}</td>
          <td><span>{when(trade.filledAt)}</span><small>{when(trade.exitedAt)}</small></td><td>{trade.side || 'Unknown'}<small>{number(blocked ? null : trade.contracts)} contracts</small></td>
          <td>{number(blocked ? null : trade.entry)}<small>{number(blocked ? null : trade.exit)}</small></td><td>{money(blocked ? null : trade.actualRiskUsd)}</td>
          <td className={tone(blocked ? null : trade.netPnlUsd)}>{money(blocked ? null : trade.netPnlUsd)}</td><td>{risk(blocked ? null : trade.rMultiple)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p className={styles.emptyForward}>{blocked ? 'A verified counted-trade ledger is unavailable until the live source recovers.' : 'No new closed trades have entered this trial yet.'}</p>}
  </section>;
}

function StrategyAnalysis({ strategy, index, blocked }) {
  const history = strategy.history || {};
  const trial = strategy.prospective || {};
  const forward = trial.metrics || {};
  const segments = strategy.segments || {};
  return <details className={styles.analysis}>
    <summary>
      <span className={`${styles.strategySwatch} ${styles[`swatch${index % 5}`]}`} aria-hidden="true" />
      <span className={styles.analysisName}>{strategy.name}<small>Profit drivers, recorded groups & forward evidence</small></span>
      <span className={styles.analysisProfit}>{money(history.netPnlUsd)}<small>Historical net</small></span>
      <span className={styles.expandIcon} aria-hidden="true">+</span>
    </summary>
    <div className={styles.analysisBody}>
      <div className={styles.analysisIntro}><div><span className={styles.eyebrow}>Historical diagnosis</span><h3>What is carrying the result?</h3></div><Link href={`/strategies/${strategy.slug}`}>Full strategy journal ↗</Link></div>
      <Metrics metrics={history} />
      <div className={styles.concentration}>
        <div><span>Profit without the best trade</span><strong className={tone(history.netWithoutBestUsd)}>{money(history.netWithoutBestUsd)}</strong><p>Subtracts the largest winner from recorded net P&amp;L.</p></div>
        <div><span>Largest winner</span><strong>{money(history.bestTradePnlUsd)}</strong><p>{percent(history.topWinSharePct)} of gross winning P&amp;L.</p></div>
        <div><span>After extra execution costs</span><strong className={tone(history.stressedNetR)}>{risk(history.stressedNetR)}</strong><p>One extra tick on entry and exit; original modeled costs stay included.</p></div>
      </div>
      {!!strategy.insights?.length && <ul className={styles.insights}>{strategy.insights.map((insight, insightIndex) => <li key={insightIndex}>{insight}</li>)}</ul>}
      <div className={styles.breakdownHeading}><h4>Where the recorded profit came from</h4><p>Observed associations. Groups below five trades are exploratory.</p></div>
      <div className={styles.segmentGrid}>
        <SegmentTable title="Direction" rows={segments.side} />
        <SegmentTable title="Entry hour · New York" rows={segments.entryHour} />
        <SegmentTable title="Market regime" rows={segments.regime} />
      </div>
      {strategy.hypothesis && <div className={styles.hypothesis}><span className={styles.eyebrow}>Hypothesis to test</span><p>{strategy.hypothesis}</p><small>A research question, not a change to strategy rules.</small></div>}
      <section className={styles.forwardDetail} aria-labelledby={`forward-${strategy.slug}`}>
        <div className={styles.analysisIntro}><div><span className={styles.eyebrow}>Prospective trial · new trades only</span><h3 id={`forward-${strategy.slug}`}>Evidence after the frozen start</h3></div><Status status={trial.status} blocked={blocked} /></div>
        {trial.reason && <p className={styles.trialReason}>{trial.reason}</p>}
        {!blocked && finite(forward.trades) && forward.trades === 0 && <p className={styles.emptyForward}>No admitted closed trades yet. Historical winners do not count toward this trial.</p>}
        <div className={styles.forwardProgress}>
          <span><strong>{number(blocked ? null : forward.trades)}</strong> admitted trades</span><span><strong>{number(blocked ? null : forward.tradingDays)}</strong> traded New York days</span>
          {trial.terminalAt && <span>Trial ended <strong>{when(trial.terminalAt)}</strong></span>}
        </div>
        <Metrics metrics={blocked ? {} : forward} prospective />
        <CountedTrades trades={trial.trades} blocked={blocked} label={`${strategy.name}: counted closed trades`} showStrategy={false} />
        <div className={styles.validationGrid}><Gates gates={blocked ? (trial.gates || []).map(gate => ({ ...gate, current: null, passed: false })) : trial.gates} /><div className={styles.riskEvidence}>
          <h4>Evidence & costs</h4>
          <dl><div><dt>Approximate daily lower bound</dt><dd>{risk(blocked ? null : forward.dailyLowerBoundR)}</dd></div><div><dt>Net result after cost stress</dt><dd>{risk(blocked ? null : forward.stressedNetR)}</dd></div><div><dt>Trades missing recorded risk</dt><dd>{number(forward.missingRisk)}</dd></div><div><dt>Later trades excluded after stop</dt><dd>{number(trial.ignoredAfterStop)}</dd></div></dl>
          <p>The daily bound uses an approximate one-sided 99% calculation on daily R totals. It assumes independent daily blocks; it is not a calibrated probability of future profit.</p>
          {!!trial.excluded?.length && <details className={styles.exclusions}><summary>Why trades did not enter this trial</summary><ul>{trial.excluded.map((item, itemIndex) => <li key={itemIndex}><span>{item.reason}</span><strong>{number(item.count)}</strong></li>)}</ul></details>}
        </div></div>
      </section>
    </div>
  </details>;
}

export default function ProfitFocusBoard({ initialReport }) {
  const [report, setReport] = useState(initialReport);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(null);
  const refresh = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const response = await fetch('/api/focus', { cache: 'no-store', signal: controller.signal });
      const next = await response.json();
      if (!next || !Array.isArray(next.strategies) || !next.dataStatus) throw new Error('The validation report could not be loaded.');
      setReport(next);
      setError('');
    } catch (failure) {
      if (failure.name !== 'AbortError') setError('The latest snapshot could not be loaded. Forward validation is blocked until a fresh report arrives.');
    } finally {
      request.current = null;
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = setInterval(refresh, 30000);
    return () => { clearInterval(timer); request.current?.abort(); };
  }, [refresh]);

  const strategies = Array.isArray(report?.strategies) ? report.strategies : [];
  const summary = report?.summary || {};
  const policy = report?.policy || {};
  const blocked = !report?.dataStatus?.ok || Boolean(error);
  const countedTrades = strategies.flatMap(strategy => strategy.prospective?.trades || []).sort((a, b) => Date.parse(a.exitedAt) - Date.parse(b.exitedAt) || String(a.id).localeCompare(String(b.id)));
  const contributionTotal = strategies.reduce((sum, strategy) => sum + (finite(strategy.selectionPnlUsd) && strategy.selectionPnlUsd > 0 ? strategy.selectionPnlUsd : 0), 0);
  return <div className={styles.focus}>
    <header className={styles.heading}>
      <div><span className={styles.eyebrow}>Selected winners / independent paper validation</span><h1>Profit Focus<span className={styles.version}>v1</span></h1><p>Understand the profit. Then test what survives.</p></div>
      <div className={styles.headingActions}><Link href="/">Original dashboard ↗</Link><button type="button" onClick={refresh} disabled={loading} aria-label="Refresh Profit Focus report">{loading ? 'Refreshing…' : '↻ Refresh'}</button></div>
    </header>
    <div className={styles.freshness} aria-live="polite"><span className={blocked ? styles.healthBlocked : styles.healthReady}><i aria-hidden="true" />{blocked ? 'Forward validation blocked' : 'Live source verified'}</span><span>Snapshot {when(report?.generatedAt)}</span><span>Source: {report?.source || 'Unavailable'} · refreshes every 30s</span></div>
    {blocked && <aside className={styles.blockedNotice} role="status"><strong>Historical context is visible. Forward evidence is not cleared.</strong>{error && <p>{error}</p>}{!!report?.dataStatus?.reasons?.length && <ul>{report.dataStatus.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}<p>Restore a fresh, healthy source with the frozen rules before interpreting trial progress.</p></aside>}

    <section className={styles.pnlOverview} aria-labelledby="current-pnl-title">
      <span className={styles.eyebrow}>Frozen prospective trial / selected five only</span><h2 id="current-pnl-title">New trial P&amp;L</h2>
      <div className={styles.trialScore}>
        <div><span>Realized net paper P&amp;L</span><strong className={tone(blocked ? null : summary.prospectivePnlUsd)}>{money(blocked ? null : summary.prospectivePnlUsd)}</strong><small>Closed trades only · open P&amp;L excluded</small></div>
        <div><span>Counted new closed trades</span><strong>{number(blocked ? null : summary.prospectiveTrades)}</strong><small>Since {when(report?.startedAt)}</small></div>
        <div><span>Paper criteria met</span><strong>{number(blocked ? null : summary.qualified)}<small> / {number(summary.selectedStrategies)}</small></strong><small>Separate from frozen historical profit</small></div>
      </div>
      <a href="#counted-trades">Reconcile the counted trades ↓</a>
    </section>
    <div id="counted-trades"><CountedTrades trades={countedTrades} blocked={blocked} /></div>

    <section className={styles.selection} aria-labelledby="selection-title">
      <div className={styles.sectionHeading}><div><span className={styles.eyebrow}>Retrospective selection</span><h2 id="selection-title">Five winners. Different sources of profit.</h2></div><p>Selected {when(report?.selectedAt)}<br />Positive lifetime paper P&amp;L at selection.</p></div>
      <p className={styles.selectionNote}>{report?.selectionBasis || 'Selected from historical paper results. Selection itself is not evidence of a repeatable edge.'}</p>
      {contributionTotal > 0 && <div className={styles.contribution} role="img" aria-label={`Contribution to ${money(contributionTotal)} in frozen selection profit: ${strategies.map(strategy => `${strategy.name}, ${money(strategy.selectionPnlUsd)}`).join('; ')}`}>
        {strategies.map((strategy, index) => finite(strategy.selectionPnlUsd) && strategy.selectionPnlUsd > 0 ? <div key={strategy.slug} className={styles[`swatch${index % 5}`]} style={{ flexGrow: strategy.selectionPnlUsd / contributionTotal }}><span>{percent(strategy.selectionPnlUsd / contributionTotal * 100)}</span></div> : null)}
      </div>}
      <div className={styles.tableScroll} role="region" aria-label="Selected strategies ledger; scroll horizontally on small screens" tabIndex={0}>
        <table className={styles.ledger}>
          <caption>Frozen selection record and separate prospective trial</caption>
          <thead><tr><th scope="col">Selected strategy</th><th scope="col">Selection P&amp;L</th><th scope="col">Selection trades</th><th scope="col">Without best trade<small>Recorded history</small></th><th scope="col">New trial P&amp;L<small>Closed trades only</small></th><th scope="col">New trial trades</th><th scope="col">Forward status</th></tr></thead>
          <tbody>{strategies.map((strategy, index) => <tr key={strategy.slug}>
            <th scope="row"><span className={`${styles.strategySwatch} ${styles[`swatch${index % 5}`]}`} aria-hidden="true" /><Link href={`/strategies/${strategy.slug}`}>{strategy.name}</Link></th>
            <td className={tone(strategy.selectionPnlUsd)}>{money(strategy.selectionPnlUsd)}</td><td>{number(strategy.selectionTrades)}</td><td className={tone(strategy.history?.netWithoutBestUsd)}>{money(strategy.history?.netWithoutBestUsd)}</td><td className={tone(blocked ? null : strategy.prospective?.metrics?.netPnlUsd)}>{money(blocked ? null : strategy.prospective?.metrics?.netPnlUsd)}</td><td>{number(blocked ? null : strategy.prospective?.metrics?.trades)} / {number(policy.minTrades)}</td><td><Status status={strategy.prospective?.status} blocked={blocked} /></td>
          </tr>)}</tbody>
        </table>
      </div>
      {!strategies.length && <p className={styles.emptyForward}>The selected accounts are unavailable. Refresh after the live source recovers.</p>}
      <div className={styles.ledgerFoot}><span>Strip widths show frozen selection profit, not capital allocation.</span><a href="#strategy-evidence">Inspect each strategy ↓</a></div>
    </section>

    <section className={styles.trial} aria-labelledby="trial-title">
      <div className={styles.trialIntro}><span className={styles.eyebrow}>Prospective validation / fresh start</span><h2 id="trial-title">The next trades must earn the conclusion.</h2><p>Trial began <strong>{when(report?.startedAt)}</strong>. Earlier trades and signals are excluded. The cohort and execution rules are frozen.</p></div>
      <div className={styles.ruleColumns}>
        <div><h3>One fixed evaluation</h3><p>Reach <strong>{number(policy.minTrades)} new trades and {number(policy.minTradingDays)} traded New York days</strong>. Evaluate at the first close meeting both thresholds.</p><p>Pass requires profit factor ≥{number(policy.minProfitFactor)}, positive net R, positive net R after extra costs, and a positive approximate daily lower bound.</p></div>
        <div><h3>Stop counting the trial when…</h3><ul><li>Drawdown reaches {risk(policy.maxDrawdownR)}, including adverse excursion.</li><li>A day loses {risk(policy.maxDailyLossR)} net.</li><li>{number(policy.maxConsecutiveLosses)} consecutive losses occur.</li><li>{number(policy.maxCalendarDays)} calendar days expire.</li></ul><small>Stops apply to validation counts. Original accounts keep their existing rules.</small></div>
        <div><h3>Compare with a fair baseline</h3><p><strong>No trade: 0R.</strong> The trial must outperform doing nothing after an additional tick on each leg.</p><p>Buy-and-hold comparison is unavailable without a matching price series. These accounts are paper simulations; passing is not authorization to trade live.</p></div>
      </div>
    </section>

    <section className={styles.evidence} id="strategy-evidence" aria-labelledby="evidence-title"><div className={styles.sectionHeading}><div><span className={styles.eyebrow}>Open the evidence</span><h2 id="evidence-title">Look past the net P&amp;L.</h2></div><p>Expand a strategy to inspect concentration,<br />recorded groups, cost sensitivity, and trial gates.</p></div>{strategies.map((strategy, index) => <StrategyAnalysis strategy={strategy} index={index} blocked={blocked} key={strategy.slug} />)}</section>
    <footer className={styles.footer}><strong>Paper research. No automatic promotion.</strong><p>Historical selection favors past winners. Forward criteria reduce that bias but do not establish future profitability. Unavailable evidence stays unavailable.</p><Link href="/">Return to all original accounts →</Link></footer>
  </div>;
}
