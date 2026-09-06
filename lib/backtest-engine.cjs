const { auditCandles, performanceMetrics, reviewBacktestEvidence } = require('./research-lab.cjs');
const { BACKTEST_STRATEGIES } = require('./strategy-registry.cjs');
const { createEmptyState, replayPlan, toJournalTrade } = require('./trader-core.cjs');
const { buildPlanFromSignal, detectSignalFromCandles, prepareOrbResearchContext } = require('./live-trader.cjs');

const isOrb = (slug) => slug.startsWith('nq-15m-orb-');

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
  if (slug === 'ema-20-60-momentum' || slug === 'ema-20-60-cash-window') {
    return cashEnd.filter((record) => record.minute >= 570 && record.minute <= 945 && record.minute % 15 === 14);
  }

  const completedFifteenMinute = new Set([
    'nq-15m-orb-close-confirmation',
    'nq-15m-orb-delayed-confirmation',
    'nq-15m-orb-no-monday',
    'nq-15m-orb-body-window',
    'nq-15m-orb-focused-time'
  ]);

  const windows = {
    'live-9am-sweep': [540, 960],
    'hourly-sweep-ifvg-bos': [60, 960],
    'nq-opening-range-breakout': [660, 930],
    'volume-poc-reversion': [630, 945],
    'nq-15m-opening-range-retest': [585, 690],
    'nq-15m-orb-close-confirmation': [585, 690],
    'nq-15m-orb-delayed-confirmation': [585, 690],
    'nq-15m-orb-no-monday': [585, 690],
    'nq-15m-orb-body-window': [585, 690],
    'nq-15m-orb-focused-time': [585, 660],
    'live-9am-sweep-min-stop': [540, 960],
    'hourly-sweep-stop-band': [60, 960],
    'nq-opening-range-true-breakout': [660, 930],
    'volume-poc-max-3atr': [630, 945],
    'nq-15m-retest-continuation': [585, 690]
  };
  const window = windows[slug] || (isOrb(slug) ? [585, 690] : null);
  if (!window) return cashEnd;
  return cashEnd.filter((record) => (
    record.minute >= window[0]
    && record.minute <= window[1]
    && (!(completedFifteenMinute.has(slug) || isOrb(slug)) || record.minute % 15 === 14)
  ));
}

function instrumentForDay(records) {
  return records.find((record) => record.candle.instrumentId !== null)?.candle.instrumentId ?? null;
}

function simulatedTrade(plan, replay, signal, slug, sequence, detectedAt) {
  return {
    ...toJournalTrade(plan, replay),
    id: `backtest-${slug}-${signal.setup.date}-${sequence}`,
    createdAt: signal.triggerTimestamp,
    signalAt: signal.triggerTimestamp,
    detectedAt,
    evidenceType: 'historical-simulated'
  };
}

function buildOneContractResearchPlan(signal, config, buildPlan = buildPlanFromSignal) {
  // Compute enough sizing room for exactly one contract without moving the stop.
  // This does not change the account config or give research a dollar loss ceiling.
  const stopRisk = Math.abs(signal.setup.entry - signal.setup.stop) / config.tickSize * config.tickValueUsd;
  const costs = config.slippageTicks * config.tickValueUsd * (signal.setup.execution === 'next-bar-market' ? 2 : 1) + config.commissionPerContractUsd;
  const oneContractBudget = Math.ceil((stopRisk + costs) * 100) / 100 + 0.01;
  if (!Number.isFinite(oneContractBudget) || !(stopRisk > 0)) throw new Error('Invalid one-contract research risk.');
  const sizingConfig = { ...config, maxAccountDrawdownPercent: 100,
    maxRiskPerTradeUsd: oneContractBudget, startingBalanceUsd: Math.max(config.startingBalanceUsd, oneContractBudget) };
  const plan = buildPlan(signal, sizingConfig, createEmptyState(sizingConfig));
  return { ...plan, sizing: { ...plan.sizing, maxContracts: 1 } };
}

