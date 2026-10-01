const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
function isManagedWatcher(cwd, args, slug, rootDir = ROOT) {
  return path.resolve(cwd) === path.resolve(rootDir) && path.basename(args[0] || '') === 'node'
    && path.resolve(cwd, args[1] || '') === path.join(path.resolve(rootDir), 'paper-trader.cjs')
    && args[2] === 'watch-live' && args.includes(`--strategy=${slug}`)
    && args.includes('--provider=databento-live') && args.includes('--interval=60000');
}
function matchingPids(slug, rootDir = ROOT, procDir = '/proc') {
  if (!fs.existsSync(procDir)) return null; // Unknown on non-Linux hosts, not zero.
  const found = [];
  for (const entry of fs.readdirSync(procDir)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cwd = fs.readlinkSync(path.join(procDir, entry, 'cwd'));
      const args = fs.readFileSync(path.join(procDir, entry, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      if (isManagedWatcher(cwd, args, slug, rootDir)) found.push(Number(entry));
    } catch { /* Process exited while scanning. */ }
  }
  return found.sort((a, b) => a - b);
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function acquireWatcherLock(rootDir, slug, options = {}) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid watcher strategy slug');
  const others = (options.findPids || matchingPids)(slug, rootDir)?.filter(pid => pid !== process.pid) || [];
  if (others.length) throw new Error(`Watcher already running for ${slug}; refusing a second journal writer`);
  const directory = path.join(rootDir, 'runtime');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${slug}-watch.lock`);
  const record = { pid: process.pid, token: randomUUID(), slug, rootDir: path.resolve(rootDir) };
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try { fd = fs.openSync(file, 'wx'); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let raw, prior;
      try { raw = fs.readFileSync(file, 'utf8'); prior = JSON.parse(raw); } catch {
        throw new Error(`Watcher lock for ${slug} is unreadable; refusing concurrent startup`);
      }
      if (!Number.isInteger(prior.pid) || prior.pid <= 0) throw new Error(`Invalid owner in ${slug} watcher lock`);
      if ((options.pidAlive || pidAlive)(prior.pid)) throw new Error(`Watcher already owns ${slug}; refusing a second journal writer`);
      // Do not unlink a lock another contender replaced while it was inspected.
      try { if (fs.readFileSync(file, 'utf8') === raw) fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      continue;
    }
    try { fs.writeFileSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
    return () => {
      try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === record.token) fs.unlinkSync(file); } catch { /* Already removed. */ }
    };
  }
  throw new Error(`Watcher startup contention for ${slug}`);
}
module.exports = { ROOT, isManagedWatcher, matchingPids, acquireWatcherLock };
