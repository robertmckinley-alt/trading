const test = require('node:test'), assert = require('node:assert/strict');
const engine = require('../lib/focus-paper.cjs');
const VWAP = 'nq-vwap-stretch-reversion';
const slugs = ['live-9am-sweep', VWAP, 'nq-fresh-level-retest', 'nq-opening-range-breakout', 'nq-15m-opening-range-retest'];
const start = Date.parse('2026-10-06T15:00:00Z');
const at = m => new Date(start + m * 60000).toISOString();
const now = m => start + m * 60000;
function policy() { return { id: 'focus-paper-1000-v2', name: 'Paper risk trial', startedAt: at(0), parents: slugs.map((slug, i) => ({
  slug, name: slug, family: i === 0 || i === 2 ? 'liquidity-reversal' : i === 1 ? 'vwap-reversion' : 'cash-breakout', accountDrawdownPercent: slug === VWAP ? 5 : 10 })),
  riskPerTradeUsd: 1000, startingBalanceUsd: 50000, dailyLossLimitUsd: 1000, portfolioOpenRiskUsd: 2500, familyOpenRiskUsd: 1000,
  baseConfig: { tickSize: .25, tickValueUsd: 5, commissionPerContractUsd: 4.5, slippageTicks: 1, sameCandleConflict: 'stop-first', defaultScaleOuts: [] } }; }
function bar(m, open = 100, high = 101, low = 99, close = 100) { return { timestamp: at(m), open, high, low, close, instrumentId: 123 }; }
function signal(id = 's1', parent = slugs[0], m = 1, changes = {}) { return { id, parent, observedAt: at(m), setup: {
  symbol: 'NQ', date: '2026-10-06', side: 'long', entry: 100, stop: 90, targets: [140], execution: 'next-bar-market',
  exitAllAtTarget: true, thesis: 'prospective fixture', setup: {}, signalAvailableAt: at(m), signalOriginAvailableAt: at(m),
  observedAt: at(m), orderExpiresAt: at(m + 3), minimumEntryRewardRisk: 1, maximumAdverseEntryRiskFraction: .25, ...changes } }; }
const control = (state, parent = slugs[0]) => state.accounts[`${parent}:control`];
const step = (s, signals, bars, p, m, opts) => engine.advance(s, signals, bars, p, now(m), opts);

test('initial creates five empty controls plus separate candidate; authorizes up to1000 including costs', () => {
  const p = policy(), s = engine.initial(p, now(0)), r = engine.report(s, p);
  assert.equal(r.accounts.length, 6); assert.equal(r.summary.realizedPnlUsd, 0); assert.equal(r.summary.closedTrades, 0);
  const next = step(s, [signal()], [bar(0)], p, 1), plan = control(next).open.plan;
  assert.equal(plan.sizing.maxContracts, 4); assert.equal(plan.sizing.actualRiskUsd, 858);
  assert.equal(plan.sizing.totalRiskPerContractUsd, 214.5); assert.ok(plan.sizing.actualRiskUsd <= 1000);
  assert.equal(control(next).trades.length, 0);
});

test('pending and open controls reserve portfolio and family risk; another book remains separate', () => {
  const p = policy(), signals = slugs.map((slug, i) => signal(`s${i}`, slug));
  const s = step(null, signals, [bar(0)], p, 1), r = engine.report(s, p);
  assert.ok(control(s).open); assert.equal(control(s, slugs[2]).open, null);
  assert.ok(r.summary.reservedRiskUsd <= 2500);
  assert.equal(r.summary.reservedRiskUsd, 2359.5);
  for (const family of new Set(p.parents.map(x => x.family))) {
    const amount = p.parents.filter(x => x.family === family).reduce((sum, parent) => sum + (control(s, parent.slug).open?.plan.sizing.actualRiskUsd || 0), 0);
    assert.ok(amount <= 1000);
  }
  assert.ok(s.accounts[`${VWAP}:vwap-confirm`].pending);
});

