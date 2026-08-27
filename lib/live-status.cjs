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

function parseLogEvents(logText) {
  const text = String(logText || '');
  const starts = [...text.matchAll(/^\[(.*?)\]\s+(.+)$/gm)];
  if (!starts.length) {
    return [];
  }

  return starts.map((match, index) => {
    const start = match.index;
    const end = index + 1 < starts.length ? starts[index + 1].index : text.length;
    const block = text.slice(start, end).trim();
    const header = String(match[2] || '').trim();

    if (header.startsWith('live watch error:')) {
      return {
        type: 'error',
        at: match[1],
        message: header.replace(/^live watch error:\s*/, '').trim(),
        block
      };
    }

    const candleMatch = block.match(/Last candle:\s+([^\s]+)\s+O:([-\d.]+)\s+H:([-\d.]+)\s+L:([-\d.]+)\s+C:([-\d.]+)/);
    const reasonMatch = block.match(/No trade:\s+(.+)/);
    const openTradeMatch = block.match(/Open trade status:\s+(.+)/);
    const realizedMatch = block.match(/Realized:\s+([-\d.]+)/);
    const unrealizedMatch = block.match(/Unrealized:\s+([-\d.]+)/);
    const markMatch = block.match(/Mark:\s+([-\d.]+)/);
    if (header === 'live tick' || candleMatch || reasonMatch || openTradeMatch) {
      return {
        type: 'tick',
        at: match[1],
        lastCandle: candleMatch
          ? {
              timestamp: candleMatch[1],
              open: Number(candleMatch[2]),
              high: Number(candleMatch[3]),
              low: Number(candleMatch[4]),
              close: Number(candleMatch[5])
            }
          : null,
        latestReason: reasonMatch?.[1] || null,
        activeTrade: openTradeMatch
          ? {
              status: openTradeMatch[1].trim(),
              realizedPnlUsd: realizedMatch ? Number(realizedMatch[1]) : 0,
              unrealizedPnlUsd: unrealizedMatch ? Number(unrealizedMatch[1]) : 0,
              markPrice: markMatch ? Number(markMatch[1]) : null
            }
          : null,
        block
      };
    }

    return {
      type: 'other',
      at: match[1],
      block
    };
  });
}

function parseLiveStatus(logText) {
  const events = parseLogEvents(logText);
  const lastTick = [...events].reverse().find((event) => event.type === 'tick') || null;
  const lastError = [...events].reverse().find((event) => event.type === 'error') || null;
  const lastEvent = events.at(-1) || null;

  return {
    lastCandle: lastTick?.lastCandle || null,
    latestReason: lastTick?.latestReason || null,
    activeTrade: lastTick?.activeTrade || null,
    latestError: lastEvent?.type === 'error' ? { at: lastEvent.at, message: lastEvent.message } : null,
    recoveredFromError:
      Boolean(lastError && lastTick) &&
      Date.parse(lastTick.at || '') > Date.parse(lastError.at || '')
  };
}

function inferDailyDate(state, liveStatus) {
  const openPlanDate = state?.live?.openPlan?.setup?.date;
  if (openPlanDate) return openPlanDate;

  const candleDate = liveStatus?.lastCandle?.timestamp
    ? String(liveStatus.lastCandle.timestamp).slice(0, 10)
    : null;
  if (candleDate) return candleDate;

  const lastTrade = Array.isArray(state?.trades) ? state.trades.at(-1) : null;
  return lastTrade?.date || new Date().toISOString().slice(0, 10);
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function summarizeTradesForDate(trades, date) {
  const closedTrades = trades.filter((trade) => trade.date === date);
  const realizedPnlUsd = closedTrades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd || 0), 0);
  const wins = closedTrades.filter((trade) => Number(trade.realizedPnlUsd || 0) > 0).length;
  const losses = closedTrades.filter((trade) => Number(trade.realizedPnlUsd || 0) < 0).length;
  const avgR = closedTrades.length
    ? closedTrades.reduce((sum, trade) => sum + Number(trade.rMultiple || 0), 0) / closedTrades.length
    : 0;

  return {
    date,
    trades: closedTrades.length,
    wins,
    losses,
    winRate: closedTrades.length ? roundMoney((wins / closedTrades.length) * 100) : 0,
    realizedPnlUsd: roundMoney(realizedPnlUsd),
    activeRealizedPnlUsd: 0,
    activeUnrealizedPnlUsd: 0,
    activePnlUsd: roundMoney(realizedPnlUsd),
    avgR: Math.round(avgR * 100) / 100,
    bestTradePnlUsd: closedTrades.length
      ? roundMoney(Math.max(...closedTrades.map((trade) => Number(trade.realizedPnlUsd || 0))))
      : 0,
    worstTradePnlUsd: closedTrades.length
      ? roundMoney(Math.min(...closedTrades.map((trade) => Number(trade.realizedPnlUsd || 0))))
      : 0,
    openTradeStatus: null,
    markPrice: null,
    tradesList: closedTrades.map((trade) => ({
      id: trade.id,
      symbol: trade.symbol,
      session: trade.session,
      side: trade.side,
      entry: trade.entry,
      stop: trade.stop,
      finalExitPrice: trade.finalExitPrice,
      exitReason: trade.exitReason,
      realizedPnlUsd: roundMoney(trade.realizedPnlUsd),
      rMultiple: trade.rMultiple,
      targetsHit: Array.isArray(trade.targetsHit) ? trade.targetsHit : [],
      targets: Array.isArray(trade.targets) ? trade.targets : [],
      thesis: trade.thesis || null,
      liquidityLabel: trade.liquidityLabel || null,
      liquidityPool: trade.liquidityPool || null,
      reaction: trade.reaction || null,
      entryModel: trade.entryModel || null,
      gapType: trade.gapType || null,
      entryTimeframe: trade.entryTimeframe || null,
      drawOnLiquidity: Array.isArray(trade.drawOnLiquidity) ? trade.drawOnLiquidity : [],
      contracts: trade.contracts || null,
      filledAt: trade.filledAt,
      createdAt: trade.createdAt
    }))
  };
}

