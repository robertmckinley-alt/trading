function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function tradeKey(trade, index) {
  return String(
    trade?.id ||
    `${trade?.date || 'unknown'}:${trade?.filledAt || trade?.createdAt || 'unknown'}:${index}`
  );
}

function consecutiveLossCount(trades) {
  let count = 0;
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    if (Number(trades[index]?.realizedPnlUsd || 0) < 0) count += 1;
    else break;
  }
  return count;
}

function rollingMetrics(trades, windowSize = 20) {
  const history = Array.isArray(trades) ? trades : [];
  const recent = history.slice(-windowSize);
  const wins = recent.filter((trade) => Number(trade?.realizedPnlUsd || 0) > 0);
  const losses = recent.filter((trade) => Number(trade?.realizedPnlUsd || 0) < 0);
  const grossProfitUsd = wins.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd || 0), 0);
  const grossLossUsd = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd || 0), 0));
  const netPnlUsd = grossProfitUsd - grossLossUsd;
  const totalR = recent.reduce((sum, trade) => sum + Number(trade?.rMultiple || 0), 0);
  let cumulativeUsd = 0;
  let peakUsd = 0;
  let maxDrawdownUsd = 0;
  let cumulativeR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;

  for (const trade of recent) {
    cumulativeUsd += Number(trade?.realizedPnlUsd || 0);
    peakUsd = Math.max(peakUsd, cumulativeUsd);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peakUsd - cumulativeUsd);
    cumulativeR += Number(trade?.rMultiple || 0);
    peakR = Math.max(peakR, cumulativeR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - cumulativeR);
  }

  return {
    sampleTrades: recent.length,
    wins: wins.length,
    losses: losses.length,
    winRate: recent.length ? round((wins.length / recent.length) * 100, 1) : null,
    expectancyUsd: recent.length ? round(netPnlUsd / recent.length, 2) : 0,
    avgR: recent.length ? round(totalR / recent.length, 3) : 0,
    profitFactor: grossLossUsd > 0 ? round(grossProfitUsd / grossLossUsd, 3) : null,
    netPnlUsd: round(netPnlUsd, 2),
    maxDrawdownUsd: round(maxDrawdownUsd, 2),
    maxDrawdownR: round(maxDrawdownR, 3),
    consecutiveLosses: consecutiveLossCount(history)
  };
}

function learningStage(tradeCount) {
  if (tradeCount === 0) return 'collecting-data';
  if (tradeCount < 5) return 'warming-up';
  if (tradeCount < 20) return 'early-sample';
  if (tradeCount < 50) return 'developing';
  return 'evidence-building';
}

function deriveAdjustment(metrics) {
  let riskMultiplier = 1;
  const reasons = [];

  if (metrics.consecutiveLosses >= 3) {
    riskMultiplier = Math.min(riskMultiplier, 0.5);
    reasons.push('Three or more consecutive losses triggered the strongest paper-risk reduction.');
  } else if (metrics.consecutiveLosses === 2) {
    riskMultiplier = Math.min(riskMultiplier, 0.65);
    reasons.push('Two consecutive losses reduced the next paper-trade risk ceiling.');
  } else if (metrics.consecutiveLosses === 1) {
    riskMultiplier = Math.min(riskMultiplier, 0.85);
    reasons.push('The most recent loss reduced the next paper-trade risk ceiling.');
  }

  if (metrics.sampleTrades >= 5 && metrics.expectancyUsd < 0) {
    riskMultiplier = Math.min(riskMultiplier, 0.75);
    reasons.push('Rolling expectancy is negative across at least five trades.');
  }
  if (metrics.sampleTrades >= 5 && metrics.maxDrawdownR >= 3) {
    riskMultiplier = Math.min(riskMultiplier, 0.65);
    reasons.push('Rolling drawdown reached at least 3R.');
  }
  if (
    metrics.sampleTrades >= 10 &&
    metrics.profitFactor !== null &&
    metrics.profitFactor < 0.8 &&
    metrics.avgR < 0
  ) {
    riskMultiplier = Math.min(riskMultiplier, 0.5);
    reasons.push('A weak 10-trade profit factor and average R triggered the strongest reduction.');
  }

  if (!reasons.length) {
    reasons.push('No evidence-based risk reduction is active.');
  }

  return {
    applied: riskMultiplier < 1,
    riskMultiplier: round(Math.max(0.5, Math.min(1, riskMultiplier)), 2),
    scope: 'next-paper-trade',
    entryRulesChanged: false,
    canExceedConfiguredRisk: false,
    reason: reasons.join(' ')
  };
}

