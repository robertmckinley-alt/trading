const fs = require('fs');
const path = require('path');
const { ORB_FILTER_RULES, ORB_EXTENSION_RULES } = require('./strategy-registry.cjs');
const { detectDmcMarketOpenSignal } = require('./dmc-market-open.cjs');
const {
  buildTradePlan,
  normalizeSetup,
  parseCsvFile,
  trackTradeLifecycle
} = require('./trader-core.cjs');

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

// The same 2,501-candle context is revisited every minute during replay.
// Cache calendar conversion only, never indicators or future-dependent signals.
const zonedFormatters = new Map();
const zonedPartsCache = new Map();
const MAX_ZONED_PARTS = 8192;

function getZonedParts(timestamp, timeZone) {
  const cacheKey = `${timeZone}|${timestamp}`;
  const cached = zonedPartsCache.get(cacheKey);
  if (cached) return cached;
  const date = new Date(timestamp);
  let formatter = zonedFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    if (zonedFormatters.size >= 16) zonedFormatters.delete(zonedFormatters.keys().next().value);
    zonedFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  const result = Object.freeze({
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  });
  if (zonedPartsCache.size >= MAX_ZONED_PARTS) zonedPartsCache.delete(zonedPartsCache.keys().next().value);
  zonedPartsCache.set(cacheKey, result);
  return result;
}

function toMinutes(hhmm) {
  const [hour, minute] = String(hhmm).split(':').map(Number);
  return (hour * 60) + minute;
}

function minutesForTimestamp(timestamp, timeZone) {
  const parts = getZonedParts(timestamp, timeZone);
  return (parts.hour * 60) + parts.minute;
}

function inWindow(minuteOfDay, start, end) {
  const startMinute = toMinutes(start);
  const endMinute = toMinutes(end);
  if (startMinute <= endMinute) {
    return minuteOfDay >= startMinute && minuteOfDay <= endMinute;
  }
  return minuteOfDay >= startMinute || minuteOfDay <= endMinute;
}

function shiftDate(dateString, deltaDays) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function parseActivationTime(activationTime) {
  const [clock, timeZone] = String(activationTime || '').split(/\s+/);
  if (!clock || !timeZone) {
    throw new Error('activationTime must look like "09:00 America/New_York"');
  }
  return {
    clock,
    timeZone,
    minuteOfDay: toMinutes(clock)
  };
}

function normalizeStrategyConfig(rawConfig) {
  const live = rawConfig.live || {};
  const apiKeyEnv = String(live.apiKeyEnv || process.env.LIVE_DATA_API_KEY_ENV || 'DATABENTO_API_KEY');
  const hasDatabentoKey = Boolean(process.env[apiKeyEnv]);
  const requestedProvider = String(live.provider || process.env.LIVE_DATA_PROVIDER || '');
  const selectedProvider = !requestedProvider || requestedProvider === 'auto'
    ? (hasDatabentoKey ? 'databento-live' : 'mock')
    : requestedProvider;
  const resolvedProvider = selectedProvider === 'databento' ? 'databento-live' : selectedProvider;
  return {
    provider: resolvedProvider,
    ticker: String(live.ticker || process.env.LIVE_DATA_TICKER || 'NQ.v.0'),
    mockCsvPath: String(live.mockCsvPath || process.env.LIVE_DATA_MOCK_CSV || path.join(process.cwd(), 'examples', 'sample-nq-1m.csv')),
    apiKeyEnv,
    baseUrl: String(live.baseUrl || process.env.LIVE_DATA_BASE_URL || 'https://api.polygon.io'),
    dataset: String(live.dataset || process.env.LIVE_DATA_DATASET || 'GLBX.MDP3'),
    schema: String(live.schema || process.env.LIVE_DATA_SCHEMA || 'ohlcv-1m'),
    stypeIn: String(live.stypeIn || process.env.LIVE_DATA_STYPE_IN || 'continuous'),
    pythonBin: String(live.pythonBin || process.env.LIVE_DATA_PYTHON_BIN || 'python3'),
    liveCachePath: String(live.liveCachePath || process.env.LIVE_DATA_CACHE_PATH || path.join(process.cwd(), 'runtime', 'databento-live.json')),
    maxLiveCandleAgeMinutes: Number(live.maxLiveCandleAgeMinutes || process.env.LIVE_DATA_MAX_CANDLE_AGE_MINUTES || 3),
    lookbackBars: Number(live.lookbackBars || process.env.LIVE_DATA_LOOKBACK_BARS || 1200),
    pollIntervalMs: Number(live.pollIntervalMs || process.env.LIVE_DATA_POLL_INTERVAL_MS || 60000),
    sessionWindows: {
      asia: {
        start: String(live.sessionWindows?.asia?.start || '20:00'),
        end: String(live.sessionWindows?.asia?.end || '01:59')
      },
      london: {
        start: String(live.sessionWindows?.london?.start || '02:00'),
        end: String(live.sessionWindows?.london?.end || '07:59')
      }
    },
    riskRewardFallback: Number(live.riskRewardFallback || 1.5),
    entryBufferTicks: Number(live.entryBufferTicks || 0),
    stopBufferTicks: Number(live.stopBufferTicks || 1),
    maxSignalAgeBars: Number(live.maxSignalAgeBars || 15),
    maxTradesPerDay: Number(live.maxTradesPerDay || 1),
    openingRangeRetest: {
      rangeStart: String(live.openingRangeRetest?.rangeStart || '09:30'),
      rangeEnd: String(live.openingRangeRetest?.rangeEnd || '09:45'),
      entryEnd: String(live.openingRangeRetest?.entryEnd || '11:30'),
      maxRetestBars: Number(live.openingRangeRetest?.maxRetestBars || 10),
      retestToleranceTicks: Number(live.openingRangeRetest?.retestToleranceTicks || 2),
      orderFlowIntervalMinutes: Number(live.openingRangeRetest?.orderFlowIntervalMinutes || 5),
      orderFlowFastEma: Number(live.openingRangeRetest?.orderFlowFastEma || 8),
      orderFlowSlowEma: Number(live.openingRangeRetest?.orderFlowSlowEma || 21)
    },
    openingRangeClose: {
      rangeStart: String(live.openingRangeClose?.rangeStart || '09:30'),
      rangeEnd: String(live.openingRangeClose?.rangeEnd || '09:45'),
      entryEnd: String(live.openingRangeClose?.entryEnd || '11:30'),
      barMinutes: Number(live.openingRangeClose?.barMinutes || 15),
      minimumBodyFraction: Number(live.openingRangeClose?.minimumBodyFraction ?? 0.5),
      maximumBreakoutWickFraction: Number(live.openingRangeClose?.maximumBreakoutWickFraction ?? 0.25),
      maximumStopPoints: Number(live.openingRangeClose?.maximumStopPoints || 20)
    },
    dmcMarketOpen: {
      requiredHourlyBars: Number(live.dmcMarketOpen?.requiredHourlyBars || 18),
      maximumHourlyBars: Number(live.dmcMarketOpen?.maximumHourlyBars || 24),
      hourlyAtrPeriod: Number(live.dmcMarketOpen?.hourlyAtrPeriod || 14),
      minimumBiasAtrRatio: Number(live.dmcMarketOpen?.minimumBiasAtrRatio ?? 0.35),
      maximumBiasAtrRatio: Number(live.dmcMarketOpen?.maximumBiasAtrRatio || 2),
      maximumBiasWickFraction: Number(live.dmcMarketOpen?.maximumBiasWickFraction ?? 0.5),
      minimumFiveMinuteBodyFraction: Number(live.dmcMarketOpen?.minimumFiveMinuteBodyFraction ?? 0.5),
      maximumFiveMinuteAdverseWickFraction: Number(live.dmcMarketOpen?.maximumFiveMinuteAdverseWickFraction ?? 0.35),
      fiveMinuteAtrPeriod: Number(live.dmcMarketOpen?.fiveMinuteAtrPeriod || 14),
      maximumEntryDistanceAtr: Number(live.dmcMarketOpen?.maximumEntryDistanceAtr || 2),
      minimumStopPoints: Number(live.dmcMarketOpen?.minimumStopPoints || 2),
      maximumStopPoints: Number(live.dmcMarketOpen?.maximumStopPoints || 22),
      minimumRewardRisk: Number(live.dmcMarketOpen?.minimumRewardRisk || 1.5),
      rangeLockBars: Number(live.dmcMarketOpen?.rangeLockBars || 3),
      rangeLockConfirmations: Number(live.dmcMarketOpen?.rangeLockConfirmations || 2),
      rangeLockAtrFraction: Number(live.dmcMarketOpen?.rangeLockAtrFraction || 0.2),
      blackoutDates: Array.isArray(live.dmcMarketOpen?.blackoutDates) ? live.dmcMarketOpen.blackoutDates.map(String) : []
    },
    htfSessionSweep: {
      entryStart: String(live.htfSessionSweep?.entryStart || '08:00'),
      entryEnd: String(live.htfSessionSweep?.entryEnd || '11:30'),
      confirmationMinutes: Number(live.htfSessionSweep?.confirmationMinutes || 5),
      minimumConfirmationBodyFraction: Number(live.htfSessionSweep?.minimumConfirmationBodyFraction ?? 0.45),
      maximumStopPoints: Number(live.htfSessionSweep?.maximumStopPoints || 24),
      minimumStopPoints: Number(live.htfSessionSweep?.minimumStopPoints || 2),
      hourlyLookbackBars: Number(live.htfSessionSweep?.hourlyLookbackBars || 3)
    }
  };
}

