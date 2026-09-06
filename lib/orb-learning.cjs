const { createHash } = require('node:crypto');

const LEARNING_VERSION = 'orb-calendar-research-v1';
const RETROSPECTIVE_LABEL = 'Retrospective walk-forward research. Historical 2025/2026 results have already informed strategy design; these are not untouched validation or verified live trades.';
const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return value.slice(0, 10);
}
function observedEndExclusive(value) {
  const date = dateOnly(value);
  if (!date) return null;
  const timestamp = new Date(value);
  if (timestamp.getUTCHours() || timestamp.getUTCMinutes() || timestamp.getUTCSeconds() || timestamp.getUTCMilliseconds()) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return date;
}
function tradeDate(trade) {
  if (dateOnly(trade.date)) return dateOnly(trade.date);
  const time = Date.parse(trade.filledAt || '');
  return Number.isFinite(time) ? DATE_FORMAT.format(new Date(time)) : null;
}
function monthStart(date) { return `${date.slice(0, 7)}-01`; }
function addMonths(date, count) {
  const [year, month] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + count, 1)).toISOString().slice(0, 10);
}
function monthsBetween(start, end) {
  const months = [];
  for (let month = monthStart(start); month < end; month = addMonths(month, 1)) months.push(month);
  return months;
}
function inWindow(trades, start, end) { return trades.filter((trade) => trade.date >= start && trade.date < end); }

function metrics(trades, dates, extraCostPerContractUsd = 0) {
  const daily = new Map(dates.map((date) => [date, 0]));
  const tradedDates = new Set(trades.map((trade) => trade.date));
  let net = 0, grossProfit = 0, grossLoss = 0, peak = 0, drawdown = 0, wins = 0, streak = 0, longestLosingStreak = 0;
  for (const trade of [...trades].sort((a, b) => a.date.localeCompare(b.date) || String(a.filledAt || '').localeCompare(String(b.filledAt || '')))) {
    const pnl = trade.realizedPnlUsd - extraCostPerContractUsd * trade.contracts;
    net += pnl;
    grossProfit += Math.max(0, pnl);
    grossLoss += Math.max(0, -pnl);
    wins += Number(pnl > 0);
    streak = pnl < 0 ? streak + 1 : 0;
    longestLosingStreak = Math.max(longestLosingStreak, streak);
    peak = Math.max(peak, net);
    drawdown = Math.max(drawdown, peak - net);
    daily.set(trade.date, (daily.get(trade.date) || 0) + pnl);
  }
  const monthly = new Map();
  for (const [date, pnl] of daily) monthly.set(date.slice(0, 7), (monthly.get(date.slice(0, 7)) || 0) + pnl);
  return {
    trades: trades.length, observedSessionDays: dates.length,
    daysWithTrades: tradedDates.size,
    zeroTradeDays: dates.filter((date) => !tradedDates.has(date)).length,
    netPnlUsd: round(net), expectancyUsd: trades.length ? round(net / trades.length) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    noLosses: grossLoss === 0 && grossProfit > 0, winRate: trades.length ? round(100 * wins / trades.length) : 0,
    maxDrawdownUsd: round(drawdown), longestLosingStreak,
    worstMonthPnlUsd: monthly.size ? round(Math.min(...monthly.values())) : 0,
    positiveMonths: [...monthly.values()].filter((pnl) => pnl > 0).length,
    observedMonths: monthly.size
  };
}
function passes(summary, minimumTrades, minimumProfitFactor) {
  return summary.trades >= minimumTrades && summary.expectancyUsd > 0
    && (summary.noLosses || summary.profitFactor >= minimumProfitFactor);
}

