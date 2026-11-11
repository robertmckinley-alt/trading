#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function read(file, allowMissing = false) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw new Error(`Cannot read ${path.basename(file)}; saved evidence was not reset.`); }
}
function atomic(file, data) {
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data) + '\n');
  fs.renameSync(temp, file);
}
function codeHash(root, files) {
  const digest = crypto.createHash('sha256');
  for (const file of files) {
    const target = path.resolve(root, file);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid frozen engine path');
    digest.update(file + '\0');
    digest.update(fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n'));
    digest.update('\0');
  }
  return digest.digest('hex');
}
function signalsFromParents(rows, policy, now) {
  return rows.flatMap(({ parent, state }) => {
    const setup = state?.live?.openPlan?.setup;
    if (!setup) return [];
    const at = Date.parse(setup.observedAt || '');
    const expiry = Date.parse(setup.orderExpiresAt || '');
    if (!Number.isFinite(at) || at < Date.parse(policy.startedAt) || at > now || !Number.isFinite(expiry) || expiry <= now) return [];
    const id = hash([parent.slug, setup.observedAt, setup.signalOriginAvailableAt || setup.signalAvailableAt, setup.entry]);
    return [{ id, parent: parent.slug, family: parent.family, observedAt: setup.observedAt, setup: structuredClone(setup) }];
  });
}
function integrityStatus(prior, frozen, policy, source, actualCodeHash, now) {
  const failures = [];
  if (hash(frozen) !== hash(policy)) failures.push('The registered paper policy changed.');
  if (!source.matches || source.actualHash !== frozen.sourceRulesHash) failures.push('The frozen parent execution source changed.');
  if (actualCodeHash !== frozen.engineCodeHash) failures.push('The frozen paper engine changed or is unavailable.');
  return {
    integrityInvalidatedAt: prior?.integrityInvalidatedAt || (failures.length ? new Date(now).toISOString() : null),
    integrityInvalidationReason: prior?.integrityInvalidationReason || (failures.length ? failures.join(' ') : null)
  };
}
function tick(root = ROOT, now = Date.now()) {
  const engine = require('../lib/focus-paper.cjs');
  const directory = path.join(root, 'runtime/focus-paper-v2');
  fs.mkdirSync(directory, { recursive: true });
  const policy = read(path.join(root, 'config/focus-paper-v2.json'));
  const prior = read(path.join(directory, 'state.json'), true);
  const frozen = prior?.registeredPolicy || policy;
  const hours = require('../lib/market-feed-status.cjs').clock(new Date(now), root, 'NQ.v.0');
  const source = require('../lib/focus-integrity.cjs').getFocusRuleStatus(root, read(path.join(root, 'config/profit-focus-v1.json')));
  const reasons = [];
  let actualCodeHash = null;
  try { actualCodeHash = codeHash(root, frozen.engineFiles); }
  catch { /* A missing execution file permanently invalidates this cohort. */ }
  const invalidation = integrityStatus(prior, frozen, policy, source, actualCodeHash, now);
  if (invalidation.integrityInvalidatedAt) reasons.push(invalidation.integrityInvalidationReason);
  // Persist the latch before feed/settlement work, even if that later work fails.
  if (invalidation.integrityInvalidatedAt) atomic(path.join(directory, 'state.json'), { ...(prior || engine.initial(frozen, now)), registeredPolicy: frozen, ...invalidation });
  const base = read(path.join(root, 'config.json'));
  const cache = read(path.resolve(root, base.live?.liveCachePath || 'runtime/databento-live.json'));
  if (!Array.isArray(cache.candles)) throw new Error('The live NQ cache is unavailable.');
  const rows = [];
  for (const parent of frozen.parents) {
    try {
      const files = require('../lib/strategy-registry.cjs').runtimeFilesForStrategy(root, parent.slug);
      const state = read(files.statePath);
      const heartbeat = state.live?.heartbeat;
      const at = Date.parse(heartbeat?.at || '');
      const lock = read(path.join(root, 'runtime', `${parent.slug}-watch.lock`));
      const owner = require('../lib/watcher-process.cjs').inspectLockOwner(lock, root, parent.slug);
      if (!Number.isFinite(at) || now - at > 180000 || at > now + 5000 || !owner.active || owner.reason !== 'live watcher owner' || (heartbeat.ok !== true && !hours.regularMarketClosed && !hours.holidayClosed)) reasons.push(`Parent signal source is unavailable: ${parent.slug}.`);
      rows.push({ parent, state });
    } catch { reasons.push(`Parent journal is unreadable: ${parent.slug}.`); }
  }
  const integrityOk = reasons.length === 0;
  const next = engine.advance(prior || engine.initial(frozen, now), integrityOk ? signalsFromParents(rows, frozen, now) : [], cache.candles, frozen, now, { integrityOk, marketClosed: Boolean(hours.regularMarketClosed || hours.holidayClosed) });
  next.registeredPolicy = frozen;
  Object.assign(next, invalidation);
  atomic(path.join(directory, 'state.json'), next);
  const report = engine.report(next, frozen);
  Object.assign(report, { policyHash: hash(frozen), engineCodeHash: actualCodeHash, sourceRulesHash: source.actualHash, integrityOk });
  if (!integrityOk) { report.status = 'integrity-blocked'; report.reason = reasons.join(' '); }
  else if ((hours.regularMarketClosed || hours.holidayClosed) && !Object.values(next.accounts).some(account => account.status === 'data-gap')) report.status = 'market-closed';
  atomic(path.join(directory, 'report.json'), report);
  return report;
}
function acquireLock(root = ROOT) {
  const file = path.join(root, 'runtime/focus-paper-v2/worker.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID();
  const inspect = record => require('../lib/watcher-process.cjs').inspectLockOwner(record, root, 'focus-paper-v2', '/proc', 'scripts/focus-paper-worker.cjs');
  const identity = inspect({ pid: process.pid });
  const record = { pid: process.pid, token, startTicks: identity.startTicks };
  for (let i = 0; i < 3; i++) {
    let fd;
    try { fd = fs.openSync(file, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const raw = fs.readFileSync(file, 'utf8'), prior = JSON.parse(raw);
      if (!Number.isInteger(prior.pid) || prior.pid <= 0 || inspect(prior).active) throw new Error('A paper worker owns this trial, or its owner cannot be verified.');
      if (fs.readFileSync(file, 'utf8') === raw) fs.unlinkSync(file);
      continue;
    }
    try { fs.writeFileSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
    return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch { /* No longer owned. */ } };
  }
  throw new Error('Paper worker startup contention.');
}
function main() {
  if (!fs.existsSync('/proc/self')) throw new Error('The paper worker requires the Linux execution host.');
  process.chdir(ROOT);
  require('dotenv').config({ path: path.join(ROOT, '.env.local'), quiet: true });
  const release = acquireLock();
  process.once('exit', release);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => process.exit(0));
  const run = () => {
    try { tick(); }
    catch (error) {
      console.error(new Date().toISOString(), error.message);
      const directory = path.join(ROOT, 'runtime/focus-paper-v2');
      atomic(path.join(directory, 'report.json'), { id: 'focus-paper-1000-v2', status: 'error', updatedAt: new Date().toISOString(), reason: error.message, integrityOk: false });
    }
  };
  run();
  if (process.argv.includes('--watch')) setInterval(run, 5000);
}
if (require.main === module) main();
module.exports = { tick, signalsFromParents, codeHash, acquireLock, integrityStatus };
