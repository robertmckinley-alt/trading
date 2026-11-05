const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLseCandlesRequest, compareCandles, fetchLseCandlePage, fetchLseDiscovery, importCsv, parseLseCandlePage } = require('../lib/futures-history.cjs');

const valid = `timestamp,open,high,low,close,volume\n2026-01-05T14:30:00Z,100,102,99,101,10\n2026-01-05T14:31:00Z,101,103,100,102,12\n`;

test('strict CSV import normalizes offset timestamps and fingerprints canonical OHLCV', () => {
  const imported = importCsv(valid);
  assert.equal(imported.audit.ok, true);
  assert.equal(imported.candles[0].timestamp, '2026-01-05T14:30:00.000Z');
  assert.equal(imported.candles[1].volume, 12);
  assert.match(imported.fingerprint, /^[a-f0-9]{64}$/);
});

test('CSV import requires explicit time zones and numeric timestamp units', () => {
  assert.throws(() => importCsv(valid.replace('2026-01-05T14:30:00Z', '2026-01-05 14:30:00')), /UTC offset/);
  assert.throws(() => importCsv(valid.replace('2026-01-05T14:30:00Z', '1767623400000')), /timestampUnit/);
  assert.equal(importCsv(valid.replace('2026-01-05T14:30:00Z', '1767623400000'), { timestampUnit: 'ms' }).candles[0].timestamp, '2026-01-05T14:30:00.000Z');
});

test('CSV import rejects malformed OHLCV, duplicates, disorder and off-minute times', () => {
  const bad = `timestamp,open,high,low,close,volume\n2026-01-05T14:30:30Z,100,99,101,100,-1\n2026-01-05T14:30:30Z,100,102,99,101,10\n2026-01-05T14:29:00Z,100,102,99,101,10\n`;
  const audit = importCsv(bad).audit;
  assert.equal(audit.structurallyValid, false);
  assert.deepEqual(new Set(audit.issues.map((issue) => issue.code)), new Set(['negative-volume', 'invalid-ohlc', 'off-interval-timestamp', 'duplicate-timestamp', 'not-chronological']));
});

test('CSV import identifies every missing interval without silently filling data', () => {
  const imported = importCsv(valid.replace('14:31:00', '14:34:00'));
  assert.equal(imported.audit.structurallyValid, true);
  assert.equal(imported.audit.ok, false);
  assert.equal(imported.audit.gapCount, 1);
  assert.equal(imported.audit.missingBars, 3);
  assert.equal(imported.candles.length, 2);
});

test('quoted CSV and explicit column mappings are supported', () => {
  const raw = `Date,O,H,L,C,V,Note\n"2026-01-05T14:30:00Z",100,102,99,101,10,"a,b"\n`;
  const imported = importCsv(raw, { columns: { timestamp: 'Date', open: 'O', high: 'H', low: 'L', close: 'C', volume: 'V' } });
  assert.equal(imported.audit.ok, true);
  assert.equal(imported.mapping.timestamp, 'Date');
});

test('Databento comparison reports coverage and field-level tolerances', () => {
  const candidate = importCsv(valid).candles;
  const reference = candidate.map((candle) => ({ ...candle }));
  reference[0].close += 0.25;
  reference.push({ ...reference[1], timestamp: '2026-01-05T14:32:00.000Z' });
  const strict = compareCandles(candidate, reference);
  assert.equal(strict.overlap, 2);
  assert.equal(strict.missingFromCandidate, 0);
  assert.equal(strict.outsideComparisonWindow.databentoRecords, 1);
  assert.equal(strict.metrics.close.mismatches, 1);
  assert.equal(strict.withinTolerance, false);
  assert.equal(compareCandles(candidate, reference, { priceTolerance: 0.25 }).withinTolerance, true, 'comparison is restricted to the shared window');
  assert.equal(compareCandles(candidate, reference.slice(0, 2), { priceTolerance: 0.25 }).withinTolerance, true);
});

test('London Strategic Edge request uses documented endpoint, parameters and private header', () => {
  const request = buildLseCandlesRequest({ apiKey: 'lse_live_test-only', symbol: 'NQ.F', timeframe: '1m', start: '2026-09-01', end: '2026-09-02', order: 'asc', limit: 5000, dataset: 'futures' });
  const url = new URL(request.url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://api.londonstrategicedge.com/vault/candles');
  assert.deepEqual(Object.fromEntries(url.searchParams), { symbol: 'NQ.F', timeframe: '1m', order: 'asc', limit: '5000', start: '2026-09-01', end: '2026-09-02', dataset: 'futures' });
  assert.equal(request.options.headers['x-api-key'], 'lse_live_test-only');
  assert.equal(request.url.includes('lse_live_'), false);
  assert.throws(() => buildLseCandlesRequest({ apiKey: 'wrong', symbol: 'NQ.F' }), /prefix/);
  assert.throws(() => buildLseCandlesRequest({ apiKey: 'lse_live_x', symbol: 'NQ.F', limit: 5001 }), /5000/);
});

test('London Strategic Edge bare-array page normalizes documented UTC timestamps', async () => {
  const payload = [{ ts: '2026-07-02 00:00:00.000000', symbol: 'NQ.F', open: 25000, high: 25002, low: 24999, close: 25001, volume: 42 }];
  const parsed = parseLseCandlePage(payload, { symbol: 'NQ.F' });
  assert.equal(parsed.candles[0].timestamp, '2026-07-02T00:00:00.000Z');
  assert.equal(parsed.audit.ok, true);
  let request;
  const fetched = await fetchLseCandlePage({ apiKey: 'lse_live_test-only', symbol: 'NQ.F', fetchImpl: async (url, options) => {
    request = { url, options }; return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  } });
  assert.equal(fetched.candles.length, 1);
  assert.equal(request.options.headers['x-api-key'], 'lse_live_test-only');
  assert.equal(JSON.stringify(fetched).includes('lse_live_test-only'), false);
});

test('London Strategic Edge discovery preflight preserves usage, meta and catalog responses', async () => {
  const bodies = {
    usage: { calls_per_minute: 100, max_rows_per_request: 5000 },
    meta: { access: { futures: ['candles', 'export'] }, future_field: true },
    catalog: [{ dataset: 'futures', symbol: 'NQ.F', ticks: 10, first_tick: '2026-01-01 00:00:00.000000', last_tick: '2026-01-02 00:00:00.000000', years: 1, country: 'US' }]
  };
  const calls = [];
  const result = await fetchLseDiscovery({ apiKey: 'lse_live_test-only', fetchImpl: async (url, options) => {
    calls.push({ url, options }); const key = url.split('/').at(-1);
    return { ok: true, status: 200, text: async () => JSON.stringify(bodies[key]) };
  } });
  assert.deepEqual(calls.map((call) => call.url), ['https://api.londonstrategicedge.com/vault/usage', 'https://api.londonstrategicedge.com/vault/meta', 'https://api.londonstrategicedge.com/vault/catalog']);
  assert.equal(result.usage.max_rows_per_request, 5000);
  assert.equal(result.meta.future_field, true);
  assert.equal(result.catalog[0].symbol, 'NQ.F');
  assert.ok(Object.values(result.hashes).every((value) => /^[a-f0-9]{64}$/.test(value)));
  assert.equal(JSON.stringify(result).includes('lse_live_test-only'), false);
});