function sequenceRisk(trades, dates, seedHex) {
  const method = {
    method: 'circular-moving-block-bootstrap', replicates: 250, blockSessions: 5,
    seed: seedHex.slice(0, 8),
    label: 'Resampling of retrospective selected-strategy daily P&L, including zero-trade sessions. This is sequence sensitivity, not a forecast, confidence bound, or proof of an edge.',
    losingStreakUnit: 'consecutive losing sessions; a zero-P&L session resets the streak'
  };
  if (dates.length < 10 || !trades.length) return { ...method, status: 'insufficient-data', observedSessions: dates.length };
  const daily = new Map(dates.map((date) => [date, 0]));
  for (const trade of trades) daily.set(trade.date, (daily.get(trade.date) || 0) + trade.realizedPnlUsd);
  const values = dates.map((date) => daily.get(date));
  let seed = Number.parseInt(method.seed, 16) || 1;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4_294_967_296;
  };
  const drawdowns = [], streaks = [];
  for (let replicate = 0; replicate < method.replicates; replicate += 1) {
    let net = 0, peak = 0, maxDrawdown = 0, streak = 0, longestStreak = 0, count = 0;
    while (count < values.length) {
      const blockStart = Math.floor(random() * values.length);
      for (let index = 0; index < method.blockSessions && count < values.length; index += 1, count += 1) {
        const pnl = values[(blockStart + index) % values.length];
        net += pnl; peak = Math.max(peak, net); maxDrawdown = Math.max(maxDrawdown, peak - net);
        streak = pnl < 0 ? streak + 1 : 0; longestStreak = Math.max(longestStreak, streak);
      }
    }
    drawdowns.push(maxDrawdown); streaks.push(longestStreak);
  }
  drawdowns.sort((a, b) => a - b); streaks.sort((a, b) => a - b);
  const percentile = (values, fraction) => values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
  return { ...method, status: 'retrospective-resampling', observedSessions: values.length,
    zeroPnlSessions: values.filter((value) => value === 0).length,
    maxDrawdownUsd: { p50: round(percentile(drawdowns, 0.5)), p95: round(percentile(drawdowns, 0.95)) },
    longestLosingSessions: { p50: percentile(streaks, 0.5), p95: percentile(streaks, 0.95) } };
}

