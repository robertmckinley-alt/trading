const HISTORICAL_URL = 'https://hist.databento.com/v0/timeseries.get_range';
const PRICE_SCALE = 1_000_000_000;
const MAX_CANDLES_PER_REQUEST = 150_000;
const MAX_TOTAL_CANDLES = 500_000;
const REQUEST_CHUNK_DAYS = 30;

function price(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return NaN;
  return Math.abs(number) > 1_000_000 ? number / PRICE_SCALE : number;
}

function timestamp(value) {
  if (typeof value === 'number' || /^\d{16,}$/.test(String(value || ''))) {
    const nanoseconds = Number(value);
    if (!Number.isFinite(nanoseconds)) return null;
    return new Date(nanoseconds / 1_000_000).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeRecord(record) {
  const header = record.hd || record.header || {};
  const normalized = {
    timestamp: timestamp(record.ts_event ?? record.timestamp ?? header.ts_event ?? header.timestamp),
    open: price(record.open),
    high: price(record.high),
    low: price(record.low),
    close: price(record.close),
    volume: Number(record.volume || 0),
    instrumentId: record.instrument_id ?? record.instrumentId ?? header.instrument_id ?? header.instrumentId ?? null
  };
  if (!normalized.timestamp || [normalized.open, normalized.high, normalized.low, normalized.close].some((value) => !Number.isFinite(value))) {
    return null;
  }
  return normalized;
}

function parseDatabentoJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  let records;
  if (text.startsWith('[')) {
    records = JSON.parse(text);
  } else {
    records = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Databento returned invalid JSON on line ${index + 1}.`);
      }
    });
  }

  const byTimestamp = new Map();
  for (const record of records) {
    const candle = normalizeRecord(record);
    if (candle) byTimestamp.set(candle.timestamp, candle);
  }
  const candles = [...byTimestamp.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  if (candles.length > MAX_CANDLES_PER_REQUEST) throw new Error(`Historical response exceeded the ${MAX_CANDLES_PER_REQUEST.toLocaleString()} candle per-request safety limit.`);
  return candles;
}

function historicalWindow(days = 60, now = new Date()) {
  const safeDays = Math.max(10, Math.min(366, Math.round(Number(days) || 60)));
  const end = new Date(now.getTime() - (20 * 60_000));
  end.setUTCSeconds(0, 0);
  const start = new Date(end.getTime() - (safeDays * 24 * 60 * 60_000));
  return { days: safeDays, start: start.toISOString(), end: end.toISOString() };
}

function historicalYearWindow(year = new Date().getUTCFullYear(), now = new Date()) {
  const requestedYear = Math.trunc(Number(year));
  const currentYear = now.getUTCFullYear();
  if (!Number.isFinite(requestedYear) || requestedYear < 2000 || requestedYear > currentYear) {
    throw new Error(`Historical year must be between 2000 and ${currentYear}.`);
  }
  const start = new Date(Date.UTC(requestedYear, 0, 1));
  const yearEnd = new Date(Date.UTC(requestedYear + 1, 0, 1));
  const delayedNow = new Date(now.getTime() - (20 * 60_000));
  delayedNow.setUTCSeconds(0, 0);
  const end = new Date(Math.min(yearEnd.getTime(), delayedNow.getTime()));
  if (end <= start) throw new Error(`Historical data for ${requestedYear} is not available yet.`);
  const days = Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
  return { year: requestedYear, days, start: start.toISOString(), end: end.toISOString() };
}

function splitHistoricalWindow(window, chunkDays = REQUEST_CHUNK_DAYS) {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  const chunkMs = Math.max(1, Number(chunkDays)) * 86_400_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Historical window is invalid.');
  const chunks = [];
  for (let cursor = start; cursor < end; cursor += chunkMs) {
    chunks.push({
      start: new Date(cursor).toISOString(),
      end: new Date(Math.min(end, cursor + chunkMs)).toISOString()
    });
  }
  return chunks;
}

async function fetchDatabentoChunk(options, window) {
  const params = new URLSearchParams({
    dataset: options.dataset || 'GLBX.MDP3',
    symbols: options.symbol || 'NQ.v.0',
    schema: 'ohlcv-1m',
    stype_in: 'continuous',
    start: window.start,
    end: window.end,
    encoding: 'json',
    pretty_px: 'true',
    pretty_ts: 'true',
    map_symbols: 'true'
  });
  const response = await options.fetchImpl(`${HISTORICAL_URL}?${params}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${options.apiKey}:`).toString('base64')}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(`Databento historical request failed (${response.status})${detail ? `: ${detail}` : '.'}`);
  }
  return parseDatabentoJson(await response.text());
}

async function fetchDatabentoHistoricalCandles(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const env = options.env || process.env;
  const apiKey = String(options.apiKey || env.DATABENTO_API_KEY || '');
  if (!apiKey) throw new Error('Historical Databento access is not configured on this server.');
  const window = options.window || historicalWindow(options.days || 60, options.now || new Date());
  const byTimestamp = new Map();
  for (const chunk of splitHistoricalWindow(window, options.chunkDays)) {
    const candles = await fetchDatabentoChunk({ ...options, apiKey, fetchImpl }, chunk);
    for (const candle of candles) byTimestamp.set(candle.timestamp, candle);
    if (byTimestamp.size > MAX_TOTAL_CANDLES) {
      throw new Error(`Historical response exceeded the ${MAX_TOTAL_CANDLES.toLocaleString()} total candle safety limit.`);
    }
  }
  const candles = [...byTimestamp.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  if (!candles.length) throw new Error('Databento returned no one-minute NQ candles for this period.');
  return {
    source: 'Databento GLBX.MDP3',
    symbol: options.symbol || 'NQ.v.0',
    dataset: options.dataset || 'GLBX.MDP3',
    schema: 'ohlcv-1m',
    window,
    candles
  };
}

module.exports = { fetchDatabentoHistoricalCandles, historicalWindow, historicalYearWindow, parseDatabentoJson, splitHistoricalWindow };
