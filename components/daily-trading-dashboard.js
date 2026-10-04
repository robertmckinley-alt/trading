'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { dashboardView, dashboardHistory, sessionDate } from '../lib/dashboard-view.cjs';

const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const shortDate = value => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const tone = value => value > 0 ? 'gain' : value < 0 ? 'loss' : '';
const sum = rows => rows.reduce((total, trade) => total + Number(trade.realizedPnlUsd), 0);
function status(strategy) {
  return strategy.live?.latestError?.message || strategy.live?.latestReason || strategy.watcher?.statusLabel || 'Awaiting a recorded signal';
}

function TradeSection({ title, rows, variant, empty }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, 6);
  return <section className={`day-card trade-section ${variant}`}>
    <header><div><span className="day-eyebrow">Closed paper trades</span><h2>{title} <span className="day-count">{rows.length}</span></h2></div><strong className={variant}>{money(sum(rows))}</strong></header>
    {!rows.length ? <p className="day-empty">{empty}</p> : <div className="day-trades">{shown.map(trade => <details className="day-trade" key={trade.key}>
      <summary><span className={`trade-symbol ${variant}`} aria-hidden="true">{variant === 'gain' ? '↗' : variant === 'loss' ? '↘' : '−'}</span><span className="trade-name"><strong>{trade.strategy.name}</strong><small>{trade.symbol || trade.strategy.ticker} · {trade.side || 'Trade'}{trade.filledAt ? ` · ${new Date(trade.filledAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET` : ''}</small></span><span className={`trade-value ${variant}`}>{money(trade.realizedPnlUsd)}<small>Details ⌄</small></span></summary>
      <div className="trade-detail"><dl><div><dt>Entry</dt><dd>{trade.entry ?? '—'}</dd></div><div><dt>Exit</dt><dd>{trade.finalExitPrice ?? '—'}</dd></div><div><dt>Result</dt><dd>{Number.isFinite(trade.rMultiple) ? `${trade.rMultiple.toFixed(2)}R` : '—'}</dd></div></dl><p>{trade.exitReason || 'No exit reason recorded'}</p><Link href={trade.strategy.route || `/strategies/${trade.strategy.slug}`}>Open strategy →</Link></div>
    </details>)}</div>}
    {rows.length > 6 && <button className="day-text-button" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer trades' : `Show all ${rows.length} trades`}</button>}
  </section>;
}