test('daily loss and account floor reduce the next risk budget, while profits cannot increase1000 cap', () => {
  const p = policy();
  for (const [pnl, parent, close, blocked] of [[-1000, slugs[0], at(0), true], [-2490, VWAP, '2026-10-05T15:00:00Z', true], [500, slugs[0], at(0), false]]) {
    const s = engine.initial(p, now(0)), a = control(s, parent);
    a.trades.push({ id: 'past-newtrial', exitedAt: close, realizedPnlUsd: pnl }); a.realizedPnlUsd = pnl; a.balanceUsd = 50000 + pnl;
    const next = step(s, [signal('new', parent)], [bar(0)], p, 1);
    assert.equal(!control(next, parent).open, blocked);
    if (!blocked) assert.ok(control(next, parent).open.plan.sizing.actualRiskUsd <= 1000);
  }
});

test('prestart, stale, future, expired and integrity-blocked signals cannot enter or replay', () => {
  const p = policy();
  const old = signal('old', slugs[0], -1), future = signal('future', slugs[0], 2), expired = signal('expired', slugs[0], 0, { orderExpiresAt: at(1) });
  const s = step(null, [old, future, expired, signal('blocked')], [bar(0)], p, 1, { integrityOk: false });
  assert.equal(Object.values(s.accounts).filter(a => a.open).length, 0);
  const replay = step(s, [signal('blocked')], [bar(0), bar(1)], p, 2);
  assert.equal(replay.events.length, 4); assert.equal(control(replay).open, null);
  assert.equal(step(null, [signal()], [bar(-5)], p, 1).status, 'waiting-for-fresh-feed');
});

test('first observation binds next future minute and preserves the original deadline and stop', () => {
  const p = policy(), sig = signal('fresh', slugs[2], 1, { setup: { entryModel: 'fresh-level-retest' }, orderExpiresAt: at(3) });
  const s = engine.advance(null, [sig], [bar(0)], p, now(1) + 1000);
  const plan = control(s, slugs[2]).open.plan;
  assert.equal(plan.setup.signalAvailableAt, at(2)); assert.equal(plan.setup.orderExpiresAt, at(3)); assert.equal(plan.setup.stop, 90);
  const next = step(s, [], [bar(1, 100, 145, 99, 140)], p, 2);
  assert.equal(control(next, slugs[2]).trades.length, 0); assert.equal(control(next, slugs[2]).open.lifecycle, undefined);
});

test('missing path fails closed and a future gap beyond risk is unfilled without widening stop', () => {
  const p = policy(), s = step(null, [signal()], [bar(0)], p, 1);
  const gap = step(s, [], [bar(2)], p, 3);
  assert.equal(control(gap).status, 'data-gap'); assert.equal(control(gap).trades.length, 0);
  const resumed = step(gap, [], [bar(1), bar(2)], p, 3);
  assert.equal(control(resumed).status, 'collecting'); assert.equal(control(resumed).open.plan.setup.stop, 90);
  const unfilled = step(s, [], [bar(1, 150, 151, 149, 150)], p, 2);
  assert.equal(control(unfilled).open, null); assert.equal(control(unfilled).trades.length, 0);
  assert.equal(unfilled.events[0].arms.control.outcome.status, 'unfilled');
});

test('completed future VWAP turn creates only next-bar candidate with unchanged structural stop', () => {
  const p = policy(), sig = signal('vwap', VWAP), before = JSON.stringify(sig);
  let s = step(null, [sig], [bar(0)], p, 1);
  s = step(s, [], [bar(1, 100, 100.5, 99.5, 100)], p, 2);
  assert.equal(s.accounts[`${VWAP}:vwap-confirm`].open, null);
  s = step(s, [], [bar(2, 100, 102, 100, 101)], p, 3);
  const candidate = s.accounts[`${VWAP}:vwap-confirm`];
  assert.ok(candidate.open); assert.equal(candidate.open.plan.setup.signalAvailableAt, at(3));
  assert.equal(candidate.open.plan.setup.orderExpiresAt, at(4)); assert.equal(candidate.open.plan.setup.stop, 90);
  assert.equal(candidate.trades.length, 0); assert.equal(JSON.stringify(sig), before);
});

