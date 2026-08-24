const fs = require('fs');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function num(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${label}`);
  }
  return parsed;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatUsd(value) {
  return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPoints(value) {
  return `${round(value, 2).toFixed(2)} pts`;
}

function accountFloorUsd(config) {
  return round(config.startingBalanceUsd * (1 - (config.maxAccountDrawdownPercent / 100)), 2);
}

function remainingDrawdownRoomUsd(balanceUsd, config) {
  return round(balanceUsd - accountFloorUsd(config), 2);
}

function createEmptyState(config) {
  return {
    startingBalanceUsd: config.startingBalanceUsd,
    balanceUsd: config.startingBalanceUsd,
    realizedPnlUsd: 0,
    trades: [],
    lastUpdatedAt: null
  };
}

function hydrateState(rawState, config) {
  const state = rawState ? { ...rawState } : createEmptyState(config);
  state.realizedPnlUsd ??= 0;
  state.startingBalanceUsd = config.startingBalanceUsd;
  state.balanceUsd = round(config.startingBalanceUsd + state.realizedPnlUsd, 2);
  state.trades = Array.isArray(state.trades) ? state.trades : [];
  state.lastUpdatedAt ??= null;
  return state;
}

function normalizeConfig(rawConfig) {
  const config = { ...rawConfig };
  config.symbol = String(config.symbol || 'NQ').toUpperCase();
  config.startingBalanceUsd = num(config.startingBalanceUsd ?? 50000, 'startingBalanceUsd');
  config.maxAccountDrawdownPercent = num(config.maxAccountDrawdownPercent ?? 0, 'maxAccountDrawdownPercent');
  config.maxRiskPerTradeUsd = num(config.maxRiskPerTradeUsd ?? 250, 'maxRiskPerTradeUsd');
  config.maxDailyLossUsd = num(config.maxDailyLossUsd ?? 750, 'maxDailyLossUsd');
  config.tickSize = num(config.tickSize ?? 0.25, 'tickSize');
  config.tickValueUsd = num(config.tickValueUsd ?? 5, 'tickValueUsd');
  config.commissionPerContractUsd = num(config.commissionPerContractUsd ?? 0, 'commissionPerContractUsd');
  config.slippageTicks = num(config.slippageTicks ?? 0, 'slippageTicks');
  config.minimumRMultiple = num(config.minimumRMultiple ?? 0, 'minimumRMultiple');
  config.sameCandleConflict = String(config.sameCandleConflict || 'stop-first');
  config.defaultScaleOuts = Array.isArray(config.defaultScaleOuts)
    ? config.defaultScaleOuts.map((scale) => ({
      targetIndex: num(scale.targetIndex, 'defaultScaleOuts.targetIndex'),
      closeFraction: num(scale.closeFraction, 'defaultScaleOuts.closeFraction')
    }))
    : [];
  return config;
}

function normalizeSetup(rawSetup, config) {
  const setup = { ...rawSetup };
  setup.symbol = String(setup.symbol || config.symbol || 'NQ').toUpperCase();
  setup.side = String(setup.side || '').toLowerCase();
  setup.entry = num(setup.entry, 'entry');
  setup.stop = num(setup.stop, 'stop');
  setup.targets = Array.isArray(setup.targets) ? setup.targets.map((target, index) => num(target, `targets[${index}]`)) : [];
  setup.thesis = String(setup.thesis || '').trim();
  setup.session = String(setup.session || 'unspecified');
  setup.date = String(setup.date || new Date().toISOString().slice(0, 10));
  setup.setup = setup.setup || {};
  setup.setup.reaction = String(setup.setup.reaction || '').toLowerCase();
  setup.setup.entryModel = String(setup.setup.entryModel || '').toLowerCase();
  setup.setup.gapType = String(setup.setup.gapType || '').toLowerCase();
  setup.setup.entryTimeframe = String(setup.setup.entryTimeframe || '').toUpperCase();
  setup.setup.liquidityPool = String(setup.setup.liquidityPool || '').toLowerCase();
  setup.setup.activationTime = String(setup.setup.activationTime || '').trim();
  setup.setup.stopPlacement = String(setup.setup.stopPlacement || '').toLowerCase();
  setup.setup.referenceSessions = Array.isArray(setup.setup.referenceSessions)
    ? setup.setup.referenceSessions.map((item) => String(item).toLowerCase())
    : [];
  setup.setup.drawOnLiquidity = Array.isArray(setup.setup.drawOnLiquidity)
    ? setup.setup.drawOnLiquidity.map((item) => String(item).toLowerCase())
    : [];
  return setup;
}

function validateSetup(setup, config) {
  const errors = [];
  if (!['long', 'short'].includes(setup.side)) {
    errors.push('side must be "long" or "short"');
  }
  if (!setup.targets.length) {
    errors.push('at least one target is required');
  }
  if (!setup.thesis) {
    errors.push('thesis is required');
  }
  if (!setup.setup.liquiditySweep) {
    errors.push('setup.liquiditySweep must be true');
  }
  if (!['bullish', 'bearish'].includes(setup.setup.reaction)) {
    errors.push('setup.reaction must be "bullish" or "bearish"');
  }
  if (!['session-sweep-fvg-reversal', 'mss-fvg', 'mss-ifvg', 'amd-fvg', 'amd-ifvg'].includes(setup.setup.entryModel)) {
    errors.push('setup.entryModel must be one of session-sweep-fvg-reversal, mss-fvg, mss-ifvg, amd-fvg, amd-ifvg');
  }
  if (!['fvg', 'ifvg'].includes(setup.setup.gapType)) {
    errors.push('setup.gapType must be "fvg" or "ifvg"');
  }
  if (setup.setup.entryTimeframe !== 'M1') {
    errors.push('setup.entryTimeframe must be "M1" for this reel strategy');
  }
  if (!setup.setup.liquidityPool) {
    errors.push('setup.liquidityPool is required');
  }
  if (!setup.setup.referenceSessions.length) {
    errors.push('setup.referenceSessions must include the session ranges you marked out, like asia/london');
  }
  if (!setup.setup.activationTime) {
    errors.push('setup.activationTime is required');
  }
  if (!['swing-low', 'swing-high', 'swing-extreme'].includes(setup.setup.stopPlacement)) {
    errors.push('setup.stopPlacement must be swing-low, swing-high, or swing-extreme');
  }
  if (!setup.setup.drawOnLiquidity.length) {
    errors.push('setup.drawOnLiquidity must include at least one target narrative like vwap/current-week-low');
  }
  if (setup.side === 'long' && setup.setup.reaction !== 'bullish') {
    errors.push('long setups must use a bullish reaction');
  }
  if (setup.side === 'short' && setup.setup.reaction !== 'bearish') {
    errors.push('short setups must use a bearish reaction');
  }
  if (setup.side === 'long') {
    if (setup.stop >= setup.entry) {
      errors.push('for long trades, stop must be below entry');
    }
    if (setup.targets.some((target) => target <= setup.entry)) {
      errors.push('for long trades, every target must be above entry');
    }
  }
  if (setup.side === 'short') {
    if (setup.stop <= setup.entry) {
      errors.push('for short trades, stop must be above entry');
    }
    if (setup.targets.some((target) => target >= setup.entry)) {
      errors.push('for short trades, every target must be below entry');
    }
  }

  const stopDistancePoints = Math.abs(setup.entry - setup.stop);
  if (stopDistancePoints <= 0) {
    errors.push('stop distance must be greater than zero');
  }

  const bestTarget = setup.side === 'long' ? Math.max(...setup.targets) : Math.min(...setup.targets);
  const rewardPoints = Math.abs(bestTarget - setup.entry);
  const rr = stopDistancePoints > 0 ? rewardPoints / stopDistancePoints : 0;
  if (config.minimumRMultiple > 0 && rr < config.minimumRMultiple) {
    errors.push(`best target only offers ${round(rr, 2)}R, below the ${config.minimumRMultiple}R minimum`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function buildTradePlan(setup, config, state) {
  const stopDistancePoints = Math.abs(setup.entry - setup.stop);
  const tickDistance = stopDistancePoints / config.tickSize;
  const riskPerContractUsd = tickDistance * config.tickValueUsd;
  const slippageUsd = config.slippageTicks * config.tickValueUsd;
  const totalRiskPerContractUsd = riskPerContractUsd + slippageUsd + config.commissionPerContractUsd;
  const drawdownRoomUsd = remainingDrawdownRoomUsd(state.balanceUsd, config);
  const riskBudgetUsd = Math.min(config.maxRiskPerTradeUsd, Math.max(0, drawdownRoomUsd));
  const maxContracts = Math.floor(riskBudgetUsd / totalRiskPerContractUsd);

  if (maxContracts < 1) {
    throw new Error(
      `Account drawdown guard active: balance ${formatUsd(state.balanceUsd)} is too close to the ${formatUsd(accountFloorUsd(config))} floor to take another trade.`
    );
  }

  const actualRiskUsd = round(maxContracts * totalRiskPerContractUsd, 2);
  const scaleOuts = config.defaultScaleOuts
    .filter((scale) => scale.targetIndex < setup.targets.length)
    .map((scale) => ({ ...scale }));

  const targets = setup.targets.map((target, index) => {
    const rewardPoints = Math.abs(target - setup.entry);
    const rr = rewardPoints / stopDistancePoints;
    const scaleOut = scaleOuts.find((item) => item.targetIndex === index);
    return {
      price: target,
      rewardPoints: round(rewardPoints, 2),
      rewardTicks: round(rewardPoints / config.tickSize, 2),
      rMultiple: round(rr, 2),
      closeFraction: scaleOut ? scaleOut.closeFraction : 0
    };
  });

  return {
    strategy: 'doctradesnq-9am-session-sweep-fvg-paper-trader',
    setup,
    sizing: {
      accountBalanceUsd: round(state.balanceUsd, 2),
      accountFloorUsd: accountFloorUsd(config),
      remainingDrawdownRoomUsd: drawdownRoomUsd,
      riskBudgetUsd: round(riskBudgetUsd, 2),
      stopDistancePoints: round(stopDistancePoints, 2),
      stopDistanceTicks: round(tickDistance, 2),
      riskPerContractUsd: round(riskPerContractUsd, 2),
      slippageUsd: round(slippageUsd, 2),
      totalRiskPerContractUsd: round(totalRiskPerContractUsd, 2),
      maxContracts,
      actualRiskUsd
    },
    targets,
    narrative: {
      activationTime: setup.setup.activationTime,
      referenceSessions: setup.setup.referenceSessions,
      liquidityPool: setup.setup.liquidityPool,
      reaction: setup.setup.reaction,
      entryModel: setup.setup.entryModel,
      gapType: setup.setup.gapType,
      entryTimeframe: setup.setup.entryTimeframe,
      stopPlacement: setup.setup.stopPlacement,
      drawOnLiquidity: setup.setup.drawOnLiquidity
    }
  };
}

function parseCsvText(rawCsv) {
  const raw = String(rawCsv || '').trim();
  if (!raw) {
    throw new Error('CSV data is required');
  }
  const lines = raw.split(/\r?\n/);
  const [headerLine, ...rows] = lines;
  const headers = headerLine.split(',').map((cell) => cell.trim());
  return rows.filter(Boolean).map((line, rowIndex) => {
    const cells = line.split(',').map((cell) => cell.trim());
    const record = {};
    headers.forEach((header, index) => {
      record[header] = cells[index];
    });
    if (!record.timestamp) {
      throw new Error(`CSV row ${rowIndex + 2} is missing timestamp`);
    }
    return {
      timestamp: record.timestamp,
      open: num(record.open, `row ${rowIndex + 2} open`),
      high: num(record.high, `row ${rowIndex + 2} high`),
      low: num(record.low, `row ${rowIndex + 2} low`),
      close: num(record.close, `row ${rowIndex + 2} close`)
    };
  });
}

function parseCsvFile(csvPath) {
  return parseCsvText(fs.readFileSync(csvPath, 'utf8'));
}

function priceTouched(candle, price) {
  return candle.low <= price && candle.high >= price;
}

function stopHit(candle, stop, side) {
  return side === 'long' ? candle.low <= stop : candle.high >= stop;
}

function targetHit(candle, target, side) {
  return side === 'long' ? candle.high >= target : candle.low <= target;
}

function pnlForMove(entry, exit, contracts, side, config) {
  const points = side === 'long' ? (exit - entry) : (entry - exit);
  const ticks = points / config.tickSize;
  const gross = ticks * config.tickValueUsd * contracts;
  const commissions = config.commissionPerContractUsd * contracts;
  return round(gross - commissions, 2);
}

function replayPlan(plan, candles, config) {
  const side = plan.setup.side;
  const entry = plan.setup.entry;
  const stop = plan.setup.stop;
  const contracts = plan.sizing.maxContracts;
  const hitTargetsSeen = [];
  let remainingContracts = contracts;
  let filledAt = null;
  let exitReason = null;
  let finalExitPrice = null;
  let realizedPnlUsd = 0;

  for (const candle of candles) {
    if (!filledAt) {
      if (priceTouched(candle, entry)) {
        filledAt = candle.timestamp;
      }
      continue;
    }

    const pendingTargets = plan.targets.filter((target) => !hitTargetsSeen.includes(target.price));
    const hitStop = stopHit(candle, stop, side);
    const hitTargets = pendingTargets.filter((target) => targetHit(candle, target.price, side));

    if (hitStop && hitTargets.length && config.sameCandleConflict === 'stop-first') {
      realizedPnlUsd += pnlForMove(entry, stop, remainingContracts, side, config);
      finalExitPrice = stop;
      exitReason = 'stop-loss same-candle conflict';
      remainingContracts = 0;
      break;
    }

    for (const target of hitTargets) {
      if (remainingContracts <= 0) break;
      const closeContracts = Math.min(remainingContracts, Math.max(1, Math.round(contracts * target.closeFraction)));
      realizedPnlUsd += pnlForMove(entry, target.price, closeContracts, side, config);
      remainingContracts -= closeContracts;
      hitTargetsSeen.push(target.price);
      finalExitPrice = target.price;
      exitReason = `target ${target.price}`;
    }

    if (remainingContracts <= 0) {
      break;
    }

    if (hitStop) {
      realizedPnlUsd += pnlForMove(entry, stop, remainingContracts, side, config);
      finalExitPrice = stop;
      exitReason = 'stop-loss';
      remainingContracts = 0;
      break;
    }
  }

  if (!filledAt) {
    return {
      status: 'not-filled',
      filledAt: null,
      exitReason: 'entry never traded',
      realizedPnlUsd: 0,
      rMultiple: 0,
      targetsHit: [],
      contracts
    };
  }

  if (remainingContracts > 0) {
    const lastCandle = candles[candles.length - 1];
    realizedPnlUsd += pnlForMove(entry, lastCandle.close, remainingContracts, side, config);
    finalExitPrice = lastCandle.close;
    exitReason = exitReason || 'end-of-data close';
  }

  const rMultiple = plan.sizing.actualRiskUsd > 0 ? round(realizedPnlUsd / plan.sizing.actualRiskUsd, 2) : 0;
  return {
    status: 'closed',
    filledAt,
    exitReason,
    finalExitPrice,
    realizedPnlUsd: round(realizedPnlUsd, 2),
    rMultiple,
    targetsHit: hitTargetsSeen,
    contracts
  };
}

function toJournalTrade(plan, replayResult) {
  return {
    id: `${plan.setup.symbol}-${plan.setup.date}-${Date.now()}`,
    symbol: plan.setup.symbol,
    date: plan.setup.date,
    session: plan.setup.session,
    side: plan.setup.side,
    entry: plan.setup.entry,
    stop: plan.setup.stop,
    targets: plan.setup.targets,
    thesis: plan.setup.thesis,
    liquidityLabel: plan.setup.setup.liquidityLabel || null,
    liquidityPool: plan.setup.setup.liquidityPool || null,
    reaction: plan.setup.setup.reaction || null,
    entryModel: plan.setup.setup.entryModel || null,
    gapType: plan.setup.setup.gapType || null,
    entryTimeframe: plan.setup.setup.entryTimeframe || null,
    drawOnLiquidity: plan.setup.setup.drawOnLiquidity || [],
    contracts: replayResult.contracts,
    filledAt: replayResult.filledAt,
    exitReason: replayResult.exitReason,
    finalExitPrice: replayResult.finalExitPrice || null,
    realizedPnlUsd: replayResult.realizedPnlUsd,
    rMultiple: replayResult.rMultiple,
    targetsHit: replayResult.targetsHit,
    status: replayResult.status,
    createdAt: new Date().toISOString()
  };
}

function computeReport(state, config) {
  const totalTrades = state.trades.length;
  const wins = state.trades.filter((trade) => trade.realizedPnlUsd > 0).length;
  const losses = state.trades.filter((trade) => trade.realizedPnlUsd < 0).length;
  const winRate = totalTrades ? round((wins / totalTrades) * 100, 1) : 0;
  const avgR = totalTrades
    ? round(state.trades.reduce((sum, trade) => sum + Number(trade.rMultiple || 0), 0) / totalTrades, 2)
    : 0;
  const floorUsd = accountFloorUsd(config);
  const drawdownRoomUsd = remainingDrawdownRoomUsd(state.balanceUsd, config);

  return {
    balanceUsd: state.balanceUsd,
    realizedPnlUsd: state.realizedPnlUsd,
    totalTrades,
    wins,
    losses,
    winRate,
    avgR,
    floorUsd,
    drawdownRoomUsd,
    maxDailyLossUsd: config.maxDailyLossUsd,
    maxRiskPerTradeUsd: config.maxRiskPerTradeUsd,
    locked: drawdownRoomUsd <= 0,
    recentTrades: state.trades.slice(-10)
  };
}

function printPlan(plan) {
  const lines = [];
  lines.push(`Strategy: ${plan.strategy}`);
  lines.push(`Setup: ${plan.setup.side.toUpperCase()} ${plan.setup.symbol} | ${plan.setup.session} | ${plan.setup.date}`);
  lines.push(`Entry ${plan.setup.entry} | Stop ${plan.setup.stop} | Thesis: ${plan.setup.thesis}`);
  lines.push(`Model: ${plan.narrative.activationTime} | mark ${plan.narrative.referenceSessions.join(', ')} highs/lows | ${plan.narrative.reaction} reaction off ${plan.narrative.liquidityPool} -> ${plan.narrative.entryModel.toUpperCase()} on ${plan.narrative.entryTimeframe} ${plan.narrative.gapType.toUpperCase()} | stop: ${plan.narrative.stopPlacement} | draw: ${plan.narrative.drawOnLiquidity.join(', ')}`);
  lines.push(`Account: ${formatUsd(plan.sizing.accountBalanceUsd)} | Floor: ${formatUsd(plan.sizing.accountFloorUsd)} | Drawdown room: ${formatUsd(plan.sizing.remainingDrawdownRoomUsd)}`);
  lines.push(`Risk: ${formatPoints(plan.sizing.stopDistancePoints)} | ${plan.sizing.stopDistanceTicks} ticks | ${formatUsd(plan.sizing.totalRiskPerContractUsd)} / contract`);
  lines.push(`Size: ${plan.sizing.maxContracts} contracts | planned risk ${formatUsd(plan.sizing.actualRiskUsd)} | risk budget ${formatUsd(plan.sizing.riskBudgetUsd)}`);
  lines.push('Targets:');
  for (const target of plan.targets) {
    lines.push(`- ${target.price} | ${target.rMultiple}R | ${target.rewardTicks} ticks | scale ${Math.round(target.closeFraction * 100)}%`);
  }
  return lines.join('\n');
}

function printReplay(plan, replayResult) {
  const lines = [];
  lines.push(`Replay result: ${replayResult.status}`);
  lines.push(`Filled at: ${replayResult.filledAt || 'not filled'}`);
  lines.push(`Exit reason: ${replayResult.exitReason}`);
  if (replayResult.finalExitPrice != null) {
    lines.push(`Final exit: ${replayResult.finalExitPrice}`);
  }
  lines.push(`Targets hit: ${replayResult.targetsHit.length ? replayResult.targetsHit.join(', ') : 'none'}`);
  lines.push(`Contracts: ${replayResult.contracts}`);
  lines.push(`Realized PnL: ${formatUsd(replayResult.realizedPnlUsd)}`);
  lines.push(`R multiple: ${replayResult.rMultiple}`);
  lines.push(`Planned risk: ${formatUsd(plan.sizing.actualRiskUsd)}`);
  return lines.join('\n');
}

function printReport(state, config) {
  const report = computeReport(state, config);
  const lines = [];
  lines.push(`Balance: ${formatUsd(report.balanceUsd)} | Realized: ${formatUsd(report.realizedPnlUsd)} | Trades: ${report.totalTrades}`);
  lines.push(`Account model: start ${formatUsd(config.startingBalanceUsd)} | max drawdown ${config.maxAccountDrawdownPercent}% | floor ${formatUsd(report.floorUsd)} | room left ${formatUsd(report.drawdownRoomUsd)}`);
  lines.push(`Win rate: ${report.winRate}% | Wins: ${report.wins} | Losses: ${report.losses} | Avg R: ${report.avgR}`);
  lines.push(`Daily max loss guard: ${formatUsd(report.maxDailyLossUsd)} | Per-trade risk: ${formatUsd(report.maxRiskPerTradeUsd)}`);
  if (report.locked) {
    lines.push('Status: drawdown floor breached, no new trades should be planned until the account is reset.');
  }
  if (!report.totalTrades) {
    lines.push('No journaled trades yet.');
  } else {
    lines.push('Recent trades:');
    for (const trade of report.recentTrades) {
      lines.push(`- ${trade.date} ${trade.symbol} ${trade.side} | ${trade.session} | PnL ${formatUsd(trade.realizedPnlUsd)} | ${trade.rMultiple}R | ${trade.exitReason}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  accountFloorUsd,
  buildTradePlan,
  computeReport,
  createEmptyState,
  formatPoints,
  formatUsd,
  hydrateState,
  loadJson,
  normalizeConfig,
  normalizeSetup,
  parseCsvFile,
  parseCsvText,
  printPlan,
  printReplay,
  printReport,
  replayPlan,
  remainingDrawdownRoomUsd,
  saveJson,
  toJournalTrade,
  validateSetup
};
