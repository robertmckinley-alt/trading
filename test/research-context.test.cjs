const test = require('node:test');
const assert = require('node:assert/strict');
const { alignReleasedSeries, benchmarkSeries, scoreForecasts } = require('../lib/research-context.cjs');
test('macro revisions never appear before their publication', () => {
  const base = { series: 'example', periodEnd: '2025-01-31T00:00:00Z' };
  const result = alignReleasedSeries(['2025-02-01T00:00:00Z', '2025-02-15T00:00:00Z', '2025-03-02T00:00:00Z'], [
    { ...base, availableAt: '2025-02-02T00:00:00Z', value: 1, vintageId: 'first' },
    { ...base, availableAt: '2025-03-01T00:00:00Z', value: 2, vintageId: 'revision' },
  ]);
  assert.deepEqual(result.rows.map(row => row.features.example?.value), [undefined, 1, 2]);
  assert.equal(result.livePromotionAllowed, false);
});
test('late revisions of old periods cannot replace newer periods; decisions retain their order', () => {
  const result = alignReleasedSeries(['2025-03-05T00:00:00Z', '2025-02-15T00:00:00Z'], [
    { series: 'x', periodEnd: '2025-01-31T00:00:00Z', availableAt: '2025-02-02T00:00:00Z', value: 1, vintageId: 'one' },
    { series: 'x', periodEnd: '2025-02-28T00:00:00Z', availableAt: '2025-03-02T00:00:00Z', value: 2, vintageId: 'two' },
    { series: 'x', periodEnd: '2025-01-31T00:00:00Z', availableAt: '2025-03-04T00:00:00Z', value: 3, vintageId: 'old-revision' },
  ]);
  assert.deepEqual(result.rows.map(row => row.features.x.value), [2, 1]);
});
test('benchmark labels its basis and computes peak-based drawdown', () => {
  const points = [100, 120, 90].map((value, i) => ({ timestamp: `2025-01-0${i + 1}T00:00:00Z`, value }));
  const options = { source: 'fixture', symbol: 'EXAMPLE', priceBasis: 'price-only' };
  const report = benchmarkSeries(points, options);
  assert.equal(report.netPnlUsd, -5000);
  assert.equal(report.maxDrawdownUsd, 15000);
  assert.equal(report.maxDrawdownPercent, 25);
  assert.throws(() => benchmarkSeries(points, { ...options, priceBasis: 'total-return-index' }), /evidence/);
  assert.throws(() => benchmarkSeries([points[1], points[0]], options), /chronological/);
});
test('forecasts compare against no-change and reject future-trained or duplicate rows', () => {
  const row = { trainingEnd: '2024-12-31T00:00:00Z', forecastAt: '2025-01-01T00:00:00Z', decisionAt: '2025-01-01T00:00:00Z', targetAt: '2025-01-02T00:00:00Z', reference: 100, prediction: 108, actual: 110, modelVersion: 'fixture-v1', datasetHash: 'fixture' };
  const report = scoreForecasts([row]);
  assert.equal(report.rmse, 2);
  assert.equal(report.naiveRmse, 10);
  assert.equal(report.skillVsNoChange, 0.8);
  assert.throws(() => scoreForecasts([{ ...row, trainingEnd: row.targetAt }]), /future/);
  assert.throws(() => scoreForecasts([row, row]), /Duplicate/);
});
