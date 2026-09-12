const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executeBacktest, getBacktestStatus, requestBacktestRefresh } = require('../lib/backtest-service.cjs');

function session(date) {
  const start = Date.parse(`${date}T14:30:00Z`);
  return Array.from({ length: 390 }, (_, i) => {
    const price = i < 15 ? 20000 : i < 30 ? 20000 + (i - 15) * .4 : i < 40 ? 20006 + (i - 30) : 20016;
    return { timestamp: new Date(start + i * 60000).toISOString(), open: price,
      high: price + 1, low: price - 1, close: price + .5, volume: 100, instrumentId: 1 };
  });
}

test('historical fetch flows through all algorithms into versioned learning without touching live state', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-integration-'));
  const states = fs.readdirSync(process.cwd()).filter((name) => /^state.*json$/.test(name));
  const before = states.map((name) => fs.readFileSync(name, 'utf8'));
  const records = [...session('2026-01-05'), ...session('2026-01-06')];
  const events = [];
  try {
    const result = await executeBacktest({ year: 2026, now: new Date('2026-01-07T01:00:00Z'), cacheDir,
      env: { DATABENTO_API_KEY: 'test-only' }, onProgress: (event) => events.push(event),
      fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(records) }) });
    assert.equal(result.strategies.length, 30);
    assert.equal(result.researchVersion, "all-strategy-fixed-risk-v1");
    assert.ok(result.strategies.every((strategy) => strategy.research?.review && !("drawdown" in strategy.research.review.gates)));
    assert.equal(result.learning.trials.length, 15);
    assert.equal(result.learning.forwardPaperGate.livePromotionAllowed, false);
    assert.equal(result.validation.version, 'all-strategy-validation-v1');
    assert.equal(result.validation.strategies.length, 30);
    assert.equal(result.validation.parameterRobustness.testedVariants, 11, 'fade is evaluated separately, not counted as a neighboring breakout parameter');
    assert.equal(result.validation.controls.automaticOptimization, false);
    assert.equal(result.learning.candidate, null);
    assert.equal(result.provenance.executionVersion, 'orb-execution-v3-cash-session');
    assert.equal(result.provenance.dataFingerprint.length, 64);
    const baseline = result.strategies.find((s) => s.slug === 'nq-15m-orb-close-confirmation');
    assert.equal(baseline.research.trades.length, 2);
    assert.equal(result.orbResearchVersion, 'one-contract-v1');
    assert.ok(result.learning.trials.every(trial => trial.sizingMode === 'fixed-contract' && trial.valid));
    assert.equal(result.learning.manifest.researchMode, 'fixed-contract');
    assert.equal(result.learning.manifest.riskPerTradeUsd, null);
    assert.equal(baseline.research.signalAudit.length, 2);
    assert.ok(baseline.research.trades.every(trade => trade.contracts === 1));
    assert.equal(baseline.trades[0].execution.model, 'next-bar-market');
    assert.equal(baseline.trades[0].filledAt, '2026-01-05T15:00:00.000Z');
    assert.ok(baseline.trades[0].entry > 20006, 'entry slippage included');
    assert.equal(events.filter((event) => event.phase === 'strategy-completed').length, 30);
    assert.deepEqual(states.map((name) => fs.readFileSync(name, 'utf8')), before);
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

test('queued bridge starts once, keeps authorization private and returns pending progress', async () => {
  const requests = [];
  const status = await requestBacktestRefresh({ startYear: 2025,
    env: { BACKTEST_SOURCE_URL: 'https://bridge.example/api/backtest', LIVE_STATUS_TOKEN: 'test-token' },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ ok: true, pending: true, progress: { phase: 'starting' } }) }; } });
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].options.body), { startYear: 2025, background: true });
  assert.equal(requests[0].options.headers.authorization, 'Bearer test-token');
  assert.equal(status.pending, true);
  assert.equal(JSON.stringify(status).includes('test-token'), false);
});

test('status keeps last completed report while a new run is pending, including first-run empty state', async () => {
  for (const result of [null, { generatedAt: '2026-01-01T00:00:00Z' }]) {
    const status = await getBacktestStatus({ env: { BACKTEST_SOURCE_URL: 'https://bridge.example/api/backtest' },
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, pending: true, result, progress: { phase: 'simulating', strategyIndex: 2 } }) }) });
    assert.deepEqual(status.result, result);
    assert.equal(status.pending, true);
    assert.equal(status.progress.strategyIndex, 2);
  }
});
