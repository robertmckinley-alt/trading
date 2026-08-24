#!/usr/bin/env node
const path = require('path');
const {
  createEmptyState,
  hydrateState,
  loadJson,
  normalizeConfig,
  normalizeSetup,
  parseCsvFile,
  printPlan,
  printReplay,
  printReport,
  replayPlan,
  saveJson,
  toJournalTrade,
  buildTradePlan,
  validateSetup
} = require('./lib/trader-core.cjs');
const {
  buildPlanFromSignal,
  detectSignalFromCandles,
  fetchLiveCandles,
  formatOpenTradeSummary,
  formatSignalSummary,
  loadLiveState,
  normalizeStrategyConfig,
  saveLiveState,
  signalKey,
  trackTradeLifecycle
} = require('./lib/live-trader.cjs');

const BASE = __dirname;
const CONFIG_PATH = path.join(BASE, 'config.json');
const STATE_PATH = path.join(BASE, 'state.json');

function loadConfig() {
  return normalizeConfig(loadJson(CONFIG_PATH));
}

function loadState(config) {
  try {
    return loadLiveState(hydrateState(loadJson(STATE_PATH), config));
  } catch {
    return loadLiveState(createEmptyState(config));
  }
}

function parseArgs(argv) {
  const [, , command, ...rest] = argv;
  return { command, rest };
}

function requireFile(filePath, label) {
  if (!filePath) {
    throw new Error(`${label} is required`);
  }
}

function parseWatchOptions(rest) {
  const fileArgs = [];
  let intervalMs = 1000;
  let provider = null;

  for (const arg of rest) {
    if (arg.startsWith('--interval=')) {
      intervalMs = Number(arg.slice('--interval='.length));
      continue;
    }
    if (arg.startsWith('--provider=')) {
      provider = String(arg.slice('--provider='.length));
      continue;
    }
    fileArgs.push(arg);
  }

  if (!Number.isFinite(intervalMs) || intervalMs < 250) {
    throw new Error('watch interval must be at least 250ms');
  }

  return {
    fileArgs,
    intervalMs: Math.round(intervalMs),
    provider
  };
}

function applyLiveProviderOverride(config, provider) {
  if (!provider) {
    return config;
  }
  return {
    ...config,
    live: {
      ...(config.live || {}),
      provider
    }
  };
}

function runWatch(setupPath, csvPath, config, state, intervalMs) {
  const resolvedSetupPath = path.resolve(setupPath);
  const resolvedCsvPath = path.resolve(csvPath);
  let lastSignature = null;

  const tick = () => {
    const rawSetup = loadJson(resolvedSetupPath);
    const setup = normalizeSetup(rawSetup, config);
    const validation = validateSetup(setup, config);
    if (!validation.valid) {
      throw new Error(`Setup validation failed:\n- ${validation.errors.join('\n- ')}`);
    }

    const plan = buildTradePlan(setup, config, state);
    const candles = parseCsvFile(resolvedCsvPath);
    const replayResult = replayPlan(plan, candles, config);
    const lastCandle = candles[candles.length - 1];
    const signature = JSON.stringify({
      entry: plan.setup.entry,
      stop: plan.setup.stop,
      target: replayResult.targetsHit[replayResult.targetsHit.length - 1] || null,
      status: replayResult.status,
      exitReason: replayResult.exitReason,
      finalExitPrice: replayResult.finalExitPrice,
      lastTimestamp: lastCandle ? lastCandle.timestamp : null
    });

    if (signature !== lastSignature) {
      lastSignature = signature;
      const now = new Date().toISOString();
      console.log(`[${now}] watch tick`);
      console.log(`Last candle: ${lastCandle ? `${lastCandle.timestamp} O:${lastCandle.open} H:${lastCandle.high} L:${lastCandle.low} C:${lastCandle.close}` : 'none'}`);
      console.log(printReplay(plan, replayResult));
      console.log('');
    }
  };

  console.log(`Watching ${resolvedCsvPath} every ${intervalMs}ms using setup ${resolvedSetupPath}`);
  tick();
  setInterval(() => {
    try {
      tick();
    } catch (error) {
      const now = new Date().toISOString();
      console.error(`[${now}] watch error: ${error.message}`);
    }
  }, intervalMs);
}