function recommendationsFor(metrics, stage) {
  const recommendations = [];
  if (metrics.sampleTrades < 20) {
    recommendations.push(`Collect ${20 - metrics.sampleTrades} more forward paper trade${20 - metrics.sampleTrades === 1 ? '' : 's'} before considering entry-rule changes.`);
  }
  if (metrics.sampleTrades >= 5 && metrics.expectancyUsd < 0) {
    recommendations.push('Review losses by session and market regime offline; keep the live paper entry rules locked.');
  }
  if (metrics.sampleTrades >= 20 && metrics.profitFactor !== null && metrics.profitFactor < 1) {
    recommendations.push('Flag this strategy for paper-only review before collecting another forward sample.');
  }
  if (metrics.sampleTrades >= 20 && (metrics.profitFactor === null || metrics.profitFactor >= 1.25) && metrics.avgR > 0) {
    recommendations.push('The forward sample is promising; continue paper validation without increasing the configured risk cap.');
  }
  if (!recommendations.length) {
    recommendations.push(stage === 'collecting-data'
      ? 'Keep the strategy rules fixed until the first paper trade closes.'
      : 'Continue collecting forward paper results with the current rules.');
  }
  return recommendations;
}

function buildProfile(trades, previous, strategySlug, now) {
  const history = Array.isArray(trades) ? trades : [];
  const metrics = rollingMetrics(history);
  const stage = learningStage(history.length);
  return {
    name: 'strategy-learning',
    strategySlug: strategySlug || previous?.strategySlug || null,
    mode: 'paper-only-audited',
    version: Number(previous?.version || 0),
    status: history.length ? 'active' : 'learning',
    stage,
    updatedAt: previous?.updatedAt || null,
    lastTradeId: previous?.lastTradeId || null,
    tradesLearned: history.length,
    windowSize: 20,
    rolling: metrics,
    adjustment: deriveAdjustment(metrics),
    recommendations: recommendationsFor(metrics, stage),
    changeLog: Array.isArray(previous?.changeLog) ? previous.changeLog.slice(-49) : [],
    controls: {
      entryRulesLocked: true,
      paperOnly: true,
      maxRiskIncreaseAllowed: false,
      humanReviewRequiredForRuleChanges: true
    },
    evaluatedAt: now
  };
}

function synchronizeStrategyLearning(trades, options = {}) {
  const history = Array.isArray(trades) ? trades : [];
  const now = options.now || new Date().toISOString();
  const previous = options.previous || null;
  let startIndex = 0;

  if (previous?.lastTradeId) {
    const previousIndex = history.findIndex((trade, index) => tradeKey(trade, index) === previous.lastTradeId);
    startIndex = previousIndex >= 0
      ? previousIndex + 1
      : Math.min(Number(previous.tradesLearned || 0), history.length);
  } else if (Number(previous?.tradesLearned || 0) > 0) {
    startIndex = Math.min(Number(previous.tradesLearned), history.length);
  }

  let profile = buildProfile(history.slice(0, startIndex), previous, options.strategySlug, now);

  for (let index = startIndex; index < history.length; index += 1) {
    const trade = history[index];
    const priorMultiplier = Number(profile.adjustment?.riskMultiplier ?? 1);
    const prefix = history.slice(0, index + 1);
    const next = buildProfile(prefix, profile, options.strategySlug, now);
    const nextMultiplier = Number(next.adjustment.riskMultiplier);
    const direction = nextMultiplier < priorMultiplier
      ? 'risk-reduced'
      : nextMultiplier > priorMultiplier
        ? 'risk-restored'
        : 'risk-held';
    const event = {
      version: Number(profile.version || 0) + 1,
      tradeId: tradeKey(trade, index),
      closedAt: trade?.createdAt || trade?.filledAt || trade?.date || now,
      outcome: Number(trade?.realizedPnlUsd || 0) > 0 ? 'win' : Number(trade?.realizedPnlUsd || 0) < 0 ? 'loss' : 'flat',
      realizedPnlUsd: round(trade?.realizedPnlUsd, 2),
      rMultiple: round(trade?.rMultiple, 3),
      action: direction,
      previousRiskMultiplier: round(priorMultiplier, 2),
      nextRiskMultiplier: round(nextMultiplier, 2),
      entryRulesChanged: false,
      reason: next.adjustment.reason
    };
    profile = {
      ...next,
      version: event.version,
      updatedAt: now,
      lastTradeId: event.tradeId,
      tradesLearned: index + 1,
      changeLog: [...profile.changeLog, event].slice(-50)
    };
  }

  if (startIndex >= history.length) {
    const current = buildProfile(history, previous, options.strategySlug, now);
    profile = {
      ...current,
      version: Number(previous?.version || current.version || 0),
      updatedAt: previous?.updatedAt || current.updatedAt,
      lastTradeId: previous?.lastTradeId || current.lastTradeId,
      changeLog: Array.isArray(previous?.changeLog) ? previous.changeLog.slice(-50) : current.changeLog
    };
  }

  return profile;
}

module.exports = {
  deriveAdjustment,
  rollingMetrics,
  synchronizeStrategyLearning
};
