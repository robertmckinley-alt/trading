const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = require('../lib/trader-core.cjs');
const { detectOpeningRangeCloseSignal, prepareOrbResearchContext } = require('../lib/live-trader.cjs');
const { STRATEGIES, BACKTEST_STRATEGIES, ORB_FILTER_VARIANTS } = require('../lib/strategy-registry.cjs');
const config = core.normalizeConfig(core.loadJson(path.join(__dirname, '..', 'config.json')));
const baseline = 'nq-15m-orb-close-confirmation';
function session(date, count = 390, confirmationVolume = 100) {
  const start = Date.parse(`${date}T14:30:00.000Z`);
  return Array.from({ length: count }, (_, minute) => ({
    timestamp: new Date(start + minute * 60_000).toISOString(),
    open: 10_000, high: minute < 15 ? 10_010 : 10_100,
    low: minute < 15 ? 9_990 : 9_900, close: 10_000,
    volume: minute >= 15 && minute < 30 ? confirmationVolume : 100
  }));
}
function triggerSession(date = '2026-02-02') {
  const bars = session(date, 30, 140);
  for (let minute = 15; minute < 30; minute += 1) {
    const index = minute - 15;
    Object.assign(bars[minute], {
      open: 10_004 + index * 0.6, high: 10_006 + index * 0.8,
      low: 10_003 + index * 0.6, close: 10_005 + index * 0.75
    });
  }
  return bars;
}
function history(count = 20) {
  const days = [];
  for (let date = new Date('2026-01-02T00:00:00Z'); days.length < count; date.setUTCDate(date.getUTCDate() + 1)) {
    if (date.getUTCDay() > 0 && date.getUTCDay() < 6) days.push(date.toISOString().slice(0, 10));
  }
  return days.flatMap((date) => session(date));
}
function signal(candles, slug = baseline, context) {
  return detectOpeningRangeCloseSignal(candles, { ...config, strategySlug: slug, orbResearchContext: context }, { trades: [] });
}

test('ORB complete 09:59 signal is actionable at 10:00 and never reuses stale confirmations', () => {
  const bars = triggerSession();
  assert.equal(signal(bars.slice(0, -1)).found, false);
  const found = signal(bars);
  assert.equal(found.found, true, found.reason);
  assert.equal(found.triggerTimestamp, '2026-02-02T14:59:00.000Z');
  assert.equal(found.metadata.actionableAt, '2026-02-02T15:00:00.000Z');
  assert.equal(found.setup.execution, 'next-bar-market');
  assert.equal(signal([...bars, { ...bars.at(-1), timestamp: '2026-02-02T15:00:00.000Z' }]).found, false);
});

test('ORB missing or duplicate minutes cannot form a complete opening range or confirmation', () => {
  const bars = triggerSession();
  assert.equal(signal(bars.filter((_, i) => i !== 20)).found, false);
  const duplicate = bars.map((bar, i) => i === 20 ? { ...bars[19] } : bar);
  assert.equal(signal(duplicate).found, false);
  assert.equal(signal(bars.map((bar, i) => i === 5 ? { ...bars[4] } : bar)).found, false);
});

test('ORB structural stops are preserved even when wider than the old 20-point clamp', () => {
  const bars = triggerSession();
  for (let i = 15; i < 30; i += 1) {
    const n = i - 15;
    Object.assign(bars[i], { open: 10_004 + n * 3, low: 10_003 + n * 3, high: 10_008 + n * 3, close: 10_006 + n * 3 });
  }
  const found = signal(bars);
  assert.equal(found.found, true, found.reason);
  assert.equal(found.setup.stop, 10_002.75);
  assert.ok(found.setup.entry - found.setup.stop > 20);
});

test('ORB feature context uses prior sessions and the matching time slot without future leakage', () => {
  const past = history();
  const now = triggerSession();
  const fullToday = [...now, ...session('2026-02-02').slice(30)];
  const before = prepareOrbResearchContext([...past, ...now]);
  const full = prepareOrbResearchContext([...past, ...fullToday, ...session('2026-02-03')]);
  const key = '2026-02-02|2026-02-02T14:59:00.000Z';
  assert.deepEqual(full[key], before[key]);
  assert.equal(full[key].priorAtr, 200);
  assert.equal(full[key].openingRangeAtrRatio, 0.1);
  assert.equal(full[key].relativeVolume, 1.4);
  assert.equal(full[key].relativeVolumeSessions, 20);
  const mutated = [...past, ...fullToday, ...session('2026-02-03')].map((bar) => bar.timestamp > now.at(-1).timestamp
    ? { ...bar, high: 1_000_000, low: 1, close: 500_000, volume: 1_000_000 } : bar);
  assert.deepEqual(prepareOrbResearchContext(mutated)[key], before[key]);
  assert.ok(Object.isFrozen(full));
  assert.ok(Object.isFrozen(full[key]));
});

test('ORB ATR and RVOL filters remain distinct and reject absent warmup explicitly', () => {
  const now = triggerSession();
  const ready = prepareOrbResearchContext([...history(), ...now]);
  for (const slug of ['nq-15m-orb-atr', 'nq-15m-orb-rvol', 'nq-15m-orb-atr-rvol']) {
    assert.equal(signal(now, slug, ready).found, true, slug);
  }
  assert.match(signal(now, 'nq-15m-orb-atr').reason, /ATR unavailable/);
  assert.match(signal(now, 'nq-15m-orb-rvol').reason, /relative volume unavailable/);
  const short = prepareOrbResearchContext([...history(10), ...now]);
  assert.equal(signal(now, 'nq-15m-orb-rvol', short).found, true);
  assert.match(signal(now, 'nq-15m-orb-atr', short).reason, /ATR unavailable/);
  const key = '2026-02-02|2026-02-02T14:59:00.000Z';
  const weakVolume = { ...ready, [key]: { ...ready[key], relativeVolume: 0.9 } };
  assert.equal(signal(now, 'nq-15m-orb-atr', weakVolume).found, true);
  assert.match(signal(now, 'nq-15m-orb-rvol', weakVolume).reason, /below preregistered/);
  const wideRange = { ...ready, [key]: { ...ready[key], openingRangeAtrRatio: 0.4 } };
  assert.equal(signal(now, 'nq-15m-orb-rvol', wideRange).found, true);
  assert.match(signal(now, 'nq-15m-orb-atr', wideRange).reason, /outside preregistered/);
});

test('incomplete prior cash sessions do not count toward RVOL minimum history', () => {
  const past = history(10);
  // Remove a late minute, after the confirmation slot, from one prior session.
  const incomplete = past.filter((bar) => bar.timestamp !== '2026-01-02T20:59:00.000Z');
  const now = triggerSession();
  const context = prepareOrbResearchContext([...incomplete, ...now]);
  const key = '2026-02-02|2026-02-02T14:59:00.000Z';
  assert.equal(context[key].relativeVolumeSessions, 9);
  assert.equal(context[key].relativeVolume, null);
});

test('new filter variants are research only and wick test isolates the 15% threshold', () => {
  assert.equal(ORB_FILTER_VARIANTS.length, 4);
  for (const variant of ORB_FILTER_VARIANTS) {
    assert.ok(BACKTEST_STRATEGIES.some((item) => item.slug === variant.slug));
    assert.equal(STRATEGIES.some((item) => item.slug === variant.slug), false);
  }
  const bars = triggerSession();
  bars.at(-1).high = 10_018.75; // Wick ~22%; baseline allows25%, new test15%.
  assert.equal(signal(bars).found, true);
  assert.equal(signal(bars, 'nq-15m-orb-wick-test').found, false);
});
