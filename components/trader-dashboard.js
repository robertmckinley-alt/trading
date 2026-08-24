'use client';

import { useEffect, useMemo, useState } from 'react';

const DEFAULT_STORAGE_KEY = 'lucid-nq-paper-trader-journal-v1';

const defaultSetup = {
  symbol: 'NQ',
  date: '2026-08-24',
  session: '9AM New York',
  side: 'short',
  entry: 23215.25,
  stop: 23224.75,
  targets: [23202.75, 23195.25, 23184.75],
  thesis: 'At 9AM New York, mark the Asia and London highs or lows, wait for the sweep, then take the 1-minute FVG reversal back into the next draw on liquidity.',
  setup: {
    liquiditySweep: true,
    reaction: 'bearish',
    entryModel: 'session-sweep-fvg-reversal',
    gapType: 'fvg',
    entryTimeframe: 'M1',
    activationTime: '09:00 America/New_York',
    referenceSessions: ['asia', 'london'],
    stopPlacement: 'swing-high',
    liquidityPool: 'london-or-asia-high',
    liquidityLabel: 'Asia / London session high',
    drawOnLiquidity: ['vwap', 'intraday-sell-side', 'current-week-low']
  }
};

function buildEmptyState(config) {
  return {
    startingBalanceUsd: config.startingBalanceUsd,
    balanceUsd: config.startingBalanceUsd,
    realizedPnlUsd: 0,
    trades: [],
    lastUpdatedAt: null
  };
}

function hydrateState(rawState, config) {
  if (!rawState) {
    return buildEmptyState(config);
  }
  const realized = Number(rawState.realizedPnlUsd || 0);
  return {
    startingBalanceUsd: config.startingBalanceUsd,
    balanceUsd: Number((config.startingBalanceUsd + realized).toFixed(2)),
    realizedPnlUsd: Number(realized.toFixed(2)),
    trades: Array.isArray(rawState.trades) ? rawState.trades : [],
    lastUpdatedAt: rawState.lastUpdatedAt || null
  };
}

function computeReport(state, config) {
  const totalTrades = state.trades.length;
  const wins = state.trades.filter((trade) => trade.realizedPnlUsd > 0).length;
  const losses = state.trades.filter((trade) => trade.realizedPnlUsd < 0).length;
  const floorUsd = Number((config.startingBalanceUsd * (1 - (config.maxAccountDrawdownPercent / 100))).toFixed(2));
  const drawdownRoomUsd = Number((state.balanceUsd - floorUsd).toFixed(2));
  const avgR = totalTrades
    ? Number((state.trades.reduce((sum, trade) => sum + Number(trade.rMultiple || 0), 0) / totalTrades).toFixed(2))
    : 0;

  return {
    totalTrades,
    wins,
    losses,
    winRate: totalTrades ? Number(((wins / totalTrades) * 100).toFixed(1)) : 0,
    avgR,
    floorUsd,
    drawdownRoomUsd,
    locked: drawdownRoomUsd <= 0
  };
}

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
}

function StatCard({ label, value, hint }) {
  return (
    <article className="stat-card">
      <p>{label}</p>
      <h3>{value}</h3>
      <span>{hint}</span>
    </article>
  );
}

