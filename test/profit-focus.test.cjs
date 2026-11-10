const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { buildFocusReport } = require('../lib/profit-focus.cjs');
const slugs = ['live-9am-sweep', 'nq-vwap-stretch-reversion', 'nq-fresh-level-retest', 'nq-opening-range-breakout', 'nq-15m-opening-range-retest'];
const start = '2026-01-01T00:00:00Z';
const at = days => new Date(Date.parse(start) + days * 86400000).toISOString();
function trade(id, days, pnl = 100, overrides = {}) {
  return { id, filledAt: at(days), exitedAt: new Date(Date.parse(at(days)) + 120000).toISOString(), signalObservedAt: at(days - .001),
    actualRiskUsd: 100, maeUsd: -20, contracts: 1, realizedPnlUsd: pnl, side: 'long', execution: {
      modelVersion: 'bounded-fill-v1', intrabarPolicyVersion: 'post-fill-evidence-v1', policyVersion: 'execution-repair-v3-fill-quality', signalAvailableAt: at(days - .0005)
    }, ...overrides };
}
function fixture(trades = [], now = at(50)) {
  const manifest = { id: 'profit-focus-v1', name: 'Profit Focus', startedAt: start, selectedAt: start,
    expectedRulesHash: 'frozen-hash', strategies: slugs.map((slug, i) => ({ slug, name: slug, baselineTradeIds: [`baseline-${i}`], selectionPnlUsd: 100, selectionTrades: 1 })) };
  const snapshot = { ok: true, source: 'remote-bridge', generatedAt: now,
    focusValidation: { id: manifest.id, expectedHash: 'frozen-hash', actualHash: 'frozen-hash', checkedAt: now, missingFiles: [] },
    strategies: slugs.map((slug, i) => ({ slug, watcher: { isHealthy: true, processCount: 1 }, journal: { dailyRecaps: [{ date: '2026-01-02', tradesList: [trade(`baseline-${i}`, -1), ...(i === 0 ? trades : [])] }] } })) };
  snapshot.focusValidation.manifestHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return { manifest, snapshot, now };
}
const report = f => buildFocusReport(f.snapshot, f.manifest, { now: f.now });
const first = f => report(f).strategies[0];

test('empty prospective trial is collecting and fixed five cohorts are never re-ranked', () => {
  const f = fixture();
  assert.equal(report(f).dataStatus.ok, true);
  assert.equal(first(f).prospective.status, 'collecting');
  assert.equal(first(f).prospective.metrics.netR, 0);
  assert.deepEqual(report(f).strategies.map(s => s.slug), slugs);
  f.manifest.strategies[0].slug = 'another-winner';
  assert.equal(report(f).dataStatus.ok, false);
});

test('null risk and null realized P&L cannot become zero or count toward validation', () => {
  const f = fixture([trade('risk', 1, 100, { actualRiskUsd: null }), trade('pnl', 2, null)]);
  const r = first(f);
  assert.equal(r.prospective.status, 'blocked');
  assert.equal(r.prospective.metrics.trades, 0);
  assert.equal(r.prospective.metrics.netR, null);
  assert.equal(r.history.netR, 1);
  assert.equal(r.history.missingRisk, 0);
  assert.equal(r.history.netPnlUsd, 100);
});

test('baseline IDs and signal origins before trial are excluded even if closure is after start', () => {
  const baseline = trade('base', 2), oldSignal = trade('old-signal', 3);
  oldSignal.execution.signalOriginAvailableAt = at(-1);
  const f = fixture([baseline, oldSignal, trade('new', 4)]);
  f.manifest.strategies[0].baselineTradeIds.push('base');
  f.manifest.strategies[0].selectionTrades = 2;
  f.manifest.strategies[0].selectionPnlUsd = 200;
  f.snapshot.focusValidation.manifestHash = createHash('sha256').update(JSON.stringify(f.manifest)).digest('hex');
  assert.equal(first(f).prospective.metrics.trades, 1);
  assert.equal(first(f).prospective.metrics.netPnlUsd, 100);
});

test('identical duplicate IDs deduplicate but conflicting copies block the trial', () => {
  const t = trade('same', 1), f = fixture([t, structuredClone(t)]);
  assert.equal(first(f).prospective.metrics.trades, 1);
  f.snapshot.strategies[0].journal.dailyRecaps[0].tradesList[2].realizedPnlUsd = 200;
  assert.equal(first(f).prospective.status, 'blocked');
  assert.match(report(f).dataStatus.reasons.join(' '), /Conflicting duplicate/);
});