function fetchDatabentoLiveCandles(strategyConfig) {
  const apiKey = process.env[strategyConfig.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${strategyConfig.apiKeyEnv} environment variable for Databento live futures data`);
  }
  const cachePath = path.resolve(strategyConfig.liveCachePath);
  if (!fs.existsSync(cachePath)) {
    throw new Error(`Databento live stream cache is not ready at ${cachePath}`);
  }
  const payload = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  if (payload.mode !== 'live' || payload.provider !== 'databento-live') {
    throw new Error('Databento cache rejected because it is not marked as live-stream data');
  }
  const candles = (Array.isArray(payload.candles) ? payload.candles : [])
    .map((candle) => ({
      timestamp: candle.timestamp,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume || 0)
    }))
    .filter((candle) => (
      candle.timestamp &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close)
    ))
    .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp))
    .slice(-Math.max(1, strategyConfig.lookbackBars));
  if (!candles.length) {
    throw new Error(`No live Databento candles available for ${strategyConfig.ticker}`);
  }
  const lastCandleAt = new Date(candles.at(-1).timestamp).getTime();
  const ageMinutes = (Date.now() - lastCandleAt) / 60_000;
  if (!Number.isFinite(lastCandleAt) || ageMinutes > strategyConfig.maxLiveCandleAgeMinutes) {
    throw new Error(
      `Databento live candle is stale by ${Number.isFinite(ageMinutes) ? ageMinutes.toFixed(1) : 'unknown'} minutes; latest candle ${candles.at(-1).timestamp}`
    );
  }
  return {
    source: `databento-live:${strategyConfig.dataset}:${strategyConfig.ticker}`,
    candles,
    metadata: {
      provider: 'databento-live',
      ticker: strategyConfig.ticker,
      dataset: strategyConfig.dataset,
      schema: strategyConfig.schema,
      stypeIn: strategyConfig.stypeIn,
      fetchedAt: new Date().toISOString(),
      streamStartedAt: payload.startedAt || null,
      cacheUpdatedAt: payload.updatedAt || null,
      note: 'Databento Live API OHLCV stream; historical API fallback is disabled',
      fetchedRows: candles.length
    }
  };
}

async function fetchPolygonFuturesCandles(strategyConfig, signalConfig) {
  const apiKey = process.env[strategyConfig.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${strategyConfig.apiKeyEnv} environment variable for live futures data`);
  }
  const url = new URL(`/futures/v1/aggs/${strategyConfig.ticker}`, strategyConfig.baseUrl);
  url.searchParams.set('resolution', '1min');
  url.searchParams.set('limit', String(strategyConfig.lookbackBars));
  url.searchParams.set('sort', 'window_start.asc');
  url.searchParams.set('apiKey', apiKey);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Polygon futures request failed with ${response.status}`);
  }
  const payload = await response.json();
  const rows = Array.isArray(payload.results) ? payload.results : [];
  if (!rows.length) {
    throw new Error(`No live candles returned for ${strategyConfig.ticker}`);
  }
  const candles = rows.map((row) => ({
    timestamp: row.window_start || row.session_end_date || row.timestamp,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close)
  })).filter((row) => Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close));
  return {
    source: `polygon-futures:${strategyConfig.ticker}`,
    candles,
    metadata: {
      provider: 'polygon-futures',
      ticker: strategyConfig.ticker,
      fetchedAt: new Date().toISOString(),
      note: 'Futures aggregate bars API'
    }
  };
}

function fetchMockCandles(strategyConfig) {
  const csvPath = path.resolve(strategyConfig.mockCsvPath);
  return {
    source: `mock:${csvPath}`,
    candles: parseCsvFile(csvPath),
    metadata: {
      provider: 'mock',
      ticker: strategyConfig.ticker,
      fetchedAt: new Date().toISOString()
    }
  };
}

async function fetchLiveCandles(rawConfig) {
  const strategyConfig = normalizeStrategyConfig(rawConfig);
  if (strategyConfig.provider === 'mock') {
    return fetchMockCandles(strategyConfig);
  }
  if (strategyConfig.provider === 'databento-live') {
    return fetchDatabentoLiveCandles(strategyConfig);
  }
  if (strategyConfig.provider === 'polygon-futures') {
    return fetchPolygonFuturesCandles(strategyConfig, rawConfig);
  }
  throw new Error(`Unsupported live provider: ${strategyConfig.provider}`);
}

function computeSessionRange(candles, timeZone, tradingDate, window) {
  const crossesMidnight = toMinutes(window.start) > toMinutes(window.end);
  const priorDate = shiftDate(tradingDate, -1);
  const sessionCandles = candles.filter((candle) => {
    const parts = getZonedParts(candle.timestamp, timeZone);
    const minuteOfDay = (parts.hour * 60) + parts.minute;
    if (!crossesMidnight) {
      return parts.date === tradingDate && inWindow(minuteOfDay, window.start, window.end);
    }
    return (
      (parts.date === priorDate && minuteOfDay >= toMinutes(window.start)) ||
      (parts.date === tradingDate && minuteOfDay <= toMinutes(window.end))
    );
  });
  if (!sessionCandles.length) {
    return null;
  }
  const highs = sessionCandles.map((candle) => candle.high);
  const lows = sessionCandles.map((candle) => candle.low);
  return {
    high: Math.max(...highs),
    low: Math.min(...lows),
    start: sessionCandles[0].timestamp,
    end: sessionCandles[sessionCandles.length - 1].timestamp
  };
}

function buildTargets(side, entry, stop, sessionRanges, config) {
  const risk = Math.abs(entry - stop);
  if (side === 'short') {
    const downsidePools = [sessionRanges.asia?.low, sessionRanges.london?.low].filter((value) => Number.isFinite(value) && value < entry).sort((a, b) => b - a);
    const first = downsidePools[0] ?? round(entry - (risk * config.riskRewardFallback), 2);
    const second = downsidePools[1] ?? round(entry - (risk * (config.riskRewardFallback + 0.75)), 2);
    const third = round(entry - (risk * (config.riskRewardFallback + 1.5)), 2);
    return [first, second, third].filter((value, index, array) => value < entry && array.indexOf(value) === index);
  }

  const upsidePools = [sessionRanges.asia?.high, sessionRanges.london?.high].filter((value) => Number.isFinite(value) && value > entry).sort((a, b) => a - b);
  const first = upsidePools[0] ?? round(entry + (risk * config.riskRewardFallback), 2);
  const second = upsidePools[1] ?? round(entry + (risk * (config.riskRewardFallback + 0.75)), 2);
  const third = round(entry + (risk * (config.riskRewardFallback + 1.5)), 2);
  return [first, second, third].filter((value, index, array) => value > entry && array.indexOf(value) === index);
}

function candleTouched(candle, price) {
  return candle.low <= price && candle.high >= price;
}

function buildHourlyTargets(side, entry, stop, hourlyRange, config) {
  const risk = Math.abs(entry - stop);
  const fallback = Number(config.riskRewardFallback || 1.5);
  const rangeTargets = side === 'short'
    ? [hourlyRange.low].filter((value) => Number.isFinite(value) && value < entry)
    : [hourlyRange.high].filter((value) => Number.isFinite(value) && value > entry);
  const ladder = side === 'short'
    ? [entry - (risk * fallback), entry - (risk * (fallback + 0.75)), entry - (risk * (fallback + 1.5))]
    : [entry + (risk * fallback), entry + (risk * (fallback + 0.75)), entry + (risk * (fallback + 1.5))];
  return [...rangeTargets, ...ladder.map((value) => round(value, 2))]
    .filter((value, index, array) => (side === 'short' ? value < entry : value > entry) && array.indexOf(value) === index)
    .sort((left, right) => side === 'short' ? right - left : left - right)
    .slice(0, 3);
}

function computeRollingHourlyRange(candles, index) {
  const lookback = candles.slice(Math.max(0, index - 60), index);
  if (lookback.length < 30) {
    return null;
  }
  return {
    high: Math.max(...lookback.map((candle) => candle.high)),
    low: Math.min(...lookback.map((candle) => candle.low)),
    start: lookback[0].timestamp,
    end: lookback[lookback.length - 1].timestamp
  };
}

function computeAmdContext(candles, sessionRanges) {
  const asia = sessionRanges?.asia;
  const london = sessionRanges?.london;
  if (!asia || !london) {
    return {
      status: 'unavailable',
      classification: 'unknown',
      suggestedBias: 'neutral',
      sweptAsiaHigh: false,
      sweptAsiaLow: false,
      reason: 'Complete Asia and London ranges are required.'
    };
  }

  const londonStart = Date.parse(london.start);
  const londonEnd = Date.parse(london.end);
  const londonCandles = candles.filter((candle) => {
    const timestamp = Date.parse(candle.timestamp);
    return Number.isFinite(timestamp) && timestamp >= londonStart && timestamp <= londonEnd;
  });
  const highSweep = londonCandles.find((candle) => candle.high > asia.high) || null;
  const lowSweep = londonCandles.find((candle) => candle.low < asia.low) || null;
  const sweptAsiaHigh = Boolean(highSweep);
  const sweptAsiaLow = Boolean(lowSweep);
  const classification = sweptAsiaHigh && sweptAsiaLow
    ? 'two-sided-manipulation'
    : sweptAsiaHigh
      ? 'asia-high-swept'
      : sweptAsiaLow
        ? 'asia-low-swept'
        : 'no-asia-sweep';
  const suggestedBias = sweptAsiaHigh && !sweptAsiaLow
    ? 'bearish-reversal'
    : sweptAsiaLow && !sweptAsiaHigh
      ? 'bullish-reversal'
      : 'neutral';

  return {
    status: 'observed',
    classification,
    suggestedBias,
    sweptAsiaHigh,
    sweptAsiaLow,
    highSweepAt: highSweep?.timestamp || null,
    lowSweepAt: lowSweep?.timestamp || null,
    supportsLong: suggestedBias === 'bullish-reversal',
    supportsShort: suggestedBias === 'bearish-reversal',
    reason: sweptAsiaHigh || sweptAsiaLow
      ? `London ${sweptAsiaHigh ? 'swept the Asia high' : ''}${sweptAsiaHigh && sweptAsiaLow ? ' and ' : ''}${sweptAsiaLow ? 'swept the Asia low' : ''}.`
      : 'London remained inside the Asia range.'
  };
}

function roundToTick(value, tickSize) {
  return round(Math.round(value / tickSize) * tickSize, 8);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function averageTrueRange(candles, period = 14) {
  if (candles.length < 2) return 0;
  const ranges = [];
  for (let index = Math.max(1, candles.length - period); index < candles.length; index += 1) {
    const candle = candles[index];
    const priorClose = candles[index - 1].close;
    ranges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - priorClose),
      Math.abs(candle.low - priorClose)
    ));
  }
  return average(ranges);
}

function emaValues(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const output = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    output.push((values[index] * multiplier) + (output[index - 1] * (1 - multiplier)));
  }
  return output;
}

function aggregateCandles(candles, intervalMinutes, timeZone) {
  const groups = new Map();
  for (const candle of candles) {
    const parts = getZonedParts(candle.timestamp, timeZone);
    const minuteOfDay = (parts.hour * 60) + parts.minute;
    const bucketMinute = Math.floor(minuteOfDay / intervalMinutes) * intervalMinutes;
    const key = `${parts.date}|${bucketMinute}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        timestamp: candle.timestamp,
        endTimestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: Number(candle.volume || 0),
        samples: 1
      });
      continue;
    }
    existing.endTimestamp = candle.timestamp;
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += Number(candle.volume || 0);
    existing.samples += 1;
  }
  return [...groups.values()].filter((candle) => candle.samples >= intervalMinutes);
}

function buildRiskTargets(side, entry, stop, rawConfig, multiples = [1.5, 2.25, 3]) {
  const risk = Math.abs(entry - stop);
  return multiples.map((multiple) => roundToTick(
    side === 'long' ? entry + (risk * multiple) : entry - (risk * multiple),
    rawConfig.tickSize
  ));
}

