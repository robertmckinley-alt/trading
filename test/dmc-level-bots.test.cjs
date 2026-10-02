const test = require('node:test');
const assert = require('node:assert/strict');
const base = require('../config.json');
const core = require('../lib/trader-core.cjs');
const live = require('../lib/live-trader.cjs');
const bots = require('../lib/dmc-level-bots.cjs');
const { checkpointsForDay } = require('../lib/backtest-engine.cjs');
const registry = require('../lib/strategy-registry.cjs');

function minutes(start, count, shape) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(start + i * 60000).toISOString(),
    open: shape.open + (shape.close - shape.open) * i / count,
    close: shape.open + (shape.close - shape.open) * (i + 1) / count,
    high: shape.high, low: shape.low, volume: 100, instrumentId: 1
  }));
}
function fixture(progression = false) {
  const start = Date.parse('2026-02-02T18:00:00Z');
  const candles = [];
  for (let i = 0; i < 20; i++) {
    let shape = progression ? { open: 94, close: 94.25, high: 96, low: 92 } : { open: 106, close: 106.25, high: 108, low: 104 };
    if (i === 10) shape = { open: 112, close: 115, high: 116, low: 111 };
    if (i === 14) shape = progression ? { open: 99, close: 100, high: 101, low: 98 } : { open: 101, close: 100, high: 102, low: 99 };
    if (progression && i === 18) shape = { open: 94, close: 96, high: 97, low: 93 };
    if (progression && i === 19) shape = { open: 96, close: 98, high: 99, low: 95 };
    candles.push(...minutes(start + i * 3600000, 60, shape));
  }
  candles.push(...minutes(Date.parse('2026-02-03T14:00:00Z'), 30, progression
    ? { open: 98, close: 98.5, high: 99, low: 95 }
    : { open: 106, close: 106.25, high: 108, low: 104 }));
  candles.push(...minutes(Date.parse('2026-02-03T14:30:00Z'), 15, progression
    ? { open: 98.5, close: 102, high: 102.25, low: 97.75 }
    : { open: 101, close: 102, high: 102.25, low: 97.75 }));
  return candles;
}
function config(slug = bots.SLUGS[0]) { const cfg = structuredClone(base); cfg.live.paperCollection = { enabled: false }; return { ...cfg, strategySlug: slug, detectorStrategySlug: slug }; }
function mirrored(candles) { return candles.map(c => ({ ...c, open: 214 - c.open, close: 214 - c.close, high: 214 - c.low, low: 214 - c.high })); }

test('DMC failed-level reversal has symmetric long and short structural plans', () => {
  for (const [side, candles] of [['long', fixture()], ['short', mirrored(fixture())]]) {
    const cfg = config();
    const signal = live.detectSignalFromCandles(candles, cfg, { trades: [] });
    assert.equal(signal.found, true, signal.reason);
    assert.equal(signal.setup.side, side);
    assert.equal(signal.setup.signalAvailableAt, '2026-02-03T14:45:00.000Z');
    assert.equal(signal.setup.orderExpiresAt, '2026-02-03T15:00:00.000Z');
    assert.equal(signal.setup.flattenAt, '2026-02-03T20:59:00.000Z');
    assert.equal(signal.metadata.stopDistancePoints, 2.5);
    assert.equal(signal.metadata.modeledLossPerContractUsd, 59.5);
    assert.ok(signal.metadata.rewardRisk >= 1.5);
    assert.equal(core.validateSetup(core.normalizeSetup(signal.setup, cfg), core.normalizeConfig(cfg)).valid, true);
    const plan = live.buildPlanFromSignal(signal, core.normalizeConfig(cfg), core.createEmptyState(cfg));
    assert.equal(plan.targets[0].closeFraction, 1);
    assert.ok(plan.sizing.actualRiskUsd <= cfg.maxRiskPerTradeUsd);
    const noFill = core.replayPlan(plan, candles, cfg);
    assert.equal(noFill.status, 'not-filled');
  }
});

test('DMC progression requires directional hourly context and completed body gain', () => {
  const cfg = config(bots.SLUGS[1]);
  for (const [side, candles] of [['long', fixture(true)], ['short', mirrored(fixture(true))]]) {
    const signal = bots.detect(candles, cfg);
    assert.equal(signal.found, true, signal.reason);
    assert.equal(signal.setup.side, side);
    assert.equal(signal.metadata.hourlyDirection, side);
  }
  assert.equal(bots.detect(fixture(), cfg).found, false);
});

