const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const LSE_BASE_URL = 'https://api.londonstrategicedge.com/vault';
const LSE_TIMEFRAMES = new Set(['1s', '5s', '15s', '30s', '1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mo']);

const CANONICAL_FIELDS = ['timestamp', 'open', 'high', 'low', 'close', 'volume'];
const DEFAULT_ALIASES = {
  timestamp: ['timestamp', 'datetime', 'date_time', 'time', 'ts', 'ts_event'],
  open: ['open', 'o'], high: ['high', 'h'], low: ['low', 'l'], close: ['close', 'c'], volume: ['volume', 'vol', 'v']
};

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function buildLseCandlesRequest(options = {}) {
  const apiKey = String(options.apiKey || '').trim();
  if (!apiKey) throw new Error('London Strategic Edge access requires LSE_API_KEY.');
  if (!apiKey.startsWith('lse_live_')) throw new Error('LSE_API_KEY does not have the documented lse_live_ prefix.');
  const symbol = String(options.symbol || '').trim();
  if (!symbol) throw new Error('London Strategic Edge candle download requires a symbol.');
  const timeframe = String(options.timeframe || '1m');
  if (!LSE_TIMEFRAMES.has(timeframe)) throw new Error(`Unsupported London Strategic Edge timeframe: ${timeframe}`);
  const limit = Number(options.limit ?? 5000);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('The client safety limit for one London Strategic Edge candle request is 1 to 5000 rows.');
  const order = String(options.order || 'asc');
  if (!['asc', 'desc'].includes(order)) throw new Error('London Strategic Edge order must be asc or desc.');
  const params = new URLSearchParams({ symbol, timeframe, order, limit: String(limit) });
  for (const field of ['start', 'end', 'dataset']) if (options[field] !== undefined && String(options[field]).trim()) params.set(field, String(options[field]).trim());
  return { url: `${LSE_BASE_URL}/candles?${params}`, options: { headers: { 'x-api-key': apiKey }, cache: 'no-store', signal: AbortSignal.timeout(120_000) } };
}

function lseAuthOptions(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('London Strategic Edge access requires LSE_API_KEY.');
  if (!key.startsWith('lse_live_')) throw new Error('LSE_API_KEY does not have the documented lse_live_ prefix.');
  return { headers: { 'x-api-key': key }, cache: 'no-store', signal: AbortSignal.timeout(120_000) };
}

async function fetchLseJson(url, options = {}) {
  const response = await (options.fetchImpl || fetch)(url, lseAuthOptions(options.apiKey || options.env?.LSE_API_KEY || process.env.LSE_API_KEY));
  const raw = await response.text();
  if (!response.ok) throw new Error(`London Strategic Edge ${options.label || 'request'} failed (${response.status}).`);
  try { return { value: JSON.parse(raw), sha256: sha256(raw) }; }
  catch { throw new Error(`London Strategic Edge ${options.label || 'request'} returned invalid JSON.`); }
}

async function fetchLseDiscovery(options = {}) {
  const common = { ...options, apiKey: options.apiKey || options.env?.LSE_API_KEY || process.env.LSE_API_KEY };
  const usage = await fetchLseJson(`${LSE_BASE_URL}/usage`, { ...common, label: 'usage request' });
  const meta = await fetchLseJson(`${LSE_BASE_URL}/meta`, { ...common, label: 'metadata request' });
  const catalog = await fetchLseJson(`${LSE_BASE_URL}/catalog`, { ...common, label: 'catalog request' });
  if (!usage.value || typeof usage.value !== 'object' || Array.isArray(usage.value)) throw new Error('London Strategic Edge usage response must be an object.');
  if (!meta.value || typeof meta.value !== 'object' || Array.isArray(meta.value)) throw new Error('London Strategic Edge metadata response must be an object.');
  if (meta.value.access !== undefined && (!meta.value.access || typeof meta.value.access !== 'object' || Array.isArray(meta.value.access))) throw new Error('London Strategic Edge metadata access field must be an object.');
  if (!Array.isArray(catalog.value)) throw new Error('London Strategic Edge catalog response must be an array.');
  return { usage: usage.value, meta: meta.value, catalog: catalog.value,
    hashes: { usage: usage.sha256, meta: meta.sha256, catalog: catalog.sha256 } };
}

