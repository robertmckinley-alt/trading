'use client';

import { useEffect, useState } from 'react';

const startingBalanceUsd = 50000;
const usd = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);
const timestamp = value => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
}).format(new Date(value));
export default function OrbForwardPanel({ initialData = null, definitions = [] }) {
  const [data, setData] = useState(initialData?.orbForward || null);
  const [error, setError] = useState(false);
  const [checkedAt, setCheckedAt] = useState(null);
  useEffect(() => {
    let disposed = false;
    let timer;
    const refresh = async () => {
      setCheckedAt(Date.now());
      try {
        const response = await fetch('/api/live-status', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Status unavailable');
        const payload = await response.json();
        if (!disposed) { setData(payload.orbForward || null); setError(false); }
      } catch { if (!disposed) setError(true); }
      if (!disposed) timer = setTimeout(refresh, 15000);
    };
    refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  const accounts = data?.accounts || definitions;
  const stale = error || !checkedAt || !data?.latestCandleAt || checkedAt - Date.parse(data.latestCandleAt) > 180000;
  const status = error ? 'Status connection unavailable' : !data || data.status === 'not-started' ? 'Awaiting VPS activation' : (data.status || 'Status unavailable').replaceAll('-', ' ');
  return <section className="orb-forward-panel" id="orb-live-paper" aria-labelledby="orb-forward-title">
    <div className="research-hero"><div><p className="eyebrow">Forward paper trading · {accounts.length} independent accounts</p><h2 id="orb-forward-title">ORB Live Paper</h2><p>Each account starts with $50,000 in paper funds. One NQ contract per signal. Structural stops and trading costs; no dollar risk cap or account loss cutoff. Results start from activation, separate from backtests and the nine primary accounts.</p></div><aside className="research-safety"><strong>{status}</strong><p>{data?.heartbeat ? `Runner heartbeat: ${timestamp(data.heartbeat)} · ${data.supervisedAccounts || accounts.length} accounts supervised` : 'The VPS must start the ORB supervisor before live results appear.'}</p>{data?.feed?.latestCandleAt && <p>Latest candle: {timestamp(data.feed.latestCandleAt)} · {data.feed.feedProcesses} feed process</p>}{data?.startedAt && <p>Started {timestamp(data.startedAt)} · Rules {data.version}</p>}</aside></div>
    <p>Paper fills use the next unseen minute open after signal observation, including modeled slippage. The 50-trade count includes only closed forward trades without detected data gaps; it is a review checkpoint, not proof of profitability.</p>
    <p>These variants share a base ORB setup. When several filters accept the same signal, their fills and P&amp;L can match. Compare the fill details and decision below for each independent account.</p>
    {data?.feed?.message && <p>Feed: {data.feed.message}</p>}
    {stale && data?.startedAt && <p role="status"><strong>Prices are not current.</strong> Equity and open P&amp;L below are last-known values, not live quotes. Market closures can pause candles; a heartbeat alone does not confirm fresh prices.</p>}
    {data?.lastError && <p role="status">Last runner error ({timestamp(data.lastError.at)}): {data.lastError.message}</p>}
    <div className="orb-forward-grid">{accounts.map(account => <article className="orb-forward-card" key={account.slug}>
      <h3>{account.name.replace('ORB Test: ', '')}</h3>
      {account.experimentId && <p>Frozen research account · Started {timestamp(account.startedAt)} · {account.experimentId}</p>}
      <p>{account.active ? `${account.active.side} · ${account.active.status}` : data?.startedAt ? 'No open position' : 'Not started'}</p>
      <dl><div><dt>Starting balance</dt><dd>{usd(startingBalanceUsd)}</dd></div><div><dt>{stale ? "Last-known equity" : "Marked equity"}</dt><dd>{usd(startingBalanceUsd + Number(account.netPnlUsd || 0) + Number(account.active?.unrealizedPnlUsd || 0))}</dd></div><div><dt>Cash balance</dt><dd>{usd(startingBalanceUsd + Number(account.netPnlUsd || 0))}</dd></div><div><dt>Return on $50,000</dt><dd>{((Number(account.netPnlUsd || 0) + Number(account.active?.unrealizedPnlUsd || 0)) / startingBalanceUsd * 100).toFixed(2)}%</dd></div><div><dt>Forward net P&amp;L</dt><dd>{usd(account.netPnlUsd)}</dd></div><div><dt>{stale ? "Last-known open P&L" : "Open P&L"}</dt><dd>{usd(account.active?.unrealizedPnlUsd)}</dd></div><div><dt>Closed trades</dt><dd>{account.closedTrades || 0}</dd></div><div><dt>Data-complete trades</dt><dd>{account.verifiedTrades || 0} / 50</dd></div><div><dt>Closed-trade drawdown</dt><dd>{usd(account.maxDrawdownUsd)}</dd></div><div><dt>Minute-close drawdown</dt><dd>{usd(account.markDrawdownUsd)}</dd></div></dl>
      {account.active && <dl>
        <div><dt>Filled entry</dt><dd>{account.active.entry ?? 'Awaiting fill details'}</dd></div>
        <div><dt>Filled at</dt><dd>{account.active.filledAt ? timestamp(account.active.filledAt) : 'Not reported'}</dd></div>
        <div><dt>Stop price</dt><dd>{account.active.stop}</dd></div>
        <div><dt>Last marked candle</dt><dd>{account.active.markedAt ? timestamp(account.active.markedAt) : 'Not reported'}</dd></div>
      </dl>}
      {account.active?.dataGap && <p>Data gap detected: this trade requires review.</p>}
      {account.lastDecision && <p>{account.lastDecision.at && `${timestamp(account.lastDecision.at)}: `}{account.lastDecision.reason}</p>}
      <details><summary>Forward trade journal ({account.trades?.length || 0})</summary>{account.trades?.length ? <div className="orb-forward-table"><table><thead><tr><th>Date</th><th>Side</th><th>Entry</th><th>Exit</th><th>Net P&amp;L</th><th>Data</th></tr></thead><tbody>{account.trades.map(trade => <tr key={trade.id}><td>{trade.date}</td><td>{trade.side}</td><td>{trade.entry}</td><td>{trade.finalExitPrice}</td><td>{usd(trade.realizedPnlUsd)}</td><td>{trade.dataQuality}</td></tr>)}</tbody></table></div> : <p>No closed forward trades yet.</p>}</details>
    </article>)}</div>
    <p>Drawdowns above use closed trades and minute-close marks, respectively. Neither measures every intraminute price move. Accounts are separate experiments; adding their P&amp;L does not model a shared account.</p>
  </section>;
}
