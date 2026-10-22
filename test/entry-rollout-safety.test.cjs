const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.json');
const core = require('../lib/trader-core.cjs');
const live = require('../lib/live-trader.cjs');
const observation = require('../lib/watcher-observation.cjs');
const registry = require('../lib/strategy-registry.cjs');
const ce = require('../lib/consolidation-expansion.cjs');
const rollout = require('../scripts/validate-entry-rollout.cjs');
const slugs = ['nq-dmc-gain-retest', 'nq-15m-opening-range-retest', 'ema-20-60-momentum', 'nq-fresh-level-retest'];

test('state writer emits valid JSON and summaries contain real newlines', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-state-check-'));
  const file = path.join(directory, 'state.json');
  t.after(() => {if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(directory);});
  const state = {balanceUsd: 49875, trades: [{id:'preserved'}], live:{openPlan:null}};
  live.saveLiveState(file, state);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), state);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
  const summary = live.formatSignalSummary({setup:{side:'long',symbol:'NQ',date:'2026-10-22',entry:100,stop:95,targets:[110]}}, {sizing:{maxContracts:1,actualRiskUsd:110}});
  assert.equal(summary.split('\n').length, 3);
});

test('VPS gate refuses pending plans, unknown states and nonflat positions', () => {
  const flat = {trades:[],live:{openPlan:null,openLifecycle:null}};
  assert.deepEqual(rollout.flatIssues(flat), []);
  assert.ok(rollout.flatIssues(null).length);
  assert.ok(rollout.flatIssues({...flat, live:{openPlan:{}}}).length);
  assert.ok(rollout.flatIssues({...flat, positionSize:1}).length);
  assert.ok(rollout.flatIssues({...flat, live:{pendingOrders:[{id:'pending'}]}}).length);
});

test('VPS cache gate rejects malformed chronology and excludes forming bars', () => {
  const bar = {timestamp:'2026-10-22T14:00:00Z',open:100,high:101,low:99,close:100,volume:100};
  const next = {...bar, timestamp:'2026-10-22T14:01:00Z'};
  const checked = rollout.inspectCandles([bar,next], Date.parse('2026-10-22T14:01:30Z'));
  assert.deepEqual(checked.complete, [bar]);
  assert.equal(checked.excludedIncompleteOrFuture, 1);
  assert.throws(() => rollout.inspectCandles([bar,bar], Infinity), /duplicate/);
  assert.throws(() => rollout.inspectCandles([{...bar,low:102}], Infinity), /invalid/);
});

test('entry revision is staged off; all four accounts initialize independently at $50k', () => {
  assert.equal(config.live.consolidationExpansion.enabled, false);
  const paths = slugs.map(slug => registry.runtimeFilesForStrategy(process.cwd(), slug).statePath);
  assert.equal(new Set(paths).size, slugs.length);
  const states = slugs.map(strategySlug => core.createEmptyState({...config, strategySlug}));
  for (const state of states) assert.equal(state.balanceUsd, 50000);
  states[0].trades.push({id: 'existing'});
  assert.equal(states[1].trades.length, 0);
});

test('version activation preserves existing balance, history and captured open plan', () => {
  for (const slug of slugs) {
    const state = live.loadLiveState({balanceUsd: 48765, trades: [{id:'old', date:'2026-10-21'}], live: {
      openPlan: {setup:{side:'long',entry:100,stop:95,targets:[110],execution:'limit-touch'},
        targets:[{price:110,closeFraction:1}], sizing:{maxContracts:1,actualRiskUsd:110}},
      openLifecycle: {status:'open'}, openSignalKey:'captured', openTriggeredAt:'2026-10-22T14:00:00Z'
    }});
    const before = structuredClone(state);
    observation.initialize(state, {...config, strategySlug:slug}, 1);
    observation.initialize(state, {...config, strategySlug:slug, live:{...config.live, consolidationExpansion:{enabled:true}}}, 2);
    assert.equal(state.live.scanAudit.rulesVersion, ce.VERSION);
    assert.equal(state.live.scanAudit.tradeCountAtStart, 1);
    assert.equal(state.balanceUsd, before.balanceUsd);
    assert.deepEqual(state.trades, before.trades);
    assert.deepEqual(state.live.openPlan, before.live.openPlan);
    assert.deepEqual(state.live.openLifecycle, before.live.openLifecycle);
    assert.equal(state.live.openSignalKey, 'captured');
  }
});

test('captured open position follows its original stop with new entry flag enabled', () => {
  const setup = {symbol:'NQ',date:'2026-10-22',session:'captured',side:'long',entry:100,stop:95,
    targets:[110],execution:'next-bar-market',signalAvailableAt:'2026-10-22T14:00:00Z',
    orderExpiresAt:'2026-10-22T14:03:00Z',thesis:'synthetic captured position'};
  const plan = core.buildTradePlan(core.normalizeSetup(setup, config), config, core.createEmptyState(config));
  const bars = [{timestamp:'2026-10-22T14:00:00Z',open:100,high:101,low:99,close:100,volume:100},
    {timestamp:'2026-10-22T14:01:00Z',open:99,high:100,low:94,close:95,volume:100}];
  const original = core.trackTradeLifecycle(plan, bars, config, {closeOpenAtEnd:false});
  const revised = core.trackTradeLifecycle(plan, bars, {...config,live:{...config.live,consolidationExpansion:{enabled:true}}}, {closeOpenAtEnd:false});
  assert.deepEqual(revised, original);
  assert.equal(revised.status, 'closed');
  assert.match(revised.exitReason, /stop-loss/);
});