function buildDailyRecaps(trades, activeDaily = null) {
  const dates = [...new Set(trades.map((trade) => trade.date).filter(Boolean))];
  if (activeDaily?.date && !dates.includes(activeDaily.date)) {
    dates.push(activeDaily.date);
  }

  return dates
    .sort()
    .reverse()
    .map((date) => {
      const recap = summarizeTradesForDate(trades, date);
      if (activeDaily?.date !== date) {
        return recap;
      }

      return {
        ...recap,
        activeRealizedPnlUsd: roundMoney(activeDaily.activeRealizedPnlUsd),
        activeUnrealizedPnlUsd: roundMoney(activeDaily.activeUnrealizedPnlUsd),
        activePnlUsd: roundMoney(recap.realizedPnlUsd + activeDaily.activeRealizedPnlUsd + activeDaily.activeUnrealizedPnlUsd),
        openTradeStatus: activeDaily.openTradeStatus,
        markPrice: activeDaily.markPrice
      };
    });
}

function summarizeJournal(state, liveStatus = null) {
  const trades = Array.isArray(state?.trades) ? state.trades : [];
  const realizedPnlUsd = Number(state?.realizedPnlUsd || 0);
  const wins = trades.filter((trade) => Number(trade.realizedPnlUsd || 0) > 0).length;
  const losses = trades.filter((trade) => Number(trade.realizedPnlUsd || 0) < 0).length;
  const dailyDate = inferDailyDate(state, liveStatus);
  const todayTrades = trades.filter((trade) => trade.date === dailyDate);
  const dailyRealizedPnlUsd = todayTrades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd || 0), 0);
  const activeTrade = liveStatus?.activeTrade || null;
  const hasActiveTrade = Boolean(state?.live?.openPlan && activeTrade);
  const activeUnrealizedPnlUsd = hasActiveTrade ? Number(activeTrade.unrealizedPnlUsd || 0) : 0;
  const activeRealizedPnlUsd = hasActiveTrade ? Number(activeTrade.realizedPnlUsd || 0) : 0;
  const activeDaily = {
    date: dailyDate,
    activeRealizedPnlUsd,
    activeUnrealizedPnlUsd,
    openTradeStatus: hasActiveTrade ? activeTrade.status : null,
    markPrice: hasActiveTrade ? activeTrade.markPrice : null
  };
  return {
    trades: trades.length,
    wins,
    losses,
    realizedPnlUsd,
    balanceUsd: Number(state?.balanceUsd || 0),
    lastUpdatedAt: state?.lastUpdatedAt || null,
    daily: {
      date: dailyDate,
      trades: todayTrades.length,
      wins: todayTrades.filter((trade) => Number(trade.realizedPnlUsd || 0) > 0).length,
      losses: todayTrades.filter((trade) => Number(trade.realizedPnlUsd || 0) < 0).length,
      realizedPnlUsd: Math.round(dailyRealizedPnlUsd * 100) / 100,
      activeRealizedPnlUsd,
      activeUnrealizedPnlUsd,
      activePnlUsd: Math.round((dailyRealizedPnlUsd + activeRealizedPnlUsd + activeUnrealizedPnlUsd) * 100) / 100,
      openTradeStatus: hasActiveTrade ? activeTrade.status : null,
      markPrice: hasActiveTrade ? activeTrade.markPrice : null
    },
    dailyRecaps: buildDailyRecaps(trades, activeDaily)
  };
}

