const { auditCandles, performanceMetrics, reviewBacktestEvidence } = require('./research-lab.cjs');
const { STRATEGIES } = require('./strategy-registry.cjs');
const { createEmptyState, replayPlan, toJournalTrade } = require('./trader-core.cjs');
const { buildPlanFromSignal, detectSignalFromCandles } = require('./live-trader.cjs');

const TIME_ZONE = 'America/New_York';
const ZONED_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
});

function zonedParts(value) {
  const parts = Object.fromEntries(ZONED_FORMATTER.formatToParts(new Date(value)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: (Number(parts.hour) * 60) + Number(parts.minute) };
}

function groupTradingDays(candles) {
  const groups = new Map();
  candles.forEach((candle, index) => {
    const parts = zonedParts(candle.timestamp);
    if (!groups.has(parts.date)) groups.set(parts.date, []);
    groups.get(parts.date).push({ candle, index, minute: parts.minute });
  });
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function checkpointsForDay(slug, records) {
  const cashEnd = records.filter((record) => record.minute <= 960);
  if (!cashEnd.length) return [];
  if (slug === 'ema-20-60-momentum') {
    return cashEnd.filter((record) => record.minute >= 570 && record.minute <= 945 && record.minute % 15 === 14);
  }

  const windows = {
    'live-9am-sweep': [540, 960],
    'hourly-sweep-ifvg-bos': [60, 960],
    'nq-opening-range-breakout': [660, 930],
    'volume-poc-reversion': [630, 945],
    'nq-15m-opening-range-retest': [585, 690],
    'nq-15m-orb-close-confirmation': [585, 690]
  };
  const window = windows[slug];
  if (!window) return [cashEnd.at(-1)];
  return cashEnd.filter((record) => record.minute >= window[0] && record.minute <= window[1] && record.minute % 5 === 0);
}

function instrumentForDay(records) {
  return records.find((record) => record.candle.instrumentId !== null)?.candle.instrumentId ?? null;
}

function simulatedTrade(plan, replay, signal, slug, sequence) {
  return {
    ...toJournalTrade(plan, replay),
    id: `backtest-${slug}-${signal.setup.date}-${sequence}`,
    createdAt: signal.triggerTimestamp,
    signalAt: signal.triggerTimestamp,
    evidenceType: 'historical-simulated'
  };
}

function runStrategyBacktest(candles, rawConfig, definition, dependencies = {}) {
  const detectSignal = dependencies.detectSignal || detectSignalFromCandles;
  const buildPlan = dependencies.buildPlan || buildPlanFromSignal;
  const replay = dependencies.replay || replayPlan;
  const days = groupTradingDays(candles);
  const config = {
    ...rawConfig,
    strategySlug: definition.slug,
    strategyFamily: definition.strategyFamily,
    live: { ...(rawConfig.live || {}), maxTradesPerDay: 1 }
  };
  const state = createEmptyState(config);
  const trades = [];
  let signals = 0;
  let notFilled = 0;
  let rejectedSignals = 0;
  let rolloverDaysSkipped = 0;
  let previousInstrument = null;

  for (const [, records] of days) {
    const instrument = instrumentForDay(records);
    if (previousInstrument !== null && instrument !== null && instrument !== previousInstrument) {
      rolloverDaysSkipped += 1;
      previousInstrument = instrument;
      continue;
    }
    if (instrument !== null) previousInstrument = instrument;

    let signal = null;
    for (const checkpoint of checkpointsForDay(definition.slug, records)) {
      const contextStart = Math.max(0, checkpoint.index - 2500);
      const context = candles.slice(contextStart, checkpoint.index + 1);
      const candidate = detectSignal(context, config, state);
      if (candidate.found) {
        signal = candidate;
        break;
      }
    }
    if (!signal) continue;
    signals += 1;
    const triggerTime = Date.parse(signal.triggerTimestamp);
    const future = records
      .filter((record) => record.minute <= 960 && Date.parse(record.candle.timestamp) > triggerTime)
      .map((record) => record.candle);
    if (!future.length) {
      notFilled += 1;
      continue;
    }

    try {
      const plan = buildPlan(signal, config, state);
      const result = replay(plan, future, config);
      if (result.status === 'not-filled') {
        notFilled += 1;
        continue;
      }
      const trade = simulatedTrade(plan, result, signal, definition.slug, trades.length + 1);
      trades.push(trade);
      state.trades.push(trade);
      state.realizedPnlUsd += trade.realizedPnlUsd;
      state.balanceUsd = state.startingBalanceUsd + state.realizedPnlUsd;
    } catch (error) {
      if (/drawdown guard|No trade: minimum 1-contract risk/.test(error.message)) {
        rejectedSignals += 1;
        continue;
      }
      throw error;
    }
  }

  return {
    slug: definition.slug,
    name: definition.name,
    family: definition.strategyFamilyName,
    evidenceType: 'historical-simulated',
    signals,
    notFilled,
    rejectedSignals,
    rolloverDaysSkipped,
    trades,
    metrics: performanceMetrics(trades),
    review: reviewBacktestEvidence(trades)
  };
}

function runAllBacktests(candles, config, options = {}) {
  const quality = auditCandles(candles);
  if (!quality.ok) throw new Error(`Historical candle audit failed with ${quality.errors} errors.`);
  const strategies = (options.strategies || STRATEGIES).map((definition) => (
    runStrategyBacktest(candles, config, definition, options.dependencies || {})
  ));
  return {
    generatedAt: new Date().toISOString(),
    evidenceType: 'historical-simulated',
    methodology: 'Candle-by-candle simulation; signals use only candles available at signal time; fills begin on the next candle.',
    costs: { riskPerTradeUsd: config.maxRiskPerTradeUsd, slippageTicks: config.slippageTicks, commissionPerContractUsd: config.commissionPerContractUsd },
    candleQuality: quality,
    candles: candles.length,
    tradingDays: groupTradingDays(candles).length,
    strategies
  };
}

module.exports = { checkpointsForDay, groupTradingDays, runAllBacktests, runStrategyBacktest };
