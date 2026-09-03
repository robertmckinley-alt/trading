#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local'), quiet: true });
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
const { getTelegramConfig, sendTelegramAlert } = require('./lib/telegram-alerts.cjs');
const { applyAdaptiveRisk, evaluateAdaptiveBots } = require('./lib/adaptive-bots.cjs');
const { synchronizeStrategyLearning } = require('./lib/strategy-learning.cjs');
const { reservePortfolioRisk } = require('./lib/portfolio-risk.cjs');
const { applyRiskDecision, buildResearchCouncilReview } = require('./lib/research-council.cjs');
const { requireStrategyDefinition, runtimeFilesForStrategy } = require('./lib/strategy-registry.cjs');

const BASE = __dirname;
const CONFIG_PATH = path.join(BASE, 'config.json');

function statePathForStrategy(strategySlug) {
  return runtimeFilesForStrategy(BASE, strategySlug).statePath;
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

function reportTelegramAlertStatus() {
  const telegram = getTelegramConfig();
  if (!telegram.enabled) {
    console.warn('Telegram alerts: disabled — TELEGRAM_BOT_TOKEN was not found in .env.local or the process environment.');
    return;
  }
  if (!telegram.validTokenFormat) {
    console.warn('Telegram alerts: disabled — TELEGRAM_BOT_TOKEN has an invalid format.');
    return;
  }
  if (!telegram.chatId) {
    console.warn('Telegram alerts: incomplete — add TELEGRAM_CHAT_ID (or TELEGRAM_CHANNEL_ID).');
    return;
  }
  console.log('Telegram trade alerts: configured (trade opened/closed only).');
}

async function sendWatcherAlert(state, event) {
  const eventType = String(event.type || 'watcher');
  if (!['trade-opened', 'trade-closed'].includes(eventType)) return;
  const dedupeKey = String(event.dedupeKey || event.status || eventType);
  if (state.live.alertKeys?.[eventType] === dedupeKey) return;

  try {
    const result = await sendTelegramAlert({
      ...event,
      at: new Date().toISOString()
    });
    if (!result.sent) {
      if (result.reason === 'not-configured') return;
      const messages = {
        'invalid-token': 'Telegram alerts are disabled because TELEGRAM_BOT_TOKEN has an invalid format.',
        'missing-chat-id': 'Telegram alerts require TELEGRAM_CHAT_ID (or TELEGRAM_CHANNEL_ID).'
      };
      const message = messages[result.reason] || 'Telegram alerts are not fully configured.';
      if (state.live.lastAlertError !== message) {
        console.error(`[${new Date().toISOString()}] ${message}`);
      }
      state.live.lastAlertError = message;
      return;
    }
    state.live.alertKeys = { ...(state.live.alertKeys || {}), [eventType]: dedupeKey };
    state.live.lastAlertAt = new Date().toISOString();
    state.live.lastAlertError = null;
  } catch {
    state.live.lastAlertError = 'Telegram alert delivery failed. Check the bot token, chat ID, and network access.';
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
  state.learning = synchronizeStrategyLearning(state.trades, {
    previous: state.learning,
    strategySlug: config.strategySlug
  });
  if (state.live.adaptive) {
    state.live.adaptive.learning = state.learning;
  }
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
    state.live.heartbeat = {
      at: new Date().toISOString(),
      ok: true,
      pollIntervalMs: actualIntervalMs,
      provider: metadata.provider,
      ticker: metadata.ticker,
      lastCandle: lastCandle || null,
      error: null
    };
    const adaptiveDecision = evaluateAdaptiveBots(candles, config, state);
    state.live.adaptive = adaptiveDecision;
    state.learning = adaptiveDecision.learning;
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
      if (lifecycle.filledAt) {
        const adaptive = state.live.openPlan.adaptive;
        await sendWatcherAlert(state, {
          type: 'trade-opened',
          status: 'opened',
          dedupeKey: state.live.openSignalKey || lifecycle.filledAt,
          strategy: config.strategySlug,
          symbol: state.live.openPlan.setup.symbol,
          side: state.live.openPlan.setup.side,
          entry: state.live.openPlan.setup.entry,
          stop: state.live.openPlan.setup.stop,
          message: adaptive
            ? `Paper entry filled at ${Math.round(adaptive.risk.riskMultiplier * 100)}% of configured risk (${adaptive.market.regime}).`
            : 'Paper entry filled.'
        });
        saveLiveState(statePath, state);
      }
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
          message: `Paper trade closed and journaled. Learning v${state.learning.version}: next paper-risk ceiling ${Math.round(state.learning.adjustment.riskMultiplier * 100)}% (${state.learning.adjustment.reason})`
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
    state.live.researchContext = signal.metadata || null;
    state.live.researchCouncil = buildResearchCouncilReview({
      signal,
      adaptiveDecision,
      feedMetadata: metadata
    });
    saveLiveState(statePath, state);
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
      if (!adaptiveDecision.risk.allowed) {
        state.live.researchCouncil = applyRiskDecision(state.live.researchCouncil, adaptiveDecision.risk);
        saveLiveState(statePath, state);
        throw new Error(`Adaptive risk guard: ${adaptiveDecision.risk.reason}`);
      }
      const adaptiveConfig = applyAdaptiveRisk(config, adaptiveDecision);
      plan = buildPlanFromSignal(signal, adaptiveConfig, state);
      plan.adaptive = adaptiveDecision;
      const portfolioDecision = reservePortfolioRisk({
        rootDir: BASE,
        config,
        strategySlug: config.strategySlug,
        proposedRiskUsd: plan.sizing.actualRiskUsd,
        commit: (decision) => {
          const researchCouncil = applyRiskDecision(state.live.researchCouncil, decision);
          plan.researchCouncil = researchCouncil;
          plan.portfolioRisk = {
            capUsd: decision.capUsd,
            reservedBeforeUsd: decision.reservedRiskUsd,
            projectedRiskUsd: decision.projectedRiskUsd
          };
          const nextLiveState = {
            ...state.live,
            portfolioRisk: decision,
            researchCouncil,
            openSignalKey: key,
            openPlan: plan,
            openTriggeredAt: signal.triggerTimestamp,
            signalHistory: [...state.live.signalHistory, key]
          };
          saveLiveState(statePath, { ...state, live: nextLiveState });
          state.live = nextLiveState;
        }
      });
      if (!portfolioDecision.allowed) {
        state.live.portfolioRisk = portfolioDecision;
        state.live.researchCouncil = applyRiskDecision(state.live.researchCouncil, portfolioDecision);
        saveLiveState(statePath, state);
        throw new Error(`Shared portfolio risk guard: ${portfolioDecision.reason}`);
      }
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
  const strategyDefinition = requireStrategyDefinition(strategySlug);
  const statePath = statePathForStrategy(strategySlug);
  const config = {
    ...loadConfig(),
    strategySlug,
    strategyFamily: strategyDefinition.strategyFamily
  };
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
    reportTelegramAlertStatus();
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