function buildLiveStrategy({
  config,
  state,
  logText,
  pid,
  sourceMode,
  slug,
  name,
  route,
  paperAccountLabel,
  journalScope,
  activationTime,
  setupSummary = null
}) {
  const liveStatus = parseLiveStatus(logText);
  const isRunning = isPidRunning(pid);
  const journal = summarizeJournal(state, liveStatus);
  const hasLiveEvidence = Boolean(liveStatus.lastCandle || liveStatus.latestReason || liveStatus.latestError);

  return {
    slug,
    name,
    route,
    mode: 'live-watcher',
    paperAccountLabel,
    journalScope,
    sourceMode,
    bankrollUsd: config.startingBalanceUsd,
    maxDrawdownPercent: config.maxAccountDrawdownPercent,
    provider: config.live?.provider || 'unknown',
    ticker: config.live?.ticker || config.symbol,
    watcher: {
      pid,
      isRunning,
      hasLiveEvidence,
      statusLabel: isRunning ? 'Running' : hasLiveEvidence ? 'Process status unclear' : 'No watcher evidence',
      staleStatusHint: !isRunning && hasLiveEvidence ? 'PID check is not active, but runtime log data exists. Treat this as stale process status until the bridge refreshes.' : null
    },
    live: {
      lastCandle: liveStatus.lastCandle,
      latestReason: liveStatus.latestReason,
      activeTrade: liveStatus.activeTrade,
      latestError: liveStatus.latestError,
      recoveredFromError: liveStatus.recoveredFromError,
      activationTime
    },
    setupSummary,
    journal
  };
}

function buildNineAmStrategy(config, state, logText, pid, sourceMode) {
  return buildLiveStrategy({
    config,
    state,
    logText,
    pid,
    sourceMode,
    slug: 'live-9am-sweep',
    name: '9AM Asia/London Sweep',
    route: '/strategies/live-9am-sweep',
    paperAccountLabel: 'Paper Account A',
    journalScope: 'Shared by the homepage 9AM lab and the /strategies/live-9am-sweep route.',
    activationTime: config.liveActivationTime || null
  });
}

function buildHourlyStrategy(config, state, logText, pid, sourceMode) {
  const setupPath = path.join(process.cwd(), 'examples', 'hourly-sweep-ifvg-bos.setup.json');
  const setup = safeReadJson(setupPath) || {};

  return buildLiveStrategy({
    config,
    state,
    logText,
    pid,
    sourceMode,
    slug: 'hourly-sweep-ifvg-bos',
    name: '1H Sweep + iFVG + 1M BOS',
    route: '/strategies/hourly-sweep-ifvg-bos',
    paperAccountLabel: 'Paper Account B',
    journalScope: 'Separate automated VPS watcher and paper journal for the hourly sweep route.',
    activationTime: 'Rolling 1H liquidity',
    setupSummary: {
      side: setup.side || null,
      entry: setup.entry || null,
      stop: setup.stop || null,
      targets: Array.isArray(setup.targets) ? setup.targets : [],
      entryModel: setup.setup?.entryModel || null,
      gapType: setup.setup?.gapType || null,
      outcome: 'Automated VPS watcher for rolling 1H sweep + iFVG/BOS setups.'
    }
  });
}

function emptyDailySummary(date = new Date().toISOString().slice(0, 10)) {
  return {
    date,
    trades: 0,
    wins: 0,
    losses: 0,
    realizedPnlUsd: 0,
    activeRealizedPnlUsd: 0,
    activeUnrealizedPnlUsd: 0,
    activePnlUsd: 0,
    openTradeStatus: null,
    markPrice: null
  };
}