test('DMC fills only a future retest before expiry and resolves ambiguous bars stop-first', () => {
  const cfg = core.normalizeConfig(config());
  const candles = fixture();
  const signal = bots.detect(candles, cfg);
  const plan = live.buildPlanFromSignal(signal, cfg, core.createEmptyState(cfg));
  const bar = (timestamp, low, high) => ({ timestamp, open: 102, close: 102, low, high, volume: 100 });
  const future = bar('2026-02-03T14:46:00.000Z', 99.75, 103);
  const filled = core.trackTradeLifecycle(plan, [...candles, future], cfg, { closeOpenAtEnd: false });
  assert.equal(filled.filledAt, future.timestamp);
  assert.equal(filled.status, 'open');
  const expired = core.trackTradeLifecycle(plan, [...candles, bar(signal.setup.orderExpiresAt, 99.75, 103)], cfg, { closeOpenAtEnd: false });
  assert.equal(expired.status, 'not-filled');
  assert.equal(expired.exitReason, 'order expired');
  const conflict = core.trackTradeLifecycle(plan, [...candles, bar(future.timestamp, 97, 116)], cfg, { closeOpenAtEnd: false });
  assert.equal(conflict.exitReason, 'stop-loss same-candle conflict');
  assert.ok(conflict.realizedPnlUsd < 0);
});

test('DMC rejects incomplete, duplicated, unsorted, invalid and zero-volume data', () => {
  const candles = fixture();
  assert.equal(bots.detect(candles.slice(0, -1), config()).found, false);
  assert.match(bots.detect(candles.filter((_, i) => i !== candles.length - 3), config()).reason, /incomplete/);
  assert.match(bots.detect([...candles, candles.at(-1)], config()).reason, /duplicate/);
  assert.match(bots.detect(candles.toReversed(), config()).reason, /unsorted/);
  const invalid = structuredClone(candles); invalid.at(-1).high = invalid.at(-1).low - 1;
  assert.match(bots.detect(invalid, config()).reason, /invalid/);
  const emptyVolume = candles.map((c, i) => i >= candles.length - 15 ? { ...c, volume: 0 } : c);
  assert.match(bots.detect(emptyVolume, config()).reason, /volume/);
});

test('DMC refuses second tests, old context, unconfirmed bars, news days and daily repeats', () => {
  const candles = fixture();
  const cfg = config();
  const tested = structuredClone(candles); tested[candles.length - 20].low = 100;
  assert.equal(bots.detect(tested, cfg).found, false);
  const stale = candles.filter(c => c.timestamp < '2026-02-03T13:00:00.000Z' || c.timestamp >= '2026-02-03T14:00:00.000Z');
  assert.match(bots.detect(stale, cfg).reason, /stale|incomplete/);
  cfg.live.dmcMarketOpen.blackoutDates = ['2026-02-03'];
  assert.match(bots.detect(candles, cfg).reason, /blackout/);
  assert.match(bots.detect(candles, config(), { trades: [{ date: '2026-02-03' }] }).reason, /one filled/);
  const unsupported = candles.map(c => ({ ...c, timestamp: c.timestamp.replace('2026-', '2027-') }));
  assert.match(bots.detect(unsupported, config()).reason, /calendar/);
});

test('DMC modeled pricing rejects poor reward/risk and ambiguity', () => {
  const cfg = config(); cfg.commissionPerContractUsd = 500;
  assert.match(bots.detect(fixture(), cfg).reason, /1.5R/);
  const trigger = { open: 105, high: 116, low: 99, close: 105 };
  const levels = [{ kind: 'pivot-low', price: 100 }, { kind: 'pivot-high', price: 115 }];
  assert.equal(new Set(bots.candidateSignals('failure', trigger, trigger, levels, 0.25).map(x => x.side)).size, 2);
});

test('DMC registration, journals and historical checkpoints remain isolated', () => {
  const records = Array.from({ length: 140 }, (_, i) => ({ minute: 570 + i }));
  for (const slug of bots.SLUGS) {
    assert.ok(registry.BACKTEST_STRATEGIES.some(s => s.slug === slug));
    assert.match(registry.runtimeFilesForStrategy(process.cwd(), slug).statePath, new RegExp(`state-${slug}\\.json$`));
    assert.deepEqual(checkpointsForDay(slug, records).map(r => r.minute), [584, 599, 614, 629, 644, 659, 674]);
  }
});
