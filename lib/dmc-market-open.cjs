const TIME_ZONE = 'America/New_York';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function zonedParts(value) {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(value))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    minuteOfDay: (Number(parts.hour) * 60) + Number(parts.minute)
  };
}

function roundToTick(value, tickSize) {
  return Math.round(value / tickSize) * tickSize;
}

function timestampForWallClock(date, clock) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = clock.split(':').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(candidate);
    const represented = Date.UTC(
      ...parts.date.split('-').map(Number).map((value, index) => index === 1 ? value - 1 : value),
      parts.hour,
      parts.minute
    );
    candidate += desired - represented;
  }
  const verified = zonedParts(candidate);
  if (verified.date !== date || verified.hour !== hour || verified.minute !== minute) {
    throw new Error(`Could not resolve ${date} ${clock} ${TIME_ZONE}`);
  }
  return new Date(candidate).toISOString();
}

function completeBars(candles, intervalMinutes) {
  const groups = new Map();
  const samplesByTime = [];
  for (const raw of candles || []) {
    const time = Date.parse(raw.timestamp);
    if (!Number.isFinite(time)) continue;
    const candle = {
      timestamp: new Date(time).toISOString(),
      open: Number(raw.open),
      high: Number(raw.high),
      low: Number(raw.low),
      close: Number(raw.close),
      volume: Number(raw.volume || 0)
    };
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
    samplesByTime.push([time, candle]);
  }
  for (const [time, candle] of samplesByTime.sort(([left], [right]) => left - right)) {
    const parts = zonedParts(time);
    const bucketMinute = Math.floor(parts.minuteOfDay / intervalMinutes) * intervalMinutes;
    const key = `${parts.date}|${bucketMinute}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candle);
  }
  const bars = [];
  for (const [key, samples] of groups) {
    if (samples.length !== intervalMinutes) continue;
    const times = samples.map((sample) => Date.parse(sample.timestamp));
    if (times.some((time, index) => index > 0 && time - times[index - 1] !== 60_000)) continue;
    const [date, bucket] = key.split('|');
    bars.push({
      date,
      minute: Number(bucket),
      timestamp: samples[0].timestamp,
      endTimestamp: samples.at(-1).timestamp,
      open: samples[0].open,
      high: Math.max(...samples.map((sample) => sample.high)),
      low: Math.min(...samples.map((sample) => sample.low)),
      close: samples.at(-1).close,
      volume: samples.reduce((total, sample) => total + sample.volume, 0),
      samples: samples.length
    });
  }
  return bars.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function averageTrueRange(bars, period) {
  if (bars.length < period + 1) return 0;
  const ranges = [];
  for (let index = bars.length - period; index < bars.length; index += 1) {
    const bar = bars[index];
    const priorClose = bars[index - 1].close;
    ranges.push(Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - priorClose),
      Math.abs(bar.low - priorClose)
    ));
  }
  return ranges.reduce((total, value) => total + value, 0) / ranges.length;
}

function pivotLevels(hours, tickSize) {
  const levels = [];
  for (let index = 1; index < hours.length - 1; index += 1) {
    const previous = hours[index - 1];
    const pivot = hours[index];
    const next = hours[index + 1];
    const bodyHigh = Math.max(pivot.open, pivot.close);
    const bodyLow = Math.min(pivot.open, pivot.close);
    const previousHigh = Math.max(previous.open, previous.close);
    const nextHigh = Math.max(next.open, next.close);
    const previousLow = Math.min(previous.open, previous.close);
    const nextLow = Math.min(next.open, next.close);
    if (bodyHigh > previousHigh && bodyHigh > nextHigh) {
      levels.push({ kind: 'pivot-high', price: roundToTick(bodyHigh, tickSize), index, pivotAt: pivot.endTimestamp });
    }
    if (bodyLow < previousLow && bodyLow < nextLow) {
      levels.push({ kind: 'pivot-low', price: roundToTick(bodyLow, tickSize), index, pivotAt: pivot.endTimestamp });
    }
  }
  return levels;
}

function freshLevels(hours, tickSize) {
  return pivotLevels(hours, tickSize).filter((level) => {
    const intervening = hours.slice(level.index + 1);
    return !intervening.some((bar) => bar.low <= level.price && bar.high >= level.price);
  });
}

function classifyBias(bias, levels) {
  const candidates = [];
  for (const level of levels) {
    if (level.kind === 'pivot-low') {
      if (bias.low < level.price && bias.open >= level.price && bias.close > level.price) {
        candidates.push({ ...level, side: 'long', pattern: 'failure-to-lose' });
      } else if (bias.open >= level.price && bias.close < level.price) {
        candidates.push({ ...level, side: 'short', pattern: 'loss' });
      }
    } else if (bias.high > level.price && bias.open <= level.price && bias.close < level.price) {
      candidates.push({ ...level, side: 'short', pattern: 'failure-to-gain' });
    } else if (bias.open <= level.price && bias.close > level.price) {
      candidates.push({ ...level, side: 'long', pattern: 'gain' });
    }
  }
  const directions = new Set(candidates.map((candidate) => candidate.side));
  if (directions.size !== 1) return { candidate: null, conflict: directions.size > 1 };
  candidates.sort((left, right) => (
    Math.abs(bias.close - left.price) - Math.abs(bias.close - right.price)
    || right.index - left.index
  ));
  return { candidate: candidates[0] || null, conflict: false };
}

function confirmationQuality(bar, side, level, rules) {
  const range = bar.high - bar.low;
  if (!(range > 0) || bar.low > level || bar.high < level) return false;
  const body = Math.abs(bar.close - bar.open);
  const adverseWick = side === 'long'
    ? Math.min(bar.open, bar.close) - bar.low
    : bar.high - Math.max(bar.open, bar.close);
  return body / range >= rules.minimumFiveMinuteBodyFraction
    && adverseWick / range <= rules.maximumFiveMinuteAdverseWickFraction
    && (side === 'long'
      ? bar.close > level && bar.close > bar.open
      : bar.close < level && bar.close < bar.open);
}

function structuralTarget(side, entry, levels, hours) {
  const levelTargets = levels
    .filter((level) => side === 'long'
      ? level.kind === 'pivot-high' && level.price > entry
      : level.kind === 'pivot-low' && level.price < entry)
    .map((level) => level.price)
    .sort((left, right) => side === 'long' ? left - right : right - left);
  if (levelTargets.length) return { price: levelTargets[0], source: 'fresh-hourly-body-level' };
  const swing = side === 'long'
    ? Math.max(...hours.map((bar) => bar.high))
    : Math.min(...hours.map((bar) => bar.low));
  if (side === 'long' ? swing > entry : swing < entry) return { price: swing, source: 'recent-hourly-swing' };
  return null;
}

function rulesFromConfig(rawConfig) {
  const configured = rawConfig.live?.dmcMarketOpen || {};
  return {
    requiredHourlyBars: Number(configured.requiredHourlyBars || 18),
    maximumHourlyBars: Number(configured.maximumHourlyBars || 24),
    hourlyAtrPeriod: Number(configured.hourlyAtrPeriod || 14),
    minimumBiasAtrRatio: Number(configured.minimumBiasAtrRatio ?? 0.35),
    maximumBiasAtrRatio: Number(configured.maximumBiasAtrRatio || 2),
    maximumBiasWickFraction: Number(configured.maximumBiasWickFraction ?? 0.5),
    minimumFiveMinuteBodyFraction: Number(configured.minimumFiveMinuteBodyFraction ?? 0.5),
    maximumFiveMinuteAdverseWickFraction: Number(configured.maximumFiveMinuteAdverseWickFraction ?? 0.35),
    fiveMinuteAtrPeriod: Number(configured.fiveMinuteAtrPeriod || 14),
    maximumEntryDistanceAtr: Number(configured.maximumEntryDistanceAtr || 2),
    minimumStopPoints: Number(configured.minimumStopPoints || 2),
    maximumStopPoints: Number(configured.maximumStopPoints || 22),
    minimumRewardRisk: Number(configured.minimumRewardRisk || 1.5),
    rangeLockBars: Number(configured.rangeLockBars || 3),
    rangeLockConfirmations: Number(configured.rangeLockConfirmations || 2),
    rangeLockAtrFraction: Number(configured.rangeLockAtrFraction || 0.2),
    blackoutDates: Array.isArray(configured.blackoutDates) ? configured.blackoutDates.map(String) : []
  };
}

function detectDmcMarketOpenSignal(candles, rawConfig, state = { trades: [] }) {
  const latest = candles?.at(-1);
  if (!latest) return { found: false, reason: 'DMC needs one-minute candles' };
  const latestParts = zonedParts(latest.timestamp);
  const tradingDate = latestParts.date;
  const rules = rulesFromConfig(rawConfig);
  if (rules.blackoutDates.includes(tradingDate)) {
    return { found: false, reason: `DMC manual news blackout for ${tradingDate}`, metadata: { tradingDate } };
  }
  if ((state.trades || []).some((trade) => trade.date === tradingDate)) {
    return { found: false, reason: `DMC daily trade cap already reached for ${tradingDate}`, metadata: { tradingDate } };
  }
  if (latestParts.minuteOfDay < 574 || latestParts.minuteOfDay > 624) {
    return { found: false, reason: 'DMC waits for completed five-minute confirmations from 09:34 through 10:24 New York', metadata: { tradingDate } };
  }

  const hourly = completeBars(candles, 60)
    .filter((bar) => bar.date < tradingDate || (bar.date === tradingDate && bar.minute < 570))
    .slice(-rules.maximumHourlyBars);
  if (hourly.length < rules.requiredHourlyBars) {
    return { found: false, reason: `DMC needs ${rules.requiredHourlyBars} complete hourly candles; found ${hourly.length}`, metadata: { tradingDate } };
  }
  const bias = hourly.at(-1);
  const priorHours = hourly.slice(0, -1);
  const hourlyAtr = averageTrueRange(priorHours, rules.hourlyAtrPeriod);
  const biasRange = bias.high - bias.low;
  const biasBody = Math.abs(bias.close - bias.open);
  const biasAtrRatio = hourlyAtr > 0 ? biasRange / hourlyAtr : 0;
  if (!(hourlyAtr > 0) || biasAtrRatio < rules.minimumBiasAtrRatio || biasAtrRatio > rules.maximumBiasAtrRatio) {
    return { found: false, reason: 'DMC pre-open hour failed the 0.35–2.0 ATR range gate', metadata: { tradingDate, biasAtrRatio } };
  }
  if ((biasRange - biasBody) / biasRange > rules.maximumBiasWickFraction) {
    return { found: false, reason: 'DMC pre-open hour is wick-heavy', metadata: { tradingDate } };
  }

  const levels = freshLevels(priorHours, rawConfig.tickSize);
  if (!levels.length) return { found: false, reason: 'DMC found no fresh hourly candle-body pivot level', metadata: { tradingDate } };
  const classified = classifyBias(bias, levels);
  if (classified.conflict) return { found: false, reason: 'DMC hourly bias conflicts in both directions', metadata: { tradingDate } };
  const candidate = classified.candidate;
  if (!candidate) return { found: false, reason: 'DMC pre-open hour did not clearly gain, lose, or fail a fresh level', metadata: { tradingDate } };

  const fiveMinute = completeBars(candles, 5);
  const cashBars = fiveMinute.filter((bar) => bar.date === tradingDate && bar.minute >= 570 && bar.minute <= 620);
  const confirmation = cashBars.at(-1);
  if (!confirmation || !confirmationQuality(confirmation, candidate.side, candidate.price, rules)) {
    return { found: false, reason: 'DMC five-minute candle did not touch, hold, and meet body/wick quality', metadata: { tradingDate, level: candidate.price } };
  }
  const earlierFiveMinute = fiveMinute.filter((bar) => Date.parse(bar.timestamp) < Date.parse(confirmation.timestamp));
  const fiveMinuteAtr = averageTrueRange(earlierFiveMinute, rules.fiveMinuteAtrPeriod);
  if (!(fiveMinuteAtr > 0) || Math.abs(confirmation.close - candidate.price) > fiveMinuteAtr * rules.maximumEntryDistanceAtr) {
    return { found: false, reason: 'DMC confirmation closed more than two five-minute ATR from entry', metadata: { tradingDate, level: candidate.price, fiveMinuteAtr } };
  }
  const compressionTolerance = Math.max(rawConfig.tickSize * 2, fiveMinuteAtr * rules.rangeLockAtrFraction);
  const lockedBars = cashBars.slice(0, -1).slice(-rules.rangeLockBars).filter((bar) => (
    bar.low < candidate.price
    && bar.high > candidate.price
    && Math.abs(bar.close - candidate.price) <= compressionTolerance
  ));
  if (lockedBars.length >= rules.rangeLockConfirmations) {
    return { found: false, reason: 'DMC range lock: prior five-minute bars wicked both sides and compressed at the level', metadata: { tradingDate, level: candidate.price } };
  }

  const entry = candidate.price;
  const stop = roundToTick(candidate.side === 'long'
    ? bias.low - rawConfig.tickSize
    : bias.high + rawConfig.tickSize, rawConfig.tickSize);
  const risk = Math.abs(entry - stop);
  if (risk < rules.minimumStopPoints || risk > rules.maximumStopPoints) {
    return { found: false, reason: `DMC structural stop ${risk} points is outside the ${rules.minimumStopPoints}–${rules.maximumStopPoints} point band`, metadata: { tradingDate, level: entry } };
  }
  const target = structuralTarget(candidate.side, entry, levels, priorHours);
  if (!target || Math.abs(target.price - entry) / risk < rules.minimumRewardRisk) {
    return { found: false, reason: 'DMC next structural target offers less than 1.5R', metadata: { tradingDate, level: entry } };
  }
  const oneR = candidate.side === 'long' ? entry + risk : entry - risk;
  const midpoint = (oneR + target.price) / 2;
  const targets = [oneR, midpoint, target.price]
    .map((price) => roundToTick(price, rawConfig.tickSize))
    .filter((price, index, list) => (
      (candidate.side === 'long' ? price > entry : price < entry)
      && list.indexOf(price) === index
    ));
  const signalAvailableAt = new Date(Date.parse(confirmation.endTimestamp) + 60_000).toISOString();
  return {
    found: true,
    setup: {
      symbol: rawConfig.symbol,
      date: tradingDate,
      session: 'Nasdaq Market Open',
      side: candidate.side,
      execution: 'limit-touch',
      entry,
      stop,
      targets,
      signalAvailableAt,
      orderExpiresAt: timestampForWallClock(tradingDate, '10:30'),
      thesis: `Paper DMC ${candidate.pattern}: the final completed pre-open hour interacted with a fresh ${candidate.kind} candle-body level, followed by a completed five-minute hold.`,
      setup: {
        liquiditySweep: candidate.pattern.startsWith('failure'),
        reaction: candidate.side === 'long' ? 'bullish' : 'bearish',
        marketStructureShift: false,
        displacement: candidate.pattern === 'gain' || candidate.pattern === 'loss',
        entryModel: 'dmc-market-open',
        gapType: 'candle-body-level',
        entryTimeframe: 'M5',
        activationTime: '09:30–10:30 America/New_York',
        referenceSessions: ['final-complete-pre-open-hour', 'hourly-body-pivots'],
        stopPlacement: candidate.side === 'long' ? 'swing-low' : 'swing-high',
        higherTimeframeBias: candidate.side === 'long' ? 'bullish' : 'bearish',
        liquidityPool: candidate.kind,
        liquidityLabel: `Fresh hourly ${candidate.kind} body level`,
        drawOnLiquidity: [target.source]
      }
    },
    sweepTimestamp: bias.endTimestamp,
    triggerTimestamp: confirmation.endTimestamp,
    sessionRanges: { asia: bias, london: bias },
    rangeSummary: [{ label: 'Final pre-open hour', ...bias }],
    metadata: {
      tradingDate,
      pattern: candidate.pattern,
      levelKind: candidate.kind,
      level: entry,
      pivotAt: candidate.pivotAt,
      hourlyAtr: Math.round(hourlyAtr * 100) / 100,
      biasAtrRatio: Math.round(biasAtrRatio * 100) / 100,
      fiveMinuteAtr: Math.round(fiveMinuteAtr * 100) / 100,
      stopDistancePoints: risk,
      structuralTarget: target.price,
      structuralTargetSource: target.source,
      rewardRisk: Math.round((Math.abs(target.price - entry) / risk) * 100) / 100
    }
  };
}

module.exports = {
  averageTrueRange,
  classifyBias,
  completeBars,
  detectDmcMarketOpenSignal,
  freshLevels,
  pivotLevels,
  rulesFromConfig,
  timestampForWallClock
};