function getLocalStrategySnapshots() {
  const configPath = path.join(process.cwd(), 'config.json');
  const statePath = path.join(process.cwd(), 'state.json');
  const pidPath = path.join(process.cwd(), 'runtime', 'lucid-nq-paper-trader-watch.pid');
  const logPath = path.join(process.cwd(), 'runtime', 'lucid-nq-paper-trader-watch.log');
  const hourlyStatePath = path.join(process.cwd(), 'state-hourly-sweep-ifvg-bos.json');
  const hourlyPidPath = path.join(process.cwd(), 'runtime', 'hourly-sweep-ifvg-bos-watch.pid');
  const hourlyLogPath = path.join(process.cwd(), 'runtime', 'hourly-sweep-ifvg-bos-watch.log');

  const config = normalizeConfig(readJson(configPath));
  const state = safeReadJson(statePath) || {};
  const pidText = safeReadText(pidPath);
  const pid = pidText ? Number(String(pidText).trim()) : null;
  const logText = safeReadText(logPath) || '';
  const logStat = safeStat(logPath);
  const hourlyState = safeReadJson(hourlyStatePath) || {};
  const hourlyPidText = safeReadText(hourlyPidPath);
  const hourlyPid = hourlyPidText ? Number(String(hourlyPidText).trim()) : null;
  const hourlyLogText = safeReadText(hourlyLogPath) || '';
  const hourlyLogStat = safeStat(hourlyLogPath);

  return {
    ok: true,
    source: 'local-runtime',
    generatedAt: new Date().toISOString(),
    logUpdatedAt: [logStat, hourlyLogStat]
      .filter(Boolean)
      .map((stat) => stat.mtime)
      .sort((a, b) => b - a)[0]?.toISOString() || null,
    strategies: [
      buildNineAmStrategy(config, state, logText, pid, 'local-runtime'),
      buildHourlyStrategy(config, hourlyState, hourlyLogText, hourlyPid, 'local-runtime')
    ]
  };
}

function parseRemoteUrls() {
  const candidates = [
    process.env.LIVE_STATUS_SOURCE_URL,
    process.env.LIVE_STATUS_SOURCE_URLS
  ].filter(Boolean);

  return candidates
    .flatMap((value) => String(value).split(/[\s,]+/))
    .map((value) => value.trim())
    .filter(Boolean);
}

async function fetchRemoteSnapshot(remoteUrl) {
  const response = await fetch(remoteUrl, {
    cache: 'no-store',
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) {
    throw new Error(`Remote status responded ${response.status}`);
  }
  return response.json();
}

function normalizeRemoteStrategy(strategy, logUpdatedAt) {
  if (!strategy) {
    return strategy;
  }

  const dailyDate = strategy.live?.lastCandle?.timestamp
    ? String(strategy.live.lastCandle.timestamp).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const journal = {
    ...(strategy.journal || {}),
    daily: strategy.journal?.daily || emptyDailySummary(dailyDate),
    dailyRecaps: Array.isArray(strategy.journal?.dailyRecaps) ? strategy.journal.dailyRecaps : []
  };
  const normalizedStrategy = {
    ...strategy,
    provider: strategy.slug === 'hourly-sweep-ifvg-bos' ? 'databento' : strategy.provider,
    mode: strategy.slug === 'hourly-sweep-ifvg-bos' ? 'live-watcher' : strategy.mode,
    journal
  };

  if (normalizedStrategy.mode !== 'live-watcher') {
    return normalizedStrategy;
  }

  const latestErrorAt = Date.parse(normalizedStrategy.live?.latestError?.at || '');
  const logUpdatedTime = Date.parse(logUpdatedAt || '');
  const hasRecoveredTick =
    Boolean(normalizedStrategy.live?.lastCandle) &&
    Number.isFinite(latestErrorAt) &&
    Number.isFinite(logUpdatedTime) &&
    logUpdatedTime > latestErrorAt;

  if (!hasRecoveredTick) {
    return normalizedStrategy;
  }

  return {
    ...normalizedStrategy,
    live: {
      ...normalizedStrategy.live,
      latestError: null,
      recoveredFromError: true
    }
  };
}

function normalizeRemoteSnapshot(data) {
  if (!data || !Array.isArray(data.strategies)) {
    return data;
  }

  return {
    ...data,
    strategies: data.strategies.map((strategy) => normalizeRemoteStrategy(strategy, data.logUpdatedAt))
  };
}

async function getStrategySnapshots() {
  const remoteUrls = parseRemoteUrls();
  if (remoteUrls.length) {
    const failures = [];
    for (const remoteUrl of remoteUrls) {
      try {
        const data = normalizeRemoteSnapshot(await fetchRemoteSnapshot(remoteUrl));
        return {
          ...data,
          source: 'remote-bridge',
          remoteUrl
        };
      } catch (error) {
        failures.push(`${remoteUrl}: ${error.message}`);
      }
    }

    const local = getLocalStrategySnapshots();
    return {
      ...local,
      ok: false,
      source: 'remote-bridge-fallback',
      remoteUrl: remoteUrls[0],
      remoteUrls,
      error: failures.join(' | ')
    };
  }

  return getLocalStrategySnapshots();
}

module.exports = {
  getLocalStrategySnapshots,
  getStrategySnapshots
};
