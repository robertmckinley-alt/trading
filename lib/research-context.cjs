// Offline research helpers. Nothing here is connected to live signals or accounts.
const { createHash } = require('node:crypto');
function time(value) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Explicit ISO timestamp with timezone required');
  return Date.parse(value);
}
function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}
function provenance(input) {
  return { inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), researchOnly: true, livePromotionAllowed: false };
}

// A revision becomes available at its own release time, never at its observation date.
function alignReleasedSeries(decisionTimes, observations) {
  const seen = new Set();
  const rows = observations.map(row => {
    if (!row.series || !row.vintageId) throw new Error('Series and vintageId are required');
    const available = time(row.availableAt), period = time(row.periodEnd);
    finite(row.value, 'Observation');
    if (period > available) throw new Error('Forecast releases are not supported as realized observations');
    const key = JSON.stringify([row.series, period, available]);
    if (seen.has(key)) throw new Error('Ambiguous duplicate release');
    seen.add(key);
    return { ...row, available, period };
  });
  rows.sort((a, b) => a.available - b.available);
  const decisions = decisionTimes.map((decisionAt, index) => ({ decisionAt, index, at: time(decisionAt) })).sort((a, b) => a.at - b.at);
  const aligned = new Array(decisions.length), selected = new Map();
  let cursor = 0;
  for (const decision of decisions) {
      while (cursor < rows.length && rows[cursor].available <= decision.at) {
        const row = rows[cursor++];
        const prior = selected.get(row.series);
        if (!prior || row.period > prior.period || (row.period === prior.period && row.available > prior.available)) selected.set(row.series, row);
      }
      aligned[decision.index] = { decisionAt: decision.decisionAt, features: Object.fromEntries([...selected].map(([series, row]) => [series, { value: row.value, periodEnd: row.periodEnd, availableAt: row.availableAt, vintageId: row.vintageId }])) };
  }
  return { ...provenance({ decisionTimes, observations }), assumptions: 'Release and vintage timestamps must be supplied and independently verified. Latest-known period per series; revisions apply only after their release.', rows: aligned };
}

function benchmarkSeries(points, options) {
  const { startingCapital = 50000, priceBasis, symbol, source, adjustmentEvidence } = options;
  if (!['price-only', 'total-return-index'].includes(priceBasis) || !symbol || !source) throw new Error('Explicit symbol, source and price basis required');
  if (priceBasis === 'total-return-index' && !adjustmentEvidence) throw new Error('Total-return series requires documented adjustment evidence');
  if (finite(startingCapital, 'Capital') <= 0 || points.length < 2) throw new Error('Positive capital and at least two benchmark points required');
  let previous = -Infinity, peak = startingCapital, maxDrawdownUsd = 0, maxDrawdownPercent = 0;
  const curve = points.map(point => {
    const at = time(point.timestamp);
    if (at <= previous || finite(point.value, 'Benchmark level') <= 0) throw new Error('Benchmark points must be positive, unique and chronological');
    previous = at;
    const equityUsd = startingCapital * point.value / points[0].value;
    peak = Math.max(peak, equityUsd);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equityUsd);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, (peak - equityUsd) / peak * 100);
    return { timestamp: point.timestamp, equityUsd };
  });
  const netPnlUsd = curve.at(-1).equityUsd - startingCapital;
  return { ...provenance({ points, options }), symbol, source, priceBasis, adjustmentEvidence: adjustmentEvidence || null,
    startingCapital, netPnlUsd, returnPercent: netPnlUsd / startingCapital * 100, maxDrawdownUsd, maxDrawdownPercent, curve,
    limitations: 'Uses supplied observation levels and fractional exposure. Excludes brokerage costs and tax; no intrabar drawdown. Adjustment evidence is caller-supplied, not verified by this function. Match strategy dates and equity sampling before comparing.' };
}

function scoreForecasts(rows) {
  if (!rows.length) throw new Error('Forecast observations required');
  let squared = 0, naiveSquared = 0, absolute = 0, correct = 0;
  const seen = new Set(), models = new Set();
  for (const row of rows) {
    const trained = time(row.trainingEnd), forecast = time(row.forecastAt), decision = time(row.decisionAt), target = time(row.targetAt);
    if (!(trained <= forecast && forecast <= decision && decision < target)) throw new Error('Forecast timing leaks future information');
    if (!row.modelVersion || !row.datasetHash) throw new Error('Frozen model version and training dataset hash required');
    models.add(row.modelVersion);
    const key = `${decision}:${target}`;
    if (seen.has(key)) throw new Error('Duplicate forecast observation');
    seen.add(key);
    for (const field of ['reference', 'prediction', 'actual']) if (finite(row[field], field) <= 0) throw new Error('Positive prices required');
    const error = row.prediction - row.actual;
    squared += error ** 2; absolute += Math.abs(error); naiveSquared += (row.reference - row.actual) ** 2;
    correct += Number(Math.sign(row.prediction - row.reference) === Math.sign(row.actual - row.reference));
  }
  if (models.size !== 1) throw new Error('Score each frozen model version separately');
  const rmse = Math.sqrt(squared / rows.length), naiveRmse = Math.sqrt(naiveSquared / rows.length);
  return { ...provenance(rows), modelVersion: rows[0].modelVersion, observations: rows.length, rmse, naiveRmse,
    mae: absolute / rows.length, directionalAccuracy: correct / rows.length,
    skillVsNoChange: naiveRmse === 0 ? null : 1 - rmse / naiveRmse,
    limitations: 'Price forecast diagnostics, not trading P&L. Caller must verify actuals, training cutoff, reference-price availability and model provenance. Does not prove predictive or economic significance.' };
}
module.exports = { alignReleasedSeries, benchmarkSeries, scoreForecasts };
