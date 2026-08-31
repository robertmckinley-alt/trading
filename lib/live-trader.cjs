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

function detectSignalFromCandles(candles, rawConfig, state) {
  if (rawConfig.strategySlug === 'hourly-sweep-ifvg-bos') {
    return detectHourlySweepIfvgBosSignal(candles, rawConfig, state);
  }
  return detectNineAmSignalFromCandles(candles, rawConfig, state);
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
      adaptive: baseState.live?.adaptive || null
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
  return [
    `Signal: ${side} ${signal.setup.symbol} ${signal.setup.date}`,
    `Entry ${signal.setup.entry} | Stop ${signal.setup.stop} | Targets ${signal.setup.targets.join(', ')}`,
    `Asia: H ${ranges.asia.high} / L ${ranges.asia.low}`,
    `London: H ${ranges.london.high} / L ${ranges.london.low}`,
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
  buildPlanFromSignal,
  detectSignalFromCandles,
  fetchLiveCandles,
  formatOpenTradeSummary,
  formatSignalSummary,
  loadLiveState,
  normalizeStrategyConfig,
  saveLiveState,
  signalKey,
  trackTradeLifecycle
};
