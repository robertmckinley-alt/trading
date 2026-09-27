const DEFAULTS = Object.freeze({ minimumTrades: 20, profitFactorBelow: 1 });

function splitStrategyCohorts(strategies, settings = {}) {
  const minimumTrades = Math.max(1, Number(settings.strategyWatchlistMinimumTrades ?? DEFAULTS.minimumTrades));
  const profitFactorBelow = Number(settings.strategyWatchlistProfitFactorBelow ?? DEFAULTS.profitFactorBelow);
  const main = [];
  const watchlist = [];
  for (const strategy of Array.isArray(strategies) ? strategies : []) {
    const trades = Number(strategy.journal?.trades ?? strategy.research?.evaluation?.trades ?? 0);
    const profitFactor = strategy.research?.evaluation?.profitFactor;
    const hasProfitFactor = profitFactor !== null && profitFactor !== undefined && Number.isFinite(Number(profitFactor));
    if (trades >= minimumTrades && hasProfitFactor && Number(profitFactor) < profitFactorBelow) {
      watchlist.push(strategy);
    } else main.push(strategy);
  }
  return { main, watchlist, minimumTrades, profitFactorBelow };
}

module.exports = { DEFAULTS, splitStrategyCohorts };
