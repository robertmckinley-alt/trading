const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const forward = require('../lib/orb-forward.cjs');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'runtime', 'orb-forward');
const pidFile = path.join(dir, 'runner.pid');
function alive() {
  try { const pid = Number(fs.readFileSync(pidFile, 'utf8')); if (pid > 0) { process.kill(pid, 0); return true; } } catch { /* Stopped. */ }
  return false;
}
function ensure() {
  if (!fs.existsSync(path.join(dir, 'enabled')) || alive()) return;
  const log = fs.openSync(path.join(dir, 'runner.log'), 'a');
  try { const child = spawn(process.execPath, [__filename, '--run'], { cwd: root, detached: true, stdio: ['ignore', log, log] }); child.unref(); } finally { fs.closeSync(log); }
}
async function run() {
  fs.mkdirSync(dir, { recursive: true });
  try { fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx' }); } catch {
    if (alive()) return;
    try { fs.unlinkSync(pidFile); fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx' }); } catch { return; }
  }
  process.on('exit', () => { try { if (Number(fs.readFileSync(pidFile)) === process.pid) fs.unlinkSync(pidFile); } catch { /* Removed. */ } });
  for (const event of ['SIGTERM', 'SIGINT']) process.on(event, () => process.exit(0));
  require('dotenv').config({ path: path.join(root, '.env.local'), quiet: true });
  const config = require('../lib/trader-core.cjs').normalizeConfig(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))));
  config.live = { ...config.live, provider: 'databento-live' };
  const stateFile = path.join(dir, 'state.json');
  const historyFile = path.join(dir, 'candles.json');
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : forward.createState(config);
  if (state.version !== forward.version(config)) {
    state.status = 'rules-changed-review-required'; state.heartbeat = new Date().toISOString(); forward.atomic(stateFile, state);
    throw new Error('Rules changed. Existing forward journal retained; review before starting a new experiment.');
  }
  let history = forward.mergeCandles(forward.readWarmup(root, config), fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile)) : []);
  console.log(`${new Date().toISOString()} STARTED nine ORB forward-paper accounts; rules=${state.version}`);
  async function tick() {
    try {
      const { candles } = await require('../lib/live-trader.cjs').fetchLiveCandles(config);
      const now = Date.now();
      // Work on a copy: a failed tick cannot partially journal a trade twice.
      const next = JSON.parse(JSON.stringify(state));
      forward.advance(next, candles, history, config, now);
      if (next.status === 'running' && !require('../lib/market-feed-status.cjs').clock(new Date(now)).orbEntryWindow) next.status = 'watching-outside-orb-window';
      const changed = next.cursor !== state.cursor;
      forward.atomic(stateFile, next); state = next;
      if (changed) {
        history = forward.mergeCandles(history, candles).filter(c => Date.parse(c.timestamp) >= now - 75 * 86400000 && Date.parse(c.timestamp) + 60000 <= now);
        forward.atomic(historyFile, history);
      }
    } catch (error) {
      state.heartbeat = new Date().toISOString();
      state.status = /Missing .*environment variable/.test(error.message) ? 'missing-data-configuration' : require('../lib/market-feed-status.cjs').clock().regularMarketClosed ? 'market-closed' : 'feed-or-processing-error';
      forward.atomic(stateFile, state);
      console.error(`${state.heartbeat} ${error.message}`);
    }
    setTimeout(tick, 15000);
  }
  await tick();
}
if (require.main === module) {
  if (process.argv.includes('--restart')) {
    (async () => {
      if (alive()) {
        const pid = Number(fs.readFileSync(pidFile));
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!args.includes(__filename)) throw new Error('PID does not belong to the ORB runner.');
        process.kill(pid, 'SIGTERM');
        for (let i = 0; i < 50 && alive(); i++) await new Promise(r => setTimeout(r, 100));
        if (alive()) throw new Error('ORB runner did not stop.');
      }
      ensure(); console.log('ORB runner restarted with existing accounts and journals.');
    })().catch(e => { console.error(e.message); process.exitCode = 1; });
  } else if (process.argv.includes('--enable')) {
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'enabled'), 'paper-only\n'); ensure();
    console.log('ORB paper runner enabled. Check runtime/orb-forward/runner.log and the ORB Live Paper section.');
  } else if (process.argv.includes('--run')) run().catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { ensure };