function tradesForDate(state, tradingDate) {
  return (state.trades || []).filter((trade) => trade.date === tradingDate).length;
}

function buildResearchSetup({
  rawConfig,
  tradingDate,
  session,
  side,
  entry,
  stop,
  targets,
  thesis,
  entryModel,
  gapType,
  entryTimeframe,
  activationTime,
  referenceSessions,
  liquidityPool,
  liquidityLabel,
  drawOnLiquidity
}) {
  return {
    symbol: rawConfig.symbol,
    date: tradingDate,
    session,
    side,
    entry,
    stop,
    targets,
    thesis,
    setup: {
      liquiditySweep: false,
      reaction: side === 'long' ? 'bullish' : 'bearish',
      marketStructureShift: false,
      displacement: false,
      entryModel,
      gapType,
      entryTimeframe,
      activationTime,
      referenceSessions,
      stopPlacement: side === 'long' ? 'swing-low' : 'swing-high',
      higherTimeframeBias: side === 'long' ? 'bullish' : 'bearish',
      liquidityPool,
      liquidityLabel,
      drawOnLiquidity
    }
  };
}

function detectHourlySweepIfvgBosSignal(candles, rawConfig, state) {
  const liveConfig = normalizeStrategyConfig(rawConfig);
  const activation = parseActivationTime(rawConfig.liveActivationTime || '00:00 America/New_York');
  const latest = candles[candles.length - 1];
  if (!latest) {
    return { found: false, reason: 'No candles available' };
  }

  const tradingDate = getZonedParts(latest.timestamp, activation.timeZone).date;
  const tradesToday = (state.trades || []).filter((trade) => trade.date === tradingDate).length;
  if (tradesToday >= liveConfig.maxTradesPerDay) {
    return { found: false, reason: `Daily trade cap already reached for ${tradingDate}`, metadata: { tradingDate } };
  }

  for (let index = Math.max(62, candles.length - 1 - liveConfig.maxSignalAgeBars); index < candles.length; index += 1) {
    const first = candles[index - 2];
    const second = candles[index - 1];
    const third = candles[index];
    const hourlyRange = computeRollingHourlyRange(candles, index - 2);
    if (!first || !second || !third || !hourlyRange) {
      continue;
    }

    const sweptHigh = Math.max(first.high, second.high, third.high) > hourlyRange.high;
    const sweptLow = Math.min(first.low, second.low, third.low) < hourlyRange.low;
    const bearishIfvgBos = first.low > third.high && second.close < second.open && third.close < first.low;
    const bullishIfvgBos = first.high < third.low && second.close > second.open && third.close > first.high;

    if (sweptHigh && bearishIfvgBos) {
      const entry = round(third.high - (liveConfig.entryBufferTicks * rawConfig.tickSize), 2);
      const stop = round(Math.max(first.high, second.high, third.high) + (liveConfig.stopBufferTicks * rawConfig.tickSize), 2);
      const targets = buildHourlyTargets('short', entry, stop, hourlyRange, liveConfig);
      const stopDistance = Math.abs(entry - stop);
      if (rawConfig.strategySlug === 'hourly-sweep-stop-band' && (stopDistance < 8.25 || stopDistance > 16)) continue;
      if (!targets.length) continue;
      return {
        found: true,
        setup: {
          symbol: rawConfig.symbol,
          date: tradingDate,
          session: 'Hourly Sweep',
          side: 'short',
          entry,
          stop,
          targets,
          thesis: 'Live signal: 1-hour high sweep, 5-minute imbalance reaction, and 1-minute bearish BOS confirmation toward sell-side liquidity.',
          setup: {
            liquiditySweep: true,
            reaction: 'bearish',
            marketStructureShift: true,
            displacement: true,
            entryModel: 'hourly-sweep-ifvg-bos',
            gapType: 'ifvg',
            entryTimeframe: 'M1',
            activationTime: 'rolling 1H liquidity',
            referenceSessions: ['hourly-high-low', 'five-minute-fvg'],
            stopPlacement: 'swing-high',
            higherTimeframeBias: 'intraday-bearish-reversal',
            liquidityPool: 'one-hour-high',
            liquidityLabel: '1H high sweep',
            drawOnLiquidity: ['intraday-sell-side', 'range-low', 'prior-lows']
          }
        },
        sweepTimestamp: second.timestamp,
        triggerTimestamp: third.timestamp,
        sessionRanges: { asia: hourlyRange, london: hourlyRange },
        metadata: { tradingDate, hourlyHigh: hourlyRange.high, hourlyLow: hourlyRange.low, signalSide: 'short' }
      };
    }

    if (sweptLow && bullishIfvgBos) {
      const entry = round(third.low + (liveConfig.entryBufferTicks * rawConfig.tickSize), 2);
      const stop = round(Math.min(first.low, second.low, third.low) - (liveConfig.stopBufferTicks * rawConfig.tickSize), 2);
      const targets = buildHourlyTargets('long', entry, stop, hourlyRange, liveConfig);
      const stopDistance = Math.abs(entry - stop);
      if (rawConfig.strategySlug === 'hourly-sweep-stop-band' && (stopDistance < 8.25 || stopDistance > 16)) continue;
      if (!targets.length) continue;
      return {
        found: true,
        setup: {
          symbol: rawConfig.symbol,
          date: tradingDate,
          session: 'Hourly Sweep',
          side: 'long',
          entry,
          stop,
          targets,
          thesis: 'Live signal: 1-hour low sweep, 5-minute imbalance reaction, and 1-minute bullish BOS confirmation toward buy-side liquidity.',
          setup: {
            liquiditySweep: true,
            reaction: 'bullish',
            marketStructureShift: true,
            displacement: true,
            entryModel: 'hourly-sweep-ifvg-bos',
            gapType: 'ifvg',
            entryTimeframe: 'M1',
            activationTime: 'rolling 1H liquidity',
            referenceSessions: ['hourly-high-low', 'five-minute-fvg'],
            stopPlacement: 'swing-low',
            higherTimeframeBias: 'intraday-bullish-reversal',
            liquidityPool: 'one-hour-low',
            liquidityLabel: '1H low sweep',
            drawOnLiquidity: ['intraday-buy-side', 'range-high', 'prior-highs']
          }
        },
        sweepTimestamp: second.timestamp,
        triggerTimestamp: third.timestamp,
        sessionRanges: { asia: hourlyRange, london: hourlyRange },
        metadata: { tradingDate, hourlyHigh: hourlyRange.high, hourlyLow: hourlyRange.low, signalSide: 'long' }
      };
    }
  }

  return {
    found: false,
    reason: 'No qualifying 1H sweep plus iFVG/BOS confirmation detected yet',
    sessionRanges: null,
    metadata: { tradingDate }
  };
}

function detectNineAmSignalFromCandles(candles, rawConfig, state) {
  const liveConfig = normalizeStrategyConfig(rawConfig);
  const activation = parseActivationTime(rawConfig.liveActivationTime || '09:00 America/New_York');
  const latest = candles[candles.length - 1];
  if (!latest) {
    return { found: false, reason: 'No candles available' };
  }

  const tradingDate = getZonedParts(latest.timestamp, activation.timeZone).date;
  const latestMinute = minutesForTimestamp(latest.timestamp, activation.timeZone);
  if (latestMinute < activation.minuteOfDay) {
    return { found: false, reason: `Waiting for ${activation.clock} ${activation.timeZone}` };
  }

  const sessionRanges = {
    asia: computeSessionRange(candles, activation.timeZone, tradingDate, liveConfig.sessionWindows.asia),
    london: computeSessionRange(candles, activation.timeZone, tradingDate, liveConfig.sessionWindows.london)
  };
  if (!sessionRanges.asia || !sessionRanges.london) {
    return { found: false, reason: 'Need complete Asia and London session ranges first' };
  }
  const amdContext = computeAmdContext(candles, sessionRanges);

  const tradesToday = (state.trades || []).filter((trade) => trade.date === tradingDate).length;
  if (tradesToday >= liveConfig.maxTradesPerDay) {
    return { found: false, reason: `Daily trade cap already reached for ${tradingDate}` };
  }

  const activationCandles = candles.filter((candle) => {
    const parts = getZonedParts(candle.timestamp, activation.timeZone);
    return parts.date === tradingDate && ((parts.hour * 60) + parts.minute) >= activation.minuteOfDay;
  });
  if (activationCandles.length < 3) {
    return { found: false, reason: 'Need at least 3 post-activation candles to detect the FVG reversal', metadata: { tradingDate, amdContext } };
  }

  const sessionHigh = Math.max(sessionRanges.asia.high, sessionRanges.london.high);
  const sessionLow = Math.min(sessionRanges.asia.low, sessionRanges.london.low);

  for (let index = 2; index < activationCandles.length; index += 1) {
    const first = activationCandles[index - 2];
    const second = activationCandles[index - 1];
    const third = activationCandles[index];
    const signalAgeBars = activationCandles.length - 1 - index;
    if (signalAgeBars > liveConfig.maxSignalAgeBars) {
      continue;
    }

    const sweptHigh = Math.max(first.high, second.high, third.high) > sessionHigh;
    const sweptLow = Math.min(first.low, second.low, third.low) < sessionLow;
    const bearishFvg = first.low > third.high && second.close < second.open;
    const bullishFvg = first.high < third.low && second.close > second.open;

    if (sweptHigh && bearishFvg) {
      const entry = round(third.high - (liveConfig.entryBufferTicks * rawConfig.tickSize), 2);
      const stop = round(Math.max(first.high, second.high, third.high) + (liveConfig.stopBufferTicks * rawConfig.tickSize), 2);
      if (rawConfig.strategySlug === 'live-9am-sweep-min-stop' && Math.abs(entry - stop) < 10) continue;
      const targets = buildTargets('short', entry, stop, sessionRanges, liveConfig);
      if (!targets.length) {
        continue;
      }
      return {
        found: true,
        setup: {
          symbol: rawConfig.symbol,
          date: tradingDate,
          session: '9AM New York',
          side: 'short',
          entry,
          stop,
          targets,
          thesis: 'Live signal: session high sweep after 9AM New York followed by a 1-minute bearish FVG reversal back toward sell-side liquidity.',
          setup: {
            liquiditySweep: true,
            reaction: 'bearish',
            entryModel: 'session-sweep-fvg-reversal',
            gapType: 'fvg',
            entryTimeframe: 'M1',
            activationTime: `${activation.clock} ${activation.timeZone}`,
            referenceSessions: ['asia', 'london'],
            stopPlacement: 'swing-high',
            higherTimeframeBias: 'intraday-bearish-reversal',
            liquidityPool: 'asia-or-london-high',
            liquidityLabel: 'Asia / London session high',
            drawOnLiquidity: ['asia-low', 'london-low', 'intraday-sell-side']
          }
        },
        sweepTimestamp: second.timestamp,
        triggerTimestamp: third.timestamp,
        sessionRanges,
        metadata: {
          tradingDate,
          sessionHigh,
          sessionLow,
          signalSide: 'short',
          amdContext
        }
      };
    }

    if (sweptLow && bullishFvg) {
      const entry = round(third.low + (liveConfig.entryBufferTicks * rawConfig.tickSize), 2);
      const stop = round(Math.min(first.low, second.low, third.low) - (liveConfig.stopBufferTicks * rawConfig.tickSize), 2);
      if (rawConfig.strategySlug === 'live-9am-sweep-min-stop' && Math.abs(entry - stop) < 10) continue;
      const targets = buildTargets('long', entry, stop, sessionRanges, liveConfig);
      if (!targets.length) {
        continue;
      }
      return {
        found: true,
        setup: {
          symbol: rawConfig.symbol,
          date: tradingDate,
          session: '9AM New York',
          side: 'long',
          entry,
          stop,
          targets,
          thesis: 'Live signal: session low sweep after 9AM New York followed by a 1-minute bullish FVG reversal back toward buy-side liquidity.',
          setup: {
            liquiditySweep: true,
            reaction: 'bullish',
            entryModel: 'session-sweep-fvg-reversal',
            gapType: 'fvg',
            entryTimeframe: 'M1',
            activationTime: `${activation.clock} ${activation.timeZone}`,
            referenceSessions: ['asia', 'london'],
            stopPlacement: 'swing-low',
            higherTimeframeBias: 'intraday-bullish-reversal',
            liquidityPool: 'asia-or-london-low',
            liquidityLabel: 'Asia / London session low',
            drawOnLiquidity: ['asia-high', 'london-high', 'intraday-buy-side']
          }
        },
        sweepTimestamp: second.timestamp,
        triggerTimestamp: third.timestamp,
        sessionRanges,
        metadata: {
          tradingDate,
          sessionHigh,
          sessionLow,
          signalSide: 'long',
          amdContext
        }
      };
    }
  }

  return {
    found: false,
    reason: 'No qualifying post-9AM session sweep plus 1-minute FVG reversal detected yet',
    sessionRanges,
    metadata: {
      tradingDate,
      sessionHigh,
      sessionLow,
      amdContext
    }
  };
}

