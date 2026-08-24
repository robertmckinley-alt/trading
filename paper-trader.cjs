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

const BASE = __dirname;
const CONFIG_PATH = path.join(BASE, 'config.json');
const STATE_PATH = path.join(BASE, 'state.json');

function loadConfig() {
  return normalizeConfig(loadJson(CONFIG_PATH));
}

function loadState(config) {
  try {
    return hydrateState(loadJson(STATE_PATH), config);
  } catch {
    return createEmptyState(config);
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

  for (const arg of rest) {
    if (arg.startsWith('--interval=')) {
      intervalMs = Number(arg.slice('--interval='.length));
      continue;
    }
    fileArgs.push(arg);
  }

  if (!Number.isFinite(intervalMs) || intervalMs < 250) {
    throw new Error('watch interval must be at least 250ms');
  }

  return {
    fileArgs,
    intervalMs: Math.round(intervalMs)
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

function main() {
  const { command, rest } = parseArgs(process.argv);
  const config = loadConfig();
  const state = loadState(config);

  if (!command) {
    throw new Error('Usage: node paper-trader.js <plan|replay|journal|report> [files]');
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

main();