test('candidate never uses incomplete, pre-observation, changed-contract, or late confirmation bars', () => {
  const p = policy();
  let s = step(null, [signal('vwap', VWAP)], [bar(0)], p, 1);
  s = engine.advance(s, [], [bar(1, 100, 104, 99, 103)], p, now(1) + 30000);
  assert.equal(s.accounts[`${VWAP}:vwap-confirm`].open, null);
  s = step(s, [], [bar(1), { ...bar(2, 100, 102, 100, 101), instrumentId: 999 }], p, 3);
  assert.equal(s.status, 'data-gap');
  assert.equal(s.accounts[`${VWAP}:vwap-confirm`].open, null);
  const late = step(step(null, [signal('late', VWAP)], [bar(0)], p, 1), [], [bar(1), bar(2, 100, 102, 100, 101), bar(3)], p, 4);
  assert.equal(late.accounts[`${VWAP}:vwap-confirm`].pending, null);
  assert.equal(late.accounts[`${VWAP}:vwap-confirm`].trades.length, 0);
});

test('both VWAP arms wait for prior cohort, restart deduplicates, and source blocks still settle existing exits', () => {
  const p = policy(), sig = signal('vwap', VWAP);
  let s = step(null, [sig], [bar(0)], p, 1);
  s = step(s, [sig, signal('busy', VWAP, 2)], [bar(1, 100, 145, 99, 140)], p, 2);
  assert.equal(control(s, VWAP).trades.length, 1); assert.ok(s.accounts[`${VWAP}:vwap-confirm`].pending);
  assert.equal(s.events.find(e => e.id === 'busy').status, 'excluded');
  assert.equal(s.events.filter(e => e.id === 'vwap').length, 1);
  let other = step(null, [signal()], [bar(0)], p, 1);
  other = step(other, [], [bar(1, 100, 145, 99, 140)], p, 2, { integrityOk: false });
  assert.equal(control(other).trades.length, 1); assert.equal(other.status, 'integrity-blocked');
});

test('closed-only report reconciles five controls, excludes candidate money and never rescales baseline history', () => {
  const p = policy(); let s = step(null, [signal('vwap', VWAP)], [bar(0)], p, 1);
  s = step(s, [], [bar(1, 100, 100.5, 99.5, 100), bar(2, 100, 102, 100, 101)], p, 3);
  s = step(s, [], [bar(3, 101, 145, 100, 140)], p, 4);
  const r = engine.report(s, p), controls = r.accounts.filter(a => a.arm === 'control'), candidate = r.accounts.find(a => a.arm === 'vwap-confirm');
  assert.equal(r.summary.closedTrades, 1); assert.equal(candidate.trades, 1);
  assert.equal(r.summary.realizedPnlUsd, controls.reduce((sum, a) => sum + a.realizedPnlUsd, 0));
  assert.equal(r.summary.realizedPnlUsd, controls.flatMap(a => a.tradeList).reduce((sum, t) => sum + t.netPnlUsd, 0));
  assert.notEqual(r.summary.realizedPnlUsd, r.summary.realizedPnlUsd + candidate.realizedPnlUsd);
  assert.equal(r.comparison.pairedComparisons, 1);
});

test('changed policy and corrupted saved account evidence throw rather than resetting journals', () => {
  const p = policy(), s = engine.initial(p, now(0));
  assert.throws(() => step(s, [], [bar(0)], { ...p, riskPerTradeUsd: 900 }, 1), /policy\/version changed/);
  delete s.accounts[`${slugs[0]}:control`];
  assert.throws(() => step(s, [], [bar(0)], p, 1), /refusing reset/);
});

test('first-seen completed bar is causal prior context but can never itself confirm a turn', () => {
  const p = policy();
  const reference = bar(0, 99, 100.5, 98, 100);
  let s = step(null, [signal('vwap', VWAP)], [reference], p, 1);
  assert.equal(s.accounts[`${VWAP}:vwap-confirm`].open, null);
  s = step(s, [], [bar(1, 100, 102, 100, 101)], p, 2);
  const candidate = s.accounts[`${VWAP}:vwap-confirm`];
  assert.equal(candidate.open.plan.setup.signalAvailableAt, at(2));
  assert.equal(candidate.open.plan.setup.entry, 101);
  assert.equal(candidate.open.plan.setup.stop, 90);
  assert.equal(candidate.open.plan.setup.orderExpiresAt, at(4));
});

