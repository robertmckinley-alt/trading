const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startChallenger, acquireManagerLock } = require('../scripts/challenger-watchdog.cjs');
const slug = 'volume-poc-reversion-x-market-regime-balanced-4519a709';
const temporary = fn => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-watchdog-'));
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.writeFileSync(path.join(root, 'runtime', 'challenger-accounts.json'), JSON.stringify({ accounts: [{
    slug, parentStrategySlug: 'volume-poc-reversion', accountType: 'challenger', status: 'active',
    experiment: { paperOnly: true, rulesFrozen: true }
  }] }));
  try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
};

test('new challengers canonicalize legacy Databento provider without altering requested interval', () => temporary(rootDir => {
  let args;
  const result = startChallenger({ slug }, { rootDir, provider: 'databento', intervalMs: 60000,
    findPids: () => [], inspectOwner: () => ({ active: false }),
    spawn: (_executable, argv) => { args = argv; return { pid: 1234, unref() {} }; } });
  assert.equal(result.state, 'started');
  assert.ok(args.includes('--provider=databento-live'));
  assert.ok(args.includes('--interval=60000'));
}));

test('live writer lock wins over an overwritten PID file and zero strict process matches', () => temporary(rootDir => {
  fs.writeFileSync(path.join(rootDir, 'runtime', `${slug}-watch.pid`), '9999');
  fs.writeFileSync(path.join(rootDir, 'runtime', `${slug}-watch.lock`), JSON.stringify({ pid: 368, startTicks: '123' }));
  const result = startChallenger({ slug }, { rootDir, findPids: () => [],
    inspectOwner: record => ({ active: record.pid === 368, reason: 'live watcher owner' }),
    spawn: () => { assert.fail('must not spawn over existing account writer'); } });
  assert.equal(result.pid, 368);
  assert.equal(result.state, 'running');
}));

test('unknown live watcher ownership prevents spawning', () => temporary(rootDir => {
  fs.writeFileSync(path.join(rootDir, 'runtime', `${slug}-watch.lock`), JSON.stringify({ pid: 368 }));
  const result = startChallenger({ slug }, { rootDir,
    inspectOwner: () => ({ active: true, reason: 'owner identity could not be verified' }),
    spawn: () => assert.fail('unknown ownership must remain protected') });
  assert.equal(result.state, 'owner-unverified');
}));

test('singleton manager rejects a second manager and safely releases ownership', () => temporary(rootDir => {
  const inspectOwner = () => ({ active: true, reason: 'live watcher owner', startTicks: '123' });
  const release = acquireManagerLock(rootDir, { inspectOwner });
  assert.throws(() => acquireManagerLock(rootDir, { inspectOwner }), /already running/);
  const competing = spawnSync(process.execPath, ['-e', `
    const { acquireManagerLock } = require(process.argv[1]);
    try {
      acquireManagerLock(process.argv[2], { inspectOwner: record => {
        try { process.kill(record.pid, 0); return {active:true,reason:'live owner'}; }
        catch { return {active:false}; }
      }});
      process.exitCode=2;
    } catch(error) { console.log(error.message); process.exitCode=1; }
  `, require.resolve('../scripts/challenger-watchdog.cjs'), rootDir], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(competing.status, 1);
  assert.match(competing.stdout, /already running/);
  release();
  const releaseAgain = acquireManagerLock(rootDir, { inspectOwner });
  releaseAgain();
}));

test('manager recovers verified stale or zombie owner but retains unreadable live owner', () => temporary(rootDir => {
  const file = path.join(rootDir, 'runtime', 'challenger-manager-watch.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 1234, startTicks: 'old', token: 'stale' }));
  const release = acquireManagerLock(rootDir, { inspectOwner: record => ({
    active: record.pid !== 1234, reason: 'exited owner', startTicks: 'new' }) });
  assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid);
  release();
  fs.writeFileSync(file, JSON.stringify({ pid: 5678, token: 'unknown' }));
  assert.throws(() => acquireManagerLock(rootDir, { inspectOwner: () => ({
    active: true, reason: 'owner identity could not be verified' }) }), /unverified/);
  assert.equal(JSON.parse(fs.readFileSync(file)).token, 'unknown');
}));
