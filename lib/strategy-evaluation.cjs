function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function evaluateStrategyJournal(state = {}) {
  const trades = Array.isArray(state.trades) ? state.trades : [];
  const closedTrades = trades.filter((trade) => Number.isFinite(Number(trade.realizedPnlUsd)));
  const wins = closedTrades.filter((trade) => Number(trade.realizedPnlUsd) > 0);
  const losses = closedTrades.filter((trade) => Number(trade.realizedPnlUsd) < 0);
  const grossProfitUsd = wins.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd), 0);
  const grossLossUsd = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd), 0));
  const tradingDays = new Set(closedTrades.map((trade) => trade.date).filter(Boolean)).size;
  const averageR = closedTrades.length
    ? closedTrades.reduce((sum, trade) => sum + Number(trade.rMultiple || 0), 0) / closedTrades.length
    : 0;
  const expectancyUsd = closedTrades.length
    ? (grossProfitUsd - grossLossUsd) / closedTrades.length
    : 0;
  const profitFactor = grossLossUsd > 0
    ? grossProfitUsd / grossLossUsd
    : grossProfitUsd > 0 ? null : 0;

  let runningPnl = 0;
  let peakPnl = 0;
  let maxDrawdownUsd = 0;
  for (const trade of closedTrades) {
    runningPnl += Number(trade.realizedPnlUsd || 0);
    peakPnl = Math.max(peakPnl, runningPnl);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peakPnl - runningPnl);
  }

  const gates = {
    sampleSize: closedTrades.length >= 50,
    tradingDays: tradingDays >= 20,
    profitFactor: grossProfitUsd > 0 && (grossLossUsd === 0 || profitFactor >= 1.2),
    positiveExpectancy: expectancyUsd > 0,
    positiveAverageR: averageR > 0,
    drawdownContained: closedTrades.length > 0 && maxDrawdownUsd <= 1500
  };
  const passedGates = Object.values(gates).filter(Boolean).length;
  const status = closedTrades.length < 20
    ? 'Warming up'
    : closedTrades.length < 50
      ? 'Collecting evidence'
      : passedGates === Object.keys(gates).length
        ? 'Paper candidate'
        : 'Needs review';

  return {
    status,
    execution: 'paper-only',
    trades: closedTrades.length,
    tradingDays,
    wins: wins.length,
    losses: losses.length,
    winRate: closedTrades.length ? round((wins.length / closedTrades.length) * 100) : 0,
    profitFactor: profitFactor === null ? null : round(profitFactor),
    expectancyUsd: round(expectancyUsd),
    averageR: round(averageR),
    maxDrawdownUsd: round(maxDrawdownUsd),
    gates,
    passedGates,
    totalGates: Object.keys(gates).length,
    note: 'Forward paper results are evidence, not a promise of future returns.'
  };
}

module.exports = { evaluateStrategyJournal };
