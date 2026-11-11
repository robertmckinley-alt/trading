const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildFocusPaperView } = require('../lib/focus-paper-view.cjs');
const policy = require('../config/focus-paper-v2.json');
function fixture() {
  const now = Date.parse(policy.startedAt) + 60000;
  const accounts = policy.parents.map(parent => ({ id: parent.slug, parent: parent.slug, name: parent.name, arm: 'control', balanceUsd: 50000, realizedPnlUsd: 0, trades: 0, open: false, reservedRiskUsd: 0, tradeList: [] }));
  accounts.push({ id: 'comparison', parent: 'nq-vwap-stretch-reversion', arm: 'vwap-confirm', realizedPnlUsd: 900, trades: 1, tradeList: [{ id: 'candidate-only', filledAt: policy.startedAt, exitedAt: new Date(now).toISOString(), actualRiskUsd: 500, netPnlUsd: 900, contracts: 1 }] });
  const report = { id: policy.id, policyHash: crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex'), engineCodeHash: policy.engineCodeHash, sourceRulesHash: policy.sourceRulesHash, integrityOk: true, startedAt: policy.startedAt, updatedAt: new Date(now).toISOString(), status: 'collecting', accounts, summary: { realizedPnlUsd: 0, closedTrades: 0, openPositions: 0, reservedRiskUsd: 0 }, comparison: { pairedComparisons: 0, deltaUsd: 0, controlPnlUsd: 0, candidatePnlUsd: 0, pairs: [] }, events: [] };
  const snapshot = { ok: true, source: 'remote-bridge', generatedAt: report.updatedAt, focusPaperTrial: report, strategies: policy.parents.map(parent => ({ slug: parent.slug, watcher: { isHealthy: true, processCount: 1 } })) };
  return { now, snapshot };
}
test('only the five new control ledgers reconcile into primary P&L; comparison stays separate', () => {
  const f = fixture(), view = buildFocusPaperView(f.snapshot, policy, f.now);
  assert.equal(view.dataStatus.ok, true);
  assert.equal(view.summary.realizedPnlUsd, 0);
  assert.equal(view.accounts.filter(account => account.arm === 'control').length, 5);
});
test('invalid candidate financial evidence cannot masquerade as a valid comparison', () => {
  const f = fixture();
  f.snapshot.focusPaperTrial.accounts.at(-1).tradeList = [];
  const view = buildFocusPaperView(f.snapshot, policy, f.now);
  assert.equal(view.dataStatus.ok, false);
  assert.equal(view.comparison.deltaUsd, null);
});
test('paired outcomes must reconcile to real trade IDs and the comparison total', () => {
  const f = fixture();
  f.snapshot.focusPaperTrial.comparison = { pairedComparisons: 1, deltaUsd: 900, controlPnlUsd: 0, candidatePnlUsd: 900, pairs: [{ id: 'pair', control: { status: 'unfilled', pnlUsd: 0, tradeId: null }, candidate: { status: 'closed', pnlUsd: 900, tradeId: 'candidate-only' } }] };
  assert.equal(buildFocusPaperView(f.snapshot, policy, f.now).dataStatus.ok, true);
  f.snapshot.focusPaperTrial.comparison.pairs[0].candidate.tradeId = 'missing';
  assert.equal(buildFocusPaperView(f.snapshot, policy, f.now).dataStatus.ok, false);
});
test('stale, changed-policy, unhealthy-source, and unreconciled reports hide current financial values', () => {
  for (const mutate of [f => { f.snapshot.source = 'remote-bridge-cache'; }, f => { f.snapshot.focusPaperTrial.updatedAt = new Date(f.now - 100000).toISOString(); }, f => { f.snapshot.focusPaperTrial.policyHash = 'changed'; }, f => { f.snapshot.focusPaperTrial.summary.realizedPnlUsd = 900; }, f => { f.snapshot.strategies[0].watcher.isHealthy = false; }]) {
    const f = fixture(); mutate(f);
    const view = buildFocusPaperView(f.snapshot, policy, f.now);
    assert.equal(view.dataStatus.ok, false);
    assert.equal(view.summary.realizedPnlUsd, null);
    assert.equal(view.accounts[0].balanceUsd, null);
    assert.deepEqual(view.events, []);
  }
});
