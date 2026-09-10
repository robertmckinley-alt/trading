const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/trader-core.cjs');
const { detectSignalFromCandles, buildPlanFromSignal } = require('../lib/live-trader.cjs');
const { runAllBacktests } = require('../lib/backtest-engine.cjs');
const { ORB_EXTENSION_VARIANTS, STRATEGIES } = require('../lib/strategy-registry.cjs');
const forward = require('../lib/orb-forward.cjs');
const config = core.normalizeConfig(require('../config.json'));
const baseline = 'nq-15m-orb-close-confirmation';
const fade = 'nq-15m-orb-failed-breakout-fade';
const one = 'nq-15m-orb-exit-1r';
const three = 'nq-15m-orb-exit-3r';

function candles(kind = 'breakout', date = '2026-02-03', startTime = '14:30') {
  const start = Date.parse(`${date}T${startTime}:00Z`);
  const trigger = kind === 'breakout'
    ? { open: 10016, high: 10025, low: 10015, close: 10024 }
    : { open: 10020, high: 10022, low: 10013, close: 10014 };
  const bars = Array.from({ length: 30 }, (_, i) => ({
    timestamp: new Date(start + i * 60000).toISOString(), volume: 100, instrumentId: 1,
    ...(i < 15 ? { open: 10000, high: 10020, low: 9980, close: 10000 } : trigger)
  }));
  return kind === 'long-fade' ? bars.map(bar => ({ ...bar,
    open: 20000 - bar.open, close: 20000 - bar.close,
    high: 20000 - bar.low, low: 20000 - bar.high })) : bars;
}
function signal(bars, slug, state = { trades: [] }) {
  return detectSignalFromCandles(bars, { ...config, strategySlug: slug }, state);
}
function future(bars, prices) {
  return prices.map((ohlc, i) => ({ timestamp: new Date(Date.parse(bars.at(-1).timestamp) + (i + 1) * 60000).toISOString(),
    volume: 100, instrumentId: 1, ...ohlc }));
}

test('exit experiments retain baseline signals and stops while changing only full-position targets', () => {
  for (const mirror of [false, true]) {
    const bars = candles().map(bar => mirror ? { ...bar, open: 20000 - bar.open, close: 20000 - bar.close,
      high: 20000 - bar.low, low: 20000 - bar.high } : bar);
    const base = signal(bars, baseline);
    assert.equal(base.found, true, base.reason);
    for (const [slug, r] of [[one, 1], [three, 3]]) {
      const result = signal(bars, slug);
      assert.equal(result.found, true, result.reason);
      assert.equal(result.triggerTimestamp, base.triggerTimestamp);
      assert.equal(result.setup.entry, base.setup.entry);
      assert.equal(result.setup.stop, base.setup.stop);
      assert.equal(result.setup.side, base.setup.side);
      assert.deepEqual(result.setup.targets, [base.setup.entry + (mirror ? -1 : 1) * r * Math.abs(base.setup.entry - base.setup.stop)]);
      const plan = buildPlanFromSignal(result, config, core.createEmptyState(config));
      assert.equal(plan.targets[0].closeFraction, 1);
    }
  }
});

test('fade uses completed one-sided rejection, extreme stop and midpoint, symmetrically', () => {
  for (const [kind, side, entry, stop] of [['fade', 'short', 10014, 10022.25], ['long-fade', 'long', 9986, 9977.75]]) {
    const bars = candles(kind);
    assert.equal(signal(bars.slice(0, -1), fade).found, false);
    const result = signal(bars, fade);
    assert.equal(result.found, true, result.reason);
    assert.equal(result.setup.side, side);
    assert.equal(result.setup.entry, entry);
    assert.equal(result.setup.stop, stop);
    assert.deepEqual(result.setup.targets, [10000]);
    assert.equal(result.setup.execution, 'next-bar-market');
    assert.equal(result.setup.signalAvailableAt, '2026-02-03T15:00:00.000Z');
    assert.deepEqual(core.validateSetup(result.setup, config), { valid: true, errors: [] });
    assert.equal(signal(bars, baseline).found, false);
    assert.equal(signal([...bars, ...future(bars, [{ open: entry, high: entry + 1, low: entry - 1, close: entry }])], fade).found, false);
    assert.equal(signal(bars, fade, { trades: [{ date: '2026-02-03' }] }).found, false);
  }
});