function parseLseCandlePage(payload, options = {}) {
  if (!Array.isArray(payload)) throw new Error('London Strategic Edge candle response must be a JSON array.');
  if (payload.length > 5000) throw new Error('London Strategic Edge candle response exceeded the client safety limit.');
  const expectedSymbol = options.symbol ? String(options.symbol) : null;
  let candles = payload.map((record, index) => {
    const row = index + 1;
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`London Strategic Edge candle ${row} is not an object.`);
    if (expectedSymbol && String(record.symbol || '') !== expectedSymbol) throw new Error(`London Strategic Edge candle ${row} returned unexpected symbol ${record.symbol || 'missing'}.`);
    const rawTimestamp = String(record.ts || '');
    const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(rawTimestamp)
      ? new Date(`${rawTimestamp.replace(' ', 'T')}Z`).toISOString()
      : parseTimestamp(rawTimestamp, row, null);
    return { timestamp, open: number(record.open, row, 'open'), high: number(record.high, row, 'high'),
      low: number(record.low, row, 'low'), close: number(record.close, row, 'close'), volume: number(record.volume, row, 'volume') };
  });
  if (options.order === 'desc') candles = candles.reverse();
  return { candles, audit: auditCandles(candles, { intervalMinutes: Number(options.intervalMinutes || 1) }), fingerprint: canonicalFingerprint(candles) };
}

async function fetchLseCandlePage(options = {}) {
  const request = buildLseCandlesRequest({ ...options, apiKey: options.apiKey || options.env?.LSE_API_KEY || process.env.LSE_API_KEY });
  const response = await (options.fetchImpl || fetch)(request.url, request.options);
  const raw = await response.text();
  if (!response.ok) throw new Error(`London Strategic Edge candle request failed (${response.status}).`);
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('London Strategic Edge returned invalid JSON.'); }
  const parsed = parseLseCandlePage(payload, { symbol: options.symbol, intervalMinutes: options.intervalMinutes, order: options.order || 'asc' });
  const start = options.start ? Date.parse(options.start) : NaN;
  const end = options.end ? Date.parse(options.end) + (/^\d{4}-\d{2}-\d{2}$/.test(options.end) ? 86_400_000 - 1 : 0) : NaN;
  if (options.start && !Number.isFinite(start)) throw new Error('London Strategic Edge start must be an ISO date or timestamp.');
  if (options.end && !Number.isFinite(end)) throw new Error('London Strategic Edge end must be an ISO date or timestamp.');
  if (parsed.candles.some((candle) => Number.isFinite(start) && Date.parse(candle.timestamp) < start)) throw new Error('London Strategic Edge returned a candle before the requested start.');
  if (parsed.candles.some((candle) => Number.isFinite(end) && Date.parse(candle.timestamp) > end)) throw new Error('London Strategic Edge returned a candle after the requested end.');
  if (parsed.candles.length > Number(options.limit ?? 5000)) throw new Error('London Strategic Edge returned more rows than requested.');
  return { ...parsed,
    request: { url: request.url, symbol: options.symbol, timeframe: options.timeframe || '1m', start: options.start || null, end: options.end || null,
      order: options.order || 'asc', limit: Number(options.limit ?? 5000), dataset: options.dataset || null }, rawSha256: sha256(raw),
    possibleAdditionalRows: parsed.candles.length === Number(options.limit ?? 5000) };
}

function parseCsvRows(raw) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const text = String(raw || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (char !== '\r') cell += char;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  while (rows.length && rows.at(-1).every((value) => !String(value).trim())) rows.pop();
  if (rows.length < 2) throw new Error('CSV must contain a header and at least one data row.');
  return rows;
}

function resolveColumns(headers, explicit = {}) {
  const normalized = new Map(headers.map((header) => [String(header).trim().toLowerCase(), header]));
  const mapping = {};
  for (const field of CANONICAL_FIELDS) {
    const requested = explicit[field];
    if (requested) {
      if (!headers.includes(requested)) throw new Error(`Configured ${field} column is missing: ${requested}`);
      mapping[field] = requested;
      continue;
    }
    const matches = DEFAULT_ALIASES[field].filter((alias) => normalized.has(alias));
    if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous ${field} columns; provide an explicit mapping.` : `CSV is missing a recognized ${field} column; provide an explicit mapping.`);
    mapping[field] = normalized.get(matches[0]);
  }
  if (new Set(Object.values(mapping)).size !== CANONICAL_FIELDS.length) throw new Error('Each canonical OHLCV field must map to a different CSV column.');
  return mapping;
}

function parseTimestamp(value, rowNumber, timestampUnit) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`CSV row ${rowNumber} has an empty timestamp.`);
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    if (!timestampUnit) throw new Error(`CSV row ${rowNumber} uses a numeric timestamp; timestampUnit is required.`);
    const factors = { s: 1000, ms: 1, us: 1 / 1000, ns: 1 / 1_000_000 };
    if (!(timestampUnit in factors)) throw new Error('timestampUnit must be s, ms, us, or ns.');
    const milliseconds = Number(raw) * factors[timestampUnit];
    if (!Number.isFinite(milliseconds)) throw new Error(`CSV row ${rowNumber} has an invalid timestamp.`);
    return new Date(milliseconds).toISOString();
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) throw new Error(`CSV row ${rowNumber} timestamp must include Z or a UTC offset.`);
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) throw new Error(`CSV row ${rowNumber} has an invalid timestamp.`);
  return new Date(milliseconds).toISOString();
}

function number(value, rowNumber, field) {
  if (String(value ?? '').trim() === '') throw new Error(`CSV row ${rowNumber} has an empty ${field}.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`CSV row ${rowNumber} has a non-finite ${field}.`);
  return parsed;
}

