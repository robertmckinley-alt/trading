// Read-only, deterministic diagnostics for a frozen paper-validation cohort.
const { createHash } = require('node:crypto');
const DAY = 86400000;
const FIXED_SLUGS = Object.freeze(['live-9am-sweep', 'nq-vwap-stretch-reversion', 'nq-fresh-level-retest', 'nq-opening-range-breakout', 'nq-15m-opening-range-retest']);
const DEFAULT_POLICY = Object.freeze({ minTrades: 100, minTradingDays: 30, maxCalendarDays: 90,
  minProfitFactor: 1.2, maxDrawdownR: 8, maxDailyLossR: 3, maxConsecutiveLosses: 6,
  stressExtraTicksPerLeg: 1, tickValueUsd: 5, benchmarkR: 0, dailyLowerBoundZ: 2.326347874 });
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const rounded = value => finite(value) ? Number(value.toFixed(6)) : null;
const sum = values => values.reduce((total, value) => total + value, 0);
const dayOf = value => timestamp(value) === null ? null : dateFormat.format(new Date(value));
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function collect(strategy) {
  const byId = new Map(), conflicts = new Set(), missingId = [];
  const recaps = Array.isArray(strategy?.journal?.dailyRecaps) ? strategy.journal.dailyRecaps : [];
  for (const recap of recaps) {
    for (const raw of Array.isArray(recap?.tradesList) ? recap.tradesList : []) {
      if (!raw || typeof raw !== 'object') { missingId.push({ date: recap.date || null }); continue; }
      const trade = { ...raw, date: raw.date || recap.date || null };
      if (typeof trade.id !== 'string' || !trade.id.trim()) { missingId.push(trade); continue; }
      const prior = byId.get(trade.id);
      if (prior && JSON.stringify(stable(prior)) !== JSON.stringify(stable(trade))) conflicts.add(trade.id);
      else if (!prior) byId.set(trade.id, trade);
    }
  }
  return { trades: [...byId.values(), ...missingId], conflicts, missingIds: missingId.length };
}
function order(a, b) {
  const closeA = timestamp(a.exitedAt) ?? timestamp(a.recordedAt) ?? timestamp(a.createdAt) ?? 0;
  const closeB = timestamp(b.exitedAt) ?? timestamp(b.recordedAt) ?? timestamp(b.createdAt) ?? 0;
  return closeA - closeB || (timestamp(a.filledAt) ?? 0) - (timestamp(b.filledAt) ?? 0) || String(a.id || '').localeCompare(String(b.id || ''));
}
function metrics(trades, policy) {
  const ordered = [...trades].sort(order), pnls = ordered.map(t => t.realizedPnlUsd);
  const hasPnl = ordered.every(t => finite(t.realizedPnlUsd));
  const missingRisk = ordered.filter(t => !positive(t.actualRiskUsd)).length;
  const hasRisk = hasPnl && !missingRisk;
  const allMae = ordered.every(t => finite(t.maeUsd) && t.maeUsd <= 0);
  const allSize = ordered.every(t => Number.isInteger(t.contracts) && t.contracts > 0);
  const wins = hasPnl ? pnls.filter(p => p > 0) : [];
  const losses = hasPnl ? pnls.filter(p => p < 0) : [];
  const netPnl = hasPnl ? sum(pnls) : null;
  const rs = hasRisk ? ordered.map(t => t.realizedPnlUsd / t.actualRiskUsd) : [];
  let equityR = 0, peakR = 0, ddR = 0, equityUsd = 0, peakUsd = 0, ddUsd = 0;
  const daily = new Map();
  for (const t of ordered) {
    if (hasPnl) { equityUsd += t.realizedPnlUsd; peakUsd = Math.max(peakUsd, equityUsd); ddUsd = Math.max(ddUsd, peakUsd - equityUsd); }
    if (hasRisk) {
      if (allMae) ddR = Math.max(ddR, peakR - (equityR + t.maeUsd / t.actualRiskUsd));
      const r = t.realizedPnlUsd / t.actualRiskUsd;
      equityR += r; peakR = Math.max(peakR, equityR); ddR = Math.max(ddR, peakR - equityR);
      const day = dayOf(t.exitedAt) || t.date;
      if (day) daily.set(day, (daily.get(day) || 0) + r);
    }
  }
  const dailyRs = [...daily.values()], dailyMean = dailyRs.length ? sum(dailyRs) / dailyRs.length : null;
  const se = dailyRs.length > 1 ? Math.sqrt(sum(dailyRs.map(r => (r - dailyMean) ** 2)) / (dailyRs.length - 1) / dailyRs.length) : null;
  const best = pnls.length && hasPnl ? Math.max(...pnls) : null;
  return { trades: ordered.length, tradingDays: new Set(ordered.map(t => dayOf(t.exitedAt) || t.date).filter(Boolean)).size,
    netPnlUsd: rounded(netPnl), netR: hasRisk ? rounded(sum(rs)) : null,
    winRate: hasPnl && ordered.length ? rounded(wins.length / ordered.length * 100) : null,
    profitFactor: hasPnl && wins.length && losses.length ? rounded(sum(wins) / -sum(losses)) : null,
    expectancyR: hasRisk && ordered.length ? rounded(sum(rs) / ordered.length) : null,
    maxDrawdownR: hasRisk && allMae && ordered.length ? rounded(ddR) : null,
    maxDrawdownUsd: hasPnl && ordered.length ? rounded(ddUsd) : null,
    bestTradePnlUsd: rounded(best), netWithoutBestUsd: best === null ? null : rounded(netPnl - best),
    topWinSharePct: wins.length ? rounded(Math.max(...wins) / sum(wins) * 100) : null,
    stressedNetR: hasRisk && allSize ? rounded(sum(ordered.map(t => (t.realizedPnlUsd - 2 * policy.stressExtraTicksPerLeg * policy.tickValueUsd * t.contracts) / t.actualRiskUsd))) : null,
    dailyLowerBoundR: se === null ? null : rounded(dailyMean - policy.dailyLowerBoundZ * se), missingRisk };
}
function segment(trades, label, policy) {
  const groups = new Map();
  for (const trade of trades) { const key = label(trade); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(trade); }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, rows]) => {
    const m = metrics(rows, policy);
    return { label: name, trades: rows.length, netPnlUsd: m.netPnlUsd, expectancyR: m.expectancyR, enoughEvidence: rows.length >= 5 };
  });
}
function gateList(m, policy) {
  return [
    ['trades', 'New closed trades', m.trades, policy.minTrades, m.trades >= policy.minTrades],
    ['days', 'Traded New York days', m.tradingDays, policy.minTradingDays, m.tradingDays >= policy.minTradingDays],
    ['profitFactor', 'Profit factor · net USD', m.profitFactor, policy.minProfitFactor, m.profitFactor !== null && m.profitFactor >= policy.minProfitFactor],
    ['netR', 'Net R above no-trade benchmark', m.netR, 0, m.netR !== null && m.netR > 0],
    ['stress', 'Net R after extra fill costs', m.stressedNetR, 0, m.stressedNetR !== null && m.stressedNetR > 0],
    ['dailyLowerBound', 'Approximate daily 99% lower bound', m.dailyLowerBoundR, 0, m.dailyLowerBoundR !== null && m.dailyLowerBoundR > 0]
  ].map(([key, label, current, required, passed]) => ({ key, label, current, required, passed }));
}
function forward(trades, definition, manifest, policy, nowMs, blockReasons, invalidated) {
  const start = timestamp(manifest.startedAt), deadline = start === null ? null : start + policy.maxCalendarDays * DAY;
  const baseline = new Set(Array.isArray(definition.baselineTradeIds) ? definition.baselineTradeIds : []), excluded = new Map(), admitted = [], quality = [], invalidCandidates = [];
  const exclude = reason => excluded.set(reason, (excluded.get(reason) || 0) + 1);
  for (const t of trades) {
    if (baseline.has(t.id)) { exclude('Frozen selection history'); continue; }
    const entry = timestamp(t.filledAt), close = timestamp(t.exitedAt);
    const observed = timestamp(t.signalObservedAt || t.signalContext?.observedAt || t.execution?.observedAt);
    const available = timestamp(t.execution?.signalAvailableAt);
    const origin = timestamp(t.execution?.signalOriginAvailableAt);
    if (start !== null && [entry, observed, available, origin].some(at => at !== null && at < start)) { exclude('Entry or signal predates trial'); continue; }
    const issues = [];
    if (!t.id || typeof t.id !== 'string') issues.push('Missing trade ID');
    if (!finite(t.realizedPnlUsd)) issues.push('Missing realized P&L');
    if (!positive(t.actualRiskUsd)) issues.push('Missing positive actual risk');
    if (!finite(t.maeUsd) || t.maeUsd > 0) issues.push('Missing valid adverse excursion');
    if (!Number.isInteger(t.contracts) || t.contracts <= 0) issues.push('Missing whole-contract size');
    if ([entry, close, observed, available].some(at => at === null) || close < entry || entry < observed || entry < available || close > nowMs || observed > nowMs || available > nowMs || (origin !== null && origin > available)) issues.push('Invalid or missing chronological execution timestamps');
    if (t.execution?.modelVersion !== 'bounded-fill-v1' || t.execution?.intrabarPolicyVersion !== 'post-fill-evidence-v1' || t.execution?.policyVersion !== 'execution-repair-v3-fill-quality') issues.push('Missing frozen execution versions');
    if (issues.length) { invalidCandidates.push({ trade: t, issues }); continue; }
    admitted.push(t);
  }
  admitted.sort(order);
  const used = []; let status = 'collecting', reason = 'Collecting new forward paper trades; no live promotion.', terminalAt = null;
  let equity = 0, peak = 0, streak = 0;
  const daily = new Map();
  for (const trade of admitted) {
    const closed = timestamp(trade.exitedAt);
    if (deadline !== null && closed >= deadline) { status = 'stopped'; reason = `${policy.maxCalendarDays}-calendar-day trial limit reached.`; terminalAt = new Date(deadline).toISOString(); break; }
    used.push(trade);
    const r = trade.realizedPnlUsd / trade.actualRiskUsd;
    const adverseDrawdown = peak - (equity + trade.maeUsd / trade.actualRiskUsd);
    equity += r; peak = Math.max(peak, equity);
    const closedDrawdown = peak - equity, day = dayOf(trade.exitedAt);
    daily.set(day, (daily.get(day) || 0) + r); streak = r < 0 ? streak + 1 : 0;
    if (Math.max(adverseDrawdown, closedDrawdown) >= policy.maxDrawdownR || daily.get(day) <= -policy.maxDailyLossR || streak >= policy.maxConsecutiveLosses) {
      status = 'stopped'; terminalAt = trade.exitedAt;
      reason = Math.max(adverseDrawdown, closedDrawdown) >= policy.maxDrawdownR ? `MAE-inclusive drawdown reached ${policy.maxDrawdownR}R.` : daily.get(day) <= -policy.maxDailyLossR ? `Daily net loss reached ${policy.maxDailyLossR}R.` : `${policy.maxConsecutiveLosses} consecutive losses.`;
      break;
    }
    if (used.length >= policy.minTrades && daily.size >= policy.minTradingDays) {
      const gates = gateList(metrics(used, policy), policy);
      status = gates.every(g => g.passed) ? 'qualified' : 'not-qualified';
      terminalAt = trade.exitedAt; reason = status === 'qualified' ? 'Frozen paper evaluation passed; no automatic live promotion.' : 'Frozen paper evaluation completed without passing every gate.'; break;
    }
  }
  if (!terminalAt && deadline !== null && nowMs >= deadline) { status = 'stopped'; terminalAt = new Date(deadline).toISOString(); reason = `${policy.maxCalendarDays}-calendar-day trial limit reached.`; }
  let ignoredInvalid = 0;
  for (const { trade, issues } of invalidCandidates) {
    const closed = timestamp(trade.exitedAt);
    if (terminalAt && closed !== null && (closed > timestamp(terminalAt) || (timestamp(terminalAt) === deadline && closed === deadline))) { ignoredInvalid++; continue; }
    quality.push(...issues); for (const issue of issues) exclude(issue);
  }
  const reasons = [...new Set([...blockReasons, ...quality])];
  if (invalidated) { status = 'invalidated'; reason = 'Frozen execution or configuration fingerprint changed. This trial cannot qualify.'; }
  else if (reasons.length) { status = 'blocked'; reason = reasons.join(' '); }
  const m = metrics(used, policy);
  return { status, reason, terminalAt, metrics: m, gates: gateList(m, policy), excluded: [...excluded].map(([reason, count]) => ({ reason, count })),
    trades: used.map(trade => ({ id: trade.id, slug: definition.slug, name: definition.name || definition.slug,
      filledAt: trade.filledAt, exitedAt: trade.exitedAt, side: typeof trade.side === 'string' ? trade.side : null,
      contracts: trade.contracts, entry: finite(trade.entry) ? trade.entry : null,
      exit: finite(trade.finalExitPrice) ? trade.finalExitPrice : null,
      actualRiskUsd: trade.actualRiskUsd, netPnlUsd: trade.realizedPnlUsd,
      rMultiple: rounded(trade.realizedPnlUsd / trade.actualRiskUsd) })),
    ignoredAfterStop: terminalAt ? admitted.length - used.length + ignoredInvalid : 0, qualityReasons: [...new Set(quality)] };
}
function buildFocusReport(snapshot, manifest, options = {}) {
  const now = options.now === undefined ? new Date() : new Date(options.now), nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Invalid focus report time');
  const policy = { ...DEFAULT_POLICY, ...(manifest?.policy || {}) }, globalReasons = [];
  for (const [key, defaultValue] of Object.entries(DEFAULT_POLICY)) {
    if (!finite(policy[key]) || (key !== 'benchmarkR' && policy[key] <= 0)) { globalReasons.push(`Invalid policy ${key}.`); policy[key] = defaultValue; }
  }
  const definitions = Array.isArray(manifest?.strategies) ? manifest.strategies : [];
  if (definitions.length !== 5 || new Set(definitions.map(s => s.slug)).size !== 5 || definitions.some(s => !FIXED_SLUGS.includes(s.slug))) globalReasons.push('Frozen five-strategy cohort is missing or changed.');
  if (timestamp(manifest?.startedAt) === null || timestamp(manifest?.startedAt) > nowMs) globalReasons.push('Invalid or future trial start.');
  if (!['remote-bridge'].includes(snapshot?.source) || snapshot?.ok === false) globalReasons.push('A fresh live server snapshot is required; cached or fallback data cannot validate.');
  const generated = timestamp(snapshot?.generatedAt);
  if (generated === null || nowMs - generated > 180000 || generated > nowMs + 5000) globalReasons.push('Live snapshot is stale or timestamp is invalid.');
  const validation = snapshot?.focusValidation;
  const expected = manifest?.expectedRulesHash;
  const manifestHash = manifest ? createHash('sha256').update(JSON.stringify(manifest)).digest('hex') : null;
  if (!manifestHash || validation?.manifestHash !== manifestHash) globalReasons.push('The web cohort and policy do not match the server-registered manifest.');
  const invalidated = Boolean(validation?.invalidatedAt || validation?.firstMismatchAt || (typeof expected === 'string' && validation?.actualHash && expected !== validation.actualHash));
  if (invalidated) globalReasons.push(typeof validation?.reason === 'string' ? validation.reason : 'Frozen trial was invalidated by a rules or manifest change.');
  if (!expected || validation?.id !== manifest?.id || validation?.expectedHash !== expected || validation?.actualHash !== expected || !Array.isArray(validation?.missingFiles) || validation.missingFiles.length) globalReasons.push('Frozen rules fingerprint is missing or does not match.');
  const checked = timestamp(validation?.checkedAt);
  if (checked === null || nowMs - checked > 180000 || checked > nowMs + 5000) globalReasons.push('Rules fingerprint check is stale or unavailable.');
  const strategies = definitions.map(definition => {
    const source = (Array.isArray(snapshot?.strategies) ? snapshot.strategies : []).find(s => s?.slug === definition.slug), rows = collect(source), reasons = [...globalReasons];
    if (!source) reasons.push(`Missing selected strategy ${definition.slug}.`);
    if (source?.watcher?.isHealthy !== true || source?.watcher?.duplicateProcesses || source?.watcher?.processCount !== 1) reasons.push(`Selected watcher ${definition.slug} is unhealthy or not uniquely confirmed.`);
    if (rows.conflicts.size) reasons.push('Conflicting duplicate trade IDs require reconciliation.');
    const ids = new Set(rows.trades.map(t => t.id));
    if (!Array.isArray(definition.baselineTradeIds) || definition.baselineTradeIds.some(id => !ids.has(id))) reasons.push('Frozen selection trade IDs are missing from the journal.');
    const baselineIds = new Set(definition.baselineTradeIds || []);
    const historical = rows.trades.filter(t => baselineIds.has(t.id));
    const completeHistory = Boolean(source) && historical.length === baselineIds.size &&
      historical.length === definition.selectionTrades &&
      historical.every(t => finite(t.realizedPnlUsd)) &&
      ![...rows.conflicts].some(id => baselineIds.has(id)) &&
      finite(definition.selectionPnlUsd) &&
      Math.abs(sum(historical.map(t => t.realizedPnlUsd)) - definition.selectionPnlUsd) < 0.011;
    if (!completeHistory) reasons.push('Frozen selection history is missing, invalid, or does not reconcile to its recorded selection total.');
    const history = metrics(historical, policy);
    if (!completeHistory) for (const key of Object.keys(history)) if (!['trades', 'tradingDays', 'missingRisk'].includes(key)) history[key] = null;
    const prospective = forward(rows.trades, definition, manifest, policy, nowMs, reasons, invalidated);
    reasons.push(...prospective.qualityReasons); delete prospective.qualityReasons;
    if (reasons.length) globalReasons.push(...reasons);
    const insights = ['Retrospective selection favors past winners; these results are not independent validation.'];
    if (history.missingRisk) insights.push(`${history.missingRisk} historical trades lack recorded positive actual risk; aggregate R statistics are unavailable.`);
    if (history.netWithoutBestUsd !== null) insights.push(`Historical net without the best trade: $${history.netWithoutBestUsd.toFixed(2)}.`);
    if (history.topWinSharePct !== null) insights.push(`The largest winning trade contributed ${history.topWinSharePct.toFixed(1)}% of gross winning P&L.`);
    if (!completeHistory) insights.push('The frozen selection history is incomplete or changed; historical financial statistics are unavailable.');
    insights.push('Historical diagnostics use only the trades present at selection. New trial trades never enter this comparison.');
    insights.push('Daily lower bounds assume independent daily blocks and use an approximate five-strategy screening correction; they are not calibrated confidence or trade-win probabilities.');
    return { slug: definition.slug, name: definition.name || source?.name || definition.slug,
      selectionPnlUsd: finite(definition.selectionPnlUsd) ? definition.selectionPnlUsd : null, selectionTrades: finite(definition.selectionTrades) ? definition.selectionTrades : null,
      history, prospective, segments: {
        side: segment(historical, t => typeof t.side === 'string' ? t.side : 'Unknown', policy),
        entryHour: segment(historical, t => timestamp(t.filledAt) === null ? 'Unknown' : `${hourFormat.format(new Date(t.filledAt))}:00 ET`, policy),
        regime: segment(historical, t => {
          const regime = t.signalContext?.marketRegime?.regime ?? t.signalContext?.marketRegime ?? t.signalContext?.regime ?? t.marketRegime;
          return typeof regime === 'string' ? regime : 'Unknown';
        }, policy)
      }, insights, hypothesis: `Test whether ${definition.name || definition.slug}'s historical results persist on new signals under unchanged entry, exit and risk rules.` };
  });
  const reasons = [...new Set(globalReasons)];
  // A selected-account data failure blocks cohort interpretation, including rows computed earlier.
  if (reasons.length) for (const strategy of strategies) if (!['invalidated', 'blocked'].includes(strategy.prospective.status)) {
    strategy.prospective.status = 'blocked'; strategy.prospective.reason = 'Cohort data is incomplete. Resolve the reported data-quality failures before interpreting validation.';
  }
  if (reasons.length) for (const strategy of strategies) {
    for (const key of Object.keys(strategy.prospective.metrics)) if (!['trades', 'tradingDays', 'missingRisk'].includes(key)) strategy.prospective.metrics[key] = null;
    for (const trade of strategy.prospective.trades) for (const key of ['contracts', 'entry', 'exit', 'actualRiskUsd', 'netPnlUsd', 'rMultiple']) trade[key] = null;
    for (const gate of strategy.prospective.gates) gate.passed = false;
    if (invalidated && validation?.reason) strategy.prospective.reason += ` ${validation.reason}`;
  }
  return { id: manifest?.id || null, name: manifest?.name || 'Profit Focus', startedAt: manifest?.startedAt || null,
    selectedAt: manifest?.selectedAt || null, selectionBasis: manifest?.selectionBasis || 'Retrospective selection.', policy,
    generatedAt: now.toISOString(), source: snapshot?.source || 'unavailable', dataStatus: { ok: !reasons.length, reasons },
    summary: { selectedStrategies: strategies.length, historicalPnlUsd: strategies.every(s => finite(s.history.netPnlUsd)) ? rounded(sum(strategies.map(s => s.history.netPnlUsd))) : null, historicalTrades: strategies.every(s => finite(s.history.netPnlUsd)) ? sum(strategies.map(s => s.history.trades)) : null,
      prospectivePnlUsd: reasons.length ? null : rounded(sum(strategies.flatMap(s => s.prospective.trades.map(t => t.netPnlUsd)))), prospectiveTrades: reasons.length ? null : sum(strategies.map(s => s.prospective.trades.length)),
      qualified: strategies.filter(s => s.prospective.status === 'qualified').length, stopped: strategies.filter(s => s.prospective.status === 'stopped').length }, strategies,
    benchmarks: { noTradeR: 0, buyAndHold: null, caveat: 'No-trade benchmark is 0R. Matching buy-and-hold series is unavailable. Recorded original costs are not subtracted twice.' } };
}
module.exports = { buildFocusReport };