export default function DailyTradingDashboard({ data, strategies, refreshData, refreshState }) {
  const [selectedDate, setSelectedDate] = useState('');
  const [query, setQuery] = useState('');
  const [instrument, setInstrument] = useState('all');
  const [range, setRange] = useState('30');
  const [chartMode, setChartMode] = useState('realized');
  const [hoverDate, setHoverDate] = useState('');
  const today = sessionDate(data?.generatedAt);
  const date = selectedDate || today;
  const filtered = useMemo(() => strategies.filter(s => (instrument === 'all' || s.ticker === instrument) && `${s.name} ${s.slug}`.toLowerCase().includes(query.toLowerCase())), [strategies, query, instrument]);
  const day = useMemo(() => dashboardView(filtered, date), [filtered, date]);
  const history = useMemo(() => dashboardHistory(filtered), [filtered]);
  const end = Date.parse(`${today}T12:00:00Z`);
  const series = history.filter(row => range === 'all' || Date.parse(`${row.date}T12:00:00Z`) >= end - (Number(range) - 1) * 86400000);
  const selectedPoint = series.find(row => row.date === (hoverDate || date));
  const maximum = Math.max(1, ...series.map(row => Math.abs(row[chartMode])));
  const total = series.reduce((n, row) => n + row.realized, 0);
  const closed = day.positive.length + day.negative.length + day.flat.length;
  const issues = strategies.filter(s => s.live?.latestError || (s.mode === 'live-watcher' && !s.watcher?.isHealthy));
  return <div className="daily-dashboard">
    <div className="day-heading"><div><p className="day-eyebrow">Your trading day / Paper accounts</p><h1>Performance, at a glance.</h1><p>Wins, losses, and the accounts waiting for their next trade.</p></div><div className="day-refresh"><button onClick={refreshData} disabled={refreshState.busy}>{refreshState.busy ? 'Refreshing…' : '↻ Refresh'}</button><small>Snapshot {data?.generatedAt ? new Date(data.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) : 'unavailable'} PT · auto-refresh 30s</small></div></div>
    {(refreshState.error || data?.ok === false || data?.source === 'remote-bridge-fallback') && <p className="day-alert" role="status">{refreshState.error || data?.error || 'Live bridge unavailable. Showing a fallback snapshot; account data may be out of date.'}</p>}
    <div className="day-toolbar"><div className="day-date"><label htmlFor="trading-date">Trading date · ET</label><input id="trading-date" type="date" value={date} max={today || undefined} onChange={e => setSelectedDate(e.target.value)} /><button onClick={() => setSelectedDate('')}>Today</button></div><div className="day-filters"><label><span className="sr-only">Filter instrument</span><select value={instrument} onChange={e => setInstrument(e.target.value)}><option value="all">All instruments</option>{[...new Set(strategies.map(s => s.ticker).filter(Boolean))].map(t => <option key={t}>{t}</option>)}</select></label><label><span className="sr-only">Search strategies</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search strategies…" /></label></div></div>
    <div className="day-metrics">
      <section className="day-card day-main-metric"><span>Daily realized P&amp;L</span><strong className={tone(day.realized + day.partial)}>{money(day.realized + day.partial)}</strong><small>{shortDate(date)} · closed trades + realized partial exits</small></section>
      <section className="day-card"><span>Positive trades</span><strong className="gain">{money(sum(day.positive))}</strong><small>{day.positive.length} winning trades</small></section>
      <section className="day-card"><span>Negative trades</span><strong className="loss">{money(sum(day.negative))}</strong><small>{day.negative.length} losing trades</small></section>
      <section className="day-card"><span>Win rate</span><strong>{closed ? `${Math.round(day.positive.length / closed * 100)}%` : '—'}</strong><small>{closed} closed · {day.flat.length} breakeven</small></section>
    </div>
    <section className="day-card day-history"><header><div><span className="day-eyebrow">Forward paper history</span><h2>P&amp;L over time</h2></div><div className="day-chart-controls"><label><span className="sr-only">Chart metric</span><select value={chartMode} onChange={e => setChartMode(e.target.value)}><option value="realized">Daily P&amp;L</option><option value="cumulative">Cumulative P&amp;L</option></select></label><div className="day-segments" aria-label="History range">{[['7', '7D'], ['30', '30D'], ['90', '90D'], ['all', 'All']].map(([value, label]) => <button key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}</div></div></header>
      <div className="day-chart-caption"><strong className={tone(selectedPoint ? selectedPoint[chartMode] : total)}>{money(selectedPoint ? selectedPoint[chartMode] : total)}</strong><span>{selectedPoint ? `${shortDate(selectedPoint.date)} · ${chartMode === 'realized' ? 'closed-trade P&L' : 'cumulative closed-trade P&L'}` : 'Closed-trade P&L in this range'} · click a bar to inspect the day</span></div>
      {series.length ? <div className="day-chart-scroll"><div className="day-bar-chart" style={{ minWidth: Math.max(0, series.length * 12) }}><span className="day-zero" aria-hidden="true">$0</span>{series.map(row => { const value = row[chartMode]; const height = Math.max(1, Math.abs(value) / maximum * 45); return <button className={`day-bar ${row.date === date ? 'selected' : ''}`} key={row.date} aria-label={`${row.date}: ${money(value)}. Show this day.`} aria-pressed={row.date === date} title={`${row.date}: ${money(value)}`} onClick={() => setSelectedDate(row.date)} onMouseEnter={() => setHoverDate(row.date)} onMouseLeave={() => setHoverDate('')} onFocus={() => setHoverDate(row.date)} onBlur={() => setHoverDate('')}><span className={tone(value)} style={{ height: `${height}%`, top: value >= 0 ? `${50 - height}%` : '50%' }} /></button>; })}</div><div className="day-axis"><span>{shortDate(series[0].date)}</span><span>{shortDate(series.at(-1).date)}</span></div></div> : <p className="day-empty">No recorded history in this range. Try All or clear your filters.</p>}
      <p className="day-footnote">{filtered.length} accounts in view · recorded journal dates only · cumulative starts at the first available journal date. Open P&amp;L is excluded. <Link href="/backtests">Historical backtests →</Link></p>
      <details className="day-history-table"><summary>View daily history as a table</summary><div className="day-table-scroll"><table><thead><tr><th>Date (ET)</th><th>Closed-trade P&amp;L</th><th>Cumulative</th><th /></tr></thead><tbody>{[...series].reverse().map(row => <tr key={row.date}><td>{row.date}</td><td className={tone(row.realized)}>{money(row.realized)}</td><td>{money(row.cumulative)}</td><td><button onClick={() => setSelectedDate(row.date)}>Inspect day</button></td></tr>)}</tbody></table></div></details>
    </section>
    <div className="day-section-pair"><TradeSection title="Positive trades" rows={day.positive} variant="gain" empty="No profitable closed trades on this date." /><TradeSection title="Negative trades" rows={day.negative} variant="loss" empty="No losing closed trades on this date." /></div>
    {day.flat.length > 0 && <TradeSection title="Breakeven trades" rows={day.flat} variant="" empty="" />}
    {day.active.length > 0 && <section className="day-card day-active"><header><div><span className="day-eyebrow">Separate from closed results</span><h2>Open positions &amp; pending orders <span className="day-count">{day.active.length}</span></h2></div><strong className={tone(day.unrealized)}>{money(day.unrealized)} unrealized</strong></header>{day.active.map(({ strategy, daily }) => <div className="day-idle-row" key={strategy.slug}><Link href={strategy.route || `/strategies/${strategy.slug}`}>{strategy.name}</Link><span>{daily.openTradeStatus === 'not-filled' ? 'Order pending · not filled' : daily.openTradeStatus}</span><strong>{money(daily.activeUnrealizedPnlUsd || 0)}</strong></div>)}</section>}
    <section className="day-card day-idle"><header><div><span className="day-eyebrow">No closed trades or active orders recorded</span><h2>No trades <span className="day-count">{day.idle.length}</span></h2></div><span className="day-muted">{shortDate(date)}</span></header><div className="day-idle-grid">{day.idle.map(strategy => <Link className="day-idle-tile" key={strategy.slug} href={strategy.route || `/strategies/${strategy.slug}`}><div><strong>{strategy.name}</strong><span aria-hidden="true">↗</span></div><small>{strategy.ticker} · {strategy.watcher?.statusLabel || 'Status unavailable'}</small><p>{status(strategy)}</p></Link>)}</div>{!day.idle.length && <p className="day-empty">No idle accounts in this selection.</p>}<p className="day-footnote">Status and signal reasons are from the latest snapshot, even when viewing a historical date.</p></section>
    {day.unavailable.length > 0 && <p className="day-alert">{day.unavailable.length} accounts have no journal or were not yet active on this date. They are excluded from “No trades.”</p>}
    <details className="day-card day-health"><summary><strong>System health</strong><span>{issues.length ? `${issues.length} accounts need review` : `${strategies.length} accounts · no watcher issues reported`}</span></summary><div>{(issues.length ? issues : strategies).map(s => <div className="day-idle-row" key={s.slug}><Link href={s.route || `/strategies/${s.slug}`}>{s.name}</Link><span>{s.watcher?.statusLabel || 'Unknown'}</span><small>{s.live?.latestError?.message || s.watcher?.staleStatusHint || 'No current error reported'}</small></div>)}</div></details>
  </div>;
}
