const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config.json');
const core = require('../lib/trader-core.cjs');
const {
  completeBars,
  detectDmcMarketOpenSignal,
  timestampForWallClock
} = require('../lib/dmc-market-open.cjs');
const { checkpointsForDay } = require('../lib/backtest-engine.cjs');

function minuteHour(start, { open, high, low, close }) {
  const output = [];
  let previous = open;
  for (let minute = 0; minute < 60; minute += 1) {
    const next = open + ((close - open) * (minute + 1) / 60);
    output.push({
      timestamp: new Date(start + minute * 60_000).toISOString(),
      open: previous,
      high: Math.max(previous, next) + 0.1,
      low: Math.min(previous, next) - 0.1,
      close: next,
      volume: 100,
      instrumentId: 1
    });
    previous = next;
  }
  output[20].high = high;
  output[40].low = low;
  return output;
}

function dmcCandles() {
  const start = Date.parse('2026-02-02T18:00:00.000Z');
  const hourly = [];
  for (let index = 0; index < 20; index += 1) {
    let shape = { open: 106, high: 108, low: 104, close: 106.25 };
    if (index === 10) shape = { open: 112, high: 116, low: 111, close: 115 };
    if (index === 14) shape = { open: 101, high: 102, low: 99, close: 100 };
    if (index === 19) shape = { open: 100.5, high: 105, low: 97.75, close: 104.5 };
    hourly.push(...minuteHour(start + index * 3_600_000, shape));
  }
  const nineAm = [];
  let previous = 104;
  for (let minute = 0; minute < 30; minute += 1) {
    const close = 104 - ((minute + 1) / 30);
    nineAm.push({ timestamp: new Date(Date.parse('2026-02-03T14:00:00.000Z') + minute * 60_000).toISOString(),
      open: previous, high: Math.max(previous, close) + 0.15, low: Math.min(previous, close) - 0.15,
      close, volume: 100, instrumentId: 1 });
    previous = close;
  }
  const closes = [100.35, 100.45, 100.55, 100.65, 100.75];
  const confirmation = closes.map((close, index) => ({
    timestamp: new Date(Date.parse('2026-02-03T14:30:00.000Z') + index * 60_000).toISOString(),
    open: index ? closes[index - 1] : 100.25,
    high: index === 4 ? 100.75 : close + 0.05,
    low: index === 0 ? 100 : Math.min(closes[index - 1], close) - 0.05,
    close,
    volume: 140,
    instrumentId: 1
  }));
  return [...hourly, ...nineAm, ...confirmation];
}

test('DMC accepts a fresh hourly failure-to-lose only after a complete five-minute hold', () => {
  const candles = dmcCandles();
  const signal = detectDmcMarketOpenSignal(candles, config, { trades: [] });
  assert.equal(signal.found, true, signal.reason);
  assert.equal(signal.setup.side, 'long');
  assert.equal(signal.setup.entry, 100);
  assert.equal(signal.setup.stop, 97.5);
  assert.deepEqual(signal.setup.targets, [102.5, 108.75, 115]);
  assert.equal(signal.setup.signalAvailableAt, '2026-02-03T14:35:00.000Z');
  assert.equal(signal.setup.orderExpiresAt, '2026-02-03T15:30:00.000Z');
  assert.equal(signal.metadata.pattern, 'failure-to-lose');
  assert.equal(core.validateSetup(core.normalizeSetup(signal.setup, core.normalizeConfig(config)), core.normalizeConfig(config)).valid, true);
});

test('DMC fails closed on incomplete confirmation data and manual news blackouts', () => {
  const candles = dmcCandles();
  const missingMinute = candles.filter((candle) => candle.timestamp !== '2026-02-03T14:32:00.000Z');
  assert.match(detectDmcMarketOpenSignal(missingMinute, config, { trades: [] }).reason, /five-minute candle/);
  const blackedOut = structuredClone(config);
  blackedOut.live.dmcMarketOpen.blackoutDates = ['2026-02-03'];
  assert.match(detectDmcMarketOpenSignal(candles, blackedOut, { trades: [] }).reason, /blackout/);
});

test('DMC aggregation rejects duplicate or missing minutes and resolves New York expiry through DST', () => {
  const candles = dmcCandles().slice(0, 60);
  assert.equal(completeBars(candles, 60).length, 1);
  assert.equal(completeBars([...candles, candles[0]], 60).length, 0);
  assert.equal(completeBars(candles.slice(1), 60).length, 0);
  assert.equal(timestampForWallClock('2026-07-06', '10:30'), '2026-07-06T14:30:00.000Z');
});

test('DMC backtest checks only completed five-minute bars with time left before expiry', () => {
  const records = Array.from({ length: 70 }, (_, index) => ({ minute: 570 + index, candle: { timestamp: new Date(index * 60_000).toISOString() } }));
  assert.deepEqual(checkpointsForDay('nq-dmc-market-open', records).map((record) => record.minute), [574, 579, 584, 589, 594, 599, 604, 609, 614, 619, 624]);
});