function runStrategyBacktest(candles, rawConfig, definition, dependencies = {}) {
  const detectSignal = dependencies.detectSignal || detectSignalFromCandles;
  const buildPlan = dependencies.buildPlan || buildPlanFromSignal;
  const replay = dependencies.replay || replayPlan;
  const days = dependencies.groupedDays || groupTradingDays(candles);
  const config = {
    ...rawConfig,
    strategySlug: definition.slug,
    strategyFamily: definition.strategyFamily,
    live: { ...(rawConfig.live || {}), maxTradesPerDay: 1 }
  };
  const state = createEmptyState(config);
  // An independent sizing state per signal removes accumulated account loss limits
  // from research. Whole-contract sizing, per-trade risk and execution costs remain.
  const researchConfig = { ...config, maxAccountDrawdownPercent: 100,
    startingBalanceUsd: Math.max(config.startingBalanceUsd, config.maxRiskPerTradeUsd) };
  const researchRejections = {};
  const researchUnfilledReasons = {};
  const signalAudit = [];
  const accountRejections = {};
  const trades = [];
  const researchTrades = [];
  let researchRejected = 0;
  let researchUnfilled = 0;
  const filterChecks = {};
  let signals = 0;
  let notFilled = 0;
  let rejectedSignals = 0;
  let rolloverDaysSkipped = 0;
  let previousInstrument = null;

  for (const [dayIndex, [date, records]] of days.entries()) {
    if (dayIndex % 10 === 0) dependencies.onProgress?.({
      phase: 'simulating', strategy: definition.slug, date,
      daysCompleted: dayIndex, daysTotal: days.length, trades: researchTrades.length, accountTrades: trades.length
    });
    const instrument = instrumentForDay(records);
    if (previousInstrument !== null && instrument !== null && instrument !== previousInstrument) {
      rolloverDaysSkipped += 1;
      previousInstrument = instrument;
      continue;
    }
    if (instrument !== null) previousInstrument = instrument;

    let signal = null;
    let detectedAt = null;
    for (const checkpoint of checkpointsForDay(definition.slug, records)) {
      const contextStart = Math.max(0, checkpoint.index - 2500);
      const context = candles.slice(contextStart, checkpoint.index + 1);
      const candidate = detectSignal(context, config, createEmptyState(config));
      if (isOrb(definition.slug) && !candidate.found && candidate.reason?.startsWith('ORB ')) {
        filterChecks[candidate.reason] = (filterChecks[candidate.reason] || 0) + 1;
      }
      if (candidate.found) {
        signal = candidate;
        detectedAt = checkpoint.candle.timestamp;
        break;
      }
    }
    if (!signal) continue;
    signals += 1;
    signal = { ...signal, setup: { ...signal.setup, detectedAt,
      signalAvailableAt: new Date(Date.parse(detectedAt) + 60_000).toISOString() } };
    const detectionTime = Date.parse(detectedAt);
    const future = records
      .filter((record) => record.minute < 960 && Date.parse(record.candle.timestamp) > detectionTime)
      .map((record) => record.candle);
    if (!future.length) {
      researchUnfilledReasons['No candles after signal'] = (researchUnfilledReasons['No candles after signal'] || 0) + 1;
      notFilled += 1;
      researchUnfilled += 1;
      continue;
    }

    // Keep a fixed-dollar-risk diagnostic independent of the account's accumulated losses.
    // The account curve below continues enforcing its actual drawdown floor.
    {
      try {
        const researchPlan = isOrb(definition.slug)
          ? buildOneContractResearchPlan(signal, researchConfig, buildPlan)
          : buildPlan(signal, researchConfig, createEmptyState(researchConfig));
        const researchReplay = replay(researchPlan, future, researchConfig, isOrb(definition.slug) ? { researchFixedContracts: 1 } : {});
        if (researchReplay.status === 'not-filled') {
          researchUnfilled += 1;
          const reason = researchReplay.exitReason || 'Unfilled order';
          researchUnfilledReasons[reason] = (researchUnfilledReasons[reason] || 0) + 1;
        } else researchTrades.push(simulatedTrade(researchPlan, researchReplay, signal, definition.slug, researchTrades.length + 1, detectedAt));
        if (isOrb(definition.slug)) signalAudit.push({
          date, detectedAt, side: signal.setup.side, entry: signal.setup.entry, stop: signal.setup.stop,
          stopDistancePoints: Math.abs(signal.setup.entry - signal.setup.stop),
          status: researchReplay.status, reason: researchReplay.exitReason,
          filledAt: researchReplay.filledAt, filledEntry: researchReplay.filledEntryPrice,
          contracts: researchReplay.contracts, netPnlUsd: researchReplay.realizedPnlUsd,
          context: signal.metadata || null
        });
      } catch (error) {
        if (/drawdown guard|No trade: minimum 1-contract risk/.test(error.message)) {
          researchRejected += 1;
          const reason = /minimum 1-contract risk/.test(error.message) ? 'One contract exceeds per-trade risk budget' : 'Sizing guard';
          researchRejections[reason] = (researchRejections[reason] || 0) + 1;
        }
        else throw error;
      }
    }

    try {
      const plan = buildPlan(signal, config, state);
      const result = replay(plan, future, config);
      if (result.status === 'not-filled') {
        notFilled += 1;
        continue;
      }
      const trade = simulatedTrade(plan, result, signal, definition.slug, trades.length + 1, detectedAt);
      trades.push(trade);
      state.trades.push(trade);
      state.realizedPnlUsd += trade.realizedPnlUsd;
      state.balanceUsd = state.startingBalanceUsd + state.realizedPnlUsd;
    } catch (error) {
      if (/drawdown guard|No trade: minimum 1-contract risk/.test(error.message)) {
        rejectedSignals += 1;
        const reason = /drawdown guard/.test(error.message) ? 'Account drawdown guard' : 'One contract exceeds remaining risk budget';
        accountRejections[reason] = (accountRejections[reason] || 0) + 1;
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
    rejectionReasons: accountRejections,
    trades,
    metrics: performanceMetrics(trades),
    review: reviewBacktestEvidence(trades),
    research: {
      mode: isOrb(definition.slug) ? 'fixed-contract' : 'fixed-risk',
      sizing: isOrb(definition.slug) ? { contracts: 1, riskCapUsd: null, accountLossLimit: false } : { riskCapUsd: config.maxRiskPerTradeUsd, accountLossLimit: false },
      description: isOrb(definition.slug) ? 'One NQ contract per eligible signal, with structural stops and execution costs. No dollar risk cap or accumulated loss cutoff. First target closes the whole contract.' : 'Same dollar risk ceiling per signal; no accumulated account drawdown lock. This is not a deployable account curve.',
      trades: researchTrades, metrics: performanceMetrics(researchTrades),
      review: reviewBacktestEvidence(researchTrades, { enforceAccountDrawdown: false }),
      rejectionReasons: researchRejections, unfilledReasons: researchUnfilledReasons,
      ...(isOrb(definition.slug) ? { signalAudit } : {}),
      signals, rejectedSignals: researchRejected, notFilled: researchUnfilled, filterChecks
    }
  };
}

function runAllBacktests(candles, config, options = {}) {
  const quality = auditCandles(candles);
  if (!quality.ok) throw new Error(`Historical candle audit failed with ${quality.errors} errors.`);
  const groupedDays = groupTradingDays(candles);
  const definitions = options.strategies || BACKTEST_STRATEGIES;
  const orbResearchContext = definitions.some((definition) => isOrb(definition.slug))
    ? prepareOrbResearchContext(candles) : null;
  const strategies = definitions.map((definition, index) => {
    const onProgress = (progress) => options.onProgress?.({
      ...progress, strategyIndex: index + 1, strategyTotal: definitions.length
    });
    const result = runStrategyBacktest(candles, { ...config, orbResearchContext }, definition, {
      ...(options.dependencies || {}), groupedDays, onProgress
    });
    onProgress({ phase: 'strategy-completed', strategy: definition.slug,
      daysCompleted: groupedDays.length, daysTotal: groupedDays.length,
      trades: result.trades.length, netPnlUsd: result.metrics.netPnlUsd });
    return result;
  });
  return {
    generatedAt: new Date().toISOString(),
    evidenceType: 'historical-simulated',
    researchVersion: 'all-strategy-fixed-risk-v1',
    orbResearchVersion: 'one-contract-v1',
    methodology: 'Research evaluates the full history without an accumulated account loss cutoff. ORB research uses one contract with no dollar risk cap; other research retains fixed-dollar sizing. Separate guarded account results are retained. Completed-candle signals; explicit ORB next-bar market execution with adverse slippage and stop gaps. Other strategies retain price-touch entries. Retrospective research, not untouched forward evidence.',
    costs: { riskPerTradeUsd: config.maxRiskPerTradeUsd, slippageTicks: config.slippageTicks, commissionPerContractUsd: config.commissionPerContractUsd },
    candleQuality: quality,
    candles: candles.length,
    tradingDays: groupedDays.length,
    strategies
  };
}

module.exports = { buildOneContractResearchPlan, checkpointsForDay, groupTradingDays, runAllBacktests, runStrategyBacktest };
