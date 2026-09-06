const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOrbLearningReport } = require('../lib/orb-learning.cjs');

function fixture() {
  const tradingDates = [];
  for (let day = Date.parse('2025-01-01'); day < Date.parse('2025-10-01'); day += 86_400_000) {
    if (![0, 6].includes(new Date(day).getUTCDay())) tradingDates.push(new Date(day).toISOString().slice(0, 10));
  }
  const strategy = (slug, value) => ({
    slug, name: slug, metrics: { trades: 2, netPnlUsd: -999 },
    research: { mode: 'fixed-risk', trades: tradingDates.map((date, index) => ({
      id: `${slug}-${date}`, date, filledAt: `${date}T15:00:00Z`,
      contracts: 1, realizedPnlUsd: value(date, index), status: 'closed'
    })) }
  });
  return {
    report: { window: { start: '2025-01-01T00:00:00Z', end: '2025-10-01T00:00:00Z' }, strategies: [
      strategy('nq-15m-orb-close-confirmation', (_date, index) => index % 4 ? 120 : -50),
      strategy('nq-15m-orb-rvol', (date, index) => date < '2025-07-01' ? (index % 4 ? 200 : -50) : -300)
    ] },
    options: { tradingDates, coverage: { complete: true, scope: 'test-calendar' }, executionVersion: 'test-v2',
      config: { commissionPerContractUsd: 4.5, slippageTicks: 1, tickValueUsd: 5, maxRiskPerTradeUsd: 500 } }
  };
}

test('calendar selection uses only preceding training trades, not the test-month winner', () => {
  const { report, options } = fixture();
  const learning = buildOrbLearningReport(report, options);
  const july = learning.walkForward.folds[0];
  assert.equal(july.trainingStart, '2025-01-01');
  assert.equal(july.trainingEndExclusive, '2025-07-01');
  assert.equal(july.selectedSlug, 'nq-15m-orb-rvol');
  assert.ok(july.test.netPnlUsd < 0);
  const changed = structuredClone(report);
  for (const strategy of changed.strategies) for (const trade of strategy.research.trades) {
    if (trade.date >= '2025-07-01') trade.realizedPnlUsd = strategy.slug.endsWith('rvol') ? 5000 : -5000;
  }
  const changedJuly = buildOrbLearningReport(changed, options).walkForward.folds[0];
  assert.equal(changedJuly.selectedSlug, july.selectedSlug);
  assert.deepEqual(changedJuly.training, july.training);
  assert.notEqual(changedJuly.test.netPnlUsd, july.test.netPnlUsd);
  assert.equal(learning.forwardPaperGate.livePromotionAllowed, false);
  assert.match(learning.label, /not untouched/);
});

test('fixed-risk calendar metrics include zero-trade dates and keep account results separate', () => {
  const { report, options } = fixture();
  report.strategies[0].research.trades.splice(0, 5);
  const trial = buildOrbLearningReport(report, options).trials.find((item) => item.slug.endsWith('confirmation'));
  assert.equal(trial.fixedRisk.zeroTradeDays, 5);
  assert.equal(trial.fixedRisk.observedSessionDays, options.tradingDates.length);
  assert.equal(trial.account.netPnlUsd, -999);
  assert.notEqual(trial.fixedRisk.netPnlUsd, -999);
  assert.equal(trial.annual[0].observedSessionDays, options.tradingDates.length);
  assert.equal(trial.calendar[0].zeroTradeDays, 5);
  assert.equal(trial.doubledCosts.netPnlUsd, Math.round((trial.fixedRisk.netPnlUsd - trial.fixedRisk.trades * 14.5) * 100) / 100);
});

test('research nomination requires coverage, fixed-risk records and known costs', () => {
  const { report, options } = fixture();
  report.strategies = report.strategies.slice(0, 1);
  const passing = buildOrbLearningReport(report, options);
  assert.equal(passing.status, 'research-candidate');
  assert.equal(passing.candidate.slug, 'nq-15m-orb-close-confirmation');
  assert.equal(passing.forwardPaperGate.status, 'not-started');
  const missingCoverage = buildOrbLearningReport(report, { ...options, coverage: undefined });
  assert.equal(missingCoverage.candidate, null);
  assert.ok(missingCoverage.blockers.some((message) => /coverage/.test(message)));
  const missingCosts = buildOrbLearningReport(report, { ...options, config: {} });
  assert.equal(missingCosts.candidate, null);
  assert.equal(missingCosts.trials[0].doubledCosts, null);
  delete report.strategies[0].research;
  const missingResearch = buildOrbLearningReport(report, options);
  assert.equal(missingResearch.candidate, null);
  assert.equal(missingResearch.trials[0].valid, false);
  assert.equal(buildOrbLearningReport().status, 'more-evidence-needed');
});