function detectOpeningRangeBreakoutSignal(candles, rawConfig, state) {
  const liveConfig = normalizeStrategyConfig(rawConfig);
  const timeZone = 'America/New_York';
  const latest = candles.at(-1);
  if (!latest) return { found: false, reason: 'No candles available' };
  const latestParts = getZonedParts(latest.timestamp, timeZone);
  const tradingDate = latestParts.date;
  const latestMinute = (latestParts.hour * 60) + latestParts.minute;
  if (tradesForDate(state, tradingDate) >= liveConfig.maxTradesPerDay) {
    return { found: false, reason: `Daily trade cap already reached for ${tradingDate}`, metadata: { tradingDate } };
  }

  const dayCandles = candles.filter((candle) => getZonedParts(candle.timestamp, timeZone).date === tradingDate);
  const openingCandles = dayCandles.filter((candle) => {
    const minute = minutesForTimestamp(candle.timestamp, timeZone);
    return minute >= 570 && minute < 660;
  });
  if (openingCandles.length < 75 || latestMinute < 660) {
    return { found: false, reason: 'Building the 09:30–11:00 New York opening range', metadata: { tradingDate } };
  }
  if (latestMinute > 930) {
    return { found: false, reason: 'Opening-range entry window closed at 15:30 New York', metadata: { tradingDate } };
  }

  const openingRange = {
    high: Math.max(...openingCandles.map((candle) => candle.high)),
    low: Math.min(...openingCandles.map((candle) => candle.low)),
    start: openingCandles[0].timestamp,
    end: openingCandles.at(-1).timestamp
  };
  const candidateCandles = dayCandles.filter((candle) => {
    const minute = minutesForTimestamp(candle.timestamp, timeZone);
    return minute >= 659 && minute <= 930;
  });
  const firstCandidateIndex = Math.max(1, candidateCandles.length - liveConfig.maxSignalAgeBars);
  for (let index = firstCandidateIndex; index < candidateCandles.length; index += 1) {
    const prior = candidateCandles[index - 1];
    const trigger = candidateCandles[index];
    const history = dayCandles.filter((candle) => new Date(candle.timestamp) <= new Date(trigger.timestamp));
    const atr = averageTrueRange(history, 14);
    const rangeWidth = openingRange.high - openingRange.low;
    const stopDistance = roundToTick(
      Math.min(20, Math.max(2, Math.min(rangeWidth * 0.25, atr * 1.5 || 2))),
      rawConfig.tickSize
    );
    let side = null;
    let entry = null;
    if (prior.close <= openingRange.high && trigger.close > openingRange.high) {
      side = 'long';
      entry = roundToTick(rawConfig.strategySlug === 'nq-opening-range-true-breakout' ? trigger.close : openingRange.high, rawConfig.tickSize);
    } else if (prior.close >= openingRange.low && trigger.close < openingRange.low) {
      side = 'short';
      entry = roundToTick(rawConfig.strategySlug === 'nq-opening-range-true-breakout' ? trigger.close : openingRange.low, rawConfig.tickSize);
    }
    if (!side) continue;
    const stop = roundToTick(side === 'long' ? entry - stopDistance : entry + stopDistance, rawConfig.tickSize);
    const targets = buildRiskTargets(side, entry, stop, rawConfig);
    return {
      found: true,
      setup: buildResearchSetup({
        rawConfig,
        tradingDate,
        session: 'Cash Opening Range',
        side,
        entry,
        stop,
        targets,
        thesis: 'Paper research signal: NQ broke the first 90-minute cash-session range. Stops are volatility scaled and capped to fit the shared paper-risk budget.',
        entryModel: 'opening-range-breakout',
        gapType: 'range-break',
        entryTimeframe: 'M1',
        activationTime: '11:00 America/New_York',
        referenceSessions: ['cash-opening-range'],
        liquidityPool: side === 'long' ? 'opening-range-high' : 'opening-range-low',
        liquidityLabel: '09:30–11:00 cash opening range',
        drawOnLiquidity: side === 'long' ? ['intraday-buy-side'] : ['intraday-sell-side']
      }),
      sweepTimestamp: openingRange.end,
      triggerTimestamp: trigger.timestamp,
      sessionRanges: { asia: openingRange, london: openingRange },
      rangeSummary: [{ label: 'Opening range', ...openingRange }],
      metadata: { tradingDate, openingHigh: openingRange.high, openingLow: openingRange.low, atr: round(atr), signalSide: side }
    };
  }
  return {
    found: false,
    reason: 'No fresh break of the 90-minute cash opening range',
    sessionRanges: { asia: openingRange, london: openingRange },
    metadata: { tradingDate, openingHigh: openingRange.high, openingLow: openingRange.low }
  };
}

function evaluateDirectionalOrderFlow(candles, triggerTimestamp, side, rules, timeZone) {
  const cutoff = Date.parse(triggerTimestamp);
  const bars = aggregateCandles(
    candles.filter((candle) => Date.parse(candle.timestamp) <= cutoff),
    rules.orderFlowIntervalMinutes,
    timeZone
  );
  if (bars.length < rules.orderFlowSlowEma + 1) {
    return {
      aligned: false,
      status: 'warming-up',
      reason: `Need ${rules.orderFlowSlowEma + 1} completed ${rules.orderFlowIntervalMinutes}-minute bars for order flow`
    };
  }

  const closes = bars.map((bar) => bar.close);
  const fast = emaValues(closes, rules.orderFlowFastEma).at(-1);
  const slow = emaValues(closes, rules.orderFlowSlowEma).at(-1);
  const close = closes.at(-1);
  const aligned = side === 'long'
    ? fast > slow && close >= fast
    : fast < slow && close <= fast;
  return {
    aligned,
    status: aligned ? 'aligned' : 'opposed',
    intervalMinutes: rules.orderFlowIntervalMinutes,
    fastPeriod: rules.orderFlowFastEma,
    slowPeriod: rules.orderFlowSlowEma,
    fastEma: round(fast),
    slowEma: round(slow),
    close: round(close),
    reason: aligned
      ? `${rules.orderFlowIntervalMinutes}-minute EMA order flow supports the ${side} retest.`
      : `${rules.orderFlowIntervalMinutes}-minute EMA order flow does not support the ${side} retest.`
  };
}

