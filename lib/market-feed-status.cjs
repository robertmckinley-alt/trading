const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
function clock(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const minute = Number(p.hour) * 60 + Number(p.minute);
  const closed = p.weekday === 'Sat' || (p.weekday === 'Sun' && minute < 1080) || (p.weekday === 'Fri' && minute >= 1020) || (minute >= 1020 && minute < 1080);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const cash = require('./orb-session.cjs').session(date);
  return { regularMarketClosed: closed, orbEntryWindow: cash.open && minute >= 599 && minute <= 691, timeZone: 'America/New_York', calendar: `ORB: ${cash.reason}. Futures: regular weekly hours only; exchange holidays may differ.` };
}
function feedPids(root) {
  try { return fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).filter(p => {
    try { const args = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0'); return fs.readlinkSync(`/proc/${p}/cwd`) === root && /^python/.test(path.basename(args[0])) && args.some(a => a.endsWith('scripts/databento-live-feed.py')); } catch { return false; }
  }).map(Number); } catch { return []; }
}
function status(root, now = new Date()) {
  const hours = clock(now);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(path.resolve(root, config.live?.liveCachePath || 'runtime/databento-live.json'))); } catch { /* Missing or malformed. */ }
  const latestCandleAt = cache?.candles?.at(-1)?.timestamp || null;
  const ageSeconds = latestCandleAt ? Math.round((now.getTime() - Date.parse(latestCandleAt)) / 1000) : null;
  const fresh = cache?.mode === 'live' && cache?.provider === 'databento-live' && ageSeconds != null && ageSeconds >= 0 && ageSeconds <= 180;
  return { ...hours, latestCandleAt, ageSeconds, fresh, feedProcesses: feedPids(root).length,
    message: fresh ? hours.orbEntryWindow ? 'Fresh live candles. ORB setups are being evaluated.' : 'Fresh live candles. Waiting for the ORB entry window.' : hours.regularMarketClosed ? 'Regular futures session is closed. Waiting for fresh live candles after reopening.' : 'No fresh live candles. Check the shared Databento feed.',
    paperSettings: { startingBalanceUsd: 50000, contractsPerSignal: 1, dollarRiskCap: null, accountLossCutoff: false, provider: 'databento-live', historicalFallback: false } };
}
let lastStart = 0;
function ensureFeed(root) {
  if (!fs.existsSync(path.join(root, 'runtime', 'orb-forward', 'enabled')) || !process.env.DATABENTO_API_KEY || feedPids(root).length || Date.now() - lastStart < 60000) return;
  lastStart = Date.now();
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
  const log = fs.openSync(path.join(root, 'runtime', 'databento-live-feed.log'), 'a');
  try {
    const child = spawn(config.live?.pythonBin || 'python3', ['scripts/databento-live-feed.py', '--output', config.live?.liveCachePath || 'runtime/databento-live.json', '--dataset', config.live?.dataset || 'GLBX.MDP3', '--symbol', config.live?.ticker || 'NQ.v.0'], { cwd: root, detached: true, stdio: ['ignore', log, log] });
    child.on('error', () => console.error('Could not start Databento feed; check Python installation.'));
    child.unref();
  } finally { fs.closeSync(log); }
}
module.exports = { clock, status, ensureFeed };