function auditCandles(candles, { intervalMinutes = 1 } = {}) {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) throw new Error('intervalMinutes must be a positive integer.');
  const intervalMs = intervalMinutes * 60_000;
  const issues = [], gaps = [];
  const seen = new Map();
  let previous = null;
  candles.forEach((candle, index) => {
    const row = index + 2;
    const time = Date.parse(candle.timestamp);
    const values = ['open', 'high', 'low', 'close', 'volume'].map((field) => Number(candle[field]));
    if (!Number.isFinite(time)) issues.push({ severity: 'error', code: 'invalid-timestamp', row });
    if (values.some((value) => !Number.isFinite(value))) issues.push({ severity: 'error', code: 'non-finite-value', row });
    if (Number(candle.volume) < 0) issues.push({ severity: 'error', code: 'negative-volume', row });
    if (Number(candle.high) < Math.max(Number(candle.open), Number(candle.close)) || Number(candle.low) > Math.min(Number(candle.open), Number(candle.close)) || Number(candle.high) < Number(candle.low)) {
      issues.push({ severity: 'error', code: 'invalid-ohlc', row });
    }
    if (Number.isFinite(time) && time % intervalMs !== 0) issues.push({ severity: 'error', code: 'off-interval-timestamp', row, timestamp: candle.timestamp });
    if (seen.has(time)) issues.push({ severity: 'error', code: 'duplicate-timestamp', row, firstRow: seen.get(time), timestamp: candle.timestamp });
    else if (Number.isFinite(time)) seen.set(time, row);
    if (previous && time <= previous.time) issues.push({ severity: 'error', code: 'not-chronological', row, previousRow: previous.row });
    if (previous && time > previous.time + intervalMs) {
      const missingBars = Math.floor((time - previous.time) / intervalMs) - 1;
      const gap = { severity: 'gap', code: 'missing-intervals', row, after: previous.timestamp, before: candle.timestamp, missingBars };
      gaps.push(gap); issues.push(gap);
    }
    if (Number.isFinite(time)) previous = { time, row, timestamp: candle.timestamp };
  });
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  return { ok: errors === 0 && gaps.length === 0, structurallyValid: errors === 0, records: candles.length, errors, gapCount: gaps.length,
    missingBars: gaps.reduce((sum, gap) => sum + gap.missingBars, 0), issues };
}

function canonicalFingerprint(candles) {
  return sha256(candles.map((candle) => CANONICAL_FIELDS.map((field) => field === 'timestamp' ? candle[field] : String(candle[field])).join(',')).join('\n') + '\n');
}

function importCsv(raw, options = {}) {
  const rows = parseCsvRows(raw);
  const headers = rows[0].map((value) => String(value).trim());
  if (headers.some((header) => !header)) throw new Error('CSV contains an empty header.');
  if (new Set(headers).size !== headers.length) throw new Error('CSV contains duplicate headers.');
  const mapping = resolveColumns(headers, options.columns || {});
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));
  const candles = rows.slice(1).map((cells, offset) => {
    const rowNumber = offset + 2;
    if (cells.length !== headers.length) throw new Error(`CSV row ${rowNumber} has ${cells.length} fields; expected ${headers.length}.`);
    return {
      timestamp: parseTimestamp(cells[index[mapping.timestamp]], rowNumber, options.timestampUnit),
      open: number(cells[index[mapping.open]], rowNumber, 'open'), high: number(cells[index[mapping.high]], rowNumber, 'high'),
      low: number(cells[index[mapping.low]], rowNumber, 'low'), close: number(cells[index[mapping.close]], rowNumber, 'close'),
      volume: number(cells[index[mapping.volume]], rowNumber, 'volume'),
      ...(options.instrumentId === undefined ? {} : { instrumentId: options.instrumentId })
    };
  });
  const audit = auditCandles(candles, options);
  return { candles, audit, mapping, fingerprint: canonicalFingerprint(candles) };
}