test('delayed first observation cannot use a bar already begun as its confirmation', () => {
  const p = policy();
  let s = engine.advance(null, [signal('vwap', VWAP)], [bar(0, 99, 100.5, 98, 100)], p, now(1) + 1000);
  s = step(s, [], [bar(1, 100, 102, 100, 101)], p, 2);
  assert.equal(s.accounts[`${VWAP}:vwap-confirm`].open, null);
  s = step(s, [], [bar(2, 101, 102.5, 100.5, 102.25)], p, 3);
  assert.ok(s.accounts[`${VWAP}:vwap-confirm`].open);
  assert.equal(s.accounts[`${VWAP}:vwap-confirm`].open.plan.setup.signalAvailableAt, at(3));
});

test('scheduled parent flatten is honored and deterministic outputs never use the wall clock', () => {
  const p = policy(), sig = signal('flatten', slugs[0], 1, { flattenAt: at(3) });
  const state = step(null, [sig], [bar(0)], p, 1), bars = [bar(1), bar(2), bar(3, 102, 150, 101, 145)];
  const a = step(state, [], bars, p, 4), b = step(state, [], bars, p, 4);
  assert.deepEqual(a, b);
  const trade = control(a).trades[0];
  assert.equal(trade.exitedAt, at(3)); assert.equal(trade.finalExitPrice, 101.75);
  assert.equal(trade.createdAt, at(4));
});

test('candidate rejects poor net reward/risk or excessive original-entry drift without moving stop', () => {
  const p = policy();
  for (const turn of [103, 125]) {
    let s = step(null, [signal('bad-turn', VWAP)], [bar(0, 99, 100.5, 98, 100)], p, 1);
    s = step(s, [], [bar(1, 100, turn + 1, 99, turn)], p, 2);
    assert.equal(s.accounts[`${VWAP}:vwap-confirm`].open, null);
    assert.ok(s.accounts[`${VWAP}:vwap-confirm`].pending);
    assert.equal(control(s, VWAP).open.plan.setup.stop, 90);
  }
});

test('extra stop slippage can exceed planned loss but candidate profits never enter the control total', () => {
  const p = policy(), before = step(null, [signal()], [bar(0)], p, 1);
  const after = step(before, [], [bar(1), bar(2, 70, 80, 65, 75)], p, 3);
  const trade = control(after).trades[0];
  assert.ok(trade.realizedPnlUsd < -trade.actualRiskUsd);
  assert.equal(engine.report(after, p).summary.realizedPnlUsd, trade.realizedPnlUsd);
});

test('every resolved comparison carries verifiable closed-trade references despite event display truncation', () => {
  const p = policy(); let s = step(null, [signal('paired', VWAP)], [bar(0)], p, 1);
  s = step(s, [], [bar(1, 100, 100.5, 99.5, 100), bar(2, 100, 102, 100, 101)], p, 3);
  s = step(s, [], [bar(3, 101, 145, 100, 140)], p, 4);
  for (let i = 0; i < 40; i++) s.events.push({ id: `excluded-${i}`, parent: slugs[0], status: 'excluded', arms: {} });
  const r = engine.report(s, p), pair = r.comparison.pairs[0];
  assert.equal(r.events.length, 30); assert.equal(r.comparison.pairs.length, 1);
  assert.equal(pair.id, 'paired');
  for (const [field, arm] of [['control', 'control'], ['candidate', 'vwap-confirm']]) {
    const trade = r.accounts.find(a => a.parent === VWAP && a.arm === arm).tradeList.find(t => t.id === pair[field].tradeId);
    assert.equal(pair[field].status, 'closed'); assert.equal(pair[field].pnlUsd, trade.netPnlUsd);
  }
});
test('saved realized P&L and active risk evidence must reconcile before any admission', () => {
  const p = policy(), s = engine.initial(p, now(0));
  control(s).realizedPnlUsd = 900;
  assert.throws(() => step(s, [], [], p, 1), /accounting/);
  const valid = step(null, [signal('risk'), signal('vwap-risk', VWAP)], [bar(0)], p, 1);
  for (const mutate of [
    x => { control(x).open.plan.sizing.actualRiskUsd = 1001; },
    x => { control(x).open.eventId = 'missing'; },
    x => { x.accounts[`${VWAP}:vwap-confirm`].pending.riskBudgetUsd = NaN; },
    x => { x.accounts[`${VWAP}:vwap-confirm`].pending.signal.parent = 'wrong'; }
  ]) {
    const corrupt = structuredClone(valid); mutate(corrupt);
    assert.throws(() => step(corrupt, [], [], p, 2), /Saved paper/);
  }
});
