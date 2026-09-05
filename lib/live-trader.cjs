const fs = require('fs');
const path = require('path');
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

function getZonedParts(timestamp, timeZone) {
  const date = new Date(timestamp);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
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
    return { found: false, reason: 'Building the 09:30â€“11:00 New York opening range', metadata: { tradingDate } };
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
      entry = roundToTick(openingRange.high, rawConfig.tickSize);
    } else if (prior.close >= openingRange.low && trigger.close < openingRange.low) {
      side = 'short';
      entry = roundToTick(openingRange.low, rawConfig.tickSize);
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
        liquidityLabel: '09:30â€“11:00 cash opening range',
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
      reason: `Building the ${rules.rangeStart}â€“${rules.rangeEnd} New York opening range`,
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
      const entry = roundToTick(level, rawConfig.tickSize);
      const rawStop = side === 'long'
        ? Math.min(trigger.low - rawConfig.tickSize, entry - 2)
        : Math.max(trigger.high + rawConfig.tickSize, entry + 2);
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
          thesis: `Paper research signal: NQ broke the ${rules.rangeStart}â€“${rules.rangeEnd} opening range, retested the broken level within ${rules.maxRetestBars} minutes, held it, and matched five-minute order flow.`,
          entryModel: 'opening-range-breakout-retest',
          gapType: 'range-retest',
          entryTimeframe: 'M1',
          activationTime: `${rules.rangeEnd}â€“${rules.entryEnd} America/New_York`,
          referenceSessions: ['15-minute-cash-opening-range', 'five-minute-order-flow'],
          liquidityPool: side === 'long' ? '15-minute-opening-range-high' : '15-minute-opening-range-low',
          liquidityLabel: `${rules.rangeStart}â€“${rules.rangeEnd} cash opening range`,
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

function detectOpeningRangeCloseSignal(candles, rawConfig, state) {
  const liveConfig = normalizeStrategyConfig(rawConfig);
  const rules = liveConfig.openingRangeClose;
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
  const dayCandles = candles.filter((candle) => getZonedParts(candle.timestamp, timeZone).date === tradingDate);
  const openingCandles = dayCandles.filter((candle) => {
    const minute = minutesForTimestamp(candle.timestamp, timeZone);
    return minute >= rangeStart && minute < rangeEnd;
  });
  if (openingCandles.length < rangeEnd - rangeStart || latestMinute < rangeEnd) {
    return { found: false, reason: `Building the ${rules.rangeStart}â€“${rules.rangeEnd} New York opening range`, metadata: { tradingDate } };
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
    .filter((bar) => minutesForTimestamp(bar.timestamp, timeZone) + rules.barMinutes <= latestMinute);
  for (let index = Math.max(0, bars.length - 2); index < bars.length; index += 1) {
    const trigger = bars[index];
    const candleRange = trigger.high - trigger.low;
    if (!(candleRange > 0)) continue;
    const bodyFraction = Math.abs(trigger.close - trigger.open) / candleRange;
    let side = null;
    let breakoutWickFraction = 1;
    if (trigger.close > openingRange.high && trigger.open <= openingRange.high) {
      side = 'long';
      breakoutWickFraction = (trigger.high - trigger.close) / candleRange;
    } else if (trigger.close < openingRange.low && trigger.open >= openingRange.low) {
      side = 'short';
      breakoutWickFraction = (trigger.close - trigger.low) / candleRange;
    }
    if (!side || bodyFraction < rules.minimumBodyFraction || breakoutWickFraction > rules.maximumBreakoutWickFraction) continue;

    const entry = roundToTick(trigger.close, rawConfig.tickSize);
    const structuralStop = side === 'long'
      ? Math.min(openingRange.high, trigger.low) - rawConfig.tickSize
      : Math.max(openingRange.low, trigger.high) + rawConfig.tickSize;
    const stopDistance = roundToTick(Math.min(rules.maximumStopPoints, Math.max(2, Math.abs(entry - structuralStop))), rawConfig.tickSize);
    const stop = roundToTick(side === 'long' ? entry - stopDistance : entry + stopDistance, rawConfig.tickSize);
    return {
      found: true,
      setup: buildResearchSetup({
        rawConfig, tradingDate, session: '15M ORB Close Confirmation', side, entry, stop,
        targets: buildRiskTargets(side, entry, stop, rawConfig),
        thesis: `Paper research signal: a completed ${rules.barMinutes}-minute candle closed outside the ${rules.rangeStart}â€“${rules.rangeEnd} opening range with a strong body and limited breakout-side wick.`,
        entryModel: 'opening-range-close-confirmation', gapType: 'range-break', entryTimeframe: `M${rules.barMinutes}`,
        activationTime: `${rules.rangeEnd}â€“${rules.entryEnd} America/New_York`, referenceSessions: ['15-minute-cash-opening-range'],
        liquidityPool: side === 'long' ? '15-minute-opening-range-high' : '15-minute-opening-range-low',
        liquidityLabel: `${rules.rangeStart}â€“${rules.rangeEnd} cash opening range`,
        drawOnLiquidity: side === 'long' ? ['intraday-buy-side'] : ['intraday-sell-side']
      }),
      sweepTimestamp: openingRange.end,
      triggerTimestamp: trigger.endTimestamp,
      sessionRanges: { asia: openingRange, london: openingRange },
      rangeSummary: [{ label: '15-minute opening range', ...openingRange }],
      metadata: { tradingDate, openingHigh: openingRange.high, openingLow: openingRange.low, confirmationBarStart: trigger.timestamp, confirmationBarEnd: trigger.endTimestamp, bodyFraction: round(bodyFraction), breakoutWickFraction: round(breakoutWickFraction), signalSide: side }
    };
  }
  return { found: false, reason: 'No completed 15-minute close passed the ORB body and wick filters', rangeSummary: [{ label: '15-minute opening range', ...openingRange }], metadata: { tradingDate } };
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
  if (currentParts.date !== tradingDate || currentMinute < 570 || currentMinute > 945) {
    return { found: false, reason: 'EMA momentum entries wait for the 09:30â€“15:45 New York window', metadata: { tradingDate } };
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
  const entry = roundToTick(current.close, rawConfig:ï¯m¢G§²ÚîÆ­yÑ”ñð€œœ¤¹Ñ½1½Ý•É…Í” ¤ì(€Í•ÑÕÀ¹•¹ÑÉä€ô¹Õ´¡Í•ÑÕÀ¹•¹ÑÉä°€•¹ÑÉäœ¤ì(€Í•ÑÕÀ¹ÍÑ½À€ô¹Õ´¡Í•ÑÕÀ¹ÍÑ½À°€ÍÑ½Àœ¤ì(€Í•ÑÕÀ¹Ñ…É•ÑÌ€ôÉÉ…ä¹¥ÍÉÉ…ä¡Í•ÑÕÀ¹Ñ…É•ÑÌ¤€üÍ•ÑÕÀ¹Ñ…É•ÑÌ¹µ…À ¡Ñ…É•Ð°¥¹‘•à¤€ôø¹Õ´¡Ñ…É•Ð°Ñ…É•ÑÍl‘í¥¹‘•áõu€¤¤€èmtì(€Í•ÑÕÀ¹Ñ¡•Í¥Ì€ôMÑÉ¥¹œ¡Í•ÑÕÀ¹Ñ¡•Í¥Ìñð€œœ¤¹ÑÉ¥´ ¤ì(€Í•ÑÕÀ¹Í•ÍÍ¥½¸€ôMÑÉ¥¹œ¡Í•ÑÕÀ¹Í•ÍÍ¥½¸ñð€Õ¹ÍÁ•¥™¥•œ¤ì(€Í•ÑÕÀ¹‘…Ñ”€ôMÑÉ¥¹œ¡Í•ÑÕÀ¹‘…Ñ”ñð¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤¹Í±¥” À°€ÄÀ¤¤ì(€Í•ÑÕÀ¹Í•ÑÕÀ€ôÍ•ÑÕÀ¹Í•ÑÕÀñðíôì(€Í•ÑÕÀ¹Í•ÑÕÀ¹É•…Ñ¥½¸€ôMÑÉ¥¹œ¡Í•ÑÕÀ¹Í•ÑÕÀ¹É•…Ñ¥½¸ñð€œœ¤¹Ñ½1½Ý•É…Í” ¤ì(€Í•ÑÕÀ¹Í•ÑÕÀ¹•¹ÑÉå5½‘•°€ôMÑÉ¥¹œ¡Í•ÑÕÀ¹Í•ÑÕÀ¹•¹ÑÉå5½‘•°ñð€œœ¤¹Ñ½1½Ý•É…Í” ¤ì(€Í•ÑÕÀ¹Í•ÑÕÀ¹…ÁQåÁ”€ôMÑÉ¥¹œ¡Í•ÑÕÀ¹Í•ÑÕÀ¹…ÁQåÁ”ñð€œœ¤¹Ñ½1½Ý•É…Í” ¤ì(€Í•ÑÕÀ¹Í•ÑÕÀ¹•¹ÑÉåQ¥µ•™É…µ”€ôMÑÉ¥¹œ¡Í•ÑÕÀ¹Í•ÑÕÀ¹•¹ÑÉåQ¥µ•™É…µ”ñð€œœ¤¹Ñ½UÁÁ•É…Í” ¤ì(€Í•ÑÕÀ¹Í•ÑÕÀ¹±¥ÅÕ¥‘¥ÑåA½½°€ôMÑÉ¥¹œ¡Í•ÑÕÀ¹Í•ÑÕÀ¹±¥ÅÕ¥‘¥ÑåA½½°ñð€œœ¤¹Ñ½1½Ý•É…Í” ¤ì(€Í•ÑÕÀ¹Í•ÑÕÀ¹…Ñ¥Ù…Ñ¥½¹Q¥µ”€ôMÑÉ¥¹œ¡Í•ÑÕÀ¹Í•ÑÕÀ¹…Ñ¥Ù…Ñ¥½¹Q¥µ”ñð€œœ¤¹ÑÉ¥´ ¤ì(€Í•ÑÕÀ¹Í•ÑÕÀ¹ÍÑ½ÁA±…•µ•¹Ð€ôMÑÉ¥¹œ¡Í•ÑÕÀ¹Í•ÑÕÀ¹ÍÑ½ÁA±…•µ•¹Ðñð€œœ¤¹Ñ½1½Ý•É…Í” ¤ì(€Í•ÑÕÀ¹Í•ÑÕÀ¹É•™•É•¹•M•ÍÍ¥½¹Ì€ôÉÉ…ä¹¥ÍÉÉ…ä¡Í•ÑÕÀ¹Í•ÑÕÀ¹É•™•É•¹•M•ÍÍ¥½¹Ì¤(€€€€üÍ•ÑÕÀ¹Í•ÑÕÀ¹É•™•É•¹•M•ÍÍ¥½¹Ì¹µ…À ¡¥Ñ•´¤€ôøMÑÉ¥¹œ¡¥Ñ•´¤¹Ñ½1½Ý•É…Í” ¤¤(€€€€èmtì(€Í•ÑÕÀ¹Í•ÑÕÀ¹‘É…Ý=¹1¥ÅÕ¥‘¥Ñä€ôÉÉ…ä¹¥ÍÉÉ…ä¡Í•ÑÕÀ¹Í•ÑÕÀ¹‘É…Ý=¹1¥ÅÕ¥‘¥Ñä¤(€€€€üÍ•ÑÕÀ¹Í•ÑÕÀ¹‘É…Ý=¹1¥ÅÕ¥‘¥Ñä¹µ…À ¡¥Ñ•´¤€ôøMÑÉ¥¹œ¡¥Ñ•´¤¹Ñ½1½Ý•É…Í” ¤¤(€€€€èmtì(€É•ÑÕÉ¸Í•ÑÕÀì)ô()™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•M•ÑÕÀ¡Í•ÑÕÀ°½¹™¥œ¤ì(€½¹ÍÐ•ÉÉ½ÉÌ€ômtì(€½¹ÍÐ•¹ÑÉå5½‘•°€ôÍ•ÑÕÀ¹Í•ÑÕÀ¹•¹ÑÉå5½‘•°ì(€½¹ÍÐµ½‘•±IÕ±•Ì€ôì(€€€€Í•ÍÍ¥½¸µÍÝ••Àµ™ÙœµÉ•Ù•ÉÍ…°œèìÍÝ••ÀèÑÉÕ”°…ÁQåÁ•Ìèl™Ùœt°Ñ¥µ•™É…µ•Ìèl4Ätô°(€€€€µÍÌµ™ÙœœèìÍÝ••ÀèÑÉÕ”°…ÁQåÁ•Ìèl™Ùœt°Ñ¥µ•™É…µ•Ìèl4Ätô°(€€€€µÍÌµ¥™ÙœœèìÍÝ••ÀèÑÉÕ”°…ÁQåÁ•Ìèl¥™Ùœt°Ñ¥µ•™É…µ•Ìèl4Ätô°(€€€€…µµ™ÙœœèìÍÝ••ÀèÑÉÕ”°…ÁQåÁ•Ìèl™Ùœt°Ñ¥µ•™É…µ•Ìèl4Ätô°(€€€€…µµ¥™ÙœœèìÍÝ••ÀèÑÉÕ”°…ÁQåÁ•Ìèl¥™Ùœt°Ñ¥µ•™É…µ•Ìèl4Ätô°(€€€€¡½ÕÉ±äµÍÝ••Àµ¥™Ùœµ‰½ÌœèìÍÝ••ÀèÑÉÕ”°…ÁQåÁ•Ìèl¥™Ùœt°Ñ¥µ•™É…µ•Ìèl4Ätô°(€€€€½Á•¹¥¹œµÉ…¹”µ‰É•…­½ÕÐœèìÍÝ••Àè™…±Í”°…ÁQåÁ•ÌèlÉ…¹”µ‰É•…¬t°Ñ¥µ•™É…µ•Ìèl4Ätô°(€€€€½Á•¹¥¹œµÉ…¹”µ±½Í”µ½¹™¥Éµ…Ñ¥½¸œèìÍÝ••Àè™…±Í”°…ÁQåÁ•ÌèlÉ…¹”µ‰É•…¬t°Ñ¥µ•™É…µ•Ìèl4ÄÔtô°(€€€€½Á•¹¥¹œµÉ…¹”µ‰É•…­½ÕÐµÉ•Ñ•ÍÐœèìÍÝ••Àè™…±Í”°…ÁQåÁ•ÌèlÉ…¹”µÉ•Ñ•ÍÐt°Ñ¥µ•™É…µ•Ìèl4Ätô°(€€€€•µ„´ÈÀ´ØÀµµ½µ•¹ÑÕ´œèìÍÝ••Àè™…±Í”°…ÁQåÁ•Ìèl•µ„µÉ½ÍÍ½Ù•Èt°Ñ¥µ•™É…µ•Ìèl4ÄÔtô°(€€€€Ù½±Õµ”µÁ½ŒµÉ•Ù•ÉÍ¥½¸œèìÍÝ••Àè™…±Í”°…ÁQåÁ•ÌèlÙ½±Õµ”µÁÉ½™¥±”t°Ñ¥µ•™É…µ•Ìèl4Ätô(€ôì(€½¹ÍÐµ½‘•±IÕ±”€ôµ½‘•±IÕ±•Ím•¹ÑÉå5½‘•±tì(€¥˜€ …l±½¹œœ°€Í¡½ÉÐt¹¥¹±Õ‘•Ì¡Í•ÑÕÀ¹Í¥‘”¤¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  Í¥‘”µÕÍÐ‰”€‰±½¹œˆ½È€‰Í¡½ÉÐˆœ¤ì(€ô(€¥˜€ …Í•ÑÕÀ¹Ñ…É•ÑÌ¹±•¹Ñ ¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  …Ð±•…ÍÐ½¹”Ñ…É•Ð¥ÌÉ•ÅÕ¥É•œ¤ì(€ô(€¥˜€ …Í•ÑÕÀ¹Ñ¡•Í¥Ì¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  Ñ¡•Í¥Ì¥ÌÉ•ÅÕ¥É•œ¤ì(€ô(€¥˜€¡µ½‘•±IÕ±”ü¹ÍÝ••À€˜˜€…Í•ÑÕÀ¹Í•ÑÕÀ¹±¥ÅÕ¥‘¥ÑåMÝ••À¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  Í•ÑÕÀ¹±¥ÅÕ¥‘¥ÑåMÝ••ÀµÕÍÐ‰”ÑÉÕ”œ¤ì(€ô(€¥˜€ …l‰Õ±±¥Í œ°€‰•…É¥Í t¹¥¹±Õ‘•Ì¡Í•ÑÕÀ¹Í•ÑÕÀ¹É•…Ñ¥½¸¤¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  Í•ÑÕÀ¹É•…Ñ¥½¸µÕÍÐ‰”€‰‰Õ±±¥Í ˆ½È€‰‰•…É¥Í ˆœ¤ì(€ô(€¥˜€ …µ½‘•±IÕ±”¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ ¡Í•ÑÕÀ¹•¹ÑÉå5½‘•°¥Ì¹½ÐÍÕÁÁ½ÉÑ•è€‘í•¹ÑÉå5½‘•°ñð€µ¥ÍÍ¥¹œõ€¤ì(€ô(€¥˜€¡µ½‘•±IÕ±”€˜˜€…µ½‘•±IÕ±”¹…ÁQåÁ•Ì¹¥¹±Õ‘•Ì¡Í•ÑÕÀ¹Í•ÑÕÀ¹…ÁQåÁ”¤¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ ¡Í•ÑÕÀ¹…ÁQåÁ”µÕÍÐ‰”€‘íµ½‘•±IÕ±”¹…ÁQåÁ•Ì¹©½¥¸ œ½È€œ¥ô™½È€‘í•¹ÑÉå5½‘•±õ€¤ì(€ô(€¥˜€¡µ½‘•±IÕ±”€˜˜€…µ½‘•±IÕ±”¹Ñ¥µ•™É…µ•Ì¹¥¹±Õ‘•Ì¡Í•ÑÕÀ¹Í•ÑÕÀ¹•¹ÑÉåQ¥µ•™É…µ”¤¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ ¡Í•ÑÕÀ¹•¹ÑÉåQ¥µ•™É…µ”µÕÍÐ‰”€‘íµ½‘•±IÕ±”¹Ñ¥µ•™É…µ•Ì¹©½¥¸ œ½È€œ¥ô™½È€‘í•¹ÑÉå5½‘•±õ€¤ì(€ô(€¥˜€ …Í•ÑÕÀ¹Í•ÑÕÀ¹±¥ÅÕ¥‘¥ÑåA½½°¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  Í•ÑÕÀ¹±¥ÅÕ¥‘¥ÑåA½½°¥ÌÉ•ÅÕ¥É•œ¤ì(€ô(€¥˜€ …Í•ÑÕÀ¹Í•ÑÕÀ¹É•™•É•¹•M•ÍÍ¥½¹Ì¹±•¹Ñ ¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  Í•ÑÕÀ¹É•™•É•¹•M•ÍÍ¥½¹ÌµÕÍÐ¥¹±Õ‘”Ñ¡”Í•ÍÍ¥½¸É…¹•Ìå½Ôµ…É­•½ÕÐ°±¥­”…Í¥„½±½¹‘½¸œ¤ì(€ô(€¥˜€ …Í•ÑÕÀ¹Í•ÑÕÀ¹…Ñ¥Ù…Ñ¥½¹Q¥µ”¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  Í•ÑÕÀ¹…Ñ¥Ù…Ñ¥½¹Q¥µ”¥ÌÉ•ÅÕ¥É•œ¤ì(€ô(€¥˜€ …lÍÝ¥¹œµ±½Üœ°€ÍÝ¥¹œµ¡¥ œ°€ÍÝ¥¹œµ•áÑÉ•µ”t¹¥¹±Õ‘•Ì¡Í•ÑÕÀ¹Í•ÑÕÀ¹ÍÑ½ÁA±…•µ•¹Ð¤¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  Í•ÑÕÀ¹ÍÑ½ÁA±…•µ•¹ÐµÕÍÐ‰”ÍÝ¥¹œµ±½Ü°ÍÝ¥¹œµ¡¥ °½ÈÍÝ¥¹œµ•áÑÉ•µ”œ¤ì(€ô(€¥˜€ …Í•ÑÕÀ¹Í•ÑÕÀ¹‘É…Ý=¹1¥ÅÕ¥‘¥Ñä¹±•¹Ñ ¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  Í•ÑÕÀ¹‘É…Ý=¹1¥ÅÕ¥‘¥ÑäµÕÍÐ¥¹±Õ‘”…Ð±•…ÍÐ½¹”Ñ…É•Ð¹…ÉÉ…Ñ¥Ù”±¥­”ÙÝ…À½ÕÉÉ•¹ÐµÝ••¬µ±½Üœ¤ì(€ô(€¥˜€¡Í•ÑÕÀ¹Í¥‘”€ôôô€±½¹œœ€˜˜Í•ÑÕÀ¹Í•ÑÕÀ¹É•…Ñ¥½¸€„ôô€‰Õ±±¥Í œ¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  ±½¹œÍ•ÑÕÁÌµÕÍÐÕÍ”„‰Õ±±¥Í É•…Ñ¥½¸œ¤ì(€ô(€¥˜€¡Í•ÑÕÀ¹Í¥‘”€ôôô€Í¡½ÉÐœ€˜˜Í•ÑÕÀ¹Í•ÑÕÀ¹É•…Ñ¥½¸€„ôô€‰•…É¥Í œ¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  Í¡½ÉÐÍ•ÑÕÁÌµÕÍÐÕÍ”„‰•…É¥Í É•…Ñ¥½¸œ¤ì(€ô(€¥˜€¡Í•ÑÕÀ¹Í¥‘”€ôôô€±½¹œœ¤ì(€€€¥˜€¡Í•ÑÕÀ¹ÍÑ½À€øôÍ•ÑÕÀ¹•¹ÑÉä¤ì(€€€€€•ÉÉ½ÉÌ¹ÁÕÍ  ™½È±½¹œÑÉ…‘•Ì°ÍÑ½ÀµÕÍÐ‰”‰•±½Ü•¹ÑÉäœ¤ì(€€€ô(€€€¥˜€¡Í•ÑÕÀ¹Ñ…É•ÑÌ¹Í½µ” ¡Ñ…É•Ð¤€ôøÑ…É•Ð€ðôÍ•ÑÕÀ¹•¹ÑÉä¤¤ì(€€€€€•ÉÉ½ÉÌ¹ÁÕÍ  ™½È±½¹œÑÉ…‘•Ì°•Ù•ÉäÑ…É•ÐµÕÍÐ‰”…‰½Ù”•¹ÑÉäœ¤ì(€€€ô(€ô(€¥˜€¡Í•ÑÕÀ¹Í¥‘”€ôôô€Í¡½ÉÐœ¤ì(€€€¥˜€¡Í•ÑÕÀ¹ÍÑ½À€ðôÍ•ÑÕÀ¹•¹ÑÉä¤ì(€€€€€•ÉÉ½ÉÌ¹ÁÕÍ  ™½ÈÍ¡½ÉÐÑÉ…‘•Ì°ÍÑ½ÀµÕÍÐ‰”…‰½Ù”•¹ÑÉäœ¤ì(€€€ô(€€€¥˜€¡Í•ÑÕÀ¹Ñ…É•ÑÌ¹Í½µ” ¡Ñ…É•Ð¤€ôøÑ…É•Ð€øôÍ•ÑÕÀ¹•¹ÑÉä¤¤ì(€€€€€•ÉÉ½ÉÌ¹ÁÕÍ  ™½ÈÍ¡½ÉÐÑÉ…‘•Ì°•Ù•ÉäÑ…É•ÐµÕÍÐ‰”‰•±½Ü•¹ÑÉäœ¤ì(€€€ô(€ô((€½¹ÍÐÍÑ½Á¥ÍÑ…¹•A½¥¹ÑÌ€ô5…Ñ ¹…‰Ì¡Í•ÑÕÀ¹•¹ÑÉä€´Í•ÑÕÀ¹ÍÑ½À¤ì(€¥˜€¡ÍÑ½Á¥ÍÑ…¹•A½¥¹ÑÌ€ðô€À¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ  ÍÑ½À‘¥ÍÑ…¹”µÕÍÐ‰”É•…Ñ•ÈÑ¡…¸é•É¼œ¤ì(€ô((€½¹ÍÐ‰•ÍÑQ…É•Ð€ôÍ•ÑÕÀ¹Í¥‘”€ôôô€±½¹œœ€ü5…Ñ ¹µ…à ¸¸¹Í•ÑÕÀ¹Ñ…É•ÑÌ¤€è5…Ñ ¹µ¥¸ ¸¸¹Í•ÑÕÀ¹Ñ…É•ÑÌ¤ì(€½¹ÍÐÉ•Ý…É‘A½¥¹ÑÌ€ô5…Ñ ¹…‰Ì¡‰•ÍÑQ…É•Ð€´Í•ÑÕÀ¹•¹ÑÉä¤ì(€½¹ÍÐÉÈ€ôÍÑ½Á¥ÍÑ…¹•A½¥¹ÑÌ€ø€À€üÉ•Ý…É‘A½¥¹ÑÌ€¼ÍÑ½Á¥ÍÑ…¹•A½¥¹ÑÌ€è€Àì(€¥˜€¡½¹™¥œ¹µ¥¹¥µÕµI5Õ±Ñ¥Á±”€ø€À€˜˜ÉÈ€ð½¹™¥œ¹µ¥¹¥µÕµI5Õ±Ñ¥Á±”¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ ¡‰•ÍÐÑ…É•Ð½¹±ä½™™•ÉÌ€‘íÉ½Õ¹¡ÉÈ°€È¥õH°‰•±½ÜÑ¡”€‘í½¹™¥œ¹µ¥¹¥µÕµI5Õ±Ñ¥Á±•õHµ¥¹¥µÕµ€¤ì(€ô((€É•ÑÕÉ¸ì(€€€Ù…±¥è•ÉÉ½ÉÌ¹±•¹Ñ €ôôô€À°(€€€•ÉÉ½ÉÌ(€ôì)ô()™Õ¹Ñ¥½¸‰Õ¥±‘QÉ…‘•A±…¸¡Í•ÑÕÀ°½¹™¥œ°ÍÑ…Ñ”¤ì(€½¹ÍÐÍÑ½Á¥ÍÑ…¹•A½¥¹ÑÌ€ô5…Ñ ¹…‰Ì¡Í•ÑÕÀ¹•¹ÑÉä€´Í•ÑÕÀ¹ÍÑ½À¤ì(€½¹ÍÐÑ¥­¥ÍÑ…¹”€ôÍÑ½Á¥ÍÑ…¹•A½¥¹ÑÌ€¼½¹™¥œ¹Ñ¥­M¥é”ì(€½¹ÍÐÉ¥Í­A•É½¹ÑÉ…ÑUÍ€ôÑ¥­¥ÍÑ…¹”€¨½¹™¥œ¹Ñ¥­Y…±Õ•UÍì(€½¹ÍÐÍ±¥ÁÁ…•UÍ€ô½¹™¥œ¹Í±¥ÁÁ…•Q¥­Ì€¨½¹™¥œ¹Ñ¥­Y…±Õ•UÍì(€½¹ÍÐÑ½Ñ…±I¥Í­A•É½¹ÑÉ…ÑUÍ€ôÉ¥Í­A•É½¹ÑÉ…ÑUÍ€¬Í±¥ÁÁ…•UÍ€¬½¹™¥œ¹½µµ¥ÍÍ¥½¹A•É½¹ÑÉ…ÑUÍì(€½¹ÍÐ‘É…Ý‘½Ý¹I½½µUÍ€ôÉ•µ…¥¹¥¹É…Ý‘½Ý¹I½½µUÍ¡ÍÑ…Ñ”¹‰…±…¹•UÍ°½¹™¥œ¤ì(€½¹ÍÐÉ¥Í­	Õ‘•ÑUÍ€ô5…Ñ ¹µ¥¸¡½¹™¥œ¹µ…áI¥Í­A•ÉQÉ…‘•UÍ°5…Ñ ¹µ…à À°‘É…Ý‘½Ý¹I½½µUÍ¤¤ì(€½¹ÍÐµ…á½¹ÑÉ…ÑÌ€ô5…Ñ ¹™±½½È¡É¥Í­	Õ‘•ÑUÍ€¼Ñ½Ñ…±I¥Í­A•É½¹ÑÉ…ÑUÍ¤ì((€¥˜€¡‘É…Ý‘½Ý¹I½½µUÍ€ðô€À¤ì(€€€Ñ¡É½Ü¹•ÜÉÉ½È (€€€€€½Õ¹Ð‘É…Ý‘½Ý¸Õ…É…Ñ¥Ù”è‰…±…¹”€‘í™½Éµ…ÑUÍ¡ÍÑ…Ñ”¹‰…±…¹•UÍ¥ô¥ÌÑ½¼±½Í”Ñ¼Ñ¡”€‘í™½Éµ…ÑUÍ¡…½Õ¹Ñ±½½ÉUÍ¡½¹™¥œ¤¥ô™±½½ÈÑ¼Ñ…­”…¹½Ñ¡•ÈÑÉ…‘”¹€(€€€€¤ì(€ô((€¥˜€¡µ…á½¹ÑÉ…ÑÌ€ð€Ä¤ì(€€€Ñ¡É½Ü¹•ÜÉÉ½È (€€€€€9¼ÑÉ…‘”èµ¥¹¥µÕ´€Äµ½¹ÑÉ…ÐÉ¥Í¬€‘í™½Éµ…ÑUÍ¡Ñ½Ñ…±I¥Í­A•É½¹ÑÉ…ÑUÍ¥ô•á••‘ÌÑ¡”ÕÉÉ•¹Ð€‘í™½Éµ…ÑUÍ¡É¥Í­	Õ‘•ÑUÍ¥ôÉ¥Í¬‰Õ‘•Ð¹€(€€€€¤ì(€ô((€½¹ÍÐ…ÑÕ…±I¥Í­UÍ€ôÉ½Õ¹¡µ…á½¹ÑÉ…ÑÌ€¨Ñ½Ñ…±I¥Í­A•É½¹ÑÉ…ÑUÍ°€È¤ì(€½¹ÍÐÍ…±•=ÕÑÌ€ô½¹™¥œ¹‘•™…Õ±ÑM…±•=ÕÑÌ(€€€€¹™¥±Ñ•È ¡Í…±”¤€ôøÍ…±”¹Ñ…É•Ñ%¹‘•à€ðÍ•ÑÕÀ¹Ñ…É•ÑÌ¹±•¹Ñ ¤(€€€€¹µ…À ¡Í…±”¤€ôø€¡ì€¸¸¹Í…±”ô¤¤ì((€½¹ÍÐÑ…É•ÑÌ€ôÍ•ÑÕÀ¹Ñ…É•ÑÌ¹µ…À ¡Ñ…É•Ð°¥¹‘•à¤€ôøì(€€€½¹ÍÐÉ•Ý…É‘A½¥¹ÑÌ€ô5…Ñ ¹…‰Ì¡Ñ…É•Ð€´Í•ÑÕÀ¹•¹ÑÉä¤ì(€€€½¹ÍÐÉÈ€ôÉ•Ý…É‘A½¥¹ÑÌ€¼ÍÑ½Á¥ÍÑ…¹•A½¥¹ÑÌì(€€€½¹ÍÐÍ…±•=ÕÐ€ôÍ…±•=ÕÑÌ¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´¹Ñ…É•Ñ%¹‘•à€ôôô¥¹‘•à¤ì(€€€É•ÑÕÉ¸ì(€€€€€ÁÉ¥”èÑ…É•Ð°(€€€€€É•Ý…É‘A½¥¹ÑÌèÉ½Õ¹¡É•Ý…É‘A½¥¹ÑÌ°€È¤°(€€€€€É•Ý…É‘Q¥­ÌèÉ½Õ¹¡É•Ý…É‘A½¥¹ÑÌ€¼½¹™¥œ¹Ñ¥­M¥é”°€È¤°(€€€€€É5Õ±Ñ¥Á±”èÉ½Õ¹¡ÉÈ°€È¤°(€€€€€±½Í•É…Ñ¥½¸èÍ…±•=ÕÐ€üÍ…±•=ÕÐ¹±½Í•É…Ñ¥½¸€è€À(€€€ôì(€ô¤ì((€É•ÑÕÉ¸ì(€€€ÍÑÉ…Ñ•äè‘½Ñ½ÉÑÉ…‘•Ì´‘íÍ•ÑÕÀ¹Í•ÑÕÀ¹•¹ÑÉå5½‘•°ñð€Á…Á•ÈôµÁ…Á•ÈµÑÉ…‘•É€°(€€€Í•ÑÕÀ°(€€€Í¥é¥¹œèì(€€€€€…½Õ¹Ñ	…±…¹•UÍèÉ½Õ¹¡ÍÑ…Ñ”¹‰…±…¹•UÍ°€È¤°(€€€€€…½Õ¹Ñ±½½ÉUÍè…½Õ¹Ñ±½½ÉUÍ¡½¹™¥œ¤°(€€€€€É•µ…¥¹¥¹É…Ý‘½Ý¹I½½µUÍè‘É…Ý‘½Ý¹I½½µUÍ°(€€€€€É¥Í­	Õ‘•ÑUÍèÉ½Õ¹¡É¥Í­	Õ‘•ÑUÍ°€È¤°(€€€€€ÍÑ½Á¥ÍÑ…¹•A½¥¹ÑÌèÉ½Õ¹¡ÍÑ½Á¥ÍÑ…¹•A½¥¹ÑÌ°€È¤°(€€€€€ÍÑ½Á¥ÍÑ…¹•Q¥­ÌèÉ½Õ¹¡Ñ¥­¥ÍÑ…¹”°€È¤°(€€€€€É¥Í­A•É½¹ÑÉ…ÑUÍèÉ½Õ¹¡É¥Í­A•É½¹ÑÉ…ÑUÍ°€È¤°(€€€€€Í±¥ÁÁ…•UÍèÉ½Õ¹¡Í±¥ÁÁ…•UÍ°€È¤°(€€€€€Ñ½Ñ…±I¥Í­A•É½¹ÑÉ…ÑUÍèÉ½Õ¹¡Ñ½Ñ…±I¥Í­A•É½¹ÑÉ…ÑUÍ°€È¤°(€€€€€µ…á½¹ÑÉ…ÑÌ°(€€€€€…ÑÕ…±I¥Í­UÍ(€€€ô°(€€€Ñ…É•ÑÌ°(€€€¹…ÉÉ…Ñ¥Ù”èì(€€€€€…Ñ¥Ù…Ñ¥½¹Q¥µ”èÍ•ÑÕÀ¹Í•ÑÕÀ¹…Ñ¥Ù…Ñ¥½¹Q¥µ”°(€€€€€É•™•É•¹•M•ÍÍ¥½¹ÌèÍ•ÑÕÀ¹Í•ÑÕÀ¹É•™•É•¹•M•ÍÍ¥½¹Ì°(€€€€€±¥ÅÕ¥‘¥ÑåA½½°èÍ•ÑÕÀ¹Í•ÑÕÀ¹±¥ÅÕ¥‘¥ÑåA½½°°(€€€€€É•…Ñ¥½¸èÍ•ÑÕÀ¹Í•ÑÕÀ¹É•…Ñ¥½¸°(€€€€€•¹ÑÉå5½‘•°èÍ•ÑÕÀ¹Í•ÑÕÀ¹•¹ÑÉå5½‘•°°(€€€€€…ÁQåÁ”èÍ•ÑÕÀ¹Í•ÑÕÀ¹…ÁQåÁ”°(€€€€€•¹ÑÉåQ¥µ•™É…µ”èÍ•ÑÕÀ¹Í•ÑÕÀ¹•¹ÑÉåQ¥µ•™É…µ”°(€€€€€ÍÑ½ÁA±…•µ•¹ÐèÍ•ÑÕÀ¹Í•ÑÕÀ¹ÍÑ½ÁA±…•µ•¹Ð°(€€€€€‘É…Ý=¹1¥ÅÕ¥‘¥ÑäèÍ•ÑÕÀ¹Í•ÑÕÀ¹‘É…Ý=¹1¥ÅÕ¥‘¥Ñä(€€€ô(€ôì)ô()™Õ¹Ñ¥½¸Á…ÉÍ•ÍÙQ•áÐ¡É…ÝÍØ¤ì(€½¹ÍÐÉ…Ü€ôMÑÉ¥¹œ¡É…ÝÍØñð€œœ¤¹ÑÉ¥´ ¤ì(€¥˜€ …É…Ü¤ì(€€€Ñ¡É½Ü¹•ÜÉÉ½È MX‘…Ñ„¥ÌÉ•ÅÕ¥É•œ¤ì(€ô(€½¹ÍÐ±¥¹•Ì€ôÉ…Ü¹ÍÁ±¥Ð ½qÈýq¸¼¤ì(€½¹ÍÐm¡•…‘•É1¥¹”°€¸¸¹É½ÝÍt€ô±¥¹•Ìì(€½¹ÍÐ¡•…‘•ÉÌ€ô¡•…‘•É1¥¹”¹ÍÁ±¥Ð œ°œ¤¹µ…À ¡•±°¤€ôø•±°¹ÑÉ¥´ ¤¤ì(€É•ÑÕÉ¸É½ÝÌ¹™¥±Ñ•È¡	½½±•…¸¤¹µ…À ¡±¥¹”°É½Ý%¹‘•à¤€ôøì(€€€½¹ÍÐ•±±Ì€ô±¥¹”¹ÍÁ±¥Ð œ°œ¤¹µ…À ¡•±°¤€ôø•±°¹ÑÉ¥´ ¤¤ì(€€€½¹ÍÐÉ•½É€ôíôì(€€€¡•…‘•ÉÌ¹™½É…  ¡¡•…‘•È°¥¹‘•à¤€ôøì(€€€€€É•½É‘m¡•…‘•Ét€ô•±±Ím¥¹‘•átì(€€€ô¤ì(€€€¥˜€ …É•½É¹Ñ¥µ•ÍÑ…µÀ¤ì(€€€€€Ñ¡É½Ü¹•ÜÉÉ½È¡MXÉ½Ü€‘íÉ½Ý%¹‘•à€¬€Éô¥Ìµ¥ÍÍ¥¹œÑ¥µ•ÍÑ…µÁ€¤ì(€€€ô(€€€É•ÑÕÉ¸ì(€€€€€Ñ¥µ•ÍÑ…µÀèÉ•½É¹Ñ¥µ•ÍÑ…µÀ°(€€€€€½Á•¸è¹Õ´¡É•½É¹½Á•¸°É½Ü€‘íÉ½Ý%¹‘•à€¬€Éô½Á•¹€¤°(€€€€€¡¥ è¹Õ´¡É•½É¹¡¥ °É½Ü€‘íÉ½Ý%¹‘•à€¬€Éô¡¥¡€¤°(€€€€€±½Üè¹Õ´¡É•½É¹±½Ü°É½Ü€‘íÉ½Ý%¹‘•à€¬€Éô±½Ý€¤°(€€€€€±½Í”è¹Õ´¡É•½É¹±½Í”°É½Ü€‘íÉ½Ý%¹‘•à€¬€Éô±½Í•€¤(€€€ôì(€ô¤ì)ô()™Õ¹Ñ¥½¸Á…ÉÍ•ÍÙ¥±”¡ÍÙA…Ñ ¤ì(€É•ÑÕÉ¸Á…ÉÍ•ÍÙQ•áÐ¡™Ì¹É•…‘¥±•Må¹Œ¡ÍÙA…Ñ °€ÕÑ˜àœ¤¤ì)ô()™Õ¹Ñ¥½¸ÁÉ¥•Q½Õ¡•¡…¹‘±”°ÁÉ¥”¤ì(€É•ÑÕÉ¸…¹‘±”¹±½Ü€ðôÁÉ¥”€˜˜…¹‘±”¹¡¥ €øôÁÉ¥”ì)ô()™Õ¹Ñ¥½¸ÍÑ½Á!¥Ð¡…¹‘±”°ÍÑ½À°Í¥‘”¤ì(€É•ÑÕÉ¸Í¥‘”€ôôô€±½¹œœ€ü…¹‘±”¹±½Ü€ðôÍÑ½À€è…¹‘±”¹¡¥ €øôÍÑ½Àì)ô()™Õ¹Ñ¥½¸Ñ…É•Ñ!¥Ð¡…¹‘±”°Ñ…É•Ð°Í¥‘”¤ì(€É•ÑÕÉ¸Í¥‘”€ôôô€±½¹œœ€ü…¹‘±”¹¡¥ €øôÑ…É•Ð€è…¹‘±”¹±½Ü€ðôÑ…É•Ðì)ô()™Õ¹Ñ¥½¸Á¹±½É5½Ù”¡•¹ÑÉä°•á¥Ð°½¹ÑÉ…ÑÌ°Í¥‘”°½¹™¥œ¤ì(€½¹ÍÐÁ½¥¹ÑÌ€ôÍ¥‘”€ôôô€±½¹œœ€ü€¡•á¥Ð€´•¹ÑÉä¤€è€¡•¹ÑÉä€´•á¥Ð¤ì(€½¹ÍÐÑ¥­Ì€ôÁ½¥¹ÑÌ€¼½¹™¥œ¹Ñ¥­M¥é”ì(€½¹ÍÐÉ½ÍÌ€ôÑ¥­Ì€¨½¹™¥œ¹Ñ¥­Y…±Õ•UÍ€¨½¹ÑÉ…ÑÌì(€½¹ÍÐ½µµ¥ÍÍ¥½¹Ì€ô½¹™¥œ¹½µµ¥ÍÍ¥½¹A•É½¹ÑÉ…ÑUÍ€¨½¹ÑÉ…ÑÌì(€É•ÑÕÉ¸É½Õ¹¡É½ÍÌ€´½µµ¥ÍÍ¥½¹Ì°€È¤ì)ô()™Õ¹Ñ¥½¸ÑÉ…­QÉ…‘•1¥™•å±”¡Á±…¸°…¹‘±•Ì°½¹™¥œ°½ÁÑ¥½¹Ì€ôíô¤ì(€½¹ÍÐ±½Í•=Á•¹Ñ¹€ô½ÁÑ¥½¹Ì¹±½Í•=Á•¹Ñ¹€„ôô™…±Í”ì(€½¹ÍÐÍ¥‘”€ôÁ±…¸¹Í•ÑÕÀ¹Í¥‘”ì(€½¹ÍÐ•¹ÑÉä€ôÁ±…¸¹Í•ÑÕÀ¹•¹ÑÉäì(€½¹ÍÐÍÑ½À€ôÁ±…¸¹Í•ÑÕÀ¹ÍÑ½Àì(€½¹ÍÐ½¹ÑÉ…ÑÌ€ôÁ±…¸¹Í¥é¥¹œ¹µ…á½¹ÑÉ…ÑÌì(€½¹ÍÐ¡¥ÑQ…É•ÑÍM••¸€ômtì(€±•ÐÉ•µ…¥¹¥¹½¹ÑÉ…ÑÌ€ô½¹ÑÉ…ÑÌì(€±•Ð™¥±±•‘Ð€ô¹Õ±°ì(€±•Ð•á¥ÑI•…Í½¸€ô¹Õ±°ì(€±•Ð™¥¹…±á¥ÑAÉ¥”€ô¹Õ±°ì(€±•ÐÉ•…±¥é•‘A¹±UÍ€ô€Àì(€±•Ðµ…É­AÉ¥”€ô…¹‘±•Ì¹±•¹Ñ €ü…¹‘±•Ím…¹‘±•Ì¹±•¹Ñ €´€Åt¹±½Í”€è¹Õ±°ì(€±•Ðµ…á…Ù½É…‰±•A½¥¹ÑÌ€ô€Àì(€±•Ðµ…á‘Ù•ÉÍ•A½¥¹ÑÌ€ô€Àì((€™½È€¡½¹ÍÐ…¹‘±”½˜…¹‘±•Ì¤ì(€€€¥˜€ …™¥±±•‘Ð¤ì(€€€€€¥˜€¡ÁÉ¥•Q½Õ¡•¡…¹‘±”°•¹ÑÉä¤¤ì(€€€€€€€™¥±±•‘Ð€ô…¹‘±”¹Ñ¥µ•ÍÑ…µÀì(€€€€€ô(€€€€€½¹Ñ¥¹Õ”ì(€€€ô((€€€½¹ÍÐ™…Ù½É…‰±•A½¥¹ÑÌ€ôÍ¥‘”€ôôô€±½¹œœ€ü…¹‘±”¹¡¥ €´•¹ÑÉä€è•¹ÑÉä€´…¹‘±”¹±½Üì(€€€½¹ÍÐ…‘Ù•ÉÍ•A½¥¹ÑÌ€ôÍ¥‘”€ôôô€±½¹œœ€ü•¹ÑÉä€´…¹‘±”¹±½Ü€è…¹‘±”¹¡¥ €´•¹ÑÉäì(€€€µ…á…Ù½É…‰±•A½¥¹ÑÌ€ô5…Ñ ¹µ…à¡µ…á…Ù½É…‰±•A½¥¹ÑÌ°™…Ù½É…‰±•A½¥¹ÑÌ°€À¤ì(€€€µ…á‘Ù•ÉÍ•A½¥¹ÑÌ€ô5…Ñ ¹µ…à¡µ…á‘Ù•ÉÍ•A½¥¹ÑÌ°…‘Ù•ÉÍ•A½¥¹ÑÌ°€À¤ì((€€€½¹ÍÐÁ•¹‘¥¹Q…É•ÑÌ€ôÁ±…¸¹Ñ…É•ÑÌ¹™¥±Ñ•È ¡Ñ…É•Ð¤€ôø€…¡¥ÑQ…É•ÑÍM••¸¹¥¹±Õ‘•Ì¡Ñ…É•Ð¹ÁÉ¥”¤¤ì(€€€½¹ÍÐ¡¥ÑMÑ½À€ôÍÑ½Á!¥Ð¡…¹‘±”°ÍÑ½À°Í¥‘”¤ì(€€€½¹ÍÐ¡¥ÑQ…É•ÑÌ€ôÁ•¹‘¥¹Q…É•ÑÌ¹™¥±Ñ•È ¡Ñ…É•Ð¤€ôøÑ…É•Ñ!¥Ð¡…¹‘±”°Ñ…É•Ð¹ÁÉ¥”°Í¥‘”¤¤ì((€€€¥˜€¡¡¥ÑMÑ½À€˜˜¡¥ÑQ…É•ÑÌ¹±•¹Ñ €˜˜½¹™¥œ¹Í…µ•…¹‘±•½¹™±¥Ð€ôôô€ÍÑ½Àµ™¥ÉÍÐœ¤ì(€€€€€É•…±¥é•‘A¹±UÍ€¬ôÁ¹±½É5½Ù”¡•¹ÑÉä°ÍÑ½À°É•µ…¥¹¥¹½¹ÑÉ…ÑÌ°Í¥‘”°½¹™¥œ¤ì(€€€€€™¥¹…±á¥ÑAÉ¥”€ôÍÑ½Àì(€€€€€•á¥ÑI•…Í½¸€ô€ÍÑ½Àµ±½ÍÌÍ…µ”µ…¹‘±”½¹™±¥Ðœì(€€€€€É•µ…¥¹¥¹½¹ÑÉ…ÑÌ€ô€Àì(€€€€€‰É•…¬ì(€€€ô((€€€™½È€¡½¹ÍÐÑ…É•Ð½˜¡¥ÑQ…É•ÑÌ¤ì(€€€€€¥˜€¡É•µ…¥¹¥¹½¹ÑÉ…ÑÌ€ðô€À¤‰É•…¬ì(€€€€€½¹ÍÐ±½Í•½¹ÑÉ…ÑÌ€ô5…Ñ ¹µ¥¸¡É•µ…¥¹¥¹½¹ÑÉ…ÑÌ°5…Ñ ¹µ…à Ä°5…Ñ ¹É½Õ¹¡½¹ÑÉ…ÑÌ€¨Ñ…É•Ð¹±½Í•É…Ñ¥½¸¤¤¤ì(€€€€€É•…±¥é•‘A¹±UÍ€¬ôÁ¹±½É5½Ù”¡•¹ÑÉä°Ñ…É•Ð¹ÁÉ¥”°±½Í•½¹ÑÉ…ÑÌ°Í¥‘”°½¹™¥œ¤ì(€€€€€É•µ…¥¹¥¹½¹ÑÉ…ÑÌ€´ô±½Í•½¹ÑÉ…ÑÌì(€€€€€¡¥ÑQ…É•ÑÍM••¸¹ÁÕÍ ¡Ñ…É•Ð¹ÁÉ¥”¤ì(€€€€€™¥¹…±á¥ÑAÉ¥”€ôÑ…É•Ð¹ÁÉ¥”ì(€€€€€•á¥ÑI•…Í½¸€ôÑ…É•Ð€‘íÑ…É•Ð¹ÁÉ¥•õ€ì(€€€ô((€€€¥˜€¡É•µ…¥¹¥¹½¹ÑÉ…ÑÌ€ðô€À¤ì(€€€€€‰É•…¬ì(€€€ô((€€€¥˜€¡¡¥ÑMÑ½À¤ì(€€€€€É•…±¥é•‘A¹±UÍ€¬ôÁ¹±½É5½Ù”¡•¹ÑÉä°ÍÑ½À°É•µ…¥¹¥¹½¹ÑÉ…ÑÌ°Í¥‘”°½¹™¥œ¤ì(€€€€€™¥¹…±á¥ÑAÉ¥”€ôÍÑ½Àì(€€€€€•á¥ÑI•…Í½¸€ô€ÍÑ½Àµ±½ÍÌœì(€€€€€É•µ…¥¹¥¹½¹ÑÉ…ÑÌ€ô€Àì(€€€€€‰É•…¬ì(€€€ô(€ô((€¥˜€ …™¥±±•‘Ð¤ì(€€€É•ÑÕÉ¸ì(€€€€€ÍÑ…ÑÕÌè€¹½Ðµ™¥±±•œ°(€€€€€™¥±±•‘Ðè¹Õ±°°(€€€€€•á¥ÑI•…Í½¸è€•¹ÑÉä¹•Ù•ÈÑÉ…‘•œ°(€€€€€É•…±¥é•‘A¹±UÍè€À°(€€€€€Õ¹É•…±¥é•‘A¹±UÍè€À°(€€€€€É5Õ±Ñ¥Á±”è€À°(€€€€€Ñ…É•ÑÍ!¥Ðèmt°(€€€€€½¹ÑÉ…ÑÌ°(€€€€€É•µ…¥¹¥¹½¹ÑÉ…ÑÌè½¹ÑÉ…ÑÌ°(€€€€€™¥¹…±á¥ÑAÉ¥”è¹Õ±°°(€€€€€µ…É­AÉ¥”°(€€€€€µ™•A½¥¹ÑÌè€À°(€€€€€µ…•A½¥¹ÑÌè€À°(€€€€€µ™•UÍè€À°(€€€€€µ…•UÍè€À(€€€ôì(€ô((€¥˜€¡É•µ…¥¹¥¹½¹ÑÉ…ÑÌ€ø€À¤ì(€€€½¹ÍÐ±…ÍÑ…¹‘±”€ô…¹‘±•Ím…¹‘±•Ì¹±•¹Ñ €´€Åtì(€€€¥˜€¡±½Í•=Á•¹Ñ¹¤ì(€€€€€É•…±¥é•‘A¹±UÍ€¬ôÁ¹±½É5½Ù”¡•¹ÑÉä°±…ÍÑ…¹‘±”¹±½Í”°É•µ…¥¹¥¹½¹ÑÉ…ÑÌ°Í¥‘”°½¹™¥œ¤ì(€€€€€™¥¹…±á¥ÑAÉ¥”€ô±…ÍÑ…¹‘±”¹±½Í”ì(€€€€€•á¥ÑI•…Í½¸€ô•á¥ÑI•…Í½¸ñð€•¹µ½˜µ‘…Ñ„±½Í”œì(€€€ô•±Í”ì(€€€€€™¥¹…±á¥ÑAÉ¥”€ô¹Õ±°ì(€€€€€•á¥ÑI•…Í½¸€ô•á¥ÑI•…Í½¸ñð€ÍÑ¥±°½Á•¸œì(€€€ô(€ô((€½¹ÍÐÕ¹É•…±¥é•‘A¹±UÍ€ôÉ•µ…¥¹¥¹½¹ÑÉ…ÑÌ€ø€À€˜˜µ…É­AÉ¥”€„ô¹Õ±°(€€€€üÁ¹±½É5½Ù”¡•¹ÑÉä°µ…É­AÉ¥”°É•µ…¥¹¥¹½¹ÑÉ…ÑÌ°Í¥‘”°½¹™¥œ¤(€€€€è€Àì(€½¹ÍÐÉ5Õ±Ñ¥Á±”€ôÁ±…¸¹Í¥é¥¹œ¹…ÑÕ…±I¥Í­UÍ€ø€À€üÉ½Õ¹¡É•…±¥é•‘A¹±UÍ€¼Á±…¸¹Í¥é¥¹œ¹…ÑÕ…±I¥Í­UÍ°€È¤€è€Àì(€É•ÑÕÉ¸ì(€€€ÍÑ…ÑÕÌèÉ•µ…¥¹¥¹½¹ÑÉ…ÑÌ€ø€À€˜˜€…±½Í•=Á•¹Ñ¹€ü€½Á•¸œ€è€±½Í•œ°(€€€™¥±±•‘Ð°(€€€•á¥ÑI•…Í½¸°(€€€™¥¹…±á¥ÑAÉ¥”°(€€€É•…±¥é•‘A¹±UÍèÉ½Õ¹¡É•…±¥é•‘A¹±UÍ°€È¤°(€€€Õ¹É•…±¥é•‘A¹±UÍèÉ½Õ¹¡Õ¹É•…±¥é•‘A¹±UÍ°€È¤°(€€€É5Õ±Ñ¥Á±”°(€€€Ñ…É•ÑÍ!¥Ðè¡¥ÑQ…É•ÑÍM••¸°(€€€½¹ÑÉ…ÑÌ°(€€€É•µ…¥¹¥¹½¹ÑÉ…ÑÌ°(€€€µ…É­AÉ¥”°(€€€µ™•A½¥¹ÑÌèÉ½Õ¹¡µ…á…Ù½É…‰±•A½¥¹ÑÌ°€È¤°(€€€µ…•A½¥¹ÑÌèÉ½Õ¹¡µ…á‘Ù•ÉÍ•A½¥¹ÑÌ°€È¤°(€€€µ™•UÍèÉ½Õ¹ ¡µ…á…Ù½É…‰±•A½¥¹ÑÌ€¼½¹™¥œ¹Ñ¥­M¥é”¤€¨½¹™¥œ¹Ñ¥­Y…±Õ•UÍ€¨½¹ÑÉ…ÑÌ°€È¤°(€€€µ…•UÍèÉ½Õ¹ ´ ¡µ…á‘Ù•ÉÍ•A½¥¹ÑÌ€¼½¹™¥œ¹Ñ¥­M¥é”¤€¨½¹™¥œ¹Ñ¥­Y…±Õ•UÍ€¨½¹ÑÉ…ÑÌ¤°€È¤(€ôì)ô()™Õ¹Ñ¥½¸É•Á±…åA±…¸¡Á±…¸°…¹‘±•Ì°½¹™¥œ¤ì(€É•ÑÕÉ¸ÑÉ…­QÉ…‘•1¥™•å±”¡Á±…¸°…¹‘±•Ì°½¹™¥œ°ì±½Í•=Á•¹Ñ¹èÑÉÕ”ô¤ì)ô()™Õ¹Ñ¥½¸Ñ½)½ÕÉ¹…±QÉ…‘”¡Á±…¸°É•Á±…åI•ÍÕ±Ð¤ì(€É•ÑÕÉ¸ì(€€€¥è€‘íÁ±…¸¹Í•ÑÕÀ¹Íåµ‰½±ô´‘íÁ±…¸¹Í•ÑÕÀ¹‘…Ñ•ô´‘í…Ñ”¹¹½Ü ¥õ€°(€€€Íåµ‰½°èÁ±…¸¹Í•ÑÕÀ¹Íåµ‰½°°(€€€‘…Ñ”èÁ±…¸¹Í•ÑÕÀ¹‘…Ñ”°(€€€Í•ÍÍ¥½¸èÁ±…¸¹Í•ÑÕÀ¹Í•ÍÍ¥½¸°(€€€Í¥‘”èÁ±…¸¹Í•ÑÕÀ¹Í¥‘”°(€€€•¹ÑÉäèÁ±…¸¹Í•ÑÕÀ¹•¹ÑÉä°(€€€ÍÑ½ÀèÁ±…¸¹Í•ÑÕÀ¹ÍÑ½À°(€€€Ñ…É•ÑÌèÁ±…¸¹Í•ÑÕÀ¹Ñ…É•ÑÌ°(€€€Ñ¡•Í¥ÌèÁ±…¸¹Í•ÑÕÀ¹Ñ¡•Í¥Ì°(€€€±¥ÅÕ¥‘¥Ñå1…‰•°èÁ±…¸¹Í•ÑÕÀ¹Í•ÑÕÀ¹±¥ÅÕ¥‘¥Ñå1…‰•°ñð¹Õ±°°(€€€±¥ÅÕ¥‘¥ÑåA½½°èÁ±…¸¹Í•ÑÕÀ¹Í•ÑÕÀ¹±¥ÅÕ¥‘¥ÑåA½½°ñð¹Õ±°°(€€€É•…Ñ¥½¸èÁ±…¸¹Í•ÑÕÀ¹Í•ÑÕÀ¹É•…Ñ¥½¸ñð¹Õ±°°(€€€•¹ÑÉå5½‘•°èÁ±…¸¹Í•ÑÕÀ¹Í•ÑÕÀ¹•¹ÑÉå5½‘•°ñð¹Õ±°°(€€€…ÁQåÁ”èÁ±…¸¹Í•ÑÕÀ¹Í•ÑÕÀ¹…ÁQåÁ”ñð¹Õ±°°(€€€•¹ÑÉåQ¥µ•™É…µ”èÁ±…¸¹Í•ÑÕÀ¹Í•ÑÕÀ¹•¹ÑÉåQ¥µ•™É…µ”ñð¹Õ±°°(€€€‘É…Ý=¹1¥ÅÕ¥‘¥ÑäèÁ±…¸¹Í•ÑÕÀ¹Í•ÑÕÀ¹‘É…Ý=¹1¥ÅÕ¥‘¥Ñäñðmt°(€€€½¹ÑÉ…ÑÌèÉ•Á±…åI•ÍÕ±Ð¹½¹ÑÉ…ÑÌ°(€€€™¥±±•‘ÐèÉ•Á±…åI•ÍÕ±Ð¹™¥±±•‘Ð°(€€€•á¥ÑI•…Í½¸èÉ•Á±…åI•ÍÕ±Ð¹•á¥ÑI•…Í½¸°(€€€™¥¹…±á¥ÑAÉ¥”èÉ•Á±…åI•ÍÕ±Ð¹™¥¹…±á¥ÑAÉ¥”ñð¹Õ±°°(€€€É•…±¥é•‘A¹±UÍèÉ•Á±…åI•ÍÕ±Ð¹É•…±¥é•‘A¹±UÍ°(€€€É5Õ±Ñ¥Á±”èÉ•Á±…åI•ÍÕ±Ð¹É5Õ±Ñ¥Á±”°(€€€Ñ…É•ÑÍ!¥ÐèÉ•Á±…åI•ÍÕ±Ð¹Ñ…É•ÑÍ!¥Ð°(€€€µ™•A½¥¹ÑÌèÉ•Á±…åI•ÍÕ±Ð¹µ™•A½¥¹ÑÌ°(€€€µ…•A½¥¹ÑÌèÉ•Á±…åI•ÍÕ±Ð¹µ…•A½¥¹ÑÌ°(€€€µ™•UÍèÉ•Á±…åI•ÍÕ±Ð¹µ™•UÍ°(€€€µ…•UÍèÉ•Á±…åI•ÍÕ±Ð¹µ…•UÍ°(€€€…‘…ÁÑ¥Ù”èÁ±…¸¹…‘…ÁÑ¥Ù”ñð¹Õ±°°(€€€ÍÑÉ…Ñ•å…µ¥±äèÁ±…¸¹ÍÑÉ…Ñ•å…µ¥±äñð¹Õ±°°(€€€Í¥¹…±½¹Ñ•áÐèÁ±…¸¹Í¥¹…±½¹Ñ•áÐñð¹Õ±°°(€€€É•Í•…É¡½Õ¹¥°èÁ±…¸¹É•Í•…É¡½Õ¹¥°ñð¹Õ±°°(€€€ÍÑ…ÑÕÌèÉ•Á±…åI•ÍÕ±Ð¹ÍÑ…ÑÕÌ°(€€€É•…Ñ•‘Ðè¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤(€ôì)ô()™Õ¹Ñ¥½¸½µÁÕÑ•I•Á½ÉÐ¡ÍÑ…Ñ”°½¹™¥œ¤ì(€½¹ÍÐÑ½Ñ…±QÉ…‘•Ì€ôÍÑ…Ñ”¹ÑÉ…‘•Ì¹±•¹Ñ ì(€½¹ÍÐÝ¥¹Ì€ôÍÑ…Ñ”¹ÑÉ…‘•Ì¹™¥±Ñ•È ¡ÑÉ…‘”¤€ôøÑÉ…‘”¹É•…±¥é•‘A¹±UÍ€ø€À¤¹±•¹Ñ ì(€½¹ÍÐ±½ÍÍ•Ì€ôÍÑ…Ñ”¹ÑÉ…‘•Ì¹™¥±Ñ•È ¡ÑÉ…‘”¤€ôøÑÉ…‘”¹É•…±¥é•‘A¹±UÍ€ð€À¤¹±•¹Ñ ì(€½¹ÍÐÝ¥¹I…Ñ”€ôÑ½Ñ…±QÉ…‘•Ì€üÉ½Õ¹ ¡Ý¥¹Ì€¼Ñ½Ñ…±QÉ…‘•Ì¤€¨€ÄÀÀ°€Ä¤€è€Àì(€½¹ÍÐ…ÙH€ôÑ½Ñ…±QÉ…‘•Ì(€€€€üÉ½Õ¹¡ÍÑ…Ñ”¹ÑÉ…‘•Ì¹É•‘Õ” ¡ÍÕ´°ÑÉ…‘”¤€ôøÍÕ´€¬9Õµ‰•È¡ÑÉ…‘”¹É5Õ±Ñ¥Á±”ñð€À¤°€À¤€¼Ñ½Ñ…±QÉ…‘•Ì°€È¤(€€€€è€Àì(€½¹ÍÐ™±½½ÉUÍ€ô…½Õ¹Ñ±½½ÉUÍ¡½¹™¥œ¤ì(€½¹ÍÐ‘É…Ý‘½Ý¹I½½µUÍ€ôÉ•µ…¥¹¥¹É…Ý‘½Ý¹I½½µUÍ¡ÍÑ…Ñ”¹‰…±…¹•UÍ°½¹™¥œ¤ì((€É•ÑÕÉ¸ì(€€€‰…±…¹•UÍèÍÑ…Ñ”¹‰…±…¹•UÍ°(€€€É•…±¥é•‘A¹±UÍèÍÑ…Ñ”¹É•…±¥é•‘A¹±UÍ°(€€€Ñ½Ñ…±QÉ…‘•Ì°(€€€Ý¥¹Ì°(€€€±½ÍÍ•Ì°(€€€Ý¥¹I…Ñ”°(€€€…ÙH°(€€€™±½½ÉUÍ°(€€€‘É…Ý‘½Ý¹I½½µUÍ°(€€€µ…á…¥±å1½ÍÍUÍè½¹™¥œ¹µ…á…¥±å1½ÍÍUÍ°(€€€µ…áI¥Í­A•ÉQÉ…‘•UÍè½¹™¥œ¹µ…áI¥Í­A•ÉQÉ…‘•UÍ°(€€€±½­•è‘É…Ý‘½Ý¹I½½µUÍ€ðô€À°(€€€É••¹ÑQÉ…‘•ÌèÍÑ…Ñ”¹ÑÉ…‘•Ì¹Í±¥” ´ÄÀ¤(€ôì)ô()™Õ¹Ñ¥½¸ÁÉ¥¹ÑA±…¸¡Á±…¸¤ì(€½¹ÍÐ±¥¹•Ì€ômtì(€±¥¹•Ì¹ÁÕÍ ¡MÑÉ…Ñ•äè€‘íÁ±…¸¹ÍÑÉ…Ñ•åõ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡M•ÑÕÀè€‘íÁ±…¸¹Í•ÑÕÀ¹Í¥‘”¹Ñ½UÁÁ•É…Í” ¥ô€‘íÁ±…¸¹Í•ÑÕÀ¹Íåµ‰½±ôð€‘íÁ±…¸¹Í•ÑÕÀ¹Í•ÍÍ¥½¹ôð€‘íÁ±…¸¹Í•ÑÕÀ¹‘…Ñ•õ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡¹ÑÉä€‘íÁ±…¸¹Í•ÑÕÀ¹•¹ÑÉåôðMÑ½À€‘íÁ±…¸¹Í•ÑÕÀ¹ÍÑ½ÁôðQ¡•Í¥Ìè€‘íÁ±…¸¹Í•ÑÕÀ¹Ñ¡•Í¥Íõ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡5½‘•°è€‘íÁ±…¸¹¹…ÉÉ…Ñ¥Ù”¹…Ñ¥Ù…Ñ¥½¹Q¥µ•ôðµ…É¬€‘íÁ±…¸¹¹…ÉÉ…Ñ¥Ù”¹É•™•É•¹•M•ÍÍ¥½¹Ì¹©½¥¸ œ°€œ¥ô¡¥¡Ì½±½ÝÌð€‘íÁ±…¸¹¹…ÉÉ…Ñ¥Ù”¹É•…Ñ¥½¹ôÉ•…Ñ¥½¸½™˜€‘íÁ±…¸¹¹…ÉÉ…Ñ¥Ù”¹±¥ÅÕ¥‘¥ÑåA½½±ô€´ø€‘íÁ±…¸¹¹…ÉÉ…Ñ¥Ù”¹•¹ÑÉå5½‘•°¹Ñ½UÁÁ•É…Í” ¥ô½¸€‘íÁ±…¸¹¹…ÉÉ…Ñ¥Ù”¹•¹ÑÉåQ¥µ•™É…µ•ô€‘íÁ±…¸¹¹…ÉÉ…Ñ¥Ù”¹…ÁQåÁ”¹Ñ½UÁÁ•É…Í” ¥ôðÍÑ½Àè€‘íÁ±…¸¹¹…ÉÉ…Ñ¥Ù”¹ÍÑ½ÁA±…•µ•¹Ñôð‘É…Üè€‘íÁ±…¸¹¹…ÉÉ…Ñ¥Ù”¹‘É…Ý=¹1¥ÅÕ¥‘¥Ñä¹©½¥¸ œ°€œ¥õ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡½Õ¹Ðè€‘í™½Éµ…ÑUÍ¡Á±…¸¹Í¥é¥¹œ¹…½Õ¹Ñ	…±…¹•UÍ¥ôð±½½Èè€‘í™½Éµ…ÑUÍ¡Á±…¸¹Í¥é¥¹œ¹…½Õ¹Ñ±½½ÉUÍ¥ôðÉ…Ý‘½Ý¸É½½´è€‘í™½Éµ…ÑUÍ¡Á±…¸¹Í¥é¥¹œ¹É•µ…¥¹¥¹É…Ý‘½Ý¹I½½µUÍ¥õ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡I¥Í¬è€‘í™½Éµ…ÑA½¥¹ÑÌ¡Á±…¸¹Í¥é¥¹œ¹ÍÑ½Á¥ÍÑ…¹•A½¥¹ÑÌ¥ôð€‘íÁ±…¸¹Í¥é¥¹œ¹ÍÑ½Á¥ÍÑ…¹•Q¥­ÍôÑ¥­Ìð€‘í™½Éµ…ÑUÍ¡Á±…¸¹Í¥é¥¹œ¹Ñ½Ñ…±I¥Í­A•É½¹ÑÉ…ÑUÍ¥ô€¼½¹ÑÉ…Ñ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡M¥é”è€‘íÁ±…¸¹Í¥é¥¹œ¹µ…á½¹ÑÉ…ÑÍô½¹ÑÉ…ÑÌðÁ±…¹¹•É¥Í¬€‘í™½Éµ…ÑUÍ¡Á±…¸¹Í¥é¥¹œ¹…ÑÕ…±I¥Í­UÍ¥ôðÉ¥Í¬‰Õ‘•Ð€‘í™½Éµ…ÑUÍ¡Á±…¸¹Í¥é¥¹œ¹É¥Í­	Õ‘•ÑUÍ¥õ€¤ì(€±¥¹•Ì¹ÁÕÍ  Q…É•ÑÌèœ¤ì(€™½È€¡½¹ÍÐÑ…É•Ð½˜Á±…¸¹Ñ…É•ÑÌ¤ì(€€€±¥¹•Ì¹ÁÕÍ ¡€´€‘íÑ…É•Ð¹ÁÉ¥•ôð€‘íÑ…É•Ð¹É5Õ±Ñ¥Á±•õHð€‘íÑ…É•Ð¹É•Ý…É‘Q¥­ÍôÑ¥­ÌðÍ…±”€‘í5…Ñ ¹É½Õ¹¡Ñ…É•Ð¹±½Í•É…Ñ¥½¸€¨€ÄÀÀ¥ô•€¤ì(€ô(€É•ÑÕÉ¸±¥¹•Ì¹©½¥¸ q¸œ¤ì)ô()™Õ¹Ñ¥½¸ÁÉ¥¹ÑI•Á±…ä¡Á±…¸°É•Á±…åI•ÍÕ±Ð¤ì(€½¹ÍÐ±¥¹•Ì€ômtì(€±¥¹•Ì¹ÁÕÍ ¡I•Á±…äÉ•ÍÕ±Ðè€‘íÉ•Á±…åI•ÍÕ±Ð¹ÍÑ…ÑÕÍõ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡¥±±•…Ðè€‘íÉ•Á±…åI•ÍÕ±Ð¹™¥±±•‘Ðñð€¹½Ð™¥±±•õ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡á¥ÐÉ•…Í½¸è€‘íÉ•Á±…åI•ÍÕ±Ð¹•á¥ÑI•…Í½¹õ€¤ì(€¥˜€¡É•Á±…åI•ÍÕ±Ð¹™¥¹…±á¥ÑAÉ¥”€„ô¹Õ±°¤ì(€€€±¥¹•Ì¹ÁÕÍ ¡¥¹…°•á¥Ðè€‘íÉ•Á±…åI•ÍÕ±Ð¹™¥¹…±á¥ÑAÉ¥•õ€¤ì(€ô(€±¥¹•Ì¹ÁÕÍ ¡Q…É•ÑÌ¡¥Ðè€‘íÉ•Á±…åI•ÍÕ±Ð¹Ñ…É•ÑÍ!¥Ð¹±•¹Ñ €üÉ•Á±…åI•ÍÕ±Ð¹Ñ…É•ÑÍ!¥Ð¹©½¥¸ œ°€œ¤€è€¹½¹”õ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡½¹ÑÉ…ÑÌè€‘íÉ•Á±…åI•ÍÕ±Ð¹½¹ÑÉ…ÑÍõ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡I•…±¥é•A¹0è€‘í™½Éµ…ÑUÍ¡É•Á±…åI•ÍÕ±Ð¹É•…±¥é•‘A¹±UÍ¥õ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡HµÕ±Ñ¥Á±”è€‘íÉ•Á±…åI•ÍÕ±Ð¹É5Õ±Ñ¥Á±•õ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡A±…¹¹•É¥Í¬è€‘í™½Éµ…ÑUÍ¡Á±…¸¹Í¥é¥¹œ¹…ÑÕ…±I¥Í­UÍ¥õ€¤ì(€É•ÑÕÉ¸±¥¹•Ì¹©½¥¸ q¸œ¤ì)ô()™Õ¹Ñ¥½¸ÁÉ¥¹ÑI•Á½ÉÐ¡ÍÑ…Ñ”°½¹™¥œ¤ì(€½¹ÍÐÉ•Á½ÉÐ€ô½µÁÕÑ•I•Á½ÉÐ¡ÍÑ…Ñ”°½¹™¥œ¤ì(€½¹ÍÐ±¥¹•Ì€ômtì(€±¥¹•Ì¹ÁÕÍ ¡	…±…¹”è€‘í™½Éµ…ÑUÍ¡É•Á½ÉÐ¹‰…±…¹•UÍ¥ôðI•…±¥é•è€‘í™½Éµ…ÑUÍ¡É•Á½ÉÐ¹É•…±¥é•‘A¹±UÍ¥ôðQÉ…‘•Ìè€‘íÉ•Á½ÉÐ¹Ñ½Ñ…±QÉ…‘•Íõ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡½Õ¹Ðµ½‘•°èÍÑ…ÉÐ€‘í™½Éµ…ÑUÍ¡½¹™¥œ¹ÍÑ…ÉÑ¥¹	…±…¹•UÍ¥ôðµ…à‘É…Ý‘½Ý¸€‘í½¹™¥œ¹µ…á½Õ¹ÑÉ…Ý‘½Ý¹A•É•¹Ñô”ð™±½½È€‘í™½Éµ…ÑUÍ¡É•Á½ÉÐ¹™±½½ÉUÍ¥ôðÉ½½´±•™Ð€‘í™½Éµ…ÑUÍ¡É•Á½ÉÐ¹‘É…Ý‘½Ý¹I½½µUÍ¥õ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡]¥¸É…Ñ”è€‘íÉ•Á½ÉÐ¹Ý¥¹I…Ñ•ô”ð]¥¹Ìè€‘íÉ•Á½ÉÐ¹Ý¥¹Íôð1½ÍÍ•Ìè€‘íÉ•Á½ÉÐ¹±½ÍÍ•ÍôðÙœHè€‘íÉ•Á½ÉÐ¹…ÙIõ€¤ì(€±¥¹•Ì¹ÁÕÍ ¡…¥±äµ…à±½ÍÌÕ…Éè€‘í™½Éµ…ÑUÍ¡É•Á½ÉÐ¹µ…á…¥±å1½ÍÍUÍ¥ôðA•ÈµÑÉ…‘”É¥Í¬è€‘í™½Éµ…ÑUÍ¡É•Á½ÉÐ¹µ…áI¥Í­A•ÉQÉ…‘•UÍ¥õ€¤ì(€¥˜€¡É•Á½ÉÐ¹±½­•¤ì(€€€±¥¹•Ì¹ÁÕÍ  MÑ…ÑÕÌè‘É…Ý‘½Ý¸™±½½È‰É•…¡•°¹¼¹•ÜÑÉ…‘•ÌÍ¡½Õ±‰”Á±…¹¹•Õ¹Ñ¥°Ñ¡”…½Õ¹Ð¥ÌÉ•Í•Ð¸œ¤ì(€ô(€¥˜€ …É•Á½ÉÐ¹Ñ½Ñ…±QÉ…‘•Ì¤ì(€€€±¥¹•Ì¹ÁÕÍ  9¼©½ÕÉ¹…±•ÑÉ…‘•Ìå•Ð¸œ¤ì(€ô•±Í”ì(€€€±¥¹•Ì¹ÁÕÍ  I••¹ÐÑÉ…‘•Ìèœ¤ì(€€€™½È€¡½¹ÍÐÑÉ…‘”½˜É•Á½ÉÐ¹É••¹ÑQÉ…‘•Ì¤ì(€€€€€±¥¹•Ì¹ÁÕÍ ¡€´€‘íÑÉ…‘”¹‘…Ñ•ô€‘íÑÉ…‘”¹Íåµ‰½±ô€‘íÑÉ…‘”¹Í¥‘•ôð€‘íÑÉ…‘”¹Í•ÍÍ¥½¹ôðA¹0€‘í™½Éµ…ÑUÍ¡ÑÉ…‘”¹É•…±¥é•‘A¹±UÍ¥ôð€‘íÑÉ…‘”¹É5Õ±Ñ¥Á±•õHð€‘íÑÉ…‘”¹•á¥ÑI•…Í½¹õ€¤ì(€€€ô(€ô(€É•ÑÕÉ¸±¥¹•Ì¹©½¥¸ q¸œ¤ì)ô()µ½‘Õ±”¹•áÁ½ÉÑÌ€ôì(€…½Õ¹Ñ±½½ÉUÍ°(€‰Õ¥±‘QÉ…‘•A±…¸°(€½µÁÕÑ•I•Á½ÉÐ°(€É•…Ñ•µÁÑåMÑ…Ñ”°(€™½Éµ…ÑA½¥¹ÑÌ°(€™½Éµ…ÑUÍ°(€¡å‘É…Ñ•MÑ…Ñ”°(€±½…‘)Í½¸°(€¹½Éµ…±¥é•½¹™¥œ°(€¹½Éµ…±¥é•M•ÑÕÀ°(€Á…ÉÍ•ÍÙ¥±”°(€Á…ÉÍ•ÍÙQ•áÐ°(€ÁÉ¥¹ÑA±…¸°(€ÁÉ¥¹ÑI•Á±…ä°(€ÁÉ¥¹ÑI•Á½ÉÐ°(€É•Á±…åA±…¸°(€É•µ…¥¹¥¹É…Ý‘½Ý¹I½½µUÍ°(€Í…Ù•)Í½¸°(€ÑÉ…­QÉ…‘•1¥™•å±”°(€Ñ½)½ÕÉ¹…±QÉ…‘”°(€Ù…±¥‘…Ñ•M•ÑÕÀ)ôì(