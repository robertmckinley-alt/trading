const test = require('node:test');
const assert = require('node:assert/strict');
const { runStrategyBacktest } = require('../lib/backtest-engine.cjs');
const { reviewBacktestEvidence } = require('../lib/research-lab.cjs');
const core = require('../lib/trader-core.cjs');
const config = core.normalizeConfig(require('../config.json'));

test('all-strategy research continues unchanged after losses exhaust the guarded account', () => {
  const candles = Array.from({ length: 30 }, (_, day) => {
    const time = Date.UTC(2025, 0, day + 1, 15);
    return [
      { timestamp: new Date(time).toISOString(), open: 100, high: 101, low: 99, close: 100 },
      { timestamp: new Date(time + 60000).toISOString(), open: 100, high: 100, low: 75, close: 80 }
    ];
  }).flat();
  const result = runStrategyBacktest(candles, config, { slug: 'test-losses', name: 'Loss sequence' }, {
    detectSignal(context) {
      const candle = context.at(-1);
      return { found: true, triggerTimestamp: candle.timestamp, setup: {
        symbol: 'NQ', date: candle.timestamp.slice(0, 10), session: 'test', side: 'long',
        entry: 100, stop: 76, targets: [124], thesis: 'loss regression', setup: {}
      } };
    }
  });
  assert.equal(result.research.trades.length, 30);
  assert.equal(result.research.rejectedSignals, 0);
  assert.ok(result.research.metrics.netPnlUsd < -5000);
  assert.ok(result.trades.length < 30);
  assert.ok(result.rejectedSignals > 0);
  assert.equal(new Set(result.research.trades.map(t => t.contracts)).size, 1);
  assert.equal(result.research.trades.at(-1).date, '2025-01-30');
  assert.equal('drawdown' in result.research.review.gates, false);
});

test('research reports drawdown without treating account loss floor as a performance gate', () => {
  const trades = Array.from({ length: 100 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    realizedPnlUsd: i < 12 ? -500 : 300, rMultiple: i < 12 ? -1 : .6
  }));
  const research = reviewBacktestEvidence(trades, { enforceAccountDrawdown: false });
  assert.ok(research.total.maxDrawdownUsd > 5000);
  assert.equal(research.recommendation, 'ADVANCE TO FORWARD TEST');
  assert.equal(reviewBacktestEvidence(trades).recommendation, 'REVISE AND RETEST');
  assert.equal('drawdown' in research.gates, false);
});

const { buildOneContractResearchPlan } = require('../lib/backtest-engine.cjs');
const { buildPlanFromSignal } = require('../lib/live-trader.cjs');

function orbSignal(stop = 100, entry = 200) {
  return { found: true, triggerTimestamp: '2026-02-02T14:59:00Z', setup: {
    symbol: 'NQ', date: '2026-02-02', session: 'test', side: 'long', entry, stop,
    targets: [300, 350], thesis: 'one-contract regression', setup: {},
    execution: 'next-bar-market', signalAvailableAt: '2026-02-02T15:00:00Z'
  } };
}

test('one-contract ORB research accepts wide stops and larger entry risk without changing guarded sizing', () => {
  const signal = orbSignal();
  assert.throws(() => buildPlanFromSignal(signal, config, core.createEmptyState(config)), /minimum 1-contract risk/);
  const before = JSON.stringify(config);
  const plan = buildOneContractResearchPlan(signal, config);
  assert.equal(plan.setup.stop, 100);
  assert.equal(plan.sizing.maxContracts, 1);
  const future = [{ timestamp: '2026-02-02T15:00:00Z', open: 220, high: 225, low: 90, close: 95 }];
  const replay = core.replayPlan(plan, future, config, { researchFixedContracts: 1 });
  assert.equal(replay.contracts, 1);
  assert.equal(replay.filledEntryPrice, 220.25);
  assert.equal(replay.finalExitPrice, 99.75);
  assert.equal(replay.actualRiskUsd, 2414.5);
  assert.equal(replay.realizedPnlUsd, -2414.5);
  assert.equal(replay.execution.sizingMode, 'one-contract-research');
  assert.equal(core.replayPlan(plan, future, config).status, 'not-filled', 'ordinary replay still enforces its budget');
  assert.equal(JSON.stringify(config), before);
});

test('one-contract ORB research never increases size for narrow stops or fills across a target', () => {
  const plan = buildOneContractResearchPlan(orbSignal(199), config);
  assert.equal(plan.sizing.maxContracts, 1);
  const candle = (open, high, low) => ({ timestamp: '2026-02-02T15:00:00Z', open, high, low, close: open });
  const winner = core.replayPlan(plan, [candle(200, 301, 200)], config, { researchFixedContracts: 1 });
  assert.equal(winner.contracts, 1);
  assert.equal(winner.realizedPnlUsd, 1985.5);
  assert.equal(winner.remainingContracts, 0);
  const crossed = core.replayPlan(plan, [candle(301, 302, 300)], config, { researchFixedContracts: 1 });
  assert.equal(crossed.status, 'not-filled');
  assert.equal(crossed.exitReason, 'entry gap beyond stop or target');
});

test('real ORB detector produces research fills on ordinary wide-range sessions, with audited outcomes', () => {
  const candles = ['2026-02-02', '2026-02-03'].flatMap(date => Array.from({ length: 390 }, (_, minute) => {
    const bar = { timestamp: new Date(Date.parse(`${date}T14:30:00Z`) + minute * 60000).toISOString(),
      open: 10000, high: 10010, low: 9990, close: 10000, volume: 100, instrumentId: 1 };
    if (minute >= 15 && minute < 30) {
      const n = minute - 15;
      Object.assign(bar, { open: 10004 + n * 3, low: 10003 + n * 3, high: 10008 + n * 3, close: 10006 + n * 3 });
    }
    if (minute === 30) Object.assign(bar, { open: 10048, high: 10052, low: 9990, close: 10000 });
    return bar;
  }));
  const result = runStrategyBacktest(candles, config, { slug: 'nq-15m-orb-close-confirmation', name: 'ORB' });
  assert.equal(result.signals, 2);
  assert.equal(result.trades.length, 0);
  assert.equal(result.rejectedSignals, 2);
  assert.equal(result.research.mode, 'fixed-contract');
  assert.equal(result.research.rejectedSignals, 0);
  assert.equal(result.research.trades.length, 2);
  assert.ok(result.research.trades.every(trade => trade.contracts === 1 && trade.actualRiskUsd > 500));
  assert.equal(result.research.signalAudit.length, 2);
  assert.equal(result.research.sizing.riskCapUsd, null);
});
