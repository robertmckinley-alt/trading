const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { signalsFromParents, codeHash, tick } = require('../scripts/focus-paper-worker.cjs');

test('only prospectively observed, unexpired parent plans can enter the new paper book', () => {
  const policy = { startedAt: '2026-11-10T18:00:00Z' }, now = Date.parse('2026-11-10T18:02:00Z');
  const make = (observedAt, expiry = '2026-11-10T18:04:00Z') => ({ parent: { slug: 'parent', family: 'family' }, state: { live: { openPlan: { setup: { observedAt, orderExpiresAt: expiry, entry: 100, signalOriginAvailableAt: observedAt } } } } });
  assert.equal(signalsFromParents([make('2026-11-10T17:59:00Z')], policy, now).length, 0);
  assert.equal(signalsFromParents([make('2026-11-10T18:03:00Z')], policy, now).length, 0);
  assert.equal(signalsFromParents([make('2026-11-10T18:01:00Z', '2026-11-10T18:02:00Z')], policy, now).length, 0);
  const parent = make('2026-11-10T18:01:00Z');
  const first = signalsFromParents([parent], policy, now)[0];
  first.setup.entry = 999;
  assert.equal(parent.state.live.openPlan.setup.entry, 100);
  parent.state.live.openPlan.setup.currentStop = 90;
  assert.equal(signalsFromParents([parent], policy, now)[0].id, first.id);
});

test('the paper engine fingerprint changes with execution code and refuses an external path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-code-'));
  try {
    fs.writeFileSync(path.join(root, 'engine.cjs'), 'baseline\r\n');
    const before = codeHash(root, ['engine.cjs']);
    fs.writeFileSync(path.join(root, 'engine.cjs'), 'changed\n');
    assert.notEqual(codeHash(root, ['engine.cjs']), before);
    assert.throws(() => codeHash(root, ['../external.cjs']), /Invalid frozen engine path/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a corrupt saved paper journal is retained and cannot silently reset account balances', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-corrupt-'));
  try {
    fs.mkdirSync(path.join(root, 'config'));
    fs.mkdirSync(path.join(root, 'runtime/focus-paper-v2'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config/focus-paper-v2.json'), '{}');
    const state = path.join(root, 'runtime/focus-paper-v2/state.json');
    fs.writeFileSync(state, '{corrupt');
    assert.throws(() => tick(root), /saved evidence was not reset/);
    assert.equal(fs.readFileSync(state, 'utf8'), '{corrupt');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('policy or engine changes permanently invalidate a cohort even after restoration', () => {
  const { integrityStatus } = require('../scripts/focus-paper-worker.cjs');
  const frozen = { engineCodeHash: 'code', sourceRulesHash: 'source' }, source = { matches: true, actualHash: 'source' };
  assert.equal(integrityStatus(null, frozen, frozen, source, 'code', 1000).integrityInvalidatedAt, null);
  for (const [policy, code] of [[{ ...frozen, risk: 2000 }, 'code'], [frozen, 'changed'], [frozen, null]]) {
    const first = integrityStatus(null, frozen, policy, source, code, 1000);
    assert.equal(first.integrityInvalidatedAt, new Date(1000).toISOString());
    assert.deepEqual(integrityStatus(first, frozen, frozen, source, 'code', 2000), first);
  }
});
