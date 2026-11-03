// Explicit, idempotent limits for the user-approved 9AM paper account only.
const SLUG = 'live-9am-sweep';
const LIMITS = Object.freeze({maxRiskPerTradeUsd:1000, adaptiveRiskFloorUsd:500, maxDailyLossUsd:1500, maxTradesPerDay:2});
function applyStrategyLimits(config, strategySlug) {
  if (strategySlug !== SLUG) return config;
  return {...config, maxRiskPerTradeUsd:LIMITS.maxRiskPerTradeUsd,
    adaptiveRiskFloorUsd:LIMITS.adaptiveRiskFloorUsd, maxDailyLossUsd:LIMITS.maxDailyLossUsd,
    live:{...config.live,maxTradesPerDay:LIMITS.maxTradesPerDay}};
}
module.exports={SLUG,LIMITS,applyStrategyLimits};