test('source outage, stale data, unhealthy watcher, and missing frozen IDs block valid zero claims', () => {
  for (const mutate of [f => { f.snapshot.source = 'remote-bridge-cache'; },
    f => { f.snapshot.generatedAt = at(49); }, f => { f.snapshot.strategies[0].watcher.isHealthy = false; },
    f => { f.manifest.strategies[0].baselineTradeIds = ['missing']; }]) {
    const f = fixture(); mutate(f);
    assert.equal(report(f).dataStatus.ok, false);
    assert.equal(report(f).summary.prospectivePnlUsd, null);
    assert.equal(first(f).prospective.metrics.netPnlUsd, null);
  }
});

test('actual rules hash beats a claimed matches flag and permanent invalidation survives hash reversion', () => {
  const f = fixture([trade('one', 1)]);
  f.snapshot.focusValidation.actualHash = 'changed'; f.snapshot.focusValidation.matches = true;
  assert.equal(first(f).prospective.status, 'invalidated');
  f.snapshot.focusValidation.actualHash = 'frozen-hash'; f.snapshot.focusValidation.invalidatedAt = at(4); f.snapshot.focusValidation.reason = 'Changed once; permanently invalid.';
  assert.equal(first(f).prospective.status, 'invalidated');
  assert.match(first(f).prospective.reason, /permanently invalid/);
});

test('six losses on separate days stop at breach trade and ignore later good or malformed trades', () => {
  const trades = Array.from({ length: 6 }, (_, i) => trade(`loss-${i}`, i + 1, -100));
  const breach = trades.at(-1).exitedAt;
  trades.push(trade('later', 8, 500), trade('bad-later', 9, null));
  const r = first(fixture(trades));
  assert.equal(r.prospective.status, 'stopped');
  assert.equal(r.prospective.metrics.trades, 6);
  assert.equal(r.prospective.terminalAt, breach);
  assert.equal(r.prospective.ignoredAfterStop, 2);
});

test('8R adverse excursion stops a profitable closed trade and daily -3R stops exactly at crossing', () => {
  const adverse = first(fixture([trade('adverse', 1, 50, { maeUsd: -800 }), trade('later', 2)]));
  assert.equal(adverse.prospective.status, 'stopped');
  assert.equal(adverse.prospective.metrics.maxDrawdownR, 8);
  const f = fixture([trade('a', 1, -150), trade('b', 1.01, -150), trade('c', 1.02)]);
  assert.match(first(f).prospective.reason, /Daily net loss/);
  assert.equal(first(f).prospective.metrics.trades, 2);
});

test('same-close trades are processed by entry time before ID regardless of input array order', () => {
  const close = at(2), early = trade('z-early', 1, -150, { exitedAt: close }), late = trade('a-late', 1.1, -150, { exitedAt: close });
  const later = trade('0-later', 1.2, 500, { exitedAt: close });
  const a = first(fixture([later, late, early])), b = first(fixture([early, later, late]));
  assert.deepEqual(a.prospective, b.prospective);
  assert.equal(a.prospective.metrics.netR, -3);
  assert.equal(a.prospective.metrics.trades, 2);
});

test('100 trades and 30 days terminate evaluation once; stress costs are charged once against recorded net', () => {
  const trades = Array.from({ length: 100 }, (_, i) => trade(`t${i}`, 1 + i * .31, i % 10 === 0 ? -20 : 100));
  trades.push(trade('after-terminal', 40, -10000));
  const f = fixture(trades), p = first(f).prospective;
  assert.equal(p.status, 'qualified');
  assert.equal(p.metrics.trades, 100);
  assert.ok(p.metrics.tradingDays >= 30);
  assert.equal(p.metrics.netR - p.metrics.stressedNetR, 10);
  assert.equal(p.ignoredAfterStop, 1);
  assert.equal(report(f).benchmarks.noTradeR, 0);
});