async function runLivePlan(config, state) {
  const { candles, metadata } = await fetchLiveCandles(config);
  const signal = detectSignalFromCandles(candles, config, state);
  if (!signal.found) {
    console.log(`Live scan: no trade yet`);
    console.log(`Reason: ${signal.reason}`);
    if (signal.sessionRanges) {
      console.log(`Asia H/L: ${signal.sessionRanges.asia.high} / ${signal.sessionRanges.asia.low}`);
      console.log(`London H/L: ${signal.sessionRanges.london.high} / ${signal.sessionRanges.london.low}`);
    }
    console.log(`Feed: ${metadata.provider} ${metadata.ticker}`);
    return;
  }

  const plan = buildPlanFromSignal(signal, config, state);
  console.log(`Feed: ${metadata.provider} ${metadata.ticker}`);
  console.log(formatSignalSummary(signal, plan));
  console.log('');
  console.log(printPlan(plan));
}

function persistClosedTrade(state, config, plan, lifecycle) {
  const trade = toJournalTrade(plan, lifecycle);
  state.trades.push(trade);
  state.realizedPnlUsd = Math.round((state.realizedPnlUsd + trade.realizedPnlUsd) * 100) / 100;
  state.startingBalanceUsd = config.startingBalanceUsd;
  state.balanceUsd = Math.round((config.startingBalanceUsd + state.realizedPnlUsd) * 100) / 100;
  state.lastUpdatedAt = new Date().toISOString();
  state.live.openSignalKey = null;
  state.live.openPlan = null;
  state.live.openTriggeredAt = null;
  return trade;
}

async function runWatchLive(config, state, intervalMs) {
  const liveConfig = normalizeStrategyConfig(config);
  let lastSignature = null;
  const actualIntervalMs = intervalMs || liveConfig.pollIntervalMs;

  const tick = async () => {
    const { candles, metadata } = await fetchLiveCandles(config);
    const lastCandle = candles[candles.length - 1];
    let summaryLines = [
      `Feed: ${metadata.provider} ${metadata.ticker}`,
      `Last candle: ${lastCandle ? `${lastCandle.timestamp} O:${lastCandle.open} H:${lastCandle.high} L:${lastCandle.low} C:${lastCandle.close}` : 'none'}`
    ];

    if (state.live.openPlan) {
      const liveCandles = state.live.openTriggeredAt
        ? candles.filter((candle) => new Date(candle.timestamp).getTime() >= new Date(state.live.openTriggeredAt).getTime())
        : candles;
      const lifecycle = trackTradeLifecycle(state.live.openPlan, liveCandles, config, { closeOpenAtEnd: false });
      summaryLines.push(formatOpenTradeSummary(state.live.openPlan, lifecycle));
      if (lifecycle.status === 'closed') {
        const trade = persistClosedTrade(state, config, state.live.openPlan, lifecycle);
        summaryLines.push(`Closed and journaled: ${trade.id} PnL ${trade.realizedPnlUsd}`);
        saveLiveState(STATE_PATH, state);
      }
      const signature = JSON.stringify({
        mode: 'open-position',
        status: lifecycle.status,
        filledAt: lifecycle.filledAt,
        targetsHit: lifecycle.targetsHit,
        remainingContracts: lifecycle.remainingContracts,
        exitReason: lifecycle.exitReason,
        markPrice: lifecycle.markPrice,
        lastTimestamp: lastCandle ? lastCandle.timestamp : null
      });
      if (signature !== lastSignature) {
        lastSignature = signature;
        console.log(`[${new Date().toISOString()}] live tick`);
        console.log(summaryLines.join('\n'));
        console.log('');
      }
      return;
    }

    const signal = detectSignalFromCandles(candles, config, state);
    if (!signal.found) {
      summaryLines.push(`No trade: ${signal.reason}`);
      const signature = JSON.stringify({
        mode: 'idle',
        reason: signal.reason,
        lastTimestamp: lastCandle ? lastCandle.timestamp : null
      });
      if (signature !== lastSignature) {
        lastSignature = signature;
        console.log(`[${new Date().toISOString()}] live tick`);
        console.log(summaryLines.join('\n'));
        console.log('');
      }
      return;
    }

    const key = signalKey(signal);
    if (state.live.signalHistory.includes(key)) {
      summaryLines.push(`Signal already consumed: ${key}`);
      const signature = JSON.stringify({
        mode: 'duplicate-signal',
        key,
        lastTimestamp: lastCandle ? lastCandle.timestamp : null
      });
      if (signature !== lastSignature) {
        lastSignature = signature;
        console.log(`[${new Date().toISOString()}] live tick`);
        console.log(summaryLines.join('\n'));
        console.log('');
      }
      return;
    }

    const plan = buildPlanFromSignal(signal, config, state);
    state.live.openSignalKey = key;
    state.live.openPlan = plan;
    state.live.openTriggeredAt = signal.triggerTimestamp;
    state.live.signalHistory.push(key);
    saveLiveState(STATE_PATH, state);
    summaryLines.push(formatSignalSummary(signal, plan));
    const signature = JSON.stringify({
      mode: 'new-signal',
      key,
      lastTimestamp: lastCandle ? lastCandle.timestamp : null
    });
    if (signature !== lastSignature) {
      lastSignature = signature;
      console.log(`[${new Date().toISOString()}] live tick`);
      console.log(summaryLines.join('\n'));
      console.log('');
    }
  };

  console.log(`Watching live market every ${actualIntervalMs}ms using provider ${liveConfig.provider}`);
  await tick();
  setInterval(() => {
    tick().catch((error) => {
      const now = new Date().toISOString();
      console.error(`[${now}] live watch error: ${error.message}`);
    });
  }, actualIntervalMs);
}