function detectOpeningRangeRetestSignal(candles, rawConfig, state) {
  const liveConfig = normalizeStrategyConfig(rawConfig);
  const rules = liveConfig.openingRangeRetest;
  const timeZone = 'America/New_York';
  const latest = candles.at(-1);
  if (!latest) return { found: false, reason: 'No candles available' };
  const latestParts = getZonedParts(latest.timestamp, timeZone);
  const tradingDate = latestParts.date;
  const latestMinute = (latestParts.hour * 60) + latestParts.minute;
  if (tradesForDate(state, tradingDate) >= liveConfig.maxTradesPerDay) {
    return { found: false, reason: `Daily trade cap already reached for ${tradingDate}`, metadata: { tradingDate } };
  }

  const rangeStart = toMinutes(rules.rangeStart);
  const rangeEnd = toMinutes(rules.rangeEnd);
  const entryEnd = toMinutes(rules.entryEnd);
  const expectedOpeningBars = Math.max(1, rangeEnd - rangeStart);
  const dayCandles = candles.filter((candle) => getZonedParts(candle.timestamp, timeZone).date === tradingDate);
  const openingCandles = dayCandles.filter((candle) => {
    const minute = minutesForTimestamp(candle.timestamp, timeZone);
    return minute >= rangeStart && minute < rangeEnd;
  });
  if (openingCandles.length < expectedOpeningBars || latestMinute < rangeEnd) {
    return {
      found: false,
      reason: `Building the ${rules.rangeStart}–${rules.rangeEnd} New York opening range`,
      metadata: { tradingDate, collectedOpeningBars: openingCandles.length, expectedOpeningBars }
    };
  }

  const openingRange = {
    high: Math.max(...openingCandles.map((candle) => candle.high)),
    low: Math.min(...openingCandles.map((candle) => candle.low)),
    start: openingCandles[0].timestamp,
    end: openingCandles.at(-1).timestamp
  };
  if (latestMinute > entryEnd) {
    return {
      found: false,
      reason: `15-minute opening-range retest window closed at ${rules.entryEnd} New York`,
      sessionRanges: { asia: openingRange, london: openingRange },
      rangeSummary: [{ label: '15-minute opening range', ...openingRange }],
      metadata: { tradingDate, openingHigh: openingRange.high, openingLow: openingRange.low }
    };
  }

  const candidates = dayCandles.filter((candle) => {
    const minute = minutesForTimestamp(candle.timestamp, timeZone);
    return minute >= rangeEnd && minute <= entryEnd;
  });
  const tolerance = Math.max(0, rules.retestToleranceTicks) * rawConfig.tickSize;
  for (let breakoutIndex = 0; breakoutIndex < candidates.length; breakoutIndex += 1) {
    const breakout = candidates[breakoutIndex];
    const prior = breakoutIndex === 0 ? openingCandles.at(-1) : candidates[breakoutIndex - 1];
    let side = null;
    let level = null;
    if (prior.close <= openingRange.high && breakout.close > openingRange.high) {
      side = 'long';
      level = openingRange.high;
    } else if (prior.close >= openingRange.low && breakout.close < openingRange.low) {
      side = 'short';
      level = openingRange.low;
    }
    if (!side) continue;

    const lastRetestIndex = Math.min(candidates.length - 1, breakoutIndex + rules.maxRetestBars);
    for (let retestIndex = breakoutIndex + 1; retestIndex <= lastRetestIndex; retestIndex += 1) {
      const trigger = candidates[retestIndex];
      const signalAgeBars = candidates.length - 1 - retestIndex;
      if (signalAgeBars > liveConfig.maxSignalAgeBars) continue;
      const heldLevel = side === 'long'
        ? trigger.low >= level - tolerance && trigger.low <= level + tolerance && trigger.close > level
        : trigger.high <= level + tolerance && trigger.high >= level - tolerance && trigger.close < level;
      if (!heldLevel) continue;

      const orderFlow = evaluateDirectionalOrderFlow(candles, trigger.timestamp, side, rules, timeZone);
      if (!orderFlow.aligned) continue;
      const continuation = rawConfig.strategySlug === 'nq-15m-retest-continuation';
      const entry = roundToTick(continuation
        ? side === 'long' ? trigger.high + rawConfig.tickSize : trigger.low - rawConfig.tickSize
        : level, rawConfig.tickSize);
      const rawStop = side === 'long'
        ? continuation ? trigger.low - rawConfig.tickSize : Math.min(trigger.low - rawConfig.tickSize, entry - 2)
        : continuation ? trigger.high + rawConfig.tickSize : Math.max(trigger.high + rawConfig.tickSize, entry + 2);
      const stopDistance = roundToTick(Math.min(20, Math.max(2, Math.abs(entry - rawStop))), rawConfig.tickSize);
      const stop = roundToTick(side === 'long' ? entry - stopDistance : entry + stopDistance, rawConfig.tickSize);
      const targets = buildRiskTargets(side, entry, stop, rawConfig);
      return {
        found: true,
        setup: buildResearchSetup({
          rawConfig,
          tradingDate,
          session: '15M Cash Opening Range Retest',
          side,
          entry,
          stop,
          targets,
          thesis: `Paper research signal: NQ broke the ${rules.rangeStart}–${rules.rangeEnd} opening range, retested the broken level within ${rules.maxRetestBars} minutes, held it, and matched five-minute order flow.`,
          entryModel: 'opening-range-breakout-retest',
          gapType: 'range-retest',
          entryTimeframe: 'M1',
          activationTime: `${rules.rangeEnd}–${rules.entryEnd} America/New_York`,
          referenceSessions: ['15-minute-cash-opening-range', 'five-minute-order-flow'],
          liquidityPool: side === 'long' ? '15-minute-opening-range-high' : '15-minute-opening-range-low',
          liquidityLabel: `${rules.rangeStart}–${rules.rangeEnd} cash opening range`,
          drawOnLiquidity: side === 'long' ? ['intraday-buy-side'] : ['intraday-sell-side']
        }),
        sweepTimestamp: breakout.timestamp,
        triggerTimestamp: trigger.timestamp,
        sessionRanges: { asia: openingRange, london: openingRange },
        rangeSummary: [{ label: '15-minute opening range', ...openingRange }],
        metadata: {
          tradingDate,
          openingHigh: openingRange.high,
          openingLow: openingRange.low,
          breakoutAt: breakout.timestamp,
          retestAt: trigger.timestamp,
          retestBars: retestIndex - breakoutIndex,
          orderFlow,
          signalSide: side
        }
      };
    }
  }

  return {
    found: false,
    reason: 'No fresh opening-range break, level-holding retest, and aligned five-minute order flow',
    sessionRanges: { asia: openingRange, london: openingRange },
    rangeSummary: [{ label: '15-minute opening range', ...openingRange }],
    metadata: { tradingDate, openingHigh: openingRange.high, openingLow: openingRange.low }
  };
}

// One-minute OHLCV timestamps identify the START of a completed minute.
// Reject missing/duplicate minutes instead of treating a partial bar as complete.
function isCompleteMinuteWindow(candles, startMinute, count, timeZone) {
  if (candles.length !== count) return false;
  const firstMs = Date.parse(candles[0].timestamp);
  return candles.every((candle, index) =>
    Date.parse(candle.timestamp) === firstMs + index * 60_000 &&
    minutesForTimestamp(candle.timestamp, timeZone) === startMinute + index);
}

