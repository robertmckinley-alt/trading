const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig } = require('../lib/trader-core.cjs');
const { createState, advance, mergeCandles, DEFINITIONS } = require('../lib/orb-forward.cjs');
const config = normalizeConfig(require('../config.json'));
const base = Date.parse('2026-02-03T14:30:00.000Z');
function bars() {
  return Array.from({ length: 30 }, (_, i) => ({ timestamp: new Date(base + i * 60000).toISOString(),
    open: i < 15 ? 10000 : 10004 + (i - 15) * .6,
    high: i < 15 ? 10010 : 10006 + (i - 15) * .8,
    low: i < 15 ? 9990 : 10003 + (i - 15) * .6,
    close: i < 15 ? 10000 : 10005 + (i - 15) * .75, volume: 140 }));
}
const candle = (minute, high = 10017, low = 10013) => ({ timestamp: new Date(base + minute * 60000).toISOString(), open: 10014, close: 10015, high, low, volume: 100 });
function triggered() {
  const state = createState(config, base);
  const data = bars();
  advance(state, data.slice(0, 29), [], config, base + 29 * 60000);
  advance(state, data, [], config, base + 30 * 60000 + 5000);
  return state;
}
test('all nine isolated accounts start empty and warmup cannot create forward orders', () => {
  assert.equal(DEFINITIONS.length, 9);
  const s = createState(config, base);
  advance(s, bars(), bars(), config, base + 30 * 60000 + 5000);
  assert.ok(s.accounts.every(a => !a.active && !a.trades.length));
});
test('observed signal fills only at a future minute; serialized restart does not duplicate it', () => {
  const s = triggered();
  const a = s.accounts[0];
  assert.ok(a.active);
  assert.equal(a.active.plan.setup.signalAvailableAt, candle(31).timestamp);
  advance(s, [...bars(), candle(30)], [], config, base + 31 * 60000 + 5000);
  assert.equal(a.active.result.status, 'not-filled');
  const resumed = JSON.parse(JSON.stringify(s));
  advance(resumed, [...bars(), candle(30), candle(31)], [], config, base + 32 * 60000 + 5000);
  assert.equal(resumed.accounts[0].active.result.filledAt, candle(31).timestamp);
  assert.equal(resumed.accounts[0].active.result.contracts, 1);
  advance(resumed, [...bars(), candle(30), candle(31), candle(32, 10100)], [], config, base + 33 * 60000 + 5000);
  assert.equal(resumed.accounts[0].trades.length, 1);
  assert.equal(resumed.accounts[0].trades[0].evidenceType, 'forward-paper');
  assert.equal(resumed.accounts[0].trades[0].dataQuality, 'complete');
  advance(resumed, [...bars(), candle(32, 10100)], [], config, base + 33 * 60000 + 5000);
  assert.equal(resumed.accounts[0].trades.length, 1);
});
test('stale confirmations never become new forward entries and gaps flag trades for review', () => {
  const s = createState(config, base); s.cursor = new Date(base + 28 * 60000).toISOString();
  advance(s, [...bars(), candle(31)], [], config, base + 32 * 60000 + 5000);
  assert.ok(s.accounts.every(a => !a.active));
  const g = triggered();
  advance(g, [candle(33, 10100)], [], config, base + 34 * 60000 + 5000);
  // Expired orders are never filled after an outage.
  assert.equal(g.accounts[0].trades.length, 0);
  assert.equal(g.accounts[0].active, null);
  const f = triggered();
  advance(f, [candle(31)], [], config, base + 32 * 60000 + 5000);
  advance(f, [candle(33, 10100)], [], config, base + 34 * 60000 + 5000);
  assert.equal(f.accounts[0].trades[0].dataQuality, 'gap-review-required');
});
test('same timestamp with different ISO precision is deduplicated', () => {
  assert.equal(mergeCandles([{...candle(1), timestamp: candle(1).timestamp.replace('.000Z','Z')}], [candle(1)]).length, 1);
});
