const test = require('node:test');
const assert = require('node:assert/strict');
const { synchronizeStrategyLearning } = require('../lib/strategy-learning.cjs');
function trades(count, pnl, evidenceType, prefix) {
  return Array.from({length: count}, (_, i) => ({id: `${prefix}-${i}`, evidenceType,
    realizedPnlUsd: pnl, rMultiple: pnl / 100, side: 'long', adaptive: {market: {regime: prefix}}}));
}
test('legacy losses cannot nominate a challenger after an unrelated forward count gate', () => {
  const history = [...trades(50, 100, 'forward-paper', 'forward'), ...trades(20, -100, 'historical-replay', 'replay')];
  const result = synchronizeStrategyLearning(history, {strategySlug: 'example'});
  assert.equal(result.experimentRecommendation, null);
  assert.equal(result.rolling.netPnlUsd, -2000); // Preserve account history and reductions.
  assert.equal(result.adjustment.riskMultiplier, .5);
  assert.equal(result.forwardEvidence.trades, 50);
  assert.equal(result.forwardEvidence.excludedTrades, 20);
  assert.equal(result.forwardEvidence.rolling.netPnlUsd, 2000);
});
test('replay wins cannot hide forward losses from challenger discovery', () => {
  const result = synchronizeStrategyLearning([...trades(50, -100, 'forward-paper', 'forward'), ...trades(20, 100, 'historical-replay', 'replay')], {strategySlug: 'example'});
  assert.equal(result.experimentRecommendation.blockedValue, 'forward');
  assert.equal(result.experimentRecommendation.evidence.evidenceType, 'forward-paper');
  assert.equal(result.experimentRecommendation.evidence.totalForwardTrades, 50);
  assert.equal(result.experimentRecommendation.evidence.parentProfitFactor, 0);
  assert.equal(result.experimentRecommendation.evidence.segmentTrades, 20);
});
test('unlabelled legacy history is not called a forward sample in recommendations', () => {
  const result = synchronizeStrategyLearning(trades(100, 100, undefined, 'legacy'), {strategySlug: 'example'});
  assert.equal(result.tradesLearned, 100);
  assert.equal(result.forwardEvidence.trades, 0);
  assert.match(result.recommendations[0], /Collect 20 more forward paper trades/);
  assert.equal(result.controls.automaticChallengerCreationAllowed, false);
});
test('research review preserves legacy totals but excludes them from forward evidence', () => {
  const {reviewEvidence, reviewBacktestEvidence} = require('../lib/research-lab.cjs');
  const legacy = trades(60, 100, 'historical-replay', 'legacy');
  const result = reviewEvidence(legacy);
  assert.equal(result.total.trades, 0);
  assert.equal(result.allJournal.trades, 60);
  assert.equal(result.excludedTrades, 60);
  assert.equal(result.verdict, 'COLLECT DATA');
  for (const review of [result, reviewBacktestEvidence(legacy)]) {
    assert.equal(review.validation.sealed, false);
    assert.equal(review.validation.livePromotionAllowed, false);
    assert.equal(review.gates.lockedHoldout, undefined);
  }
});
test('strategy scorecard gates use forward trades while preserving all-account totals', () => {
  const {evaluateStrategyJournal} = require('../lib/strategy-evaluation.cjs');
  const sample = Array.from({length: 50}, (_, i) => ({id: String(i), date: `2026-09-${String(i % 25 + 1).padStart(2, '0')}`, evidenceType: 'historical-replay', realizedPnlUsd: i % 5 ? 100 : -100, actualRiskUsd: 100, maeUsd: -100, rMultiple: i % 5 ? 1 : -1}));
  const legacy = evaluateStrategyJournal({trades: sample});
  assert.equal(legacy.trades, 50);
  assert.equal(legacy.forwardEvidence.trades, 0);
  assert.notEqual(legacy.status, 'Paper candidate');
  assert.equal(legacy.gates.sampleSize, false);
  const forward = sample.map(t => ({...t, evidenceType: 'forward-paper'}));
  const result = evaluateStrategyJournal({trades: [...forward, ...trades(20, -1000, 'historical-replay', 'legacy')]});
  assert.equal(result.trades, 70);
  assert.equal(result.forwardEvidence.trades, 50);
  assert.equal(result.status, 'Paper candidate');
  assert.equal(result.boardGroup, 'watchlist');
  assert.equal(result.livePromotionAllowed, false);
});
