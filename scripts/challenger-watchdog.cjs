#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const { loadChallengerDefinitions, runtimeFilesForStrategy } = require('../lib/strategy-registry.cjs');
const { inspectLockOwner, matchingPids } = require('../lib/watcher-process.cjs');

function canonicalProvider(provider) {
  return provider === 'databento' ? 'databento-live' : provider;
}

function acquireManagerLock(rootDir = ROOT_DIR, options = {}) {
  const inspect = options.inspectOwner || ((record) => inspectLockOwner(record, rootDir,
    'challenger-manager', '/proc', 'scripts/challenger-watchdog.cjs'));
  const directory = path.join(rootDir, 'runtime');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'challenger-manager-watch.lock');
  const record = { pid: process.pid, token: randomUUID() };
  const identity = inspect(record);
  if (identity.startTicks) record.startTicks = identity.startTicks;
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try { fd = fs.openSync(file, 'wx'); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let raw, prior;
      try { raw = fs.readFileSync(file, 'utf8'); prior = JSON.parse(raw); }
      catch { throw new Error('Challenger manager lock is unreadable; refusing concurrent startup'); }
      if (!Number.isInteger(prior.pid) || prior.pid <= 0) throw new Error('Invalid challenger manager lock owner');
      const owner = inspect(prior);
      if (owner.active) throw new Error(`Challenger manager already running or owner unverified (${owner.reason})`);
      // Only recover the exact stale record inspected, never a replacement lock.
      try { if (fs.readFileSync(file, 'utf8') === raw) fs.unlinkSync(file); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      continue;
    }
    try { fs.writeFileSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
    return () => {
      try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === record.token) fs.unlinkSync(file); }
      catch { /* Already released or replaced. */ }
    };
  }
  throw new Error('Challenger manager startup contention');
}

function pidIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidPath) {
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function startChallenger(definition, options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const provider = canonicalProvider(options.provider || process.env.LIVE_DATA_PROVIDER || 'databento-live');
  const intervalMs = Math.max(1000, Number(options.intervalMs || process.env.CHALLENGER_POLL_INTERVAL_MS || 60000));
  const files = runtimeFilesForStrategy(rootDir, definition.slug);
  fs.mkdirSync(path.dirname(files.logPath), { recursive: true });
  const inspect = options.inspectOwner || ((record) => inspectLockOwner(record, rootDir, definition.slug));
  const lockPath = path.join(rootDir, 'runtime', `${definition.slug}-watch.lock`);
  let lock;
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Unreadable watcher lock for ${definition.slug}; refusing startup`); }
  if (lock !== undefined) {
    if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error(`Invalid watcher lock for ${definition.slug}`);
    const owner = inspect(lock);
    if (owner.active) return { state: owner.reason === 'live watcher owner' ? 'running' : 'owner-unverified', slug: definition.slug, pid: lock.pid };
  }
  const pids = (options.findPids || matchingPids)(definition.slug, rootDir);
  if (pids?.length) return { state: pids.length === 1 ? 'running' : 'duplicate-processes', slug: definition.slug, pid: pids[0], pids };
  const existingPid = readPid(files.pidPath);
  if (existingPid) {
    const owner = inspect({ pid: existingPid });
    if (owner.active) return { state: owner.reason === 'live watcher owner' ? 'running' : 'owner-unverified', slug: definition.slug, pid: existingPid };
  }

  const logFd = fs.openSync(files.logPath, 'a');
  let child;
  try {
    child = (options.spawn || spawn)(process.execPath, [
      path.join(rootDir, 'paper-trader.cjs'),
      'watch-live',
      `--provider=${provider}`,
      `--interval=${intervalMs}`,
      `--strategy=${definition.slug}`
    ], {
      cwd: rootDir,
      detached: true,
      env: process.env,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true
    });
  } finally {
    fs.closeSync(logFd);
  }
  fs.writeFileSync(files.pidPath, `${child.pid}\n`);
  child.unref();
  return { state: 'started', slug: definition.slug, pid: child.pid };
}

function checkChallengers(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  return loadChallengerDefinitions(rootDir).map((definition) => startChallenger(definition, { ...options, rootDir }));
}

function parseOptions(argv) {
  return {
    watch: argv.includes('--watch'),
    intervalMs: Number(argv.find((arg) => arg.startsWith('--interval='))?.split('=')[1] || 30000)
  };
}

async function main() {
  require('dotenv').config({path:path.join(ROOT_DIR,'.env.local'),quiet:true});
  const options = parseOptions(process.argv.slice(2));
  const release = options.watch ? acquireManagerLock() : () => {};
  process.once('exit', release);
  if (options.watch) {
    process.once('SIGTERM', () => process.exit(0));
    process.once('SIGINT', () => process.exit(0));
  }
  const run = () => {
    const results = checkChallengers();
    if (results.length) console.log(JSON.stringify({ checkedAt: new Date().toISOString(), challengers: results }));
  };
  run();
  if (!options.watch) return;
  setInterval(run, Math.max(5000, options.intervalMs));
  await new Promise(() => {});
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { checkChallengers, pidIsRunning, startChallenger, canonicalProvider, acquireManagerLock };
