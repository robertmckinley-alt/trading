'use client';

import { useEffect, useState } from 'react';

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function formatStamp(value) {
  if (!value) return 'n/a';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function outcomeTone(strategy) {
  if (strategy.mode === 'paper-route') return 'neutral';
  if (strategy.watcher?.isRunning && !strategy.live?.latestError) return 'good';
  if (strategy.live?.latestError) return 'warn';
  return 'neutral';
}

function StrategyOutcome({ strategy }) {
  if (strategy.mode === 'paper-route') {
    return (
      <div className="strategy-outcome">
        <p className="outcome-label">Current outcome</p>
        <strong>{strategy.setupSummary?.outcome || 'Paper route'}</strong>
        <span>
          {strategy.setupSummary?.entryModel || 'manual'} / {strategy.setupSummary?.gapType || 'n/a'}
        </span>
      </div>
    );
  }

  const candle = strategy.live?.lastCandle;
  return (
    <div className="strategy-outcome">
      <p className="outcome-label">Current outcome</p>
      <strong>{strategy.live?.latestReason || strategy.watcher?.statusLabel || 'Unknown'}</strong>
      <span>
        {candle ? `Last close ${candle.close} at ${formatStamp(candle.timestamp)}` : 'No live candle yet'}
      </span>
    </div>
  );
}

function StrategyCard({ strategy }) {
  const tone = outcomeTone(strategy);
  const journal = strategy.journal || {};

  return (
    <article className={`live-card live-card-${tone}`}>
      <div className="live-card-head">
        <div>
          <p className="eyebrow">Strategy</p>
          <h3>{strategy.name}</h3>
          <p className="live-inline-meta">{strategy.paperAccountLabel}</p>
        </div>
        <a className="ghost-link" href={strategy.route}>
          Open route
        </a>
      </div>

      <div className="live-pill-row">
        <span>{formatUsd(strategy.bankrollUsd)} bankroll</span>
        <span>{strategy.maxDrawdownPercent}% max DD</span>
        <span>{strategy.ticker}</span>
      </div>

      <div className="live-mini-grid">
        <div>
          <span>Mode</span>
          <strong>{strategy.mode === 'live-watcher' ? 'Live watcher' : 'Separate paper route'}</strong>
        </div>
        <div>
          <span>Provider</span>
          <strong>{strategy.provider}</strong>
        </div>
        <div>
          <span>Trades</span>
          <strong>{journal.trades ?? 0}</strong>
        </div>
        <div>
          <span>Realized</span>
          <strong>{formatUsd(journal.realizedPnlUsd ?? 0)}</strong>
        </div>
      </div>

      {strategy.mode === 'live-watcher' ? (
        <div className="live-status-strip">
          <span className={`live-dot ${strategy.watcher?.isRunning ? 'live-dot-good' : 'live-dot-warn'}`} />
          <strong>{strategy.watcher?.statusLabel || 'Unknown'}</strong>
          <span>PID {strategy.watcher?.pid || 'n/a'}</span>
        </div>
      ) : null}

      <StrategyOutcome strategy={strategy} />

      {strategy.mode === 'live-watcher' && strategy.live?.latestError ? (
        <p className="live-inline-error">Latest runtime noise: {strategy.live.latestError.message}</p>
      ) : null}
      {strategy.mode === 'live-watcher' && !strategy.live?.latestError && strategy.live?.activationTime ? (
        <p className="live-inline-meta">Activation gate: {strategy.live.activationTime}</p>
      ) : null}
      {strategy.journalScope ? (
        <p className="live-inline-meta">{strategy.journalScope}</p>
      ) : null}
      {strategy.mode === 'paper-route' && strategy.setupSummary?.targets?.length ? (
        <p className="live-inline-meta">
          Sample targets: {strategy.setupSummary.targets.join(', ')}
        </p>
      ) : null}
    </article>
  );
}

export default function LiveStrategyBoard({ initialData }) {
  const [data, setData] = useState(initialData);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const response = await fetch('/api/live-status', { cache: 'no-store' });
        const payload = await response.json();
        if (!cancelled && payload?.strategies) {
          setData(payload);
        }
      } catch {
        // Keep the last good snapshot visible.
      }
    }

    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const strategies = Array.isArray(data?.strategies) ? data.strategies : [];

  return (
    <section className="live-board">
      <div className="live-board-head">
        <div>
          <p className="eyebrow">Main page visual</p>
          <h2>Both strategies plus current outcomes</h2>
        </div>
        <div className="live-board-meta">
          <span>Source: {data?.source || 'unknown'}</span>
          <span>Updated: {formatStamp(data?.generatedAt)}</span>
        </div>
      </div>

      {data?.error ? <p className="live-inline-error">Bridge warning: {data.error}</p> : null}

      <div className="live-board-grid">
        {strategies.map((strategy) => (
          <StrategyCard key={strategy.slug} strategy={strategy} />
        ))}
      </div>
    </section>
  );
}
