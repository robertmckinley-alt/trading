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

function statePathForStrategy(strategySlug) {
  if (strategySlug === 'hourly-sweep-ifvg-bos') {
    return path.join(BASE, 'state-hourly-sweep-ifvg-bos.json');
  }
  return path.join(BASE, 'state.json');
}

function loadConfig() {
  return normalizeConfig(loadJson(CONFIG_PATH));
}

function loadState(config, statePath) {
  try {
    return loadLiveState(hydrateState(loadJson(statePath), config));
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
  let intervalMs = null;
  let provider = null;
  let strategySlug = 'live-9am-sweep';

  for (const arg of rest) {
    if (arg.startsWith('--interval=')) {
      intervalMs = Number(arg.slice('--interval='.length));
      continue;
    }
    if (arg.startsWith('--provider=')) {
      provider = String(arg.slice('--provider='.length));
      continue;
    }
    if (arg.startsWith('--strategy=')) {
      strategySlug = String(arg.slice('--strategy='.length));
      continue;
    }
    fileArgs.push(arg);
  }

  if (intervalMs !== null && (!Number.isFinite(intervalMs) || intervalMs < 250)) {
    throw new Error('watch interval must be at least 250ms');
  }

  return {
    fileArgs,
    intervalMs: Math.round(intervalMs),
    provider,
    strategySlug
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

async function sendWatcherAlert(state, event) {
  const webhookUrl = process.env.TRADING_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;
  const eventType = String(event.type || 'watcher');
  const dedupeKey = String(event.dedupeKey || event.status || eventType);
  if (state.live.alertKeys?.[eventType] === dedupeKey) return;

  try {
    const token = process.env.TRADING_ALERT_WEBHOOK_TOKEN;
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        source: 'doctortrades-watcher',
        at: new Date().toISOString(),
        ...event
      }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Alert webhook responded ${response.status}`);
    state.live.alertKeys = { ...(state.live.alertKeys || {}), [eventType]: dedupeKey };
    state.live.lastAlertAt = new Date().toISOString();
    state.live.lastAlertError = null;
  } catch (error) {
    state.live.lastAlertError = `Alert delivery failed: ${error.message}`;
    console.error(`[${new Date().toISOString()}] ${state.live.lastAlertError}`);
  }
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

function persistClosedTrade(statePath, state, config, plan, lifecycle) {
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

async function runWatchLive(config, state, intervalMs, statePath) {
  const liveConfig = normalizeStrategyConfig(config);
  let lastSignature = null;
  const actualIntervalMs = intervalMs || liveConfig.pollIntervalMs;
  let inFlight = false;

  const tick = async () => {
    const { candles, metadata } = await fetchLiveCandles(config);
    const lastCandle = candles[candles.length - 1];
    const previousHeartbeat = state.live.heartbeat;
    state.live.heartbeat = {
      at: new Date().toISOString(),
      ok: true,
      pollIntervalMs: actualIntervalMs,
      provider: metadata.provider,
      ticker: metadata.ticker,
      lastCandle: lastCandle || null,
      error: null
    };
    if (previousHeartbeat?.ok === false) {
      await sendWatcherAlert(state, {
        type: 'watcher-health',
        status: 'recovered',
        dedupeKey: 'recovered',
        strategy: config.strategySlug,
        provider: metadata.provider,
        ticker: metadata.ticker,
        message: 'Live market data refresh recovered.'
      });
    }
    saveLiveState(statePath, state);
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
        const trade = persistClosedTrade(statePath, state, config, state.live.openPlan, lifecycle);
        await sendWatcherAlert(state, {
          type: 'trade-closed',
          status: 'closed',
          dedupeKey: trade.id,
          strategy: config.strategySlug,
          symbol: trade.symbol,
          side: trade.side,
          realizedPnlUsd: trade.realizedPnlUsd,
          rMultiple: trade.rMultiple,
          message: 'Paper trade closed and journaled.'
        });
        summaryLines.push(`Closed and journaled: ${trade.id} PnL ${trade.realizedPnlUsd}`);
        saveLiveState(statePath, state);
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

    let plan;
    try {
      plan = buildPlanFromSignal(signal, config, state);
    } catch (error) {
      summaryLines.push(`No trade: ${error.message}`);
      const signature = JSON.stringify({
        mode: 'rejected-signal',
        reason: error.message,
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
    state.live.openSignalKey = key;
    state.live.openPlan = plan;
    state.live.openTriggeredAt = signal.triggerTimestamp;
    state.live.signalHistory.push(key);
    await sendWatcherAlert(state, {
      type: 'trade-opened',
      status: 'opened',
      dedupeKey: key,
      strategy: config.strategySlug,
      symbol: signal.symbol,
      side: signal.side,
      entry: signal.entry,
      stop: signal.stop,
      message: 'Paper trade signal opened.'
    });
    saveLiveState(statePath, state);
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

  const poll = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      await tick();
    } catch (error) {
      state.live.heartbeat = {
        ...(state.live.heartbeat || {}),
        at: new Date().toISOString(),
        ok: false,
        pollIntervalMs: actualIntervalMs,
        error: error.message
      };
      await sendWatcherAlert(state, {
        type: 'watcher-health',
        status: 'failed',
        dedupeKey: 'failed',
        strategy: config.strategySlug,
        provider: liveConfig.provider,
        ticker: liveConfig.ticker,
        message: 'Live market data refresh failed. Check the private watcher logs.'
      });
      try {
        saveLiveState(statePath, state);
      } catch {
        // Preserve the original feed error in the watcher log.
      }
      throw error;
    } finally {
      inFlight = false;
    }
  };

  console.log(`Watching live market every ${actualIntervalMs}ms using provider ${liveConfig.provider}`);
  try {
    await poll();
  } catch (error) {
    const now = new Date().toISOString();
    console.error(`[${now}] live watch error: ${error.message}`);
  }
  setInterval(() => {
    poll().catch((error) => {
      const now = new Date().toISOString();
      console.error(`[${now}] live watch error: ${error.message}`);
    });
  }, actualIntervalMs);
  await new Promise(() => {});
}

async function main() {
  const { command, rest } = parseArgs(process.argv);
  const { provider, strategySlug } = parseWatchOptions(rest);
  const statePath = statePathForStrategy(strategySlug);
  const config = loadConfig();
  const state = loadState(config, statePath);

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
    runWatch(setupPath, csvPath, config, state, intervalMs || 1000);
    return;
  }

  if (command === 'live-plan') {
    await runLivePlan({ ...applyLiveProviderOverride(config, provider), strategySlug }, state);
    return;
  }

  if (command === 'watch-live') {
    const { intervalMs } = parseWatchOptions(rest);
    await runWatchLive({ ...applyLiveProviderOverride(config, provider), strategySlug }, state, intervalMs, statePath);
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
    saveJson(statePath, state);
    console.log(printReplay(plan, replayResult));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
