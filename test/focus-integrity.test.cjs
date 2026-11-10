const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { getFocusRuleStatus } = require('../lib/focus-integrity.cjs');

test('execution fingerprint blocks a rules change permanently, even after reversion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-integrity-'));
  try {
    fs.writeFileSync(path.join(root, 'rules.cjs'), 'baseline\n');
    const expectedRulesHash = crypto.createHash('sha256').update('rules.cjs\0baseline\n\0').digest('hex');
    const manifest = { id: 'profit-focus-v1', rulesFiles: ['rules.cjs'], expectedRulesHash };
    assert.equal(getFocusRuleStatus(root, manifest).matches, true);
    fs.writeFileSync(path.join(root, 'rules.cjs'), 'changed\n');
    const changed = getFocusRuleStatus(root, manifest);
    assert.equal(changed.matches, false);
    assert.ok(changed.invalidatedAt);
    fs.writeFileSync(path.join(root, 'rules.cjs'), 'baseline\n');
    const reverted = getFocusRuleStatus(root, manifest);
    assert.equal(reverted.actualHash, expectedRulesHash);
    assert.equal(reverted.matches, false);
    assert.equal(reverted.invalidatedAt, changed.invalidatedAt);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('changing trial policy under the same version invalidates the registration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-policy-'));
  try {
    fs.writeFileSync(path.join(root, 'rules.cjs'), 'baseline');
    const expectedRulesHash = crypto.createHash('sha256').update('rules.cjs\0baseline\0').digest('hex');
    const manifest = { id: 'profit-focus-v1', rulesFiles: ['rules.cjs'], expectedRulesHash, minTrades: 100 };
    assert.equal(getFocusRuleStatus(root, manifest).matches, true);
    const result = getFocusRuleStatus(root, { ...manifest, minTrades: 10 });
    assert.equal(result.matches, false);
    assert.match(result.reason, /policy changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing files block validation and cannot be treated as an empty matching hash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-missing-'));
  try {
    const result = getFocusRuleStatus(root, { id: 'profit-focus-v1', rulesFiles: ['missing.cjs'], expectedRulesHash: 'test' });
    assert.equal(result.actualHash, null);
    assert.equal(result.matches, false);
    assert.deepEqual(result.missingFiles, ['missing.cjs']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('restoring a missing execution file does not reset the invalidated trial', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-restored-'));
  try {
    const file = path.join(root, 'rules.cjs');
    fs.writeFileSync(file, 'baseline');
    const expectedRulesHash = crypto.createHash('sha256').update('rules.cjs\0baseline\0').digest('hex');
    const manifest = { id: 'profit-focus-v1', rulesFiles: ['rules.cjs'], expectedRulesHash };
    assert.equal(getFocusRuleStatus(root, manifest).matches, true);
    fs.unlinkSync(file);
    const missing = getFocusRuleStatus(root, manifest);
    assert.ok(missing.invalidatedAt);
    fs.writeFileSync(file, 'baseline');
    const restored = getFocusRuleStatus(root, manifest);
    assert.equal(restored.actualHash, expectedRulesHash);
    assert.equal(restored.matches, false);
    assert.equal(restored.invalidatedAt, missing.invalidatedAt);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