test('100 trades within one day do not meet maturity, missing execution versions block, zero winners PF is null', () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => trade(`t${i}`, 1 + i * .0001, 1)));
  assert.equal(first(f).prospective.status, 'collecting');
  const missing = trade('missing', 2); delete missing.execution.intrabarPolicyVersion;
  f.snapshot.strategies[0].journal.dailyRecaps[0].tradesList.push(missing);
  assert.equal(first(f).prospective.status, 'blocked');
  assert.equal(first(fixture([trade('loss', 1, -100)])).prospective.metrics.profitFactor, null);
});

test('90-day timeout is terminal without pretending insufficient sample qualified', () => {
  const p = first(fixture([trade('one', 1), trade('late', 92)], at(100))).prospective;
  assert.equal(p.status, 'stopped'); assert.equal(p.metrics.trades, 1);
  assert.equal(p.terminalAt, at(90)); assert.equal(p.ignoredAfterStop, 1);
});

test('malformed missing source blocks and extreme finite inputs never emit Infinity or NaN', () => {
  const missing = fixture(); missing.snapshot.strategies = {};
  assert.equal(report(missing).dataStatus.ok, false);
  assert.equal(first(missing).history.netPnlUsd, null);
  const r = first(fixture([trade('large', 1, 1e308)]));
  function check(value) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value));
    else if (value && typeof value === 'object') for (const child of Object.values(value)) check(child);
  }
  check(r);
});

test('web-only manifest changes cannot borrow integrity from the registered server policy', () => {
  for (const mutate of [f => { f.manifest.policy = { minTrades: 1 }; },
    f => { f.manifest.startedAt = at(-2); },
    f => { f.manifest.strategies[0].baselineTradeIds = []; }]) {
    const f = fixture(); mutate(f);
    const r = report(f);
    assert.equal(r.dataStatus.ok, false);
    assert.match(r.dataStatus.reasons.join(' '), /server-registered manifest/);
    assert.equal(r.summary.prospectivePnlUsd, null);
  }
});

test('new profitable or losing trades never alter the frozen historical metrics or segments', () => {
  const before = first(fixture());
  const after = first(fixture([trade('new-win', 1, 900), trade('new-loss', 2, -100)]));
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.segments, before.segments);
  assert.equal(after.history.netPnlUsd, 100);
  assert.equal(after.prospective.metrics.netPnlUsd, 800);
});

test('invalid or missing baseline P&L is unavailable, never a valid zero historical result', () => {
  const f = fixture();
  f.snapshot.strategies[0].journal.dailyRecaps[0].tradesList[0].realizedPnlUsd = null;
  const invalid = report(f);
  assert.equal(invalid.dataStatus.ok, false);
  assert.equal(invalid.strategies[0].history.netPnlUsd, null);
  assert.equal(invalid.summary.historicalPnlUsd, null);
  f.snapshot.strategies = [];
  const missing = report(f);
  assert.equal(missing.summary.historicalPnlUsd, null);
  assert.equal(missing.summary.historicalTrades, null);
});

test('missing historical risk with known monetary evidence remains dollars-only', () => {
  const f = fixture();
  f.snapshot.strategies[0].journal.dailyRecaps[0].tradesList[0].actualRiskUsd = null;
  const r = report(f);
  assert.equal(r.dataStatus.ok, true);
  assert.equal(r.strategies[0].history.netPnlUsd, 100);
  assert.equal(r.strategies[0].history.netR, null);
  assert.equal(r.strategies[0].history.missingRisk, 1);
});

test('a valid or malformed trade at the exact deadline is equally outside the terminal trial', () => {
  const valid = trade('valid-deadline', 89.9, 100, { exitedAt: at(90) });
  const malformed = trade('bad-deadline', 89.9, null, { exitedAt: at(90) });
  for (const t of [valid, malformed]) {
    const p = first(fixture([trade('before', 1), t], at(100))).prospective;
    assert.equal(p.status, 'stopped');
    assert.equal(p.terminalAt, at(90));
    assert.equal(p.metrics.trades, 1);
    assert.equal(p.ignoredAfterStop, 1);
  }
});

test('malformed journal shapes fail closed without throwing', () => {
  for (const recaps of [{}, [null], [{ tradesList: {} }]]) {
    const f = fixture(); f.snapshot.strategies[0].journal.dailyRecaps = recaps;
    assert.equal(report(f).dataStatus.ok, false);
    assert.equal(report(f).summary.historicalPnlUsd, null);
  }
});
