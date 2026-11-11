'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import styles from '../app/focus/paper.module.css';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integers = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const decimals = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const timestamp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const valid = value => typeof value === 'number' && Number.isFinite(value);
const usd = value => valid(value) ? dollars.format(value) : 'Unavailable';
const count = value => valid(value) ? integers.format(value) : 'Unavailable';
const numeric = value => valid(value) ? decimals.format(value) : 'Unavailable';
const time = value => value && Number.isFinite(Date.parse(value)) ? timestamp.format(new Date(value)) : 'Unavailable';
const valueClass = value => valid(value) ? value > 0 ? styles.positive : value < 0 ? styles.negative : '' : styles.muted;

function AccountStatus({ account, blocked }) {
  if (blocked) return <span className={`${styles.status} ${styles.statusBlocked}`}>Data unavailable</span>;
  const label = account.open ? 'Open paper trade' : account.pending ? 'Pending plan' : account.status === 'stopped' ? 'Account paused' : account.status === 'data-gap' ? 'Data gap' : 'Waiting for a signal';
  return <span className={`${styles.status} ${account.open || account.pending ? styles.statusActive : styles.statusIdle}`}>{label}</span>;
}

function TradeAudit({ accounts, blocked }) {
  const trades = accounts.flatMap(account => (Array.isArray(account.tradeList) ? account.tradeList : []).map(trade => ({ ...trade, accountId: account.id, accountName: account.name }))).sort((a, b) => (Date.parse(b.exitedAt) || 0) - (Date.parse(a.exitedAt) || 0));
  return <section className={styles.panel} aria-labelledby="paper-audit-title">
    <div className={styles.sectionHeading}><div><span className={styles.eyebrow}>Closed-trade audit / five control accounts</span><h2 id="paper-audit-title">The trades behind the total.</h2></div><span className={styles.counter}>{blocked ? 'Awaiting verified data' : `${count(trades.length)} closed trades`}</span></div>
    <p className={styles.sectionNote}>Only these new control trades contribute to the main realized P&amp;L. Open plans, the VWAP comparison, original accounts, and v1 history are excluded.</p>
    {blocked ? <p className={styles.empty}>The closed-trade ledger is unavailable until a fresh, verified report arrives.</p> : !trades.length ? <p className={styles.empty}>No new closed paper trades yet. The total starts at $0.00; old trades are not resized or copied here.</p> : <div className={styles.tableScroll} role="region" aria-label="New control closed trades; scroll horizontally for all columns" tabIndex={0}>
      <table className={styles.auditTable}><caption>Recorded fills and net realized P&amp;L, including modeled costs</caption><thead><tr><th scope="col">Account / trade</th><th scope="col">Side</th><th scope="col">Contracts</th><th scope="col">Entry / exit</th><th scope="col">Filled / closed · ET</th><th scope="col">Actual risk</th><th scope="col">Net P&amp;L</th><th scope="col">R</th></tr></thead><tbody>{trades.map(trade => <tr key={`${trade.accountId}:${trade.id}`}><th scope="row">{trade.accountName || 'Selected account'}<small className={styles.tradeId}>{trade.id}</small></th><td>{trade.side || 'Unavailable'}</td><td>{count(trade.contracts)}</td><td>{numeric(trade.entry)}<small>{numeric(trade.exit)}</small></td><td>{time(trade.filledAt)}<small>{time(trade.exitedAt)}</small></td><td>{usd(trade.actualRiskUsd)}</td><td className={valueClass(trade.netPnlUsd)}>{usd(trade.netPnlUsd)}</td><td>{valid(trade.rMultiple) ? `${numeric(trade.rMultiple)}R` : 'Unavailable'}</td></tr>)}</tbody></table>
    </div>}
  </section>;
}