export default function TraderDashboard({
  initialConfig,
  initialSetupText,
  initialCsvText,
  storageKey = DEFAULT_STORAGE_KEY
}) {
  const [setupText, setSetupText] = useState(initialSetupText);
  const [csvText, setCsvText] = useState(initialCsvText);
  const [journalState, setJournalState] = useState(() => buildEmptyState(initialConfig));
  const [plan, setPlan] = useState(null);
  const [replayResult, setReplayResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return;
    try {
      setJournalState(hydrateState(JSON.parse(stored), initialConfig));
    } catch {
      window.localStorage.removeItem(storageKey);
    }
  }, [initialConfig, storageKey]);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(journalState));
  }, [journalState, storageKey]);

  const report = useMemo(() => computeReport(journalState, initialConfig), [journalState, initialConfig]);

  function parseSetup() {
    const parsed = JSON.parse(setupText);
    return { ...defaultSetup, ...parsed, setup: { ...defaultSetup.setup, ...(parsed.setup || {}) } };
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.errors ? data.errors.join('\n') : data.error || 'Request failed');
    }
    return data;
  }

  async function handlePlan() {
    setBusy('plan');
    setError('');
    try {
      const setup = parseSetup();
      const data = await postJson('/api/plan', { setup, journalState });
      setPlan(data.plan);
      setReplayResult(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function handleReplay({ saveTrade }) {
    setBusy(saveTrade ? 'journal' : 'replay');
    setError('');
    try {
      const setup = parseSetup();
      const data = await postJson('/api/replay', { setup, csvText, journalState, journalTrade: saveTrade });
      setPlan(data.plan);
      setReplayResult(data.replayResult);
      if (saveTrade && data.trade) {
        setJournalState((current) => hydrateState({
          ...current,
          trades: [...current.trades, data.trade],
          realizedPnlUsd: Number((current.realizedPnlUsd + data.trade.realizedPnlUsd).toFixed(2)),
          lastUpdatedAt: new Date().toISOString()
        }, initialConfig));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function resetJournal() {
    const empty = buildEmptyState(initialConfig);
    setJournalState(empty);
    window.localStorage.setItem(storageKey, JSON.stringify(empty));
  }

  return (
    <section className="dashboard-grid">
      <div className="editor-stack">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Setup JSON</p>
              <h2>Plan the exact clip model</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => setSetupText(initialSetupText)}>Reload sample</button>
          </div>
          <textarea value={setupText} onChange={(event) => setSetupText(event.target.value)} spellCheck="false" />
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">1m CSV</p>
              <h2>Replay against candles</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => setCsvText(initialCsvText)}>Reload sample</button>
          </div>
          <textarea className="csv-box" value={csvText} onChange={(event) => setCsvText(event.target.value)} spellCheck="false" />
        </article>

        <div className="action-row">
          <button className="primary-button" type="button" onClick={handlePlan} disabled={Boolean(busy)}>
            {busy === 'plan' ? 'Planning...' : 'Run plan'}
          </button>
          <button className="secondary-button" type="button" onClick={() => handleReplay({ saveTrade: false })} disabled={Boolean(busy)}>
            {busy === 'replay' ? 'Replaying...' : 'Replay only'}
          </button>
          <button className="secondary-button" type="button" onClick={() => handleReplay({ saveTrade: true })} disabled={Boolean(busy)}>
            {busy === 'journal' ? 'Journaling...' : 'Replay + journal'}
          </button>
        </div>
        {error ? <p className="error-box">{error}</p> : null}
      </div>

      <div className="results-stack">
        <article className="panel highlight-panel">
          <p className="eyebrow">Account guardrails</p>
          <div className="stat-grid">
            <StatCard label="Balance" value={formatUsd(journalState.balanceUsd)} hint="Browser-local journal state" />
            <StatCard label="Floor" value={formatUsd(report.floorUsd)} hint="10% max drawdown floor" />
            <StatCard label="Room left" value={formatUsd(report.drawdownRoomUsd)} hint={report.locked ? 'Locked until reset' : 'Available before floor'} />
            <StatCard label="Win rate" value={`${report.winRate}%`} hint={`${report.totalTrades} journaled trades`} />
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Current plan</p>
              <h2>Sizing and narrative</h2>
            </div>
          </div>
          {plan ? (
            <div className="result-body">
              <div className="mini-grid">
                <div>
                  <span>Contracts</span>
                  <strong>{plan.sizing.maxContracts}</strong>
                </div>
                <div>
                  <span>Planned risk</span>
                  <strong>{formatUsd(plan.sizing.actualRiskUsd)}</strong>
                </div>
                <div>
                  <span>Stop distance</span>
                  <strong>{plan.sizing.stopDistancePoints} pts</strong>
                </div>
                <div>
                  <span>Model</span>
                  <strong>{plan.narrative.entryModel}</strong>
                </div>
              </div>
              <pre>{JSON.stringify(plan, null, 2)}</pre>
            </div>
          ) : (
            <p className="empty-copy">Run a plan to see contract sizing, target R multiples, and the exact rule payload sent to the engine.</p>
          )}
        </article>

        <article className="panel">
          <p className="eyebrow">Replay result</p>
          <h2>Outcome on uploaded candles</h2>
          {replayResult ? (
            <div className="result-body">
              <div className="mini-grid">
                <div>
                  <span>Status</span>
                  <strong>{replayResult.status}</strong>
                </div>
                <div>
                  <span>PnL</span>
                  <strong>{formatUsd(replayResult.realizedPnlUsd)}</strong>
                </div>
                <div>
                  <span>R multiple</span>
                  <strong>{replayResult.rMultiple}R</strong>
                </div>
                <div>
                  <span>Filled at</span>
                  <strong>{replayResult.filledAt || 'Not filled'}</strong>
                </div>
              </div>
              <pre>{JSON.stringify(replayResult, null, 2)}</pre>
            </div>
          ) : (
            <p className="empty-copy">Replay the setup to inspect fills, target hits, stop behavior, and end-of-data closes.</p>
          )}
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Journal</p>
              <h2>Vercel-safe local persistence</h2>
            </div>
            <button className="ghost-button danger" type="button" onClick={resetJournal}>Reset journal</button>
          </div>
          <div className="mini-grid journal-grid">
            <div>
              <span>Realized</span>
              <strong>{formatUsd(journalState.realizedPnlUsd)}</strong>
            </div>
            <div>
              <span>Avg R</span>
              <strong>{report.avgR}R</strong>
            </div>
            <div>
              <span>Wins / Losses</span>
              <strong>{report.wins} / {report.losses}</strong>
            </div>
            <div>
              <span>Last update</span>
              <strong>{journalState.lastUpdatedAt ? new Date(journalState.lastUpdatedAt).toLocaleString() : 'Fresh slate'}</strong>
            </div>
          </div>
          <div className="trade-list">
            {journalState.trades.length ? journalState.trades.slice().reverse().map((trade) => (
              <article key={trade.id} className="trade-card">
                <div>
                  <p>{trade.date} {trade.symbol} {trade.side.toUpperCase()}</p>
                  <span>{trade.exitReason}</span>
                </div>
                <strong>{formatUsd(trade.realizedPnlUsd)}</strong>
              </article>
            )) : <p className="empty-copy">No browser-saved trades yet. Use Replay + journal to build a local track record.</p>}
          </div>
        </article>
      </div>
    </section>
  );
}
