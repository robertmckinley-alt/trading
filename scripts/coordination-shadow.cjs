#!/usr/bin/env node
// Reads watcher state and cached candles only. Writes only its own shadow report.
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'runtime/coordination-shadow');
const model = require('../lib/coordination-shadow.cjs');
const { getStrategyDefinitions, runtimeFilesForStrategy } = require('../lib/strategy-registry.cjs');
const { normalizeConfig } = require('../lib/trader-core.cjs');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const ownerActive = pid => Number.isInteger(pid) && pid > 0 && require('../lib/watcher-process.cjs').inspectLockOwner({pid},root,'coordination-shadow','/proc','scripts/coordination-shadow.cjs').active;
function tick() {
  const base = read(path.join(root, 'config.json'));
  if (!base) throw Error('Config unavailable');
  const accounts = getStrategyDefinitions(root).flatMap(d => {
    const state = read(runtimeFilesForStrategy(root, d.slug).statePath);
    if (!state) return [];
    const slug = d.detectorStrategySlug || d.parentStrategySlug || d.slug;
    const raw = slug === 'mgc-open-ema12' ? require('../lib/gold-open-ema.cjs').config(base) : slug === 'nq-fresh-level-retest' ? { ...base, ...require('../lib/fresh-level-retest.cjs').ACCOUNT } : slug === 'nq-vwap-stretch-reversion' ? { ...base, ...require('../lib/vwap-stretch.cjs').ACCOUNT } : base;
    const config = normalizeConfig(raw);
    const cache = read(path.resolve(root, raw.live?.liveCachePath || 'runtime/databento-live.json'));
    return [{ slug: d.slug, trades: state.trades || [], plan: state.live?.openPlan, lifecycle: state.live?.openLifecycle, heartbeat: state.live?.heartbeat, config: Object.fromEntries(['startingBalanceUsd','maxAccountDrawdownPercent','maxRiskPerTradeUsd','tickSize','tickValueUsd','commissionPerContractUsd','slippageTicks','limitFillModel','sameCandleConflict','defaultScaleOuts'].map(k => [k, config[k]])), candles: cache?.candles || [] }];
  });
  const prior = read(path.join(folder, 'state.json'));
  const state = model.advance(prior, accounts, Date.now());
  for (const [name, value] of [['state', state], ['report', model.report(state)]]) {
    fs.writeFileSync(path.join(folder, `${name}.tmp`), JSON.stringify(value));
    fs.renameSync(path.join(folder, `${name}.tmp`), path.join(folder, `${name}.json`));
  }
}
function main() {
  fs.mkdirSync(folder, { recursive: true });
  if (process.argv.includes('--start')) {
    const pid = read(path.join(folder, 'worker.pid'));
    if (ownerActive(pid)) { console.log(`Shadow controller already running: ${pid}`); return; }
    const fd = fs.openSync(path.join(folder, 'worker.log'), 'a');
    const child = spawn(process.execPath, [__filename], { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', e => { console.error(e.message); process.exitCode = 1; });
    child.unref(); fs.closeSync(fd);
    console.log(`Shadow controller launched PID ${child.pid}; verify runtime/coordination-shadow/report.json heartbeat.`);
    return;
  }
  const lock = path.join(folder, 'worker.pid');
  try { fs.writeFileSync(lock, JSON.stringify(process.pid), { flag: 'wx' }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = read(lock);
    if (!Number.isInteger(pid) || pid <= 0) throw Error('Invalid coordination owner; inspect worker.pid before recovery');
    if (ownerActive(pid)) throw Error(`Controller already running: ${pid}`);
    fs.unlinkSync(lock); fs.writeFileSync(lock, JSON.stringify(process.pid), { flag: 'wx' });
  }
  const clean = () => { if (read(lock) === process.pid) fs.unlinkSync(lock); };
  process.on('exit', clean); process.on('SIGTERM', () => process.exit(0)); process.on('SIGINT', () => process.exit(0));
  const run = () => { try { tick(); } catch (e) { console.error(new Date().toISOString(), e.message); } };
  run(); if (!process.argv.includes('--once')) setInterval(run, 5000);
}
if (require.main === module) main();
module.exports = { tick };