export default function FocusPaperBoard({ initialReport, accountDefinitions = [], policyLimits = {} }) {
  const [report, setReport] = useState(initialReport);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(null);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    try {
      const response = await fetch('/api/focus-paper', { cache: 'no-store', signal: controller.signal });
      const next = await response.json();
      if (!next?.dataStatus || !Array.isArray(next.accounts)) throw new Error('Paper report unavailable');
      setReport(next);
      setError('');
    } catch (failure) {
      if (failure.name !== 'AbortError') setError('The current paper report could not be loaded. Financial values are hidden until a fresh report arrives.');
    } finally {
      pending.current = null;
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = setInterval(refresh, 30000);
    return () => { clearInterval(timer); pending.current?.abort(); };
  }, [refresh]);

  const blocked = !report?.dataStatus?.ok || Boolean(error);
  const financial = value => blocked ? null : value;
  const limits = { ...policyLimits, ...report?.policy };
  const availableAccounts = Array.isArray(report?.accounts) ? report.accounts : [];
  const controls = availableAccounts.filter(account => account.arm === 'control');
  const accounts = accountDefinitions.length ? accountDefinitions.map(definition => controls.find(account => account.parent === definition.slug) || { id: definition.slug, parent: definition.slug, name: definition.name, arm: 'control' }) : controls;
  const candidate = availableAccounts.find(account => account.arm === 'vwap-confirm');
  const vwapControl = controls.find(account => account.parent === 'nq-vwap-stretch-reversion');
  const summary = report?.summary || {};
  const comparison = report?.comparison || {};
  return <div className={styles.board}>
    <header className={styles.heading}><div><span className={styles.eyebrow}>Independent accounts / new paper trades only</span><h1>$1,000 risk<span>Paper trial</span></h1><p>Five separate accounts. A new ledger from the first admitted signal.</p></div><div className={styles.actions}><Link href="/focus/baseline">Frozen v1 baseline ↗</Link><button type="button" onClick={refresh} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh'}</button></div></header>
    <div className={styles.freshness} aria-live="polite"><span className={blocked ? styles.healthBlocked : styles.healthReady}><i aria-hidden="true" />{blocked ? 'Paper report blocked' : 'Paper report verified'}</span><span>Updated {time(report?.updatedAt)}</span><span>30-second refresh · {report?.source || 'Source unavailable'}</span></div>
    {blocked && <aside className={styles.notice} role="status"><strong>Current financial data is unavailable.</strong>{error && <p>{error}</p>}{!!report?.dataStatus?.reasons?.length && <ul>{report.dataStatus.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}<p>No previous results are substituted for this new cohort.</p></aside>}

    <section className={styles.pnlPanel} aria-labelledby="control-result-title"><div className={styles.resultTitle}><span className={styles.eyebrow}>Five controls / realized paper P&amp;L</span><h2 id="control-result-title">New trial result</h2><p>Started {time(report?.startedAt)}<br />Closed trades only. VWAP comparison excluded.</p></div><dl className={styles.topMetrics}><div className={styles.primaryMetric}><dt>Realized P&amp;L</dt><dd className={valueClass(financial(summary.realizedPnlUsd))}>{usd(financial(summary.realizedPnlUsd))}</dd></div><div><dt>Closed trades</dt><dd>{count(financial(summary.closedTrades))}</dd></div><div><dt>Open paper positions</dt><dd>{count(financial(summary.openPositions))}</dd><small>Filled positions only</small></div><div><dt>Reserved risk</dt><dd>{usd(financial(summary.reservedRiskUsd))}</dd><small>Pending and open controls</small></div></dl></section>

    <section className={styles.riskStrip} aria-label="Frozen paper risk limits"><div><span>Planned risk / trade</span><strong>Up to {usd(limits.riskPerTradeUsd)}</strong></div><div><span>Daily loss / account</span><strong>{usd(limits.dailyLossLimitUsd)}</strong></div><div><span>Book open-risk cap</span><strong>{usd(limits.portfolioOpenRiskUsd)}</strong></div><div><span>Family open-risk cap</span><strong>{usd(limits.familyOpenRiskUsd)}</strong></div><p>This is planned loss at the stop, including modeled fees and slippage—not purchase value. Whole-contract sizing can use less than $1,000. Gaps and adverse execution can exceed planned risk.</p></section>

    <section className={styles.panel} aria-labelledby="control-accounts-title"><div className={styles.sectionHeading}><div><span className={styles.eyebrow}>Five independent control accounts</span><h2 id="control-accounts-title">Same selected strategies. Separate capital.</h2></div><span className={styles.counter}>{usd(limits.startingBalanceUsd)} starting balance each</span></div><p className={styles.sectionNote}>These accounts copy only newly admitted parent signals observed after activation. They do not test signals the original strategies rejected.</p><div className={styles.tableScroll} role="region" aria-label="Five new paper control accounts; scroll horizontally for all columns" tabIndex={0}><table className={styles.accountTable}><caption>New cohort only · original accounts and frozen v1 remain separate</caption><thead><tr><th scope="col">Selected strategy</th><th scope="col">New realized P&amp;L</th><th scope="col">Closed trades</th><th scope="col">Paper balance</th><th scope="col">Reserved risk</th><th scope="col">Account state</th></tr></thead><tbody>{accounts.map((account, index) => <tr key={account.id || account.parent}><th scope="row"><span className={`${styles.swatch} ${styles[`swatch${index % 5}`]}`} aria-hidden="true" /><Link href={`/strategies/${account.parent}`}>{account.name || account.parent}</Link></th><td className={valueClass(financial(account.realizedPnlUsd))}>{usd(financial(account.realizedPnlUsd))}</td><td>{count(financial(account.trades))}</td><td>{usd(financial(account.balanceUsd))}</td><td>{usd(financial(account.reservedRiskUsd))}</td><td><AccountStatus account={account} blocked={blocked} /></td></tr>)}</tbody></table></div><div className={styles.panelFoot}><span>VWAP account floor: $47,500 · Other account floors: $45,000.</span><a href="#new-paper-audit">Inspect counted closed trades ↓</a></div></section>

    <div id="new-paper-audit" className={styles.auditAnchor}><TradeAudit accounts={controls} blocked={blocked} /></div>

    <section className={styles.comparison} aria-labelledby="vwap-comparison-title"><div className={styles.comparisonTitle}><div><span className={styles.eyebrow}>Separate experiment / excluded from main P&amp;L</span><h2 id="vwap-comparison-title">VWAP: wait for a completed turn?</h2></div><span className={styles.experimentBadge}>Unvalidated hypothesis</span></div><p>The comparison waits for a completed bullish one-minute candle that closes above the previous candle’s high. It must confirm and enter before the original signal deadline. Otherwise it records a skipped or unfilled opportunity.</p><div className={styles.compareGrid}><div><span>VWAP control account</span><strong className={valueClass(financial(vwapControl?.realizedPnlUsd))}>{usd(financial(vwapControl?.realizedPnlUsd))}</strong><small>Already included in the five-control total</small></div><div><span>Turn-confirmation account</span><strong className={valueClass(financial(candidate?.realizedPnlUsd))}>{usd(financial(candidate?.realizedPnlUsd))}</strong><small>Separate $50,000 account; excluded from main total</small></div><div><span>Resolved paired difference</span><strong className={valueClass(financial(comparison.deltaUsd))}>{usd(financial(comparison.deltaUsd))}</strong><small>{count(financial(comparison.pairedComparisons))} resolved signal comparisons</small></div></div><div className={styles.compareNotes}><p><strong>Matched opportunities.</strong> Both VWAP arms wait until the prior pair finishes. The original structural stop, target, execution checks, and deadline stay in place. Actual contract counts can differ.</p><p><strong>Separate risk book.</strong> The comparison has its own up-to-$1,000 planned trade risk and $1,000 daily loss limit. Its P&amp;L and risk are not added to the five-control totals.</p></div><details className={styles.method}><summary>How to read this comparison</summary><p>The paired difference counts only signals where both arms have a terminal outcome. Account totals can include outcomes not yet paired. A filtered signal contributes $0 to its comparison outcome; it is not a profitable trade. No improved performance is claimed from a small sample.</p><dl><div><dt>Paired control P&amp;L</dt><dd>{usd(financial(comparison.controlPnlUsd))}</dd></div><div><dt>Paired confirmation P&amp;L</dt><dd>{usd(financial(comparison.candidatePnlUsd))}</dd></div><div><dt>Confirmation closed trades</dt><dd>{count(financial(candidate?.trades))}</dd></div></dl></details></section>

    <section className={styles.scope} aria-labelledby="paper-scope-title"><h2 id="paper-scope-title">A new paper book, not resized history.</h2><div><p>Only signals first observed after activation can enter these accounts. Pending and open plans reserve risk. Daily loss room, account floors, book limits, and family limits can reduce size or reject an entry.</p><p>The original strategy accounts and frozen v1 trial continue separately. No historical trade is multiplied to simulate the larger risk budget. This trial has no broker connection or automatic live promotion.</p></div><nav aria-label="Related paper research"><Link href="/focus/baseline">Read the frozen v1 baseline →</Link><Link href="/">View all original accounts →</Link></nav></section>
  </div>;
}
