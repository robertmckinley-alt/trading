function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function trueRanges(candles) {
  return candles.slice(1).map((candle, index) => {
    const previousClose = Number(candles[index].close);
    return Math.max(
      Number(candle.high) - Number(candle.low),
      Math.abs(Number(candle.high) - previousClose),
      Math.abs(Number(candle.low) - previousClose)
    );
  }).filter(Number.isFinite);
}

function marketRegimeBot(candles) {
  const sample = Array.isArray(candles) ? candles.slice(-180) : [];
  if (sample.length < 31) {
    return {
      name: 'market-regime',
      status: 'warming-up',
      regime: 'unknown',
      riskMultiplier: 0.5,
      reason: `Waiting for 31 live bars (${sample.length} available).`
    };
  }

  const ranges = trueRanges(sample);
  const recentAtr = average(ranges.slice(-15));
  const baselineAtr = average(ranges.slice(-120)) || recentAtr;
  const volatilityRatio = baselineAtr > 0 ? recentAtr / baselineAtr : 1;
  const recent = sample.slice(-30);
  const netMove = Math.abs(Number(recent.at(-1).close) - Number(recent[0].close));
  const totalMove = recent.slice(1).reduce(
    (sum, candle, index) => sum + Math.abs(Number(candle.close) - Number(recent[index].close)),
    0
  );
  const trendEfficiency = totalMove > 0 ? netMove / totalMove : 0;

  let regime = 'balanced';
  let riskMultiplier = 1;
  let reason = 'Volatility and directional efficiency are inside normal bounds.';
  if (volatilityRatio >= 1.8) {
    regime = 'extreme-volatility';
    riskMultiplier = 0.5;
    reason = 'Recent true range is at least 1.8× its baseline.';
  } else if (volatilityRatio >= 1.35) {
    regime = 'high-volatility';
    riskMultiplier = 0.75;
    reason = 'Recent true range is elevated versus its baseline.';
  } else if (trendEfficiency >= 0.55) {
    regime = 'trending';
    reason = 'Recent closes show strong directional efficiency.';
  } else if (trendEfficiency <= 0.18 && volatilityRatio <= 0.9) {
    regime = 'quiet-chop';
    riskMultiplier = 0.75;
    reason = 'Low volatility and low directional efficiency suggest chop.';
  }

  return {
    name: 'market-regime',
    status: 'active',
    regime,
    riskMultiplier,
    volatilityRatio: round(volatilityRatio),
    trendEfficiency: round(trendEfficiency),
    recentAtrPoints: round(recentAtr),
    reason
  };
}

function performanceBot(trades, tradingDate) {
  const history = Array.isArray(trades) ? trades : [];
  const recent = history.slice(-20);
  let consecutiveLosses = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (Number(history[index].realizedPnlUsd || 0) < 0) consecutiveLosses += 1;
    else break;
  }
  const dailyPnlUsd = history
    .filter((trade) => trade.date === tradingDate)
    .reduce((sum, trade) => sum + Number(trade.realizedPnlUsd || 0), 0);
  const wins = recent.filter((trade) => Number(trade.realizedPnlUsd || 0) > 0).length;
  const avgR = recent.length
    ? average(recent.map((trade) => Number(trade.rMultiple || 0)))
    : 0;
  const riskMultiplier = consecutiveLosses >= 3 ? 0.5 : consecutiveLosses === 2 ? 0.65 : consecutiveLosses === 1 ? 0.85 : 1;

  return {
    name: 'performance',
    status: recent.length ? 'active' : 'learning',
    sampleTrades: recent.length,
    winRate: recent.length ? round((wins / recent.length) * 100, 1) : null,
    avgR: round(avgR),
    consecutiveLosses,
    dailyPnlUsd: round(dailyPnlUsd, 2),
    riskMultiplier,
    reason: consecutiveLosses
      ? `Risk reduced after ${consecutiveLosses} consecutive loss${consecutiveLosses === 1 ? '' : 'es'}.`
      : 'No active losing-streak reduction.'
  };
}

function riskGuardBot(config, state, market, performance) {
  const configuredRiskUsd = Math.max(0, Number(config.maxRiskPerTradeUsd || 0));
  const riskFloorUsd = Math.min(
    configuredRiskUsd,
    Math.max(0, Number(config.adaptiveRiskFloorUsd || 0))
  );
  const dailyLossLimitUsd = Math.max(0, Number(config.maxDailyLossUsd || 0));
  const atDailyLossLimit = dailyLossLimitUsd > 0 && performance.dailyPnlUsd <= -dailyLossLimitUsd;
  const floorUsd = Number(config.startingBalanceUsd || 0) * (1 - (Number(config.maxAccountDrawdownPercent || 0) / 100));
  const atAccountFloor = Number(state.balanceUsd || 0) <= floorUsd;
  const multiplier = Math.max(0.5, Math.min(1, market.riskMultiplier, performance.riskMultiplier));
  const adjustedRiskUsd = Math.min(
    configuredRiskUsd,
    Math.max(riskFloorUsd, configuredRiskUsd * multiplier)
  );
  const effectiveMultiplier = configuredRiskUsd > 0 ? adjustedRiskUsd / configuredRiskUsd : 0;
  const allowed = !atDailyLossLimit && !atAccountFloor;
  const reasons = [];
  if (atDailyLossLimit) reasons.push('Daily loss limit reached. New trades are paused for this trading date.');
  if (atAccountFloor) reasons.push('Account drawdown floor reached. New trades are paused.');
  if (!reasons.length && riskFloorUsd > 0 && adjustedRiskUsd === riskFloorUsd) {
    reasons.push(`The configured $${riskFloorUsd.toFixed(2)} adaptive baseline is active.`);
  }
  if (!reasons.length && multiplier < 1) reasons.push('Risk reduced by the most conservative active bot.');
  if (!reasons.length) reasons.push('All paper-trading risk guards are clear.');

  return {
    name: 'risk-guard',
    status: allowed ? 'clear' : 'paused',
    allowed,
    riskMultiplier: round(effectiveMultiplier),
    recommendedRiskMultiplier: round(multiplier),
    configuredRiskUsd: round(configuredRiskUsd, 2),
    riskFloorUsd: round(riskFloorUsd, 2),
    adjustedRiskUsd: round(adjustedRiskUsd, 2),
    dailyLossLimitUsd: round(dailyLossLimitUsd, 2),
    accountFloorUsd: round(floorUsd, 2),
    reason: reasons.join(' ')
  };
}

function tradingDateForCandle(candle, timeZone = 'America/New_York') {
  const date = new Date(candle?.timestamp || Date.now());
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function evaluateAdaptiveBots(candles, config, state) {
  const latest = candles?.at(-1) || null;
  const tradingDate = tradingDateForCandle(latest);
  const market = marketRegimeBot(candles);
  const performance = performanceBot(state.trades, tradingDate);
  const risk = riskGuardBot(config, state, market, performance);
  return {
    evaluatedAt: new Date().toISOString(),
    tradingDate,
    mode: 'paper-only-bounded',
    market,
    performance,
    risk
  };
}

function applyAdaptiveRisk(config, decision) {
  return {
    ...config,
    maxRiskPerTradeUsd: Math.min(
      Number(config.maxRiskPerTradeUsd || 0),
      Number(decision?.risk?.adjustedRiskUsd || 0)
    )
  };
}

module.exports = {
  applyAdaptiveRisk,
  evaluateAdaptiveBots,
  marketRegimeBot,
  performanceBot,
  riskGuardBot,
  tradingDateForCandle
};