// Precompute once over sorted history. Publish a day's features BEFORE adding that
// day's completed session to history, so neither daily ATR nor RVOL sees the future.
function prepareOrbResearchContext(candles) {
  const timeZone = 'America/New_York';
  const days = new Map();
  for (const candle of candles) {
    const parts = getZonedParts(candle.timestamp, timeZone);
    const minute = parts.hour * 60 + parts.minute;
    if (minute < 570 || minute >= 960) continue;
    if (!days.has(parts.date)) days.set(parts.date, []);
    days.get(parts.date).push(candle);
  }
  const context = Object.create(null);
  const trueRanges = [];
  const volumeSessions = [];
  let priorClose = null;
  for (const [date, day] of [...days.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    day.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const opening = day.filter((candle) => minutesForTimestamp(candle.timestamp, timeZone) < 585);
    const openingWidth = isCompleteMinuteWindow(opening, 570, 15, timeZone)
      ? Math.max(...opening.map((bar) => bar.high)) - Math.min(...opening.map((bar) => bar.low)) : null;
    const priorAtr = trueRanges.length >= 14 ? average(trueRanges.slice(-14)) : null;
    const slots = new Map();
    for (const candle of day) {
      const slot = Math.floor(minutesForTimestamp(candle.timestamp, timeZone) / 15) * 15;
      if (!slots.has(slot)) slots.set(slot, []);
      slots.get(slot).push(candle);
    }
    const sessionVolumes = Object.create(null);
    for (const [slot, minutes] of slots) {
      if (!isCompleteMinuteWindow(minutes, slot, 15, timeZone)) continue;
      const volume = minutes.reduce((sum, bar) => sum + Number(bar.volume || 0), 0);
      // Unknown or invalid volume is not evidence of low relative volume.
      const volumeValid = minutes.every((bar) => bar.volume != null && Number.isFinite(Number(bar.volume)) && Number(bar.volume) >= 0);
      sessionVolumes[slot] = volumeValid ? volume : null;
      const priorVolumes = volumeSessions.map((session) => session[slot]).filter((value) => value != null);
      const priorVolumeMean = priorVolumes.length >= 10 ? average(priorVolumes) : null;
      context[`${date}|${minutes.at(-1).timestamp}`] = Object.freeze({
        priorAtr, priorAtrSessions: Math.min(14, trueRanges.length),
        openingRangeAtrRatio: priorAtr > 0 && openingWidth != null ? openingWidth / priorAtr : null,
        relativeVolume: volumeValid && priorVolumeMean > 0 ? volume / priorVolumeMean : null,
        priorVolumeMean, relativeVolumeSessions: priorVolumes.length,
        confirmationVolume: volumeValid ? volume : null
      });
    }
    if (isCompleteMinuteWindow(day, 570, 390, timeZone)) {
      const high = Math.max(...day.map((bar) => bar.high));
      const low = Math.min(...day.map((bar) => bar.low));
      if (priorClose != null) {
        trueRanges.push(Math.max(high - low, Math.abs(high - priorClose), Math.abs(low - priorClose)));
        if (trueRanges.length > 14) trueRanges.shift();
      }
      priorClose = day.at(-1).close;
      volumeSessions.push(sessionVolumes);
      if (volumeSessions.length > 20) volumeSessions.shift();
    }
  }
  return Object.freeze(context);
}

function detectOpeningRangeCloseSignal(candles, rawConfig, state) {
  const liveConfig = normalizeStrategyConfig(rawConfig);
  const variantRules = {
    'nq-15m-orb-delayed-confirmation': { earliestConfirmationEnd: '10:14' },
    'nq-15m-orb-no-monday': { excludedWeekdays: ['Mon'] },
    'nq-15m-orb-body-window': { maximumBodyFraction: 0.799999 },
    'nq-15m-orb-focused-time': { earliestConfirmationEnd: '10:14', latestConfirmationEnd: '10:59' }
  };
  const rules = { ...liveConfig.openingRangeClose, ...(variantRules[rawConfig.strategySlug] || {}), ...(ORB_FILTER_RULES[rawConfig.strategySlug] || {}), ...(ORB_EXTENSION_RULES[rawConfig.strategySlug] || {}), ...(rawConfig.orbExperimentRules || {}) };
  const timeZone = 'America/New_York';
  const latest = candles.at(-1);
  if (!latest) return { found: false, reason: 'No candles available' };
  const latestParts = getZonedParts(latest.timestamp, timeZone);
  const tradingDate = latestParts.date;
  const cashSession = require('./orb-session.cjs').session(tradingDate);
  if (!cashSession.open) return { found: false, reason: cashSession.reason, metadata: { tradingDate } };
  const latestMinute = (latestParts.hour * 60) + latestParts.minute;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(latest.timestamp));
  if ((rules.excludedWeekdays || []).includes(weekday)) {
    return { found: false, reason: `${rawConfig.strategySlug} does not trade on ${weekday}`, metadata: { tradingDate, weekday } };
  }
  if (tradesForDate(state, tradingDate) >= liveConfig.maxTradesPerDay) {
    return { found: false, reason: `Daily trade cap already reached for ${tradingDate}`, metadata: { tradingDate } };
  }

  const rangeStart = toMinutes(rules.rangeStart);
  const rangeEnd = toMinutes(rules.rangeEnd);
  const entryEnd = toMinutes(rules.entryEnd);
  const dayCandles = candles.filter((candle) => getZonedParts(candle.timestamp, timeZone).date === tradingDate);
  const openingCandles = dayCandles.filter((candle) => {
    const minute = minutesForTimestamp(candle.timestamp, timeZone);
    return minute >= rangeStart && minute < rangeEnd;
  });
  if (!isCompleteMinuteWindow(openingCandles, rangeStart, rangeEnd - rangeStart, timeZone) || latestMinute < rangeEnd) {
    return { found: false, reason: `Building the ${rules.rangeStart}–${rules.rangeEnd} New York opening range`, metadata: { tradingDate } };
  }

  const openingRange = {
    high: Math.max(...openingCandles.map((candle) => candle.high)),
    low: Math.min(...openingCandles.map((candle) => candle.low)),
    start: openingCandles[0].timestamp,
    end: openingCandles.at(-1).timestamp
  };
  if (latestMinute > entryEnd) {
    return { found: false, reason: `15-minute ORB close window closed at ${rules.entryEnd} New York`, rangeSummary: [{ label: '15-minute opening range', ...openingRange }], metadata: { tradingDate } };
  }

  const candidateMinutes = dayCandles.filter((candle) => {
    const minute = minutesForTimestamp(candle.timestamp, timeZone);
    return minute >= rangeEnd && minute < entryEnd;
  });
  const bars = aggregateCandles(candidateMinutes, rules.barMinutes, timeZone)
    .filter((bar) => {
      const startMinute = minutesForTimestamp(bar.timestamp, timeZone);
      const minutes = candidateMinutes.filter((candle) => candle.timestamp >= bar.timestamp && candle.timestamp <= bar.endTimestamp);
      return bar.endTimestamp === latest.timestamp && startMinute % rules.barMinutes === 0 &&
        minutesForTimestamp(bar.endTimestamp, timeZone) === startMinute + rules.barMinutes - 1 &&
        isCompleteMinuteWindow(minutes, startMinute, rules.barMinutes, timeZone);
    });
  for (let index = 0; index < bars.length; index += 1) {
    const trigger = bars[index];
    const confirmationEndMinute = minutesForTimestamp(trigger.endTimestamp, timeZone);
    if (rules.earliestConfirmationEnd && confirmationEndMinute < toMinutes(rules.earliestConfirmationEnd)) continue;
    if (rules.latestConfirmationEnd && confirmationEndMinute > toMinutes(rules.latestConfirmationEnd)) continue;
    const candleRange = trigger.high - trigger.low;
    if (!(candleRange > 0)) continue;
    const bodyFraction = Math.abs(trigger.close - trigger.open) / candleRange;
    let side = null;
    let breakoutWickFraction = 1;
    if (rules.fade) {
      const sweepDistance = rules.minimumSweepTicks * rawConfig.tickSize;
      const sweptHigh = trigger.high >= openingRange.high + sweepDistance;
      const sweptLow = trigger.low <= openingRange.low - sweepDistance;
      // Reject two-sided sweeps: OHLC cannot establish their intrabar order.
      const inside = trigger.close > openingRange.low && trigger.close < openingRange.high;
      if (inside && sweptHigh && !sweptLow && trigger.close < trigger.open) {
        side = 'short';
        breakoutWickFraction = (trigger.close - trigger.low) / candleRange;
      } else if (inside && sweptLow && !sweptHigh && trigger.close > trigger.open) {
        side = 'long';
        breakoutWickFraction = (trigger.high - trigger.close) / candleRange;
      }
    } else if (trigger.close > openingRange.high && trigger.open <= openingRange.high) {
      side = 'long';
      breakoutWickFraction = (trigger.high - trigger.close) / candleRange;
    } else if (trigger.close < openingRange.low && trigger.open >= openingRange.low) {
      side = 'short';
      breakoutWickFraction = (trigger.close - trigger.low) / candleRange;
    }
    if (!side || bodyFraction < rules.minimumBodyFraction || bodyFraction > (rules.maximumBodyFraction ?? 1) || breakoutWickFraction > rules.maximumBreakoutWickFraction) continue;

    const research = rawConfig.orbResearchContext?.[`${tradingDate}|${trigger.endTimestamp}`] || null;
    const filterRejection = (reason) => ({ found: false, reason, metadata: { tradingDate, research } });
    if (rules.useAtr) {
      if (research?.openingRangeAtrRatio == null) return filterRejection('ORB ATR unavailable: need 14 prior complete-session true ranges and a complete opening range');
      if (research.openingRangeAtrRatio < rules.minimumOpeningAtrRatio || research.openingRangeAtrRatio > rules.maximumOpeningAtrRatio) return filterRejection('ORB opening-range ATR ratio outside preregistered 0.05–0.30 band');
    }
    if (rules.useRelativeVolume) {
      if (research?.relativeVolume == null) return filterRejection('ORB relative volume unavailable: need valid volume and at least 10 prior complete cash sessions for this slot');
      if (research.relativeVolume < rules.minimumRelativeVolume) return filterRejection('ORB relative volume below preregistered 1.2 threshold');
    }
    const entry = roundToTick(trigger.close, rawConfig.tickSize);
    const structuralStop = rules.fade
      ? (side === 'long' ? trigger.low - rawConfig.tickSize : trigger.high + rawConfig.tickSize)
      : side === 'long'
      ? Math.min(openingRange.high, trigger.low) - rawConfig.tickSize
      : Math.max(openingRange.low, trigger.high) + rawConfig.tickSize;
    // Preserve the actual invalidation level. Position sizing can reject excessive risk.
    const stop = roundToTick(structuralStop, rawConfig.tickSize);
    const midpoint = roundToTick((openingRange.high + openingRange.low) / 2, rawConfig.tickSize);
    const midpointReward = (side === 'long' ? 1 : -1) * (midpoint - entry);
    if (rules.fade && midpointReward < Math.abs(entry - stop) * rules.minimumMidpointRewardRisk) {
      return filterRejection('ORB fade midpoint offers less than the preregistered 1R minimum');
    }
    const targets = rules.fade ? [midpoint] : buildRiskTargets(side, entry, stop, rawConfig, rules.targetMultiples);
    return {
      found: true,
      setup: { ...buildResearchSetup({
        rawConfig, tradingDate, session: rules.fade ? '15M ORB Failed Breakout Fade' : '15M ORB Close Confirmation', side, entry, stop,
        targets,
        thesis: rules.fade ? 'Independent paper hypothesis: a completed 15-minute candle swept one opening-range edge and closed back inside; fade toward the midpoint with at least 1R planned reward.' : `Paper research signal: a completed ${rules.barMinutes}-minute candle closed outside the ${rules.rangeStart}–${rules.rangeEnd} opening range with a strong body and limited breakout-side wick.`,
        entryModel: rules.fade ? 'opening-range-fade' : 'opening-range-close-confirmation', gapType: rules.fade ? 'range-rejection' : 'range-break', entryTimeframe: `M${rules.barMinutes}`,
        activationTime: `${rules.rangeEnd}–${rules.entryEnd} America/New_York`, referenceSessions: ['15-minute-cash-opening-range'],
        liquidityPool: (rules.fade ? side === 'short' : side === 'long') ? '15-minute-opening-range-high' : '15-minute-opening-range-low',
        liquidityLabel: `${rules.rangeStart}–${rules.rangeEnd} cash opening range`,
        drawOnLiquidity: rules.fade ? ['opening-range-midpoint'] : side === 'long' ? ['intraday-buy-side'] : ['intraday-sell-side']
      }), execution: 'next-bar-market',
        ...(rules.exitAllAtTarget ? { exitAllAtTarget: true } : {}),
        signalAvailableAt: new Date(Date.parse(trigger.endTimestamp) + 60_000).toISOString() },
      sweepTimestamp: openingRange.end,
      triggerTimestamp: trigger.endTimestamp,
      sessionRanges: { asia: openingRange, london: openingRange },
      rangeSummary: [{ label: '15-minute opening range', ...openingRange }],
      metadata: { tradingDate, weekday, research, ...(ORB_EXTENSION_RULES[rawConfig.strategySlug] ? { researchRules: ORB_EXTENSION_RULES[rawConfig.strategySlug] } : {}), actionableAt: new Date(Date.parse(trigger.endTimestamp) + 60_000).toISOString(), variant: rawConfig.strategySlug, openingHigh: openingRange.high, openingLow: openingRange.low, confirmationBarStart: trigger.timestamp, confirmationBarEnd: trigger.endTimestamp, bodyFraction: round(bodyFraction), breakoutWickFraction: round(breakoutWickFraction), signalSide: side }
    };
  }
  return { found: false, reason: rules.fade ? 'ORB fade: no completed one-sided rejection passed the body and wick filters' : 'No completed 15-minute close passed the ORB body and wick filters', rangeSummary: [{ label: '15-minute opening range', ...openingRange }], metadata: { tradingDate } };
}

function detectEmaMomentumSignal(candles, rawConfig, state) {
  const liveConfig = normalizeStrategyConfig(rawConfig);
  const timeZone = 'America/New_York';
  const latest = candles.at(-1);
  if (!latest) return { found: false, reason: 'No candles available' };
  const tradingDate = getZonedParts(latest.timestamp, timeZone).date;
  if (tradesForDate(state, tradingDate) >= liveConfig.maxTradesPerDay) {
    return { found: false, reason: `Daily trade cap already reached for ${tradingDate}`, metadata: { tradingDate } };
  }

  const bars = aggregateCandles(candles, 15, timeZone);
  if (bars.length < 62) {
    return { found: false, reason: `Warming up EMA 20/60 (${bars.length}/62 completed 15-minute bars)`, metadata: { tradingDate } };
  }
  const closes = bars.map((bar) => bar.close);
  const fast = emaValues(closes, 20);
  const slow = emaValues(closes, 60);
  const current = bars.at(-1);
  const prior = bars.at(-2);
  const currentParts = getZonedParts(current.endTimestamp, timeZone);
  const currentMinute = (currentParts.hour * 60) + currentParts.minute;
  const cashWindow = rawConfig.strategySlug === 'ema-20-60-cash-window' ? [615, 675] : [570, 945];
  if (currentParts.date !== tradingDate || currentMinute < cashWindow[0] || currentMinute > cashWindow[1]) {
    return { found: false, reason: 'EMA momentum entries wait for the 09:30–15:45 New York window', metadata: { tradingDate } };
  }

  const index = bars.length - 1;
  const crossedLong = fast[index - 1] <= slow[index - 1] && fast[index] > slow[index];
  const crossedShort = fast[index - 1] >= slow[index - 1] && fast[index] < slow[index];
  if (!crossedLong && !crossedShort) {
    return {
      found: false,
      reason: `No fresh EMA 20/60 crossover; fast ${round(fast[index])}, slow ${round(slow[index])}`,
      metadata: { tradingDate, fastEma: round(fast[index]), slowEma: round(slow[index]) }
    };
  }

  const side = crossedLong ? 'long' : 'short';
  const atr = averageTrueRange(bars, 14);
  const stopDistance = roundToTick(Math.min(20, Math.max(2, atr || 2)), rawConfig.tickSize);
  const entry = roundToTick(current.close, rawConfig.tickSize);
  const stop = roundToTick(side === 'long' ? entry - stopDistance : entry + stopDistance, rawConfig.tickSize);
  return {
    found: true,
    setup: buildResearchSetup({
      rawConfig,
      tradingDate,
      session: 'Cash Momentum',
      side,
      entry,
      stop,
      targets: buildRiskTargets(side, entry, stop, rawConfig),
      thesis: 'Paper research signal: the 20-period EMA crossed the 60-period EMA on completed 15-minute NQ bars during the cash session.',
      entryModel: 'ema-20-60-momentum',
      gapType: 'ema-crossover',
      entryTimeframe: 'M15',
      activationTime: '09:30–15:45 America/New_York',
      referenceSessions: ['cash-session', 'ema-20-60'],
      liquidityPool: side === 'long' ? 'trend-continuation-highs' : 'trend-continuation-lows',
      liquidityLabel: '15-minute EMA momentum',
      drawOnLiquidity: side === 'long' ? ['intraday-buy-side'] : ['intraday-sell-side']
    }),
    sweepTimestamp: prior.endTimestamp,
    triggerTimestamp: current.endTimestamp,
    sessionRanges: null,
    rangeSummary: [{ label: 'EMA 20/60', high: round(fast[index]), low: round(slow[index]) }],
    metadata: { tradingDate, fastEma: round(fast[index]), slowEma: round(slow[index]), atr: round(atr), signalSide: side }
  };
}

