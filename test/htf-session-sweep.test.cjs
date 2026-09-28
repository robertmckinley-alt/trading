const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config.json');
const { detectHtfSessionSweepSignal } = require('../lib/live-trader.cjs');
const { checkpointsForDay } = require('../lib/backtest-engine.cjs');

function candle(timestamp, open, close, overrides = {}) {
  return { timestamp, open, high: Math.max(open, close) + 0.25, low: Math.min(open, close) - 0.25, close, volume: 100, instrumentId: 1, ...overrides };
}

function session(start, count, open, close) {
  const candles = [];
  let previous = open;
  for (let index = 0; index < count; index += 1) {
    const next = open + ((close - open) * (index + 1) / count);
    candles.push(candle(new Date(start + index * 60_000).toISOString(), previous, next));
    previous = next;
  }
  return candles;
}

function validLongSetup() {
  const asia = session(Date.parse('2026-02-03T01:00:00Z'), 360, 100, 101);
  asia[100].high = 110;
  const london = session(Date.parse('2026-02-03T07:00:00Z'), 360, 101, 104);
  london[30].low = 98.5;
  const rejection = [99.25, 99.75, 100.25, 100.75, 101.25].map((close, index) => candle(
    new Date(Date.parse('2026-02-03T13:00:00Z') + index * 60_000).toISOString(),
    index ? [99.25, 99.75, 100.25, 100.75][index - 1] : 99,
    close,
    index === 0 ? { low: 98.75 } : {}
  ));
  const bos = candle('2026-02-03T13:05:00.000Z', 101.25, 104.5, { high: 104.75, low: 101 });
  return [...asia, ...london, ...rejection, bos];
}

test('HTF session sweep requires one-sided London raid, hourly alignment, 5M rejection and fresh 1M BOS', () => {
  const signal = detectHtfSessionSweepSignal(validLongSetup(), config, { trades: [] });
  assert.equal(signal.found, true, signal.reason);
  assert.equal(signal.setup.side, 'long');
  assert.equal(signal.triggerTimestamp, '2026-02-03T13:05:00.000Z');
  assert.equal(signal.setup.execution, 'next-bar-market');
  assert.equal(signal.metadata.sweptLow, true);
  assert.equal(signal.metadata.sweptHigh, false);
});

test('HTF session sweep rejects two-sided London manipulation', () => {
  const candles = validLongSetup();
  candles[400].high = 111;
  const signal = detectHtfSessionSweepSignal(candles, config, { trades: [] });
  assert.equal(signal.found, false);
  assert.match(signal.reason, /both sides/);
});

test('HTF session sweep backtest evaluates every minute in its entry window', () => {
  const records = Array.from({ length: 240 }, (_, index) => ({ minute: 450 + index, candle: { timestamp: new Date(index * 60_000).toISOString() } }));
  const checkpoints = checkpointsForDay('nq-htf-session-sweep', records).map(record => record.minute);
  assert.equal(checkpoints[0], 480);
  assert.equal(checkpoints.at(-1), 689);
  assert.equal(checkpoints.length, 210);
});

test('a newer rejection does not hide a fresh break of an earlier confirmation', () => {
  const input = validLongSetup().slice(0, -1);
  for (let i = 0; i < 5; i++) input.push(candle(new Date(Date.parse('2026-02-03T13:05:00Z') + i * 60000).toISOString(), 99 + i * .4, 99.4 + i * .4, i === 2 ? { high: 105 } : {}));
  input.push(candle('2026-02-03T13:10:00.000Z',101,102));
  const s = detectHtfSessionSweepSignal(input, { ...config, live: { ...config.live, htfSessionSweep: { minimumConfirmationBodyFraction: .1 } } }, { trades: [] });
  assert.equal(s.found, true, s.reason);
  assert.equal(s.metadata.confirmationAt, '2026-02-03T13:04:00.000Z');
});

test('a confirmation outside both Asia boundaries is not a return inside value', () => {
  const input = validLongSetup();
  for (const c of input.slice(-6)) { c.open += 20; c.close += 20; c.high += 20; c.low += 20; }
  const s = detectHtfSessionSweepSignal(input, config, { trades: [] });
  assert.equal(s.found, false);
  assert.match(s.reason, /back inside/);
});
