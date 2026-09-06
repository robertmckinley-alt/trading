'use client';

import { useEffect, useState } from 'react';

const usd = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);
export default function OrbForwardPanel({ initialData = null, definitions = [] }) {
  const [data, setData] = useState(initialData?.orbForward || null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer;
    const refresh = async () => {
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
  const status = error ? 'Status connection unavailable' : !data || data.status === 'not-started' ? 'Awaiting VPS activation' : data.status.replaceAll('-', ' ');
  return <section className="orb-forward-panel" id="orb-live-paper" aria-labelledby="orb-forward-title">
    <div className="research-hero"><div><p className="eyebrow">Forward paper trading · 9 independent accounts</p><h2 id="orb-forward-title">ORB Live Paper</h2><p>One NQ contract per signal. Structural stops and trading costs; no dollar risk cap or account loss cutoff. Results start from activation, separate from backtests and the original seven accounts.</p></div><aside className="research-safety"><strong>{status}</strong><p>{data?.heartbeat ? `Last heartbeat: ${new Date(data.heartbeat).toLocaleString()}` : 'The VPS must start the new ORB runner before live results appear.'}</p>{data?.startedAt && <p>Started {new Date(data.startedAt).toLocaleString()} · Rules {data.version}</p>}</aside></div>
    <p>Paper fills use the next unseen minute open after signal observation, including modeled slippage. The 50-trade count includes only closed forward trades without detected data gaps; it is a review checkpoint, not proof of profitability.</p>
    <div className="orb-forward-grid">{accounts.map(account => <article className="orb-forward-card" key={account.slug}>
      <h3>{account.name.replace('ORB Test: ', '')}</h3>
      <p>{account.active ? `${account.active.side} · ${account.active.status}` : data?.startedAt ? 'No open position' : 'Not started'}</p>
      <dl><div><dt>Forward net P&amp;L</dt><dd>{usd(account.netPnlUsd)}</dd></div><div><dt>Open P&amp;L</dt><dd>{usd(account.active?.unrealizedPnlUsd)}</dd></div><div><dt>Closed trades</dt><dd>{account.closedTrades || 0}</dd></div><div><dt>Data-complete trades</dt><dd>{account.verifiedTrades || 0} / 50</dd></div><div><dt>Closed-trade drawdown</dt><dd>{usd(account.maxDrawdownUsd)}</dd></div><div><dt>Minute-close drawdown</dt><dd>{usd(account.markDrawdownUsd)}</dd></div></dl>
      {account.lastDecision && <p>{account.lastDecision.reason}</p>}
      <details><summary>Forward trade journal ({account.trades?.length || 0})</summary>{account.trades?.length ? <div className="orb-forward-table"><table><thead><tr><th>Date</th><th>Side</th><th>Entry</th><th>Exit</th><th>Net P&amp;L</th><th>Data</th></tr></thead><tbody>{account.trades.map(trade => <tr key={trade.id}><td>{trade.date}</td><td>{trade.side}</td><td>{trade.entry}</td><td>{trade.finalExitPrice}</td><td>{usd(trade.realizedPnlUsd)}</td><td>{trade.dataQuality}</td></tr>)}</tbody></table></div> : <p>No closed forward trades yet.</p>}</details>
    </article>)}</div>
    <p>Drawdowns above use closed trades and minute-close marks, respectively. Neither measures every intraminute price move. Accounts are separate experiments; adding their P&amp;L does not model a shared account.</p>
  </section>;
}