function volumePointOfControl(candles, tickSize, bucketPoints = 1) {
  const buckets = new Map();
  for (const candle of candles) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    const price = roundToTick(Math.round(typical / bucketPoints) * bucketPoints, tickSize);
    buckets.set(price, (buckets.get(price) || 0) + Number(candle.volume || 0));
  }
  return [...buckets.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function detectVolumePocReversionSignal(candles, rawConfig, state) {
  const liveConfig = normalizeStrategyConfig(rawConfig);
  const timeZone = 'America/New_York';
  const latest = candles.at(-1);
  if (!latest) return { found: false, reason: 'No candles available' };
  const tradingDate = getZonedParts(latest.timestamp, timeZone).date;
  if (tradesForDate(state, tradingDate) >= liveConfig.maxTradesPerDay) {
    return { found: false, reason: `Daily trade cap already reached for ${tradingDate}`, metadata: { tradingDate } };
  }
  const cashCandles = candles.filter((candle) => {
    const parts = getZonedParts(candle.timestamp, timeZone);
    const minute = (parts.hour * 60) + parts.minute;
    return parts.date === tradingDate && minute >= 570 && minute <= 945;
  });
  if (cashCandles.length < 61) {
    return { found: false, reason: `Building cash-session volume profile (${cashCandles.length}/61 bars)`, metadata: { tradingDate } };
  }

  const firstCandidateIndex = Math.max(40, cashCandles.length - liveConfig.maxSignalAgeBars);
  for (let index = firstCandidateIndex; index < cashCandles.length; index += 1) {
    const trigger = cashCandles[index];
    const history = cashCandles.slice(0, index);
    const poc = volumePointOfControl(history, rawConfig.tickSize);
    const atr = averageTrueRange(history, 14);
    const averageVolume = average(history.slice(-20).map((candle) => Number(candle.volume || 0)));
    if (!Number.isFinite(poc) || atr <= 0 || averageVolume <= 0) continue;
    const body = Math.max(Math.abs(trigger.close - trigger.open), rawConfig.tickSize);
    const upperWick = trigger.high - Math.max(trigger.open, trigger.close);
    const lowerWick = Math.min(trigger.open, trigger.close) - trigger.low;
    const highVolume = Number(trigger.volume || 0) > averageVolume * 1.3;
    const exhaustedAbove = trigger.close > poc + atr && trigger.close < trigger.open && upperWick >= body * 0.8;
    const exhaustedBelow = trigger.close < poc - atr && trigger.close > trigger.open && lowerWick >= body * 0.8;
    if (!highVolume || (!exhaustedAbove && !exhaustedBelow)) continue;

    const side = exhaustedBelow ? 'long' : 'short';
    const entry = roundToTick(trigger.close, rawConfig.tickSize);
    const rawStop = side === 'long'
      ? Math.min(trigger.low - rawConfig.tickSize, entry - atr)
      : Math.max(trigger.high + rawConfig.tickSize, entry + atr);
    const boundedDistance = roundToTick(Math.min(20, Math.max(2, Math.abs(entry - rawStop))), rawConfig.tickSize);
    const stop = roundToTick(side === 'long' ? entry - boundedDistance : entry + boundedDistance, rawConfig.tickSize);
    const distanceToPoc = Math.abs(poc - entry);
    if (rawConfig.strategySlug === 'volume-poc-max-3atr' && distanceToPoc > atr * 3) continue;
    const targets = [
      roundToTick(side === 'long' ? entry + (distanceToPoc * 0.67) : entry - (distanceToPoc * 0.67), rawConfig.tickSize),
      roundToTick(poc, rawConfig.tickSize),
      roundToTick(side === 'long' ? poc + (boundedDistance * 0.5) : poc - (boundedDistance * 0.5), rawConfig.tickSize)
    ].filter((target, targetIndex, list) => (
      (side === 'long' ? target > entry : target < entry) && list.indexOf(target) === targetIndex
    ));
    if (!targets.length) continue;
    const profileRange = {
      high: Math.max(...history.map((candle) => candle.high)),
      low: Math.min(...history.map((candle) => candle.low)),
      start: history[0].timestamp,
      end: history.at(-1).timestamp
    };
    return {
      found: true,
      setup: buildResearchSetup({
        rawConfig,
        tradingDate,
        session: 'Cash Mean Reversion',
        side,
        entry,
        stop,
        targets,
        thesis: 'Paper research signal: price extended at least one ATR from the bar-volume POC, then printed a high-volume exhaustion candle back toward value.',
        entryModel: 'volume-poc-reversion',
        gapType: 'volume-profile',
        entryTimeframe: 'M1',
        activationTime: '10:30–15:45 America/New_York',
        referenceSessions: ['cash-volume-profile'],
        liquidityPool: 'bar-volume-point-of-control',
        liquidityLabel: 'One-minute bar-volume POC proxy',
        drawOnLiquidity: ['volume-poc', 'cash-session-value']
      }),
      sweepTimestamp: history.at(-1).timestamp,
      triggerTimestamp: trigger.timestamp,
      sessionRanges: { asia: profileRange, london: profileRange },
      rangeSummary: [{ label: 'Cash profile', ...profileRange }],
      metadata: { tradingDate, poc, atr: round(atr), volumeRatio: round(Number(trigger.volume || 0) / averageVolume), signalSide: side }
    };
  }
  return { found: false, reason: 'No high-volume exhaustion at least one ATR from the bar-volume POC', metadata: { tradingDate } };
}

function detectHtfSessionSweepSignal(candles, rawConfig, state) {
  const liveConfig = normalizeStrategyConfig(rawConfig);
  const rules = liveConfig.htfSessionSweep;
  const timeZone = 'America/New_York';
  const latest = candles.at(-1);
  if (!latest) return { found: false, reason: 'No candles available' };
  const latestParts = getZonedParts(latest.timestamp, timeZone);
  const tradingDate = latestParts.date;
  const latestMinute = latestParts.hour * 60 + latestParts.minute;
  if (tradesForDate(state, tradingDate) >= liveConfig.maxTradesPerDay) return { found: false, reason: `Daily trade cap already reached for ${tradingDate}`, metadata: { tradingDate } };
  if (latestMinute < toMinutes(rules.entryStart) || latestMinute > toMinutes(rules.entryEnd)) return { found: false, reason: `HTF session sweep waits for ${rules.entryStart}–${rules.entryEnd} New York`, metadata: { tradingDate } };

  const priorDate = shiftDate(tradingDate, -1);
  const asiaCandles = candles.filter((candle) => {
    const parts = getZonedParts(candle.timestamp, timeZone);
    const minute = parts.hour * 60 + parts.minute;
    return (parts.date === priorDate && minute >= 1200) || (parts.date === tradingDate && minute <= 119);
  });
  const londonCandles = candles.filter((candle) => {
    const parts = getZonedParts(candle.timestamp, timeZone);
    const minute = parts.hour * 60 + parts.minute;
    return parts.date === tradingDate && minute >= 120 && minute <= 479;
  });
  if (asiaCandles.length < 300 || londonCandles.length < 300) return { found: false, reason: 'Building complete Asia and London session ranges', metadata: { tradingDate } };
  const asia = { high: Math.max(...asiaCandles.map(c => c.high)), low: Math.min(...asiaCandles.map(c => c.low)), start: asiaCandles[0].timestamp, end: asiaCandles.at(-1).timestamp };
  const london = { high: Math.max(...londonCandles.map(c => c.high)), low: Math.min(...londonCandles.map(c => c.low)), start: londonCandles[0].timestamp, end: londonCandles.at(-1).timestamp };
  const sweptHigh = london.high > asia.high;
  const sweptLow = london.low < asia.low;
  if (sweptHigh === sweptLow) return { found: false, reason: sweptHigh ? 'London swept both sides of Asia; directional hypothesis invalidated' : 'London did not sweep an Asia extreme', metadata: { tradingDate } };
  const side = sweptLow ? 'long' : 'short';

  const hourly = aggregateCandles(candles.filter(c => Date.parse(c.timestamp) < Date.parse(latest.timestamp)), 60, timeZone);
  const completedHours = hourly.filter(bar => Date.parse(bar.endTimestamp) < Date.parse(latest.timestamp)).slice(-rules.hourlyLookbackBars);
  if (!completedHours.length) return { found: false, reason: 'Waiting for completed hourly bias candles', metadata: { tradingDate } };
  const hourlyBias = completedHours.reduce((sum, bar) => sum + (bar.close - bar.open), 0);
  if ((side === 'long' && hourlyBias <= 0) || (side === 'short' && hourlyBias >= 0)) return { found: false, reason: 'Completed hourly direction does not align with the session-sweep reversal', metadata: { tradingDate, hourlyBias: round(hourlyBias) } };

  const entryCandles = candles.filter((candle) => {
    const parts = getZonedParts(candle.timestamp, timeZone);
    const minute = parts.hour * 60 + parts.minute;
    return parts.date === tradingDate && minute >= toMinutes(rules.entryStart) && minute <= latestMinute;
  });
  const fiveMinuteBars = aggregateCandles(entryCandles, rules.confirmationMinutes, timeZone);
  const confirmation = [...fiveMinuteBars].reverse().find((bar) => {
    if (Date.parse(bar.endTimestamp) >= Date.parse(latest.timestamp)) return false;
    const range = bar.high - bar.low;
    const bodyFraction = range > 0 ? Math.abs(bar.close - bar.open) / range : 0;
    return bodyFraction >= rules.minimumConfirmationBodyFraction && (side === 'long' ? bar.close > asia.low && bar.close > bar.open : bar.close < asia.high && bar.close < bar.open);
  });
  if (!confirmation) return { found: false, reason: 'Waiting for a completed five-minute rejection back inside the Asia range', metadata: { tradingDate } };
  const afterConfirmation = entryCandles.filter(c => Date.parse(c.timestamp) > Date.parse(confirmation.endTimestamp));
  const bos = afterConfirmation.find(c => side === 'long' ? c.close > confirmation.high : c.close < confirmation.low);
  if (!bos || bos.timestamp !== latest.timestamp) return { found: false, reason: 'Waiting for a fresh one-minute structure break after five-minute rejection', metadata: { tradingDate } };
  const entry = roundToTick(bos.close, rawConfig.tickSize);
  const structuralExtreme = side === 'long' ? Math.min(london.low, confirmation.low) : Math.max(london.high, confirmation.high);
  const rawDistance = Math.abs(entry - structuralExtreme) + rawConfig.tickSize;
  if (rawDistance < rules.minimumStopPoints || rawDistance > rules.maximumStopPoints) return { found: false, reason: `Structural stop ${round(rawDistance)} points is outside the ${rules.minimumStopPoints}–${rules.maximumStopPoints} point research band`, metadata: { tradingDate } };
  const stop = roundToTick(side === 'long' ? structuralExtreme - rawConfig.tickSize : structuralExtreme + rawConfig.tickSize, rawConfig.tickSize);
  return {
    found: true,
    setup: { ...buildResearchSetup({ rawConfig, tradingDate, session: 'HTF Session Sweep', side, entry, stop,
      targets: buildRiskTargets(side, entry, stop, rawConfig),
      thesis: 'Paper research signal: London swept one Asia extreme, completed hourly direction aligned with reversal, a five-minute candle closed back inside value, and a fresh one-minute structure break confirmed entry.',
      entryModel: 'htf-session-sweep', gapType: 'session-liquidity-sweep', entryTimeframe: 'M1',
      activationTime: `${rules.entryStart}–${rules.entryEnd} America/New_York`, referenceSessions: ['asia', 'london', 'completed-hourly-bias'],
      liquidityPool: side === 'long' ? 'asia-high' : 'asia-low', liquidityLabel: side === 'long' ? 'Asia high' : 'Asia low',
      drawOnLiquidity: [side === 'long' ? 'buy-side-liquidity' : 'sell-side-liquidity'] }), execution: 'next-bar-market', signalAvailableAt: new Date(Date.parse(bos.timestamp) + 60_000).toISOString() },
    sweepTimestamp: side === 'long' ? londonCandles.find(c => c.low < asia.low)?.timestamp : londonCandles.find(c => c.high > asia.high)?.timestamp,
    triggerTimestamp: bos.timestamp,
    sessionRanges: { asia, london }, rangeSummary: [{ label: 'Asia', ...asia }, { label: 'London', ...london }],
    metadata: { tradingDate, signalSide: side, hourlyBias: round(hourlyBias), confirmationAt: confirmation.endTimestamp, sweptHigh, sweptLow }
  };
}

function detectSignalFromCandles(candles, rawConfig, state) {
  if (require('./price-action-patterns.cjs').SLUGS.includes(rawConfig.strategySlug)) {
    const signal = require('./price-action-patterns.cjs').detect(candles, rawConfig.strategySlug, rawConfig.tickSize);
    if (!signal.found) return signal;
    return { found: true, triggerTimestamp: signal.triggerTimestamp, sweepTimestamp: signal.breakAt,
      metadata: signal, rangeSummary: [], sessionRanges: {},
      setup: { ...buildResearchSetup({ rawConfig, tradingDate: signal.date, session: rawConfig.strategySlug,
        side: signal.side, entry: signal.entry, stop: signal.stop, targets: signal.targets,
        thesis: 'Independent mechanical price-action experiment. Confirmed structure, bounded retest, next-bar entry.',
        entryModel: 'confirmed-price-action-retest', gapType: 'range-break', entryTimeframe: 'M5',
        activationTime: '09:49–11:29 America/New_York', referenceSessions: ['cash-session'],
        liquidityPool: 'confirmed-price-level', liquidityLabel: String(signal.level), drawOnLiquidity: ['fixed-2R'] }),
        execution: 'next-bar-market', exitAllAtTarget: true,
        signalAvailableAt: new Date(Date.parse(signal.triggerTimestamp) + 60000).toISOString() } };
  }
  const detectors = {
    'live-9am-sweep': detectNineAmSignalFromCandles,
    'live-9am-sweep-min-stop': detectNineAmSignalFromCandles,
    'hourly-sweep-ifvg-bos': detectHourlySweepIfvgBosSignal,
    'hourly-sweep-stop-band': detectHourlySweepIfvgBosSignal,
    'nq-opening-range-breakout': detectOpeningRangeBreakoutSignal,
    'nq-opening-range-true-breakout': detectOpeningRangeBreakoutSignal,
    'nq-15m-opening-range-retest': detectOpeningRangeRetestSignal,
    'nq-15m-retest-continuation': detectOpeningRangeRetestSignal,
    'nq-15m-orb-close-confirmation': detectOpeningRangeCloseSignal,
    'nq-15m-orb-delayed-confirmation': detectOpeningRangeCloseSignal,
    'nq-15m-orb-no-monday': detectOpeningRangeCloseSignal,
    'nq-15m-orb-body-window': detectOpeningRangeCloseSignal,
    'nq-15m-orb-focused-time': detectOpeningRangeCloseSignal,
    'nq-15m-orb-atr': detectOpeningRangeCloseSignal,
    'nq-15m-orb-rvol': detectOpeningRangeCloseSignal,
    'nq-15m-orb-atr-rvol': detectOpeningRangeCloseSignal,
    'nq-15m-orb-wick-test': detectOpeningRangeCloseSignal,
    'nq-15m-orb-exit-1r': detectOpeningRangeCloseSignal,
    'nq-15m-orb-exit-3r': detectOpeningRangeCloseSignal,
    'nq-15m-orb-failed-breakout-fade': detectOpeningRangeCloseSignal,
    'ema-20-60-momentum': detectEmaMomentumSignal,
    'ema-20-60-cash-window': detectEmaMomentumSignal,
    'volume-poc-reversion': detectVolumePocReversionSignal,
    'volume-poc-max-3atr': detectVolumePocReversionSignal,
    'nq-dmc-market-open': detectDmcMarketOpenSignal,
    'nq-htf-session-sweep': detectHtfSessionSweepSignal
  };
  const strategySlug = rawConfig.strategySlug || 'live-9am-sweep';
  const detector = detectors[strategySlug];
  if (!detector) {
    throw new Error(`No detector registered for strategy: ${strategySlug}`);
  }
  return detector(candles, rawConfig, state);
}

function signalKey(signal) {
  return [
    signal.setup.date,
    signal.setup.side,
    signal.sweepTimestamp,
    signal.triggerTimestamp,
    signal.setup.entry,
    signal.setup.stop
  ].join('|');
}

function loadLiveState(baseState) {
  return {
    ...baseState,
    live: {
      ...(baseState.live || {}),
      openSignalKey: baseState.live?.openSignalKey || null,
      openPlan: baseState.live?.openPlan || null,
      openTriggeredAt: baseState.live?.openTriggeredAt || null,
      signalHistory: Array.isArray(baseState.live?.signalHistory) ? baseState.live.signalHistory : [],
      heartbeat: baseState.live?.heartbeat || null,
      adaptive: baseState.live?.adaptive || null,
      portfolioRisk: baseState.live?.portfolioRisk || null,
      researchContext: baseState.live?.researchContext || null,
      researchCouncil: baseState.live?.researchCouncil || null
    }
  };
}

function saveLiveState(filePath, state) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Ignore cleanup failures and surface the original persistence error.
    }
    throw error;
  }
}

