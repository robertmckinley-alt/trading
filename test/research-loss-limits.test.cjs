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
