// Restarts missing paper strategy watchers without touching journals or balances.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { STRATEGIES, runtimeFilesForStrategy } = require('../lib/strategy-registry.cjs');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const STATE_FILE = path.join(RUNTIME, 'strategy-watchdog-state.json');
const COOLDOWN_MS = 5 * 60_000;

function isManagedWatcher(cwd, args, slug) {
  return cwd === ROOT && path.basename(args[0] || '') === 'node'
    && path.resolve(cwd, args[1] || '') === path.join(ROOT, 'paper-trader.cjs')
    && args[2] === 'watch-live' && args.includes(`--strategy=${slug}`)
    && args.includes('--provider=databento-live') && args.includes('--interval=60000');
}

function matchingPids(slug) {
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${entry}/cwd`);
      const args = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (!isManagedWatcher(cwd, args, slug)) continue;
      found.push(Number(entry));
    } catch { /* Process exited while scanning /proc. */ }
  }
  return found.sort((a, b) => a - b);
}

function atomicWrite(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function run() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  const state = (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { strategies: {} }; } })();
  state.strategies ||= {};
  let changed = false;
  for (const strategy of STRATEGIES) {
    const files = runtimeFilesForStrategy(ROOT, strategy.slug);
    const pids = matchingPids(strategy.slug);
    if (pids.length) {
      if (pids.length === 1) fs.writeFileSync(files.pidPath, `${pids[0]}\n`);
      state.strategies[strategy.slug] = { status: pids.length === 1 ? 'running' : 'duplicate-processes', pids, checkedAt: new Date().toISOString() };
      changed = true;
      continue;
    }
    const previous = state.strategies[strategy.slug] || {};
    const now = Date.now();
    if (Number(previous.nextStartAt || 0) > now) {
      state.strategies[strategy.slug] = { ...previous, status: 'restart-cooldown', checkedAt: new Date(now).toISOString() };
      changed = true;
      continue;
    }
    if (!process.env.DATABENTO_API_KEY?.trim()) {
      state.strategies[strategy.slug] = { status: 'missing-databento-key', pids: [], checkedAt: new Date(now).toISOString() };
      changed = true;
      continue;
    }
    const failures = Math.min(Number(previous.failures || 0) + 1, 6);
    const waitMs = Math.min(COOLDOWN_MS * (2 ** (failures - 1)), 60 * 60_000);
    const nextStartAt = now + waitMs;
    const logFd = fs.openSync(files.logPath, 'a');
    fs.writeSync(logFd, `\n[watchdog ${new Date(now).toISOString()}] restarting missing watcher ${strategy.slug}\n`);
    const child = spawn(process.execPath, ['paper-trader.cjs', 'watch-live', '--provider=databento-live', '--interval=60000', `--strategy=${strategy.slug}`], {
      cwd: ROOT, env: process.env, detached: true, stdio: ['ignore', logFd, logFd]
    });
    child.on('error', error => console.error(JSON.stringify({ strategy: strategy.slug, error: error.message })));
    child.unref();
    fs.closeSync(logFd);
    const record = { status: 'starting', pids: child.pid ? [child.pid] : [], failures, nextStartAt, checkedAt: new Date(now).toISOString() };
    state.strategies[strategy.slug] = record;
    if (child.pid) fs.writeFileSync(files.pidPath, `${child.pid}\n`);
    console.log(JSON.stringify({ strategy: strategy.slug, ...record }));
    changed = true;
  }
  if (changed) atomicWrite(STATE_FILE, state);
}

if (require.main === module) {
  try { process.chdir(ROOT); require('dotenv').config({ path: path.join(ROOT, '.env.local'), quiet: true }); run(); }
  catch (error) { console.error(`Strategy watchdog failed: ${error.message}`); process.exitCode = 1; }
}
module.exports = { isManagedWatcher, matchingPids, run };
