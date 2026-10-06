#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const { loadChallengerDefinitions, runtimeFilesForStrategy } = require('../lib/strategy-registry.cjs');

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
  const provider = options.provider || process.env.LIVE_DATA_PROVIDER || 'databento-live';
  const intervalMs = Math.max(1000, Number(options.intervalMs || process.env.CHALLENGER_POLL_INTERVAL_MS || 60000));
  const files = runtimeFilesForStrategy(rootDir, definition.slug);
  fs.mkdirSync(path.dirname(files.logPath), { recursive: true });
  const existingPid = readPid(files.pidPath);
  if (existingPid && require('../lib/watcher-process.cjs').inspectLockOwner({pid:existingPid},rootDir,definition.slug).active) {
    return { state: 'running', slug: definition.slug, pid: existingPid };
  }

  const logFd = fs.openSync(files.logPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [
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

module.exports = { checkChallengers, pidIsRunning, startChallenger };
