const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validate, runDaily, monitor } = require('../lib/orb-discovery.cjs');
const { attachCandidates, createState } = require('../lib/orb-forward.cjs');
const config = require('../lib/trader-core.cjs').normalizeConfig(require('../config.json'));
const trade = (year, index, pnl = 100) => ({ id: `${year}-${index}`, date: `${year}-02-${String(index % 20 + 1).padStart(2, '0')}`,
  status: 'closed', contracts: 1, realizedPnlUsd: pnl });
const trades = [...Array.from({ length: 50 }, (_, i) => trade(2025, i)), ...Array.from({ length: 20 }, (_, i) => trade(2026, i))];
const baseline = trades.map(t => ({ ...t, realizedPnlUsd: 10 }));
const provenance = { coverage: { complete: true }, dataFingerprint: 'fixture' };
test('promotion gates reject missing coverage, insufficient evidence and bad trades', () => {
  assert.equal(validate(trades, baseline, provenance, config).status, 'paper-candidate');
  assert.equal(validate(trades, baseline, {}, config).status, 'rejected');
  assert.equal(validate(trades.slice(1), baseline, provenance, config).status, 'rejected');
  assert.equal(validate(trades.map(t => ({ ...t, dataQuality: 'gap-review-required' })), baseline, provenance, config).status, 'rejected');
  assert.equal(validate(trades, trades, provenance, config).status, 'rejected');
});
test('daily research is capped, restart-idempotent, archived, and freezes paper candidates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-'));
  const report = { window: { start: '2025-01-01', end: '2026-09-01' }, provenance,
    strategies: [{ slug: 'nq-15m-orb-close-confirmation', research: { trades: baseline } }] };
  let calls = 0;
  const options = { root, config, report, candles: [], context: {}, now: new Date('2026-09-10T00:00:00Z'),
    runStrategy: () => { calls++; return { research: { trades } }; } };
  try {
    const a = runDaily(options);
    assert.equal(calls, 4); assert.equal(a.trials.length, 4); assert.equal(a.remaining, 8);
    runDaily(options); assert.equal(calls, 4);
    const candidates = JSON.parse(fs.readFileSync(path.join(root, 'runtime/orb-discovery/paper-candidates.json')));
    assert.equal(candidates.length, 4);
    const state = createState(config);
    attachCandidates(state, candidates, candidates[0].implementationHash);
    attachCandidates(state, candidates, candidates[0].implementationHash);
    assert.equal(state.accounts.length, 13);
    assert.ok(state.accounts.every(a => a.netPnlUsd === 0 && a.trades.length === 0));
    assert.ok(fs.existsSync(path.join(root, `runtime/orb-discovery/trials/${candidates[0].id}.json`)));
    runDaily({ ...options, now: new Date('2026-09-11T00:00:00Z') }); assert.equal(calls, 8);
    const changed = runDaily({ ...options, config: { ...config, slippageTicks: 2 } });
    assert.equal(changed.status, 'rules-changed-review-required'); assert.equal(calls, 8);
    const wrongCode = createState(config); attachCandidates(wrongCode, candidates, 'wrong');
    assert.equal(wrongCode.accounts.length, 9);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('monitor excludes gap trades and needs enough complete observations', () => {
  const rows = monitor([{ slug: 'x', trades: Array.from({ length: 20 }, (_, i) => ({ ...trade(2026, i, -10), dataQuality: 'complete' })) },
    { slug: 'y', trades: [{ ...trade(2026, 0), dataQuality: 'gap-review-required' }] }]);
  assert.equal(rows[0].status, 'deterioration-review');
  assert.equal(rows[1].verifiedTrades, 0); assert.equal(rows[1].gapTrades, 1);
});
test('a research override changes real ORB targets without mutating the baseline config', () => {
  const { runStrategyBacktest } = require('../lib/backtest-engine.cjs');
  const start = Date.parse('2026-02-03T14:30:00Z');
  const candles = Array.from({ length: 60 }, (_, i) => ({ timestamp: new Date(start + i * 60000).toISOString(),
    open: i < 15 ? 10000 : i < 30 ? 10004 + (i - 15) * .6 : 10014,
    high: i < 15 ? 10010 : i < 30 ? 10006 + (i - 15) * .8 : 10080,
    low: i < 15 ? 9990 : i < 30 ? 10003 + (i - 15) * .6 : 10013,
    close: i < 15 ? 10000 : i < 30 ? 10005 + (i - 15) * .75 : 10050, volume: 140 }));
  const def = { slug: 'nq-15m-orb-close-confirmation', name: 'Baseline' };
  const original = JSON.stringify(config);
  const baseline = runStrategyBacktest(candles, config, def).research.trades[0];
  const variant = runStrategyBacktest(candles, { ...config, orbExperimentRules: { targetMultiples: [1] } }, def).research.trades[0];
  assert.ok(baseline && variant);
  assert.notDeepEqual(variant.targets, baseline.targets);
  assert.equal(variant.contracts, 1);
  assert.equal(JSON.stringify(config), original);
});
