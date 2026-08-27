'use client';

import { useEffect, useState } from 'react';

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function formatStamp(value) {
  if (!value) return 'n/a';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function buildPortfolioTotals(strategies) {
  return strategies.reduce(
    (totals, strategy) => {
      const journal = strategy.journal || {};
      totals.bankrollUsd += Number(strategy.bankrollUsd || 0);
      totals.balanceUsd += Number(journal.balanceUsd ?? strategy.bankrollUsd ?? 0);
      totals.realizedPnlUsd += Number(journal.realizedPnlUsd || 0);
      totals.trades += Number(journal.trades || 0);
      totals.wins += Number(journal.wins || 0);
      totals.losses += Number(journal.losses || 0);
      if (strategy.mode === 'live-watcher') {
        totals.automatedStrategies += 1;
        if (strategy.watcher?.isRunning) totals.runningWatchers += 1;
      }
      if (strategy.mode === 'paper-route') totals.manualRoutes += 1;
      return totals;
    },
    {
      bankrollUsd: 0,
      balanceUsd: 0,
      realizedPnlUsd: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      automatedStrategies: 0,
      runningWatchers: 0,
      manualRoutes: 0
    }
  );
}

function buildDailyTotals(strategies) {
  return strategies.reduce(
    (totals, strategy) => {
      const daily = strategy.journal?.daily || {};
      totals.realizedPnlUsd += Number(daily.realizedPnlUsd || 0);
      totals.activeRealizedPnlUsd += Number(daily.activeRealizedPnlUsd || 0);
      totals.activeUnrealizedPnlUsd += Number(daily.activeUnrealizedPnlUsd || 0);
      totals.activePnlUsd += Number(daily.activePnlUsd || 0);
      totals.trades += Number(daily.trades || 0);
      totals.wins += Number(daily.wins || 0);
      totals.losses += Number(daily.losses || 0);
      if (!totals.date && daily.date) totals.date = daily.date;
      if (daily.openTradeStatus) totals.openTrades += 1;
      return totals;
    },
    {
      date: null,
      realizedPnlUsd: 0,
      activeRealizedPnlUsd: 0,
      activeUnrealizedPnlUsd: 0,
      activePnlUsd: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      openTrades: 0
    }
  );
}

function buildRecapDates(strategies) {
  return [...new Set(strategies.flatMap((strategy) => (
    Array.isArray(strategy.journal?.dailyRecaps)
      ? strategy.journal.dailyRecaps.map((recap) => recap.date)
      : []
  )).filter(Boolean))].sort().reverse();
}

function findStrategyRecap(strategy, date) {
  return Array.isArray(strategy.journal?.dailyRecaps)
    ? strategy.journal.dailyRecaps.find((recap) => recap.date === date) || null
    : null;
}

function buildRecapForDate(strategies, date) {
  return strategies.reduce(
    (recap, strategy) => {
      const strategyRecap = findStrategyRecap(strategy, date);
      if (!strategyRecap) {
        recap.strategyRows.push({
          slug: strategy.slug,
          name: strategy.paperAccountLabel,
          strategyName: strategy.name,
          activePnlUsd: 0,
          realizedPnlUsd: 0,
          trades: 0,
          wins: 0,
          losses: 0,
          openTradeStatus: null,
          tradesList: []
        });
        return recap;
      }

      recap.trades += Number(strategyRecap.trades || 0);
      recap.wins += Number(strategyRecap.wins || 0);
      recap.losses += Number(strategyRecap.losses || 0);
      recap.realizedPnlUsd += Number(strategyRecap.realizedPnlUsd || 0);
      recap.activePnlUsd += Number(strategyRecap.activePnlUsd || 0);
      recap.activeUnrealizedPnlUsd += Number(strategyRecap.activeUnrealizedPnlUsd || 0);
      recap.avgRTotal += Number(strategyRecap.avgR || 0) * Number(strategyRecap.trades || 0);
      recap.openTrades += strategyRecap.openTradeStatus ? 1 : 0;
      recap.tradesList.push(...(strategyRecap.tradesList || []).map((trade) => ({
        ...trade,
        strategyName: strategy.name,
        account: strategy.paperAccountLabel
      })));
      recap.strategyRows.push({
        slug: strategy.slug,
        name: strategy.paperAccountLabel,
        strategyName: strategy.name,
        activePnlUsd: Number(strategyRecap.activePnlUsd || 0),
        realizedPnlUsd: Number(strategyRecap.realizedPnlUsd || 0),
        trades: Number(strategyRecap.trades || 0),
        wins: Number(strategyRecap.wins || 0),
        losses: Number(strategyRecap.losses || 0),
        openTradeStatus: strategyRecap.openTradeStatus || null,
        tradesList: strategyRecap.tradesList || []
      });
      return recap;
    },
    {
      date,
      trades: 0,
      wins: 0,
      losses: 0,
      realizedPnlUsd: 0,
      activePnlUsd: 0,
      activeUnrealizedPnlUsd: 0,
      avgRTotal: 0,
      openTrades: 0,
      strategyRows: [],
      tradesList: []
    }
  );
}

function outcomeTone(strategy) {
  if (strategy.mode === 'paper-route') return 'neutral';
  if (strategy.watcher?.isRunning && !strategy.live?.latestError) return 'good';
  if (strategy.live?.latestError) return 'warn';
  if (strategy.watcher?.hasLiveEvidence || strategy.watcher?.staleStatusHint) return 'warn';
  return 'neutral';
}

function DailyTracker({ strategies, selectedDate, onDateChange }) {
  const daily = buildDailyTotals(strategies);
  const recapDates = buildRecapDates(strategies);
  const activeDate = selectedDate || recapDates[0] || daily.date || new Date().toISOString().slice(0, 10);
  const selectedRecap = buildRecapForDate(strategies, activeDate);
  const selectedWinRate = selectedRecap.trades > 0 ? (selectedRecap.wins / selectedRecap.trades) * 100 : 0;
  const selectedAvgR = selectedRecap.trades > 0 ? selectedRecap.avgRTotal / selectedRecap.trades : 0;
  const hasDailyActivity = daily.trades > 0 || daily.openTrades > 0 || daily.activePnlUsd !== 0;
  const hasSelectedActivity = selectedRecap.trades > 0 || selectedRecap.openTrades > 0 || selectedRecap.activePnlUsd !== 0;

  return (
    <div className="daily-tracker" aria-label="Daily active PnL tracker">
      <div className="daily-tracker-head">
        <div>
          <span>Daily tracker</span>
          <strong>{daily.date || 'Current session'}</strong>
        </div>
        <p>{hasDailyActivity ? `${daily.openTrades} open / ${daily.trades} closed today` : 'No trades recorded for the current trading date yet'}</p>
      </div>

      <div className="daily-tracker-grid">
        <div className="daily-tracker-metric daily-tracker-primary">
          <span>Active PnL</span>
          <strong>{formatUsd(daily.activePnlUsd)}</strong>
          <p>Realized plus open-position mark</p>
        </div>
        <div className="daily-tracker-metric">
          <span>Today realized</span>
          <strong>{formatUsd(daily.realizedPnlUsd)}</strong>
          <p>{daily.wins} wins / {daily.losses} losses</p>
        </div>
        <div className="daily-tracker-metric">
          <span>Open unrealized</span>
          <strong>{formatUsd(daily.activeUnrealizedPnlUsd)}</strong>
          <p>{daily.openTrades} active position{daily.openTrades === 1 ? '' : 's'}</p>
        </div>
        <div className="daily-tracker-metric">
          <span>Today trades</span>
          <strong>{daily.trades}</strong>
          <p>Closed journal entries</p>
        </div>
      </div>

      <div className="daily-strategy-list">
        {strategies.map((strategy) => {
          const item = strategy.journal?.daily || {};
          return (
            <div className="daily-strategy-row" key={strategy.slug}>
              <span>{strategy.paperAccountLabel}</span>
              <strong>{formatUsd(item.activePnlUsd || 0)}</strong>
              <p>{item.trades || 0} trades / {item.openTradeStatus || 'no open trade'}</p>
            </div>
          );
        })}
      </div>

      <div className="daily-recap">
        <div className="daily-recap-head">
          <div>
            <span>Daily recap</span>
            <strong>{activeDate}</strong>
          </div>
          <label>
            <span>Search date</span>
            <input
              type="date"
              value={activeDate}
              onChange={(event) => onDateChange(event.target.value)}
            />
          </label>
        </div>

        {recapDates.length ? (
          <div className="recap-date-strip" aria-label="Recent recap dates">
            {recapDates.slice(0, 8).map((date) => (
              <button
                className={date === activeDate ? 'recap-date-button recap-date-button-active' : 'recap-date-button'}
                key={date}
                type="button"
                onClick={() => onDateChange(date)}
              >
                {date}
              </button>
            ))}
          </div>
        ) : null}

        <div className="daily-tracker-grid">
          <div className="daily-tracker-metric daily-tracker-primary">
            <span>Recap PnL</span>
            <strong>{formatUsd(selectedRecap.activePnlUsd)}</strong>
            <p>{hasSelectedActivity ? `${selectedRecap.openTrades} open / ${selectedRecap.trades} closed` : 'No trades found for this date'}</p>
          </div>
          <div className="daily-tracker-metric">
            <span>Closed PnL</span>
            <strong>{formatUsd(selectedRecap.realizedPnlUsd)}</strong>
            <p>{selectedRecap.wins} wins / {selectedRecap.losses} losses</p>
          </div>
          <div className="daily-tracker-metric">
            <span>Win rate</span>
            <strong>{formatPercent(selectedWinRate)}</strong>
            <p>{selectedRecap.trades} closed trade{selectedRecap.trades === 1 ? '' : 's'}</p>
          </div>
          <div className="daily-tracker-metric">
            <span>Avg R</span>
            <strong>{selectedAvgR.toFixed(2)}R</strong>
            <p>{formatUsd(selectedRecap.activeUnrealizedPnlUsd)} open mark</p>
          </div>
        </div>

        <div className="daily-strategy-list">
          {selectedRecap.strategyRows.map((row) => (
            <div className="daily-strategy-row" key={row.slug}>
              <span>{row.name}</span>
              <strong>{formatUsd(row.activePnlUsd)}</strong>
              <p>{row.trades} trades / {row.openTradeStatus || 'no open trade'}</p>
            </div>
          ))}
        </div>

        <div className="recap-trade-list">
          {selectedRecap.tradesList.length ? selectedRecap.tradesList.map((trade) => (
            <article className="recap-trade-row" key={trade.id}>
              <div className="recap-trade-main">
                <div>
                  <span>{trade.account}</span>
                  <strong>{trade.symbol} {String(trade.side || '').toUpperCase()}</strong>
                </div>
                <p>{trade.thesis || `${trade.strategyName} trade`}</p>
              </div>

              <div className="recap-trade-facts">
                <div>
                  <span>Entry</span>
                  <strong>{trade.entry ?? 'n/a'}</strong>
                </div>
                <div>
                  <span>Stop</span>
                  <strong>{trade.stop ?? 'n/a'}</strong>
                </div>
                <div>
                  <span>Exit</span>
                  <strong>{trade.finalExitPrice ?? 'n/a'}</strong>
                </div>
                <div>
                  <span>Result</span>
                  <strong>{formatUsd(trade.realizedPnlUsd)} / {Number(trade.rMultiple || 0).toFixed(2)}R</strong>
                </div>
              </div>

              <div className="recap-trade-tags">
                <span>{trade.exitReason || 'closed'}</span>
                {trade.entryModel ? <span>{trade.entryModel}</span> : null}
                {trade.gapType ? <span>{trade.gapType}</span> : null}
                {trade.liquidityLabel ? <span>{trade.liquidityLabel}</span> : null}
              </div>

              <div className="recap-trade-foot">
                <span>Filled {trade.filledAt ? formatStamp(trade.filledAt) : 'n/a'}</span>
                <span>Targets hit: {trade.targetsHit?.length ? trade.targetsHit.join(', ') : 'none'}</span>
                <span>Draw: {trade.drawOnLiquidity?.length ? trade.drawOnLiquidity.join(', ') : 'n/a'}</span>
              </div>
            </article>
          )) : (
            <p className="empty-copy">No journaled trades for {activeDate}.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function PortfolioTotals({ strategies }) {
  const totals = buildPortfolioTotals(strategies);
  const winRate = totals.trades > 0 ? (totals.wins / totals.trades) * 100 : 0;
  const returnPercent = totals.bankrollUsd > 0 ? (totals.realizedPnlUsd / totals.bankrollUsd) * 100 : 0;

  return (
    <div className="portfolio-totals" aria-label="Running strategy totals">
      <div className="portfolio-total-card portfolio-total-card-primary">
        <span>Combined balance</span>
        <strong>{formatUsd(totals.balanceUsd)}</strong>
        <p>{formatUsd(totals.realizedPnlUsd)} realized across {formatUsd(totals.bankrollUsd)} allocated</p>
      </div>
      <div className="portfolio-total-card">
        <span>Total trades</span>
        <strong>{totals.trades}</strong>
        <p>{totals.wins} wins / {totals.losses} losses</p>
      </div>
      <div className="portfolio-total-card">
        <span>Win rate</span>
        <strong>{formatPercent(winRate)}</strong>
        <p>{formatPercent(returnPercent)} realized return</p>
      </div>
      <div className="portfolio-total-card">
        <span>Automated strategies</span>
        <strong>{totals.automatedStrategies}/{strategies.length}</strong>
        <p>{totals.runningWatchers} running live watcher, {totals.manualRoutes} manual only</p>
      </div>
    </div>
  );
}

function StrategyOutcome({ strategy, isBridgeFallback }) {
  if (strategy.mode === 'paper-route') {
    return (
      <div className="strategy-outcome">
        <p className="outcome-label">Current outcome</p>
        <strong>Not live automated yet</strong>
        <span>
          {strategy.setupSummary?.outcome || 'Separate manual paper route; no VPS watcher attached.'}
        </span>
      </div>
    );
  }

  const candle = strategy.live?.lastCandle;
  const primaryOutcome = strategy.live?.latestReason
    || (candle ? 'Watching live candle stream' : null)
    || (isBridgeFallback ? 'Waiting on fresh bridge snapshot' : null)
    || strategy.watcher?.statusLabel
    || 'Unknown';
  const secondaryOutcome = candle
    ? `Last close ${candle.close} at ${formatStamp(candle.timestamp)}`
    : isBridgeFallback
      ? 'Remote bridge timed out; showing local fallback only'
      : 'No live candle yet';

  return (
    <div className="strategy-outcome">
      <p className="outcome-label">Current outcome</p>
      <strong>{primaryOutcome}</strong>
      <span>{secondaryOutcome}</span>
    </div>
  );
}

function StrategyCard({ strategy, isBridgeFallback }) {
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
          <strong>{strategy.mode === 'live-watcher' ? 'Live watcher' : 'Manual only'}</strong>
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
      ) : (
        <div className="live-status-strip">
          <span className="live-dot live-dot-warn" />
          <strong>No live watcher</strong>
          <span>Manual journal only</span>
        </div>
      )}

      <StrategyOutcome strategy={strategy} isBridgeFallback={isBridgeFallback} />

      {strategy.mode === 'live-watcher' && strategy.live?.latestError ? (
        <p className="live-inline-error">Latest runtime noise: {strategy.live.latestError.message}</p>
      ) : null}
      {strategy.mode === 'live-watcher' && strategy.watcher?.staleStatusHint ? (
        <p className="live-inline-warning">{strategy.watcher.staleStatusHint}</p>
      ) : null}
      {strategy.mode === 'live-watcher' && !strategy.live?.latestError && strategy.live?.activationTime ? (
        <p className="live-inline-meta">Activation gate: {strategy.live.activationTime}</p>
      ) : null}
      {strategy.journalScope ? (
        <p className="live-inline-meta">{strategy.journalScope}</p>
      ) : null}
      {strategy.mode === 'paper-route' && strategy.setupSummary?.targets?.length ? (
        <p className="live-inline-meta">
          Sample model: {strategy.setupSummary?.entryModel || 'manual'} / {strategy.setupSummary?.gapType || 'n/a'}.
          Targets: {strategy.setupSummary.targets.join(', ')}
        </p>
      ) : null}
    </article>
  );
}

export default function LiveStrategyBoard({ initialData }) {
  const [data, setData] = useState(initialData);
  const [selectedDate, setSelectedDate] = useState('');

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
  const isBridgeFallback = data?.source === 'remote-bridge-fallback';

  return (
    <section className="live-board">
      <div className="live-board-head">
        <div>
          <p className="eyebrow">Main page visual</p>
          <h2>Dashboard totals and current outcomes</h2>
        </div>
        <div className="live-board-meta">
          <span>Source: {isBridgeFallback ? 'fallback snapshot' : data?.source || 'unknown'}</span>
          <span>Updated: {formatStamp(data?.generatedAt)}</span>
        </div>
      </div>

      {data?.error ? (
        <p className="live-inline-warning">
          Bridge warning: remote status timed out, so this board is showing the local fallback snapshot. {data.error}
        </p>
      ) : null}

      <PortfolioTotals strategies={strategies} />
      <DailyTracker strategies={strategies} selectedDate={selectedDate} onDateChange={setSelectedDate} />

      <div className="live-board-grid">
        {strategies.map((strategy) => (
          <StrategyCard key={strategy.slug} strategy={strategy} isBridgeFallback={isBridgeFallback} />
        ))}
      </div>
    </section>
  );
}
