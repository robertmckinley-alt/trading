// Independent paper adaptations with a versioned collection profile. Not Hunter's bot code.
const { completeBars, pivotLevels, averageTrueRange, timestampForWallClock } = require('./dmc-market-open.cjs');
const { session } = require('./orb-session.cjs');

const SLUGS = ['nq-dmc-failed-level-reversal', 'nq-dmc-gain-retest'];
const VERSION = 'dmc-hourly-levels-m15-v1';
const collection = require('./paper-collection.cjs');
const clock = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function parts(timestamp) {
  const p = Object.fromEntries(clock.formatToParts(new Date(timestamp)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
const tickRound = (price, tick) => Math.round(price / tick) * tick;
const reject = reason => ({ found: false, reason: `DMC paper: ${reason}` });

function usableCandles(candles) {
  let previous = -Infinity;
  for (const c of candles || []) {
    const time = Date.parse(c.timestamp);
    if (!Number.isFinite(time) || time <= previous || ![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)
      || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close) || c.low > c.high || c.volume < 0) return false;
    previous = time;
  }
  return previous > -Infinity;
}

function freshBefore(hours, candles, before, tick, maxPriorTests = null) {
  if (maxPriorTests !== null) {
    // A pivot is not known until its right-hand H1 candle has completed.
    // Count distinct completed M15 touch episodes AFTER that confirmation.
    const bars = completeBars(candles, 15).filter(b => Date.parse(b.endTimestamp) + 60000 <= before);
    return pivotLevels(hours, tick).filter(level => {
      const knownAt = Date.parse(hours[level.index + 1].endTimestamp) + 60000;
      let tests = 0, touching = false;
      for (const b of bars) {
        if (Date.parse(b.timestamp) < knownAt) continue;
        const touch = b.low <= level.price && b.high >= level.price;
        if (touch && !touching) tests++;
        touching = touch;
      }
      return tests <= maxPriorTests;
    });
  }
  return pivotLevels(hours, tick).filter(level => !candles.some(c =>
    Date.parse(c.timestamp) > Date.parse(level.pivotAt) && Date.parse(c.timestamp) < before
    && c.low <= level.price && c.high >= level.price));
}

function candidateSignals(mode, trigger, prior, levels, tick) {
  const result = [];
  for (const level of levels) {
    const p = level.price;
    if (mode === 'failure') {
      if (level.kind === 'pivot-low' && trigger.open >= p && trigger.low <= p - tick && trigger.close >= p + tick) result.push({ ...level, side: 'long', pattern: 'failure-to-lose' });
      if (level.kind === 'pivot-high' && trigger.open <= p && trigger.high >= p + tick && trigger.close <= p - tick) result.push({ ...level, side: 'short', pattern: 'failure-to-gain' });
    } else {
      if (level.kind === 'pivot-high' && prior.close <= p && trigger.open <= p && trigger.close >= p + tick) result.push({ ...level, side: 'long', pattern: 'gain' });
      if (level.kind === 'pivot-low' && prior.close >= p && trigger.open >= p && trigger.close <= p - tick) result.push({ ...level, side: 'short', pattern: 'loss' });
    }
  }
  return result;
}

function hourlyDirection(hours) {
  const [prior, last] = hours.slice(-2);
  if (!prior || !last || Date.parse(last.timestamp) - Date.parse(prior.timestamp) !== 3600000) return 'neutral';
  if (last.close > last.open && last.close > prior.close && prior.close > prior.open) return 'long';
  if (last.close < last.open && last.close < prior.close && prior.close < prior.open) return 'short';
  return 'neutral';
}

function detect(candles, config, state = { trades: [] }) {
  const slug = config.detectorStrategySlug || config.strategySlug;
  if (!SLUGS.includes(slug)) return reject('unknown level-bot variant');
  if (!usableCandles(candles)) return reject('missing, duplicate, unsorted, or invalid OHLCV candles');
  const last = candles.at(-1);
  const { date, minute } = parts(last.timestamp);
  const policy = session(date);
  const collecting = collection.active(config);
  const lastSignalMinute = collecting ? Math.min(929, policy.closeMinute - 31) : 674;
  const cutoff = collecting ? (policy.closeMinute === 780 ? '12:45' : '15:45') : '11:30';
  if (!policy.known || !policy.open) return reject(policy.reason);
  // Latest raw candle is a completed one-minute bar; 09:44 is available at 09:45.
  const timeframe = collecting ? 5 : 15;
  if (minute < 584 || minute > lastSignalMinute || minute % timeframe !== timeframe - 1) return reject(collecting ? 'wait for a fresh completed M5 candle, 09:45–15:30 New York (early-close cutoff applies)' : 'wait for a fresh completed M15 candle, 09:45–11:15 New York');
  if ((config.live?.dmcMarketOpen?.blackoutDates || []).includes(date)) return reject(`manual news blackout ${date}`);
  if ((state.trades || []).some(trade => trade.date === date)) return reject('one filled trade per account per New York day');
  const bars = completeBars(candles, timeframe);
  const trigger = bars.at(-1);
  const prior = bars.at(-2);
  if (!trigger || Date.parse(trigger.endTimestamp) !== Date.parse(last.timestamp) || !prior
    || Date.parse(trigger.timestamp) - Date.parse(prior.timestamp) !== timeframe * 60000) return reject(`M${timeframe} confirmation or preceding bar is incomplete`);
  if (!(trigger.volume > 0)) return reject('confirmation volume is missing or zero');
  const triggerStart = Date.parse(trigger.timestamp);
  const hours = completeBars(candles, 60).filter(h => Date.parse(h.endTimestamp) < triggerStart).slice(collecting ? -48 : -24);
  if (hours.length < 18) return reject(`need 18 complete prior H1 bars; found ${hours.length}`);
  if (Date.parse(hours.at(-1).endTimestamp) < triggerStart - 61 * 60000) return reject('latest hourly context is stale or incomplete');
  const atr = averageTrueRange(bars.slice(0, -1), 14);
  const range = trigger.high - trigger.low;
  if (!(atr > 0) || range < 0.35 * atr || range > 2 * atr) return reject(`M${timeframe} range outside the frozen 0.35–2 ATR band`);
  const tick = Number(config.tickSize);
  if (!(tick > 0) || !(config.tickValueUsd > 0)) return reject('instrument tick specification missing');
  const levels = freshBefore(hours, candles, triggerStart, tick, collecting ? 1 : null);
  const mode = slug === SLUGS[0] ? 'failure' : 'progression';
  const candidates = candidateSignals(mode, trigger, prior, levels, tick);
  if (new Set(candidates.map(c => c.side)).size > 1) return reject('both directions triggered; range lock');
  candidates.sort((a, b) => Math.abs(trigger.close - a.price) - Math.abs(trigger.close - b.price) || b.index - a.index);
  const candidate = candidates[0];
  if (!candidate) return reject(collecting ? 'no confirmed M5 failure or gain at an eligible H1 body pivot' : 'no confirmed first-test failure or gain of a fresh hourly body pivot');
  const direction = collecting ? (hours.at(-1).close > hours.at(-1).open ? 'long' : hours.at(-1).close < hours.at(-1).open ? 'short' : 'neutral') : hourlyDirection(hours);
  if (mode === 'progression' ? direction !== candidate.side : direction !== 'neutral' && direction !== candidate.side) return reject('completed hourly direction does not support this variant');
  if (mode === 'progression' && Math.abs(trigger.close - trigger.open) / range < 0.5) return reject('gain candle body is below half its range');
  if (Math.abs(trigger.close - candidate.price) > atr) return reject(`entry more than one M${timeframe} ATR behind price`);
  const side = candidate.side;
  const entry = candidate.price;
  const stop = tickRound(side === 'long' ? trigger.low - tick : trigger.high + tick, tick);
  const risk = side === 'long' ? entry - stop : stop - entry;
  if (risk < 2 || risk > 22) return reject('structural stop outside the frozen 2–22 point band');
  const opposingLevels = levels.filter(l => side === 'long' ? l.price > entry && l.kind === 'pivot-high' : l.price < entry && l.kind === 'pivot-low')
    .filter(l => !(trigger.low <= l.price && trigger.high >= l.price))
    .sort((a, b) => side === 'long' ? a.price - b.price : b.price - a.price);
  const swingTarget = side === 'long' ? Math.max(...hours.map(h => h.high)) : Math.min(...hours.map(h => h.low));
  const target = opposingLevels[0]?.price ?? (collecting && (side === 'long' ? swingTarget > entry : swingTarget < entry) ? swingTarget : undefined);
  if (!Number.isFinite(target)) return reject('no untouched opposing hourly structural target');
  const pointValue = config.tickValueUsd / tick;
  // Costs match limit-touch engine: configured commission plus exit slippage.
  const cost = Number(config.commissionPerContractUsd || 0) + Number(config.slippageTicks || 0) * config.tickValueUsd;
  const reward = Math.abs(target - entry) * pointValue - cost;
  const loss = risk * pointValue + cost;
  const rewardRisk = reward / loss;
  if (!Number.isFinite(rewardRisk) || rewardRisk < 1.5) return reject('nearest structural target offers less than 1.5R after modeled costs');
  const available = Date.parse(trigger.endTimestamp) + 60000;
  const expires = Math.min(available + 15 * 60000, Date.parse(timestampForWallClock(date, cutoff)));
  return {
    found: true, triggerTimestamp: trigger.endTimestamp, sweepTimestamp: trigger.endTimestamp,
    sessionRanges: {}, rangeSummary: [],
    setup: {
      symbol: config.symbol, date, session: 'DMC level-to-level paper', side,
      execution: 'limit-touch', entry, stop, targets: [target], exitAllAtTarget: true,
      signalAvailableAt: new Date(available).toISOString(), orderExpiresAt: new Date(expires).toISOString(),
      flattenAt: timestampForWallClock(date, policy.closeMinute === 780 ? '12:59' : '15:59'),
      thesis: `Independent DMC paper ${candidate.pattern}: completed M${timeframe} confirmation at a ${collecting ? 'confirmed H1 pivot with at most one prior M15 touch episode' : 'first-test H1 candle-body pivot'}, with a bounded retest order and an observed structural target.`,
      setup: { entryModel: 'dmc-level-to-level', entryTimeframe: `M${timeframe}`, gapType: 'candle-body-level',
        reaction: side === 'long' ? 'bullish' : 'bearish', liquiditySweep: mode === 'failure',
        activationTime: collecting ? '09:45–15:45 America/New_York (early-close cutoff applies)' : '09:45–11:30 America/New_York', referenceSessions: ['completed-hourly-body-pivots', `completed-M${timeframe}`],
        stopPlacement: side === 'long' ? 'swing-low' : 'swing-high', liquidityPool: candidate.kind,
        liquidityLabel: `${collecting ? 'Confirmed' : 'First-test'} H1 ${candidate.kind}`, drawOnLiquidity: ['nearest-fresh-hourly-body-level'] }
    },
    metadata: { rulesVersion: collecting ? collection.VERSION : VERSION, tradingDate: date, pattern: candidate.pattern, level: entry,
      pivotAt: candidate.pivotAt, hourlyDirection: direction, atr, confirmationVolume: trigger.volume,
      structuralTarget: target, stopDistancePoints: risk, modeledLossPerContractUsd: loss,
      rewardRisk, newsPolicy: 'manual-blackout-only; automatic economic calendar not connected' }
  };
}

module.exports = { SLUGS, VERSION, candidateSignals, detect, freshBefore, hourlyDirection, usableCandles };
