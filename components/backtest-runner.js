'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'doctortrades-60-day-backtest-v1';

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function money(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);
}

function recommendationClass(value) {
  if (value === 'ADVANCE TO FORWARD TEST') return 'research-verdict-good';
  if (value === 'REJECT CURRENT RULES') return 'research-verdict-bad';
  return 'research-verdict-warn';
}

function BacktestCard({ strategy }) {
  const review = strategy.review;
  return (
    <article className="backtest-card">
      <header>
        <div><span>{strategy.family}</span><h2>{strategy.name}</h2></div>
        <strong className={`research-verdict ${recommendationClass(review.recommendation)}`}>{review.recommendation}</strong>
      </header>
      <dl className="backtest-metrics">
        <div><dt>Simulated trades</dt><dd>{review.total.trades}</dd></div>
        <div><dt>Net P&amp;L</dt><dd>{money(review.total.netPnlUsd)}</dd></div>
        <div><dt>Win rate</dt><dd>{review.total.winRate}%</dd></div>
        <div><dt>Profit factor</dt><dd>{review.total.profitFactor === null ? '—' : review.total.profitFactor.toFixed(2)}</dd></div>
        <div><dt>Expectancy</dt><dd>{money(review.total.expectancyUsd)}</dd></div>
        <div><dt>Max drawdown</dt><dd>{money(review.total.maxDrawdownUsd)}</dd></div>
        <div><dt>Holdout trades</dt><dd>{review.holdout.trades}</dd></div>
        <div><dt>Holdout expectancy</dt><dd>{money(review.holdout.expectancyUsd)}</dd></div>
      </dl>
      <div className="backtest-gates" aria-label={`${strategy.name} backtest gates`}>
        {Object.entries(review.gates).map(([gate, passed]) => (
          <span className={passed ? 'backtest-gate-pass' : 'backtest-gate-fail'} key={gate}>{passed ? 'Pass' : 'Fail'} · {gate.replace(/([A-Z])/g, ' $1')}</span>
        ))}
      </div>
      <div className="research-flags">
        <strong>Recommendation notes</strong>
        {review.redFlags.length ? <ul>{review.redFlags.map((flag) => <li key={flag}>{flag}</li>)}</ul> : <p>Historical gates passed. Advance to forward paper testing, not live capital.</p>}
      </div>
      <p className="backtest-fill-note">{strategy.signals} signals · {strategy.notFilled} unfilled · {strategy.rolloverDaysSkipped} rollover days skipped</p>
    </article>
  );
}

export default function BacktestRunner() {
  const [access, setAccess] = useState({ checking: true, configured: false, operatorConfigured: false, authenticated: false });
  const [passcode, setPasscode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    let saved = null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch {
      // A saved result is optional.
    }
    if (saved) Promise.resolve(saved).then(setResult);
    requestJson('/api/backtest')
      .then(setAccess)
      .catch((err) => setError(err.message))
      .finally(() => setAccess((current) => ({ ...current, checking: false })));
  }, []);

  async function unlock(event) {
    event.preventDefault();
    setBusy('unlock');
    setError('');
    try {
      await requestJson('/api/operator-session', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode })
      });
      const status = await requestJson('/api/backtest');
      setAccess({ ...status, checking: false });
      setPasscode('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function runBacktest() {
    setBusy('run');
    setError('');
    try {
      const data = await requestJson('/api/backtest', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days: 60 })
      });
      setResult(data.result);
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data.result)); } catch { /* optional cache */ }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="backtest-runner">
      <section className="backtest-control panel" aria-labelledby="backtest-control-title">
        <div>
          <span className="section-kicker">60-day walk-forward simulation</span>
          <h2 id="backtest-control-title">Run every strategy against the same NQ history</h2>
          <p>The engine downloads one-minute candles, evaluates signals without future candles, begins fills on the next candle, applies commissions and slippage, and reserves the newest 30% of trades as holdout evidence.</p>
        </div>
        {access.checking ? <p role="status">Checking backtest access…</p> : !access.operatorConfigured ? (
          <p className="live-inline-warning">Operator access must be configured before paid historical data can run.</p>
        ) : !access.authenticated ? (
          <form className="operator-form backtest-unlock" onSubmit={unlock}>
            <label htmlFor="backtest-passcode">Operator passcode</label>
            <div>
              <input id="backtest-passcode" type="password" autoComplete="current-password" maxLength="512" required value={passcode} onChange={(event) => setPasscode(event.target.value)} />
              <button className="secondary-button" disabled={Boolean(busy)} type="submit">{busy === 'unlock' ? 'Unlocking…' : 'Unlock'}</button>
            </div>
          </form>
        ) : (
          <div className="backtest-action">
            <button className="primary-button" disabled={Boolean(busy) || !access.configured} onClick={runBacktest} type="button">
              {busy === 'run' ? 'Running 60-day backtest…' : 'Run last 60 days'}
            </button>
            {!access.configured ? <p className="live-inline-warning">Historical data is not connected yet. Add Databento access on Vercel or update the VPS bridge.</p> : null}
          </div>
        )}
        {error ? <p className="error-box" role="alert">{error}</p> : null}
      </section>

      {result ? (
        <section className="backtest-results" aria-labelledby="backtest-results-title">
          <div className="section-heading">
            <div><span className="section-kicker">Historical simulated evidence</span><h2 id="backtest-results-title">Backtest results</h2></div>
            <p>{result.window?.days || 60} days · {result.tradingDays} sessions · {result.candles.toLocaleString()} candles</p>
          </div>
          <aside className="backtest-disclosure"><strong>Not verified forward trades.</strong> These results can recommend advancing a strategy to forward paper testing. They cannot promote a strategy directly to live trading.</aside>
          <div className="backtest-grid">{result.strategies.map((strategy) => <BacktestCard key={strategy.slug} strategy={strategy} />)}</div>
          <p className="backtest-method">{result.methodology} Cost model: {result.costs.slippageTicks} tick slippage and {money(result.costs.commissionPerContractUsd)} commission per contract.</p>
        </section>
      ) : null}
    </div>
  );
}