function formatSignalSummary(signal, plan) {
  const ranges = signal.sessionRanges;
  const side = signal.setup.side.toUpperCase();
  const rangeLines = Array.isArray(signal.rangeSummary)
    ? signal.rangeSummary.map((range) => `${range.label}: H ${range.high} / L ${range.low}`)
    : ranges?.asia && ranges?.london
      ? [`Asia: H ${ranges.asia.high} / L ${ranges.asia.low}`, `London: H ${ranges.london.high} / L ${ranges.london.low}`]
      : [];
  return [
    `Signal: ${side} ${signal.setup.symbol} ${signal.setup.date}`,
    `Entry ${signal.setup.entry} | Stop ${signal.setup.stop} | Targets ${signal.setup.targets.join(', ')}`,
    ...rangeLines,
    `Contracts: ${plan.sizing.maxContracts} | Risk ${plan.sizing.actualRiskUsd}`
  ].join('\n');
}

function formatOpenTradeSummary(plan, lifecycle) {
  return [
    `Open trade status: ${lifecycle.status}`,
    `Filled at: ${lifecycle.filledAt || 'waiting for fill'}`,
    `Targets hit: ${lifecycle.targetsHit.length ? lifecycle.targetsHit.join(', ') : 'none'}`,
    `Remaining: ${lifecycle.remainingContracts}`,
    `Realized: ${lifecycle.realizedPnlUsd}`,
    `Unrealized: ${lifecycle.unrealizedPnlUsd}`,
    `Mark: ${lifecycle.markPrice ?? 'n/a'}`,
    `Exit reason: ${lifecycle.exitReason}`
  ].join('\n');
}

function buildPlanFromSignal(signal, rawConfig, state) {
  const plan = buildTradePlan(normalizeSetup(signal.setup, rawConfig), rawConfig, state);
  if (signal.setup.exitAllAtTarget) {
    if (plan.targets.length !== 1) throw new Error('Full-position exit requires exactly one target.');
    plan.targets[0].closeFraction = 1;
  }
  plan.strategyFamily = rawConfig.strategyFamily || null;
  plan.signalContext = signal.metadata || null;
  return plan;
}

module.exports = {
  aggregateCandles,
  averageTrueRange,
  buildPlanFromSignal,
  computeAmdContext,
  detectEmaMomentumSignal,
  detectHtfSessionSweepSignal,
  detectDmcMarketOpenSignal,
  detectOpeningRangeBreakoutSignal,
  detectOpeningRangeCloseSignal,
  detectOpeningRangeRetestSignal,
  detectSignalFromCandles,
  detectVolumePocReversionSignal,
  fetchLiveCandles,
  formatOpenTradeSummary,
  formatSignalSummary,
  loadLiveState,
  normalizeStrategyConfig,
  prepareOrbResearchContext,
  saveLiveState,
  signalKey,
  trackTradeLifecycle
};