test('version manifest is stable across key order and changes when costs, execution, or parameters change', () => {
  const { report, options } = fixture();
  const first = buildOrbLearningReport(report, options);
  const reordered = buildOrbLearningReport({ ...report, generatedAt: 'later', strategies: [...report.strategies].reverse() }, {
    ...options, config: Object.fromEntries(Object.entries(options.config).reverse())
  });
  assert.equal(first.manifestHash, reordered.manifestHash);
  assert.notEqual(first.manifestHash, buildOrbLearningReport(report, { ...options, executionVersion: 'new' }).manifestHash);
  assert.notEqual(first.manifestHash, buildOrbLearningReport(report, { ...options, codeHash: 'changed' }).manifestHash);
  assert.notEqual(first.manifestHash, buildOrbLearningReport(report, { ...options, config: { ...options.config, slippageTicks: 2 } }).manifestHash);
  assert.notEqual(first.manifestHash, buildOrbLearningReport(report, { ...options, config: { ...options.config, live: { openingRangeClose: { minimumBodyFraction: 0.8 } } } }).manifestHash);
});

test('partial months are excluded from walk-forward evaluation and the next nomination training window', () => {
  const { report, options } = fixture();
  report.window.end = '2025-09-15T00:00:00Z';
  for (const strategy of report.strategies) strategy.research.trades = strategy.research.trades.filter((trade) => trade.date < '2025-09-15');
  const learning = buildOrbLearningReport(report, options);
  assert.equal(learning.walkForward.folds.length, 2);
  assert.equal(learning.walkForward.folds.at(-1).testEndExclusive, '2025-09-01');
  assert.equal(learning.trials[0].calendar.at(-1).completeCalendarMonth, false);
});

test('doubled costs can block a profitable low-margin simulation', () => {
  const { report, options } = fixture();
  report.strategies = report.strategies.slice(0, 1);
  report.strategies[0].research.trades.forEach((trade, index) => { trade.realizedPnlUsd = index % 4 ? 10 : -5; });
  const learning = buildOrbLearningReport(report, options);
  assert.ok(learning.trials[0].fixedRisk.netPnlUsd > 0);
  assert.ok(learning.trials[0].doubledCosts.netPnlUsd < 0);
  assert.equal(learning.candidate, null);
  assert.ok(learning.walkForward.folds.every((fold) => fold.selectedSlug === null));
});

test('block resampling is bounded, deterministic, includes zero sessions and never mutates inputs', () => {
  const { report, options } = fixture();
  report.strategies = report.strategies.slice(0, 1);
  report.strategies[0].research.trades = report.strategies[0].research.trades.filter((trade) => trade.date !== '2025-07-01');
  const before = JSON.stringify({ report, options });
  const first = buildOrbLearningReport(report, options);
  const second = buildOrbLearningReport(report, options);
  assert.equal(JSON.stringify({ report, options }), before);
  assert.deepEqual(first.sequenceRisk, second.sequenceRisk);
  assert.equal(first.sequenceRisk.replicates, 250);
  assert.equal(first.sequenceRisk.blockSessions, 5);
  assert.equal(first.sequenceRisk.zeroPnlSessions, 1);
  assert.equal(first.sequenceRisk.observedSessions, first.walkForward.aggregate.observedSessionDays);
  assert.ok(first.sequenceRisk.maxDrawdownUsd.p95 >= first.sequenceRisk.maxDrawdownUsd.p50);
  assert.ok(first.sequenceRisk.longestLosingSessions.p95 >= first.sequenceRisk.longestLosingSessions.p50);
  assert.match(first.sequenceRisk.label, /not a forecast/);
  assert.equal(buildOrbLearningReport().sequenceRisk.status, 'insufficient-data');
});

test('intraday end dates include observed trades without admitting a partial last month into selection', () => {
  const { report, options } = fixture();
  report.window.end = '2025-09-30T18:00:00Z';
  const learning = buildOrbLearningReport(report, options);
  assert.ok(learning.trials.every((trial) => trial.valid));
  assert.equal(learning.trials[0].fixedRisk.trades, report.strategies[0].research.trades.length);
  assert.equal(learning.trials[0].calendar.at(-1).completeCalendarMonth, false);
  assert.equal(learning.walkForward.folds.at(-1).testEndExclusive, '2025-09-01');
  assert.equal(learning.manifest.requestedWindow.end, '2025-09-30T18:00:00Z');
  const changed = structuredClone(report);
  for (const strategy of changed.strategies) for (const trade of strategy.research.trades) {
    if (trade.date >= '2025-09-01') trade.realizedPnlUsd = 1_000_000;
  }
  assert.deepEqual(learning.walkForward, buildOrbLearningReport(changed, options).walkForward);
  const midnight = structuredClone(report);
  midnight.window.end = '2025-10-01T00:00:00Z';
  const complete = buildOrbLearningReport(midnight, options);
  assert.equal(complete.trials[0].calendar.at(-1).completeCalendarMonth, true);
  assert.equal(complete.walkForward.folds.at(-1).testEndExclusive, '2025-10-01');
  assert.equal(complete.manifest.window.observedEndExclusive, '2025-10-01');
});
