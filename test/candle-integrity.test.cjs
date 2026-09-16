const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateCandles } = require('../lib/live-trader.cjs');

test('shared aggregation rejects duplicate, missing and out-of-order minutes', () => {
  const start = Date.parse('2026-07-07T13:30:00Z');
  const candles = Array.from({ length: 5 }, (_, i) => ({ timestamp: new Date(start + i * 60000).toISOString(), open: 100, high: 102, low: 99, close: 101, volume: 5 }));
  const aggregate = input => aggregateCandles(input, 5, 'America/New_York');
  assert.equal(aggregate(candles).length, 1);
  assert.equal(aggregate(candles.slice(1)).length, 0);
  assert.equal(aggregate([candles[0], candles[0], ...candles.slice(2)]).length, 0);
  assert.equal(aggregate([candles[1], candles[0], ...candles.slice(2)]).length, 0);
  assert.equal(aggregate([...candles, candles[4]]).length, 0);
});
