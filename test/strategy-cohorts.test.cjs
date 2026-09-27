const test = require('node:test');
const assert = require('node:assert/strict');
const { splitStrategyCohorts } = require('../lib/strategy-cohorts.cjs');

const strategy = (slug, trades, profitFactor) => ({ slug,
  journal: { trades }, research: { evaluation: { profitFactor } } });

test('only strategies with enough closed forward trades and PF below 1 move to watchlist', () => {
  const rows = [
    strategy('small-sample', 19, 0.2),
    strategy('weak', 20, 0.99),
    strategy('break-even', 20, 1),
    strategy('profitable', 50, 1.4),
    strategy('no-loss-yet', 25, null),
    strategy('missing-pf', 25, undefined)
  ];
  const cohorts = splitStrategyCohorts(rows);
  assert.deepEqual(cohorts.watchlist.map(row => row.slug), ['weak']);
  assert.deepEqual(cohorts.main.map(row => row.slug), ['small-sample', 'break-even', 'profitable', 'no-loss-yet', 'missing-pf']);
  assert.equal(cohorts.minimumTrades, 20);
  assert.equal(cohorts.profitFactorBelow, 1);
});

test('minimum sample and PF threshold are configurable', () => {
  const cohorts = splitStrategyCohorts([strategy('candidate', 10, 1.1)], {
    strategyWatchlistMinimumTrades: 10,
    strategyWatchlistProfitFactorBelow: 1.2
  });
  assert.equal(cohorts.watchlist[0].slug, 'candidate');
});
