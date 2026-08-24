const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { normalizeConfig } = require('./trader-core.cjs');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function safeReadJson(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function safeReadText(filePath) {
  try {
    return readText(filePath);
  } catch {
    return null;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'pid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return output === String(pid);
  } catch {
    return false;
  }
}

function parseLastCandle(logText) {
  const matches = [...String(logText || '').matchAll(/Last candle:\s+([^\s]+)\s+O:([-\d.]+)\s+H:([-\d.]+)\s+L:([-\d.]+)\s+C:([-\d.]+)/g)];
  const last = matches.at(-1);
  if (!last) {
    return null;
  }
  return {
    timestamp: last[1],
    open: Number(last[2]),
    high: Number(last[3]),
    low: Number(last[4]),
    close: Number(last[5])
  };
}

function parseLatestReason(logText) {
  const matches = [...String(logText || '').matchAll(/No trade:\s+(.+)/g)];
  return matches.at(-1)?.[1] || null;
}

function parseLatestError(logText) {
  const matches = [...String(logText || '').matchAll(/\[(.*?)\]\s+live watch error:\s+(.+)/g)];
  const last = matches.at(-1);
  if (!last) {
    return null;
  }
  return {
    at: last[1],
    message: last[2]
  };
}

function summarizeJournal(state) {
  const trades = Array.isArray(state?.trades) ? state.trades : [];
  const realizedPnlUsd = Number(state?.realizedPnlUsd || 0);
  const wins = trades.filter((trade) => Number(trade.realizedPnlUsd || 0) > 0).length;
  const losses = trades.filter((trade) => Number(trade.realizedPnlUsd || 0) < 0).length;
  return {
    trades: trades.length,
    wins,
    losses,
    realizedPnlUsd,
    balanceUsd: Number(state?.balanceUsd || 0),
    lastUpdatedAt: state?.lastUpdatedAt || null
  };
}

function buildNineAmStrategy(config, state, logText, pid, sourceMode) {
  const lastCandle = parseLastCandle(logText);
  const reason = parseLatestReason(logText);
  const latestError = parseLatestError(logText);
  const isRunning = isPidRunning(pid);
  const journal = summarizeJournal(state);

  return {
    slug: 'live-9am-sweep',
    name: '9AM Asia/London Sweep',
    route: '/strategies/live-9am-sweep',
    mode: 'live-watcher',
    sourceMode,
    bankrollUsd: config.startingBalanceUsd,
    maxDrawdownPercent: config.maxAccountDrawdownPercent,
    provider: config.live?.provider || 'unknown',
    ticker: config.live?.ticker || config.symbol,
    watcher: {
      pid,
      isRunning,
      statusLabel: isRunning ? 'Running' : 'Stopped',
      staleStatusHint: !isRunning && lastCandle ? 'Status script may be stale or detached from the real process state.' : null
    },
    live: {
      lastCandle,
      latestReason: reason,
      latestError,
      activationTime: config.liveActivationTime || null
    },
    journal
  };
}

function buildHourlyStrategy(config) {
  const setupPath = path.join(process.cwd(), 'examples', 'hourly-sweep-ifvg-bos.setup.json');
  const setup = safeReadJson(setupPath) || {};

  return {
    slug: 'hourly-sweep-ifvg-bos',
    name: '1H Sweep + iFVG + 1M BOS',
    route: '/strategies/hourly-sweep-ifvg-bos',
    mode: 'manual-route',
    sourceMode: 'static-config',
    bankrollUsd: config.startingBalanceUsd,
    maxDrawdownPercent: config.maxAccountDrawdownPercent,
    provider: 'manual',
    ticker: setup.symbol || config.symbol,
    setupSummary: {
      side: setup.side || null,
      entry: setup.entry || null,
      stop: setup.stop || null,
      targets: Array.isArray(setup.targets) ? setup.targets : [],
      entryModel: setup.setup?.entryModel || null,
      gapType: setup.setup?.gapType || null,
      outcome: 'Manual route only right now; no VPS watcher attached yet.'
    },
    journal: {
      trades: 0,
      wins: 0,
      losses: 0,
      realizedPnlUsd: 0,
      balanceUsd: config.startingBalanceUsd,
      lastUpdatedAt: null
    }
  };
}

function getLocalStrategySnapshots() {
  const configPath = path.join(process.cwd(), 'config.json');
  const statePath = path.join(process.cwd(), 'state.json');
  const pidPath = path.join(process.cwd(), 'runtime', 'lucid-nq-paper-trader-watch.pid');
  const logPath = path.join(process.cwd(), 'runtime', 'lucid-nq-paper-trader-watch.log');

  const config = normalizeConfig(readJson(configPath));
  const state = safeReadJson(statePath) || {};
  const pidText = safeReadText(pidPath);
  const pid = pidText ? Number(String(pidText).trim()) : null;
  const logText = safeReadText(logPath) || '';
  const logStat = safeStat(logPath);

  return {
    ok: true,
    source: 'local-runtime',
    generatedAt: new Date().toISOString(),
    logUpdatedAt: logStat ? logStat.mtime.toISOString() : null,
    strategies: [
      buildNineAmStrategy(config, state, logText, pid, 'local-runtime'),
      buildHourlyStrategy(config)
    ]
  };
}

async function getStrategySnapshots() {
  const remoteUrl = process.env.LIVE_STATUS_SOURCE_URL;
  if (remoteUrl) {
    try {
      const response = await fetch(remoteUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Remote status responded ${response.status}`);
      }
      const data = await response.json();
      return {
        ...data,
        source: 'remote-bridge',
        remoteUrl
      };
    } catch (error) {
      const local = getLocalStrategySnapshots();
      return {
        ...local,
        ok: false,
        source: 'remote-bridge-fallback',
        remoteUrl,
        error: error.message
      };
    }
  }

  return getLocalStrategySnapshots();
}

module.exports = {
  getLocalStrategySnapshots,
  getStrategySnapshots
};
