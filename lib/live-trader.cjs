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
    maxTradesPerDay: Number(live.maxTradesPerDay || 1)
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
    return { found: false, reason: `Daily trade cap already reached for ${tradingDate}` };
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

  const tradesToday = (state.trades || []).filter((trade) => trade.date === tradingDate).length;
  if (tradesToday >= liveConfig.maxTradesPerDay) {
    return { found: false, reason: `Daily trade cap already reached for ${tradingDate}` };
  }

  const activationCandles = candles.filter((candle) => {
    const parts = getZonedParts(candle.timestamp, activation.timeZone);
    return parts.date === tradingDate && ((parts.hour * 60) + parts.minute) >= activation.minuteOfDay;
  });
  if (activationCandles.length < 3) {
    return { found: false, reason: 'Need at least 3 post-activation candles to detect the FVG reversal' };
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
          signalSide: 'short'
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
          signalSide: 'long'
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
      sessionLow
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

function detectSignalFromCandles(candles, rawConfig, state) {
  const detectors = {
    'live-9am-sweep': detectNineAmSignalFromCandles,
    'hourly-sweep-ifvg-bos': detectHourlySweepIfvgBosSignal,
    'nq-opening-range-breakout': detectOpeningRangeBreakoutSignal,
    'ema-20-60-momentum': detectEmaMomentumSignal,
    'volume-poc-reversion': detectVolumePocReversionSignal
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
      portfolioRisk: baseState.live?.portfolioRisk || null
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
  return buildTradePlan(normalizeSetup(signal.setup, rawConfig), rawConfig, state);
}

module.exports = {
  aggregateCandles,
  averageTrueRange,
  buildPlanFromSignal,
  detectEmaMomentumSignal,
  detectOpeningRangeBreakoutSignal,
  detectSignalFromCandles,
  detectVolumePocReversionSignal,
  fetchLiveCandles,
  formatOpenTradeSummary,
  formatSignalSummary,
  loadLiveState,
  normalizeStrategyConfig,
  saveLiveState,
  signalKey,
  trackTradeLifecycle
};