async function main() {
  const { command, rest } = parseArgs(process.argv);
  const config = loadConfig();
  const state = loadState(config);

  if (!command) {
    throw new Error('Usage: node paper-trader.js <plan|replay|journal|report|live-plan|watch-live> [files]');
  }

  if (command === 'report') {
    console.log(printReport(state, config));
    return;
  }

  if (command === 'watch') {
    const { fileArgs, intervalMs } = parseWatchOptions(rest);
    const [setupPath, csvPath] = fileArgs;
    requireFile(setupPath, 'setup path');
    requireFile(csvPath, 'csv path');
    runWatch(setupPath, csvPath, config, state, intervalMs);
    return;
  }

  if (command === 'live-plan') {
    const { provider } = parseWatchOptions(rest);
    await runLivePlan(applyLiveProviderOverride(config, provider), state);
    return;
  }

  if (command === 'watch-live') {
    const { intervalMs, provider } = parseWatchOptions(rest);
    await runWatchLive(applyLiveProviderOverride(config, provider), state, intervalMs);
    return;
  }

  const [setupPath, csvPath] = rest;
  requireFile(setupPath, 'setup path');
  const rawSetup = loadJson(path.resolve(setupPath));
  const setup = normalizeSetup(rawSetup, config);
  const validation = validateSetup(setup, config);
  if (!validation.valid) {
    throw new Error(`Setup validation failed:\n- ${validation.errors.join('\n- ')}`);
  }

  const plan = buildTradePlan(setup, config, state);
  if (command === 'plan') {
    console.log(printPlan(plan));
    return;
  }

  requireFile(csvPath, 'csv path');
  const candles = parseCsvFile(path.resolve(csvPath));
  const replayResult = replayPlan(plan, candles, config);

  if (command === 'replay') {
    console.log(printReplay(plan, replayResult));
    return;
  }

  if (command === 'journal') {
    const trade = toJournalTrade(plan, replayResult);
    state.trades.push(trade);
    state.realizedPnlUsd = Math.round((state.realizedPnlUsd + trade.realizedPnlUsd) * 100) / 100;
    state.startingBalanceUsd = config.startingBalanceUsd;
    state.balanceUsd = Math.round((config.startingBalanceUsd + state.realizedPnlUsd) * 100) / 100;
    state.lastUpdatedAt = new Date().toISOString();
    saveJson(STATE_PATH, state);
    console.log(printReplay(plan, replayResult));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