/** Pure, bounded retrospective evaluation. This function never changes live settings. */
function buildOrbLearningReport(report = {}, options = {}) {
  const start = dateOnly(report.window?.start);
  const end = dateOnly(report.window?.end);
  // Include observed trades on an intraday end date, but never treat that partial
  // date/month as completed training or test history.
  const observedEnd = observedEndExclusive(report.window?.end);
  const dates = [...new Set(options.tradingDates || report.tradingDates || [])].filter((date) => dateOnly(date) === date && (!start || date >= start) && (!observedEnd || date < observedEnd)).sort();
  const config = options.config || {};
  const costs = {
    commissionPerContractUsd: Number(config.commissionPerContractUsd ?? report.costs?.commissionPerContractUsd),
    slippageTicks: Number(config.slippageTicks ?? report.costs?.slippageTicks),
    tickValueUsd: Number(config.tickValueUsd ?? report.costs?.tickValueUsd)
  };
  // Base replay charges slippage on entry and exit and the configured round-trip commission.
  const costKnown = Object.values(costs).every((value) => Number.isFinite(value) && value >= 0) && costs.tickValueUsd > 0;
  const extraCost = costKnown ? costs.commissionPerContractUsd + 2 * costs.slippageTicks * costs.tickValueUsd : null;
  const gates = {
    trainingMonths: Math.max(1, Math.floor(options.trainMonths || 6)),
    minimumTrainingTrades: Math.max(50, Math.floor(options.minTrainingTrades || 50)),
    minimumTestTrades: Math.max(15, Math.floor(options.minTestTrades || 15)),
    minimumProfitFactor: Math.max(1.2, Number(options.minimumProfitFactor || 1.2)),
    requirePositiveDoubledCostExpectancy: true
  };
  const definitions = options.strategyDefinitions || [];
  const strategies = (report.strategies || []).filter((strategy) => /^nq-15m-orb-/.test(strategy.slug || '')).sort((a, b) => a.slug.localeCompare(b.slug));
  const manifest = {
    learningVersion: LEARNING_VERSION,
    executionVersion: options.executionVersion || report.executionVersion || null,
    codeHash: options.codeHash || null, dataFingerprint: options.dataFingerprint || report.dataFingerprint || null,
    configHash: hash(config), requestedWindow: report.window || null,
    evidenceType: 'historical-simulated', researchMode: 'fixed-risk',
    window: { start, end, observedEndExclusive: observedEnd }, selection: 'preceding-calendar-training-net-to-drawdown; slug tie-break',
    gates, costs, riskPerTradeUsd: config.maxRiskPerTradeUsd ?? report.costs?.riskPerTradeUsd ?? null,
    sequenceRisk: { method: 'circular-moving-block-bootstrap', replicates: 250, blockSessions: 5 },
    trialDefinitions: strategies.map((strategy) => ({ slug: strategy.slug, definition: definitions.find((definition) => definition.slug === strategy.slug) || { slug: strategy.slug } })),
    parameters: config.live?.openingRangeClose || {}, metadata: options.metadata || null
  };
  const blockers = [];
  if (!start || !observedEnd || start >= observedEnd) blockers.push('A valid historical date window is required.');
  if (!dates.length) blockers.push('Observed session dates are missing; zero-trade days cannot be audited.');
  const coverage = options.coverage || report.coverage || {};
  if (coverage.complete !== true) blockers.push('Historical coverage is absent, incomplete, or not verified for the requested window.');
  if (!costKnown) blockers.push('Commission, slippage, and tick value are required for doubled-cost stress testing.');
  if (!manifest.executionVersion) blockers.push('The execution model must have a version.');
  if (!strategies.length) blockers.push('No ORB research strategies are available.');
  const trials = strategies.map((strategy) => {
    const issues = [];
    if (strategy.research?.mode !== 'fixed-risk' || !Array.isArray(strategy.research?.trades)) issues.push('Uncensored fixed-risk research trades are missing.');
    const seen = new Set();
    const trades = [];
    for (const trade of strategy.research?.trades || []) {
      const date = tradeDate(trade);
      const pnl = Number(trade.realizedPnlUsd);
      const contracts = Number(trade.contracts);
      if (!date || !Number.isFinite(pnl) || !(contracts > 0) || !Number.isInteger(contracts) || trade.status === 'open') {
        issues.push('A trade has invalid dates, costs, quantity, P&L, or an open position.'); continue;
      }
      if ((start && date < start) || (observedEnd && date >= observedEnd) || !dates.includes(date)) issues.push('A trade falls outside the audited session calendar.');
      if (trade.id && seen.has(trade.id)) issues.push('Duplicate trade IDs are present.');
      if (trade.id) seen.add(trade.id);
      trades.push({ ...trade, date, contracts, realizedPnlUsd: pnl });
    }
    const calendar = start && observedEnd ? monthsBetween(start, observedEnd).map((month) => {
      const nextMonth = addMonths(month, 1);
      const monthTrades = inWindow(trades, month, nextMonth);
      const monthDates = dates.filter((date) => date >= month && date < nextMonth);
      return { month: month.slice(0, 7), completeCalendarMonth: month >= start && nextMonth <= end, ...metrics(monthTrades, monthDates) };
    }) : [];
    const annual = [2025, 2026].map((year) => {
      const yearStart = `${year}-01-01`, yearEnd = `${year + 1}-01-01`;
      return { year, completeCalendarYear: Boolean(start && end && start <= yearStart && end >= yearEnd), ...metrics(inWindow(trades, yearStart, yearEnd), dates.filter((date) => date >= yearStart && date < yearEnd)) };
    });
    const trial = {
      slug: strategy.slug, name: strategy.name || strategy.slug, valid: !issues.length, issues: [...new Set(issues)],
      evidenceHash: hash(trades.map((trade) => ({ date: trade.date, filledAt: trade.filledAt, contracts: trade.contracts, pnl: trade.realizedPnlUsd }))),
      fixedRisk: metrics(trades, dates), doubledCosts: costKnown ? metrics(trades, dates, extraCost) : null,
      account: strategy.metrics || null, annual, calendar
    };
    return { trial, trades };
  });
  const datesIn = (from, to) => dates.filter((date) => date >= from && date < to);
  const choose = (from, to) => trials.filter(({ trial }) => trial.valid).map(({ trial, trades }) => {
    const trainingTrades = inWindow(trades, from, to);
    const training = metrics(trainingTrades, datesIn(from, to));
    const stress = costKnown ? metrics(trainingTrades, datesIn(from, to), extraCost) : null;
    return { slug: trial.slug, training, stress, trades };
  }).filter(({ training, stress }) => passes(training, gates.minimumTrainingTrades, gates.minimumProfitFactor) && stress?.expectancyUsd > 0)
    .sort((a, b) => (b.training.netPnlUsd / Math.max(1, b.training.maxDrawdownUsd)) - (a.training.netPnlUsd / Math.max(1, a.training.maxDrawdownUsd)) || a.slug.localeCompare(b.slug))[0];
  const folds = [], selectedTrades = [], selectedDates = [];
  if (start && end && start < end) {
    const firstFullMonth = start === monthStart(start) ? start : addMonths(monthStart(start), 1);
    for (let testStart = addMonths(firstFullMonth, gates.trainingMonths); addMonths(testStart, 1) <= end; testStart = addMonths(testStart, 1)) {
      const trainingStart = addMonths(testStart, -gates.trainingMonths), testEnd = addMonths(testStart, 1);
      const selected = choose(trainingStart, testStart);
      const testTrades = selected ? inWindow(selected.trades, testStart, testEnd) : [];
      const testDates = datesIn(testStart, testEnd);
      selectedTrades.push(...testTrades); selectedDates.push(...testDates);
      folds.push({ trainingStart, trainingEndExclusive: testStart, testStart, testEndExclusive: testEnd,
        selectedSlug: selected?.slug || null, training: selected?.training || null,
        test: metrics(testTrades, testDates), doubledCosts: costKnown ? metrics(testTrades, testDates, extraCost) : null,
        status: selected ? 'retrospective-test' : 'no-qualified-training-candidate' });
    }
  }
  const walkForward = {
    label: RETROSPECTIVE_LABEL, folds, aggregate: metrics(selectedTrades, selectedDates),
    doubledCosts: costKnown ? metrics(selectedTrades, selectedDates, extraCost) : null
  };
  if (!folds.length) blockers.push('Not enough complete calendar months for training plus a test month.');
  if (!passes(walkForward.aggregate, gates.minimumTestTrades, gates.minimumProfitFactor)) blockers.push('Retrospective selected-month results do not meet sample, expectancy, and profit-factor gates.');
  if (!(walkForward.doubledCosts?.expectancyUsd > 0)) blockers.push('Retrospective selected-month results do not survive doubled execution costs.');
  // The current partial month is excluded from selecting the next research candidate.
  const freezeEnd = end ? monthStart(end) : null;
  const latest = freezeEnd ? choose(addMonths(freezeEnd, -gates.trainingMonths), freezeEnd) : null;
  if (!latest) blockers.push('No strategy passes the most recent complete training window.');
  if (trials.some(({ trial }) => !trial.valid)) blockers.push('One or more trial records are invalid or lack fixed-risk research evidence.');
  const candidate = !blockers.length && latest ? { slug: latest.slug, training: latest.training, status: 'candidate-for-frozen-forward-paper-test' } : null;
  const manifestHash = hash(manifest);
  return {
    version: LEARNING_VERSION, evidenceType: 'historical-simulated', label: RETROSPECTIVE_LABEL,
    status: candidate ? 'research-candidate' : 'more-evidence-needed', candidate,
    blockers: [...new Set(blockers)], manifest, manifestHash,
    coverage: { complete: coverage.complete === true, scope: coverage.scope || 'unverified', issues: coverage.issues || [], observedSessionDays: dates.length },
    trials: trials.map(({ trial }) => trial), walkForward,
    sequenceRisk: sequenceRisk(selectedTrades, selectedDates, manifestHash),
    forwardPaperGate: { status: 'not-started', livePromotionAllowed: false, rulesFrozen: false,
      message: 'Freeze a version before collecting new forward paper trades. Historical simulations do not count as verified forward trades.' }
  };
}

module.exports = { LEARNING_VERSION, buildOrbLearningReport };