test('fade rejects missing minutes, two-sided sweeps, touches, outside closes and insufficient reward', () => {
  const bars = candles('fade');
  assert.equal(signal(bars.filter((_, i) => i !== 20), fade).found, false);
  assert.equal(signal(bars.map((b, i) => i === 20 ? { ...bars[19] } : b), fade).found, false);
  const change = changes => bars.map((b, i) => i >= 15 ? { ...b, ...changes } : b);
  assert.equal(signal(change({ low: 9979 }), fade).found, false);
  assert.equal(signal(change({ high: 10020 }), fade).found, false);
  assert.equal(signal(change({ close: 10021 }), fade).found, false);
  assert.match(signal(change({ low: 10004, close: 10005 }), fade).reason, /midpoint offers less/);
  assert.equal(signal(change({ low: 9997, close: 9998 }), fade).found, false);
});

test('new signals respect New York time through daylight-saving changes', () => {
  for (const [date, time, actionable] of [['2026-03-06', '14:30', '15:00'], ['2026-03-09', '13:30', '14:00']]) {
    for (const slug of [fade, one, three]) {
      const result = signal(candles(slug === fade ? 'fade' : 'breakout', date, time), slug);
      assert.equal(result.found, true, result.reason);
      assert.equal(result.setup.signalAvailableAt, `${date}T${actionable}:00.000Z`);
    }
  }
});

test('full exits close every contract; 1R and 3R produce different outcomes on the same future', () => {
  const bars = candles();
  const subsequent = future(bars, [
    { open: 10024, high: 10035, low: 10023, close: 10030 },
    { open: 10030, high: 10031, low: 10010, close: 10012 }
  ]);
  const generous = { ...config, maxRiskPerTradeUsd: 1500 };
  const outcomes = [one, three].map(slug => {
    const found = signal(bars, slug);
    const plan = buildPlanFromSignal(found, generous, core.createEmptyState(generous));
    const result = core.replayPlan(plan, subsequent, generous);
    assert.ok(result.contracts > 1);
    assert.equal(result.remainingContracts, 0);
    assert.equal(result.filledAt, subsequent[0].timestamp);
    return result;
  });
  assert.ok(outcomes[0].realizedPnlUsd > 0);
  assert.ok(outcomes[1].realizedPnlUsd < 0);
});

test('fade execution respects entry gaps and pessimistic same-candle conflicts', () => {
  const bars = candles('fade');
  const plan = buildPlanFromSignal(signal(bars, fade), config, core.createEmptyState(config));
  const conflict = core.replayPlan(plan, future(bars, [{ open: 10014, high: 10024, low: 9999, close: 10000 }]), config);
  assert.match(conflict.exitReason, /stop-loss same-candle/);
  assert.ok(conflict.realizedPnlUsd < 0);
  const gap = core.replayPlan(plan, future(bars, [{ open: 9999, high: 10002, low: 9998, close: 10000 }]), config);
  assert.equal(gap.status, 'not-filled');
  assert.equal(gap.exitReason, 'entry gap beyond stop or target');
});

test('all extensions run through research backtests and preserve the nine locked forward accounts', () => {
  for (const slug of [fade, one, three]) {
    const bars = candles(slug === fade ? 'fade' : 'breakout');
    const subsequent = slug === fade
      ? [{ open: 10014, high: 10015, low: 9999, close: 10000 }]
      : [{ open: 10024, high: 10055, low: 10023, close: 10050 }];
    const definition = ORB_EXTENSION_VARIANTS.find(s => s.slug === slug);
    const result = runAllBacktests([...bars, ...future(bars, subsequent)], config, { strategies: [definition] }).strategies[0];
    assert.equal(result.research.trades.length, 1);
    assert.equal(result.research.trades[0].contracts, 1);
    assert.equal(result.research.signalAudit[0].filledAt, '2026-02-03T15:00:00.000Z');
    assert.equal(result.forwardPaperEligible, false);
    assert.deepEqual(result.researchRules, definition.researchRules);
    assert.equal(STRATEGIES.some(s => s.slug === slug), false);
    assert.equal(forward.DEFINITIONS.some(s => s.slug === slug), false);
  }
  assert.equal(forward.DEFINITIONS.length, 9);
  assert.equal(forward.version(config, 'orb-forward-paper-v1'), '765e8ae1bf6fd108');
  assert.notEqual(forward.version(config), '765e8ae1bf6fd108');
});