function importCsvFile(filename, options = {}) {
  const raw = fs.readFileSync(filename);
  const imported = importCsv(raw.toString('utf8'), options);
  return { ...imported, source: { provider: options.provider || 'unspecified', dataset: options.dataset || null, symbol: options.symbol || null,
    intervalMinutes: options.intervalMinutes || 1, timestampPolicy: options.timestampUnit ? `unix-${options.timestampUnit}` : 'explicit-offset-normalized-to-utc',
    path: path.resolve(filename), bytes: raw.length, sha256: sha256(raw), firstTimestamp: imported.candles[0]?.timestamp || null,
    lastTimestamp: imported.candles.at(-1)?.timestamp || null, records: imported.candles.length } };
}

function compareCandles(candidate, reference, options = {}) {
  const priceTolerance = Number(options.priceTolerance ?? 0);
  const volumeTolerance = Number(options.volumeTolerance ?? 0);
  if (!(priceTolerance >= 0) || !(volumeTolerance >= 0)) throw new Error('Comparison tolerances must be non-negative.');
  const start = Math.max(Date.parse(candidate[0]?.timestamp), Date.parse(reference[0]?.timestamp));
  const end = Math.min(Date.parse(candidate.at(-1)?.timestamp), Date.parse(reference.at(-1)?.timestamp));
  const inWindow = (candle) => Date.parse(candle.timestamp) >= start && Date.parse(candle.timestamp) <= end;
  const candidateWindow = Number.isFinite(start) && start <= end ? candidate.filter(inWindow) : [];
  const referenceWindow = Number.isFinite(start) && start <= end ? reference.filter(inWindow) : [];
  const referenceByTime = new Map(referenceWindow.map((candle) => [candle.timestamp, candle]));
  const candidateTimes = new Set(candidateWindow.map((candle) => candle.timestamp));
  const fields = ['open', 'high', 'low', 'close', 'volume'];
  const metrics = Object.fromEntries(fields.map((field) => [field, { mismatches: 0, meanAbsoluteDifference: 0, maxAbsoluteDifference: 0 }]));
  const examples = [];
  let overlap = 0;
  for (const candle of candidateWindow) {
    const other = referenceByTime.get(candle.timestamp);
    if (!other) continue;
    overlap += 1;
    for (const field of fields) {
      const difference = Math.abs(Number(candle[field]) - Number(other[field]));
      const metric = metrics[field];
      metric.meanAbsoluteDifference += difference;
      metric.maxAbsoluteDifference = Math.max(metric.maxAbsoluteDifference, difference);
      const tolerance = field === 'volume' ? volumeTolerance : priceTolerance;
      if (difference > tolerance) {
        metric.mismatches += 1;
        if (examples.length < 20) examples.push({ timestamp: candle.timestamp, field, candidate: candle[field], databento: other[field], difference });
      }
    }
  }
  for (const metric of Object.values(metrics)) metric.meanAbsoluteDifference = overlap ? metric.meanAbsoluteDifference / overlap : null;
  const missingFromCandidate = referenceWindow.filter((candle) => !candidateTimes.has(candle.timestamp)).length;
  const missingFromDatabento = candidateWindow.filter((candle) => !referenceByTime.has(candle.timestamp)).length;
  const mismatches = Object.values(metrics).reduce((sum, metric) => sum + metric.mismatches, 0);
  return { comparable: overlap > 0, withinTolerance: overlap > 0 && mismatches === 0 && missingFromCandidate === 0 && missingFromDatabento === 0,
    candidateRecords: candidate.length, databentoRecords: reference.length, comparisonWindow: Number.isFinite(start) && start <= end
      ? { start: new Date(start).toISOString(), end: new Date(end).toISOString(), candidateRecords: candidateWindow.length, databentoRecords: referenceWindow.length } : null,
    outsideComparisonWindow: { candidateRecords: candidate.length - candidateWindow.length, databentoRecords: reference.length - referenceWindow.length },
    overlap, missingFromCandidate, missingFromDatabento, priceTolerance, volumeTolerance, metrics, examples };
}

function codeFingerprint(root = process.cwd()) {
  const files = fs.readdirSync(path.join(root, 'lib')).filter((name) => name.endsWith('.cjs')).sort();
  const hash = createHash('sha256');
  for (const name of files) hash.update(name).update('\0').update(fs.readFileSync(path.join(root, 'lib', name))).update('\0');
  return { sha256: hash.digest('hex'), files };
}

module.exports = { CANONICAL_FIELDS, LSE_BASE_URL, LSE_TIMEFRAMES, auditCandles, buildLseCandlesRequest, canonicalFingerprint, codeFingerprint, compareCandles, fetchLseCandlePage, fetchLseDiscovery, importCsv, importCsvFile, parseCsvRows, parseLseCandlePage, sha256 };
