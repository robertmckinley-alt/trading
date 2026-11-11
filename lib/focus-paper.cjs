// Independent forward paper accounts. No filesystem writes, parent edits, or broker calls.
const { createHash } = require('node:crypto');
const common = require('./regime-experiment.cjs');
const { normalizeConfig, trackTradeLifecycle, toJournalTrade } = require('./trader-core.cjs');
const { buildPlanFromSignal } = require('./live-trader.cjs');
const { bindForwardObservation } = require('./watcher-observation.cjs');
const VERSION = 'focus-paper-v2';
const VWAP = 'nq-vwap-stretch-reversion';
const PARENTS = ['live-9am-sweep', VWAP, 'nq-fresh-level-retest', 'nq-opening-range-breakout', 'nq-15m-opening-range-retest'];
const minute = 60000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const iso = value => new Date(value).toISOString();
const money = value => Number.isFinite(value) ? Number(value.toFixed(2)) : null;
const dayClock = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = at => dayClock.format(new Date(at));
function validatePolicy(policy) {
  if (!policy || !policy.id || !Number.isFinite(time(policy.startedAt)) || !Array.isArray(policy.parents) || policy.parents.length !== 5 || new Set(policy.parents.map(p => p.slug)).size !== 5 || policy.parents.some(p => !PARENTS.includes(p.slug))) throw Error('Invalid frozen five-account paper policy');
  for (const key of ['riskPerTradeUsd', 'startingBalanceUsd', 'dailyLossLimitUsd', 'portfolioOpenRiskUsd', 'familyOpenRiskUsd']) if (!finite(policy[key]) || policy[key] <= 0) throw Error(`Invalid paper policy ${key}`);
  if (policy.riskPerTradeUsd > 1000 || policy.dailyLossLimitUsd > 1000 || policy.portfolioOpenRiskUsd > 2500 || policy.familyOpenRiskUsd > 1000 || policy.startingBalanceUsd !== 50000) throw Error('Paper risk policy exceeds the authorized limits');
  if (!policy.baseConfig || policy.baseConfig.tickSize !== .25 || policy.baseConfig.tickValueUsd !== 5 || !finite(policy.baseConfig.commissionPerContractUsd) || policy.baseConfig.commissionPerContractUsd < 0 || !finite(policy.baseConfig.slippageTicks) || policy.baseConfig.slippageTicks < 0) throw Error('Explicit valid NQ tick, fee and slippage configuration is required');
  for (const parent of policy.parents) if (!parent.slug || !parent.family || !finite(parent.accountDrawdownPercent) || parent.accountDrawdownPercent <= 0 || parent.accountDrawdownPercent > (parent.slug === VWAP ? 5 : 10)) throw Error('Invalid parent family or account floor');
}
function configFor(policy, parent) {
  return normalizeConfig({ ...policy.baseConfig, symbol: 'NQ', startingBalanceUsd: policy.startingBalanceUsd,
    maxRiskPerTradeUsd: policy.riskPerTradeUsd, maxDailyLossUsd: policy.dailyLossLimitUsd,
    maxAccountDrawdownPercent: parent.accountDrawdownPercent, strategySlug: parent.slug, strategyFamily: parent.family });
}
function initial(policy, now = Date.now()) {
  validatePolicy(policy);
  const state = { id: policy.id, version: VERSION, policyHash: hash(policy), startedAt: policy.startedAt,
    updatedAt: iso(now), status: 'collecting', reason: 'Waiting for new admitted parent signals.', accounts: {}, events: [], seen: [], firstSeen: {} };
  for (const parent of policy.parents) {
    common.account(state, parent.slug, 'control', configFor(policy, parent));
    if (parent.slug === VWAP) common.account(state, parent.slug, 'vwap-confirm', configFor(policy, parent));
  }
  return state;
}
const reserved = account => account.open ? account.open.plan.sizing.actualRiskUsd : account.pending ? account.pending.riskBudgetUsd : 0;
function budget(state, account, parent, policy, now) {
  const daily = account.trades.filter(t => Number.isFinite(time(t.exitedAt)) && day(t.exitedAt) === day(now)).reduce((sum, t) => sum + t.realizedPnlUsd, 0);
  const book = Object.values(state.accounts).filter(a => a.arm === account.arm);
  const totalRisk = book.reduce((sum, a) => sum + reserved(a), 0);
  const familyRisk = book.filter(a => a.config.strategyFamily === parent.family).reduce((sum, a) => sum + reserved(a), 0);
  return Math.max(0, Math.min(policy.riskPerTradeUsd, policy.dailyLossLimitUsd + Math.min(0, daily),
    account.balanceUsd - policy.startingBalanceUsd * (1 - parent.accountDrawdownPercent / 100),
    policy.portfolioOpenRiskUsd - totalRisk, policy.familyOpenRiskUsd - familyRisk));
}
function makePlan(signal, setup, account, risk, now) {
  if (!finite(risk) || risk <= 0) throw Error('Account, daily, portfolio, or family risk guard');
  const originalDeadline = time(signal.setup.orderExpiresAt), stop = signal.setup.stop;
  if (!Number.isFinite(originalDeadline) || originalDeadline <= Math.ceil(now / minute) * minute) throw Error('No future entry before the original order deadline');
  const direction = setup.side === 'long' ? 1 : setup.side === 'short' ? -1 : 0;
  if (setup.symbol !== 'NQ' || !/^\d{4}-\d{2}-\d{2}$/.test(setup.date || '') || !['next-bar-market', 'limit-touch'].includes(setup.execution) || !direction || !finite(setup.entry) || !finite(stop) || direction * (setup.entry - stop) <= 0 || !Array.isArray(setup.targets) || !setup.targets.length || setup.targets.some(t => !finite(t) || direction * (t - setup.entry) <= 0)) throw Error('Invalid symbol, timing, entry, structural stop, or original target direction');
  const plan = buildPlanFromSignal({ found: true, setup: structuredClone(setup), triggerTimestamp: setup.signalAvailableAt,
    metadata: { eventId: signal.id, parent: signal.parent, observedAt: iso(now), parentObservedAt: signal.observedAt } }, { ...account.config, maxRiskPerTradeUsd: risk }, account);
  bindForwardObservation(plan, now);
  // The fresh-level binder may grant a new fill minute: this trial cannot extend its parent's deadline.
  plan.setup.orderExpiresAt = iso(Math.min(originalDeadline, time(plan.setup.orderExpiresAt)));
  if (time(plan.setup.signalAvailableAt) >= time(plan.setup.orderExpiresAt)) throw Error('Original deadline passed before prospective fill');
  if (plan.setup.stop !== stop || plan.sizing.actualRiskUsd > risk || !Number.isInteger(plan.sizing.maxContracts) || plan.sizing.maxContracts < 1) throw Error('Unsafe planned stop or contract sizing');
  return plan;
}
function outcome(state, account, result) {
  const event = state.events.find(e => e.id === (account.open?.eventId || account.pending?.eventId));
  if (!event?.arms?.[account.arm]) throw Error('Paper account event provenance is missing');
  event.arms[account.arm].outcome = result;
}
function settle(state, candles, now) {
  for (const a of Object.values(state.accounts)) {
    if (!a.open) continue;
    const start = time(a.open.plan.setup.signalAvailableAt), end = Math.floor(now / minute) * minute - minute;
    if (end < start) continue;
    const saved = new Map((a.open.candles || []).map(c => [time(c.timestamp), c]));
    for (const c of candles) if (time(c.timestamp) >= start && time(c.timestamp) <= end) {
      const existing = saved.get(time(c.timestamp));
      if (existing && hash(existing) !== hash(c)) { a.status = 'data-gap'; a.pathConflict = true; }
      else saved.set(time(c.timestamp), c);
    }
    a.open.candles = [...saved.values()].sort((x, y) => time(x.timestamp) - time(y.timestamp));
    if (a.pathConflict) continue;
    const contiguous = [];
    for (const c of a.open.candles) {
      const expected = start + contiguous.length * minute;
      if (!validBar(c) || !common.validPath([c], expected, expected) || (contiguous.length && instrument(c) !== instrument(contiguous[0]))) break;
      contiguous.push(c);
    }
    if (!contiguous.length) { a.status = 'data-gap'; continue; }
    const life = trackTradeLifecycle(a.open.plan, contiguous, a.config, { closeOpenAtEnd: false, now, flattenAt: a.open.plan.setup.flattenAt });
    a.open.lifecycle = life;
    if (life.status === 'closed') {
      const trade = { ...toJournalTrade(a.open.plan, life), id: `${state.id}:${a.id}:${a.open.eventId}`, createdAt: iso(now), eventId: a.open.eventId, evidenceType: 'forward-focus-paper' };
      a.trades.push(trade); a.realizedPnlUsd = money(a.trades.reduce((total, t) => total + t.realizedPnlUsd, 0)); a.balanceUsd = policyBalance(state, a);
      outcome(state, a, { status: 'closed', pnlUsd: trade.realizedPnlUsd }); a.open = null; a.status = 'collecting';
    } else if (life.status === 'not-filled' && (time(contiguous.at(-1).timestamp) + minute >= time(a.open.plan.setup.orderExpiresAt) || ['entry gap beyond stop or target', 'entry gap exceeds risk budget', 'entry gap below minimum reward/risk', 'entry drift exceeds limit', 'invalid order timing', 'order expired'].includes(life.exitReason))) {
      outcome(state, a, { status: 'unfilled', pnlUsd: 0, reason: life.exitReason }); a.open = null; a.status = 'collecting';
    } else a.status = time(contiguous.at(-1).timestamp) === end ? 'collecting' : 'data-gap';
  }
}
const policyBalance = (_state, account) => money(account.config.startingBalanceUsd + account.realizedPnlUsd);
const instrument = c => c.instrumentId ?? c.instrument_id;
function validBar(c) {
  return c && Number.isFinite(time(c.timestamp)) && time(c.timestamp) % minute === 0 && instrument(c) != null && ['open', 'high', 'low', 'close'].every(k => finite(c[k])) && c.low > 0 && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close);
}
function processConfirmation(state, candles, policy, now, canAdmit) {
  const parent = policy.parents.find(p => p.slug === VWAP), a = state.accounts[`${VWAP}:vwap-confirm`];
  if (!a?.pending) return;
  const pending = a.pending, deadline = time(pending.signal.setup.orderExpiresAt);
  if (now >= deadline) { outcome(state, a, { status: 'filtered', pnlUsd: 0, reason: 'No observable completed turn before original deadline' }); a.pending = null; return; }
  if (!canAdmit) return;
  const start = pending.pathStart ?? pending.observationFloor, end = Math.floor(now / minute) * minute - minute;
  if (end < start) return;
  const saved = new Map((pending.candles || []).map(c => [time(c.timestamp), c]));
  for (const c of candles) if (time(c.timestamp) >= start && time(c.timestamp) <= end) {
    if (saved.has(time(c.timestamp)) && hash(saved.get(time(c.timestamp))) !== hash(c)) { a.status = 'data-gap'; pending.pathConflict = true; }
    else saved.set(time(c.timestamp), c);
  }
  pending.candles = [...saved.values()].sort((x, y) => time(x.timestamp) - time(y.timestamp));
  if (pending.pathConflict) return;
  for (let i = 0; i < pending.candles.length; i++) {
    const c = pending.candles[i], expected = start + i * minute;
    if (!validBar(c) || time(c.timestamp) !== expected || (i && instrument(c) !== instrument(pending.candles[0]))) { a.status = 'data-gap'; return; }
    const prior = i ? pending.candles[i - 1] : pending.referenceBar;
    if (!prior || !validBar(prior) || time(prior.timestamp) + minute !== time(c.timestamp) || instrument(prior) !== instrument(c)) { a.status = 'data-gap'; return; }
    if (time(c.timestamp) <= pending.checkedThrough) continue;
    pending.checkedThrough = time(c.timestamp);
    // Earlier completed bars are causal reference context, never retrospective confirmations.
    if (time(c.timestamp) < pending.observationFloor) continue;
    const available = time(c.timestamp) + minute;
    if (available >= deadline || c.close <= c.open || c.close <= prior.high) continue;
    // A delayed worker cannot backfill a confirmation into a bar that already began.
    const prospectiveFloor = Math.ceil(now / minute) * minute;
    if (prospectiveFloor >= deadline) continue;
    const original = pending.signal.setup, drift = c.close - original.entry;
    if (drift > Math.abs(original.entry - original.stop) * Math.min(original.maximumAdverseEntryRiskFraction ?? .25, .25)) continue;
    const remainingDrift = Math.max(0, Math.abs(original.entry - original.stop) * Math.min(.25, original.maximumAdverseEntryRiskFraction ?? .25) - drift);
    const setup = { ...structuredClone(original), execution: 'next-bar-market', entry: c.close, signalAvailableAt: iso(available),
      signalOriginAvailableAt: original.signalOriginAvailableAt || original.signalAvailableAt,
      minimumEntryRewardRisk: Math.max(1, original.minimumEntryRewardRisk || 0), maximumAdverseEntryRiskFraction: Math.min(.25, remainingDrift / Math.abs(c.close - original.stop)), observedAt: iso(now) };
    try {
      // Remove confirmation reservation while computing its own available independent budget.
      a.pending = null;
      const plan = makePlan(pending.signal, setup, a, Math.min(pending.riskBudgetUsd, budget(state, a, parent, policy, now)), now);
      const r = plan.sizing.totalRiskPerContractUsd, reward = (plan.targets[0].price - setup.entry) / a.config.tickSize * a.config.tickValueUsd - a.config.slippageTicks * a.config.tickValueUsd - a.config.commissionPerContractUsd;
      if (reward / r < setup.minimumEntryRewardRisk) throw Error('Completed turn below minimum net reward/risk');
      a.open = { eventId: pending.eventId, plan, candles: [] }; a.status = 'collecting';
      state.events.find(e => e.id === pending.eventId).arms['vwap-confirm'].decision = 'confirmed-future-entry'; return;
    } catch (error) { a.pending = pending; pending.lastRejection = error.message; }
  }
}
function advance(previous, signals, candles, policy, now = Date.now(), { integrityOk = true } = {}) {
  validatePolicy(policy);
  const state = structuredClone(previous || initial(policy, now));
  if (state.version !== VERSION || state.id !== policy.id || state.policyHash !== hash(policy)) throw Error('Frozen paper policy/version changed; create a new version, never reset saved evidence');
  if (Object.keys(state.accounts || {}).length !== 6) throw Error('Saved paper account set is invalid; refusing reset');
  for (const parent of policy.parents) for (const arm of parent.slug === VWAP ? ['control', 'vwap-confirm'] : ['control']) {
    const account = state.accounts?.[`${parent.slug}:${arm}`];
    if (!account || !Array.isArray(account.trades) || !finite(account.balanceUsd) || !finite(account.realizedPnlUsd) || hash(account.config) !== hash(configFor(policy, parent)) || account.trades.some(t => !finite(t.realizedPnlUsd)) || money(account.balanceUsd) !== money(policy.startingBalanceUsd + account.trades.reduce((total, t) => total + t.realizedPnlUsd, 0))) throw Error('Saved paper account evidence or frozen configuration is invalid; refusing reset');
    const total = money(account.trades.reduce((sum, trade) => sum + trade.realizedPnlUsd, 0));
    if (money(account.realizedPnlUsd) !== total || account.parent !== parent.slug || account.arm !== arm || (account.open && account.pending)) throw Error('Saved paper accounting or account provenance is invalid; refusing reset');
    const active = account.open || account.pending;
    if (active) {
      const event = state.events?.find(e => e.id === active.eventId);
      if (!event || event.parent !== parent.slug || !event.arms?.[arm] || event.arms[arm].outcome) throw Error('Saved paper event provenance is invalid; refusing reset');
      const risk = reserved(account);
      if (!finite(risk) || risk <= 0 || risk > policy.riskPerTradeUsd) throw Error('Saved paper reservation is invalid; refusing reset');
      if (account.open) {
        const { plan } = account.open, sizing = plan?.sizing, setup = plan?.setup;
        if (plan?.executionModelVersion !== 'bounded-fill-v1' || !finite(sizing?.riskBudgetUsd) || risk > sizing.riskBudgetUsd || sizing.riskBudgetUsd > policy.riskPerTradeUsd || !Number.isInteger(sizing.maxContracts) || sizing.maxContracts < 1 || !finite(setup?.stop) || !(time(setup.signalAvailableAt) < time(setup.orderExpiresAt))) throw Error('Saved paper open plan is invalid; refusing reset');
      } else if (arm !== 'vwap-confirm' || active.signal?.id !== active.eventId || active.signal?.parent !== parent.slug || !(time(active.signal?.observedAt) >= time(policy.startedAt)) || !finite(active.observationFloor) || !finite(active.pathStart) || !(time(active.signal?.setup?.signalAvailableAt) < time(active.signal?.setup?.orderExpiresAt))) throw Error('Saved paper pending plan is invalid; refusing reset');
    }
  }
  if (!Number.isFinite(now) || now < time(state.updatedAt)) throw Error('Paper clock must be valid and monotonic');
  const completed = (Array.isArray(candles) ? candles : []).filter(c => time(c?.timestamp) + minute <= now).sort((a, b) => time(a.timestamp) - time(b.timestamp));
  const dedup = new Map(); let candleConflict = false;
  for (const c of completed) { const key = time(c.timestamp); if (dedup.has(key) && hash(dedup.get(key)) !== hash(c)) candleConflict = true; else dedup.set(key, c); }
  const rows = [...dedup.values()], latest = rows.at(-1);
  const fresh = validBar(latest) && now - time(latest.timestamp) <= 180000 && !candleConflict;
  settle(state, candleConflict ? [] : rows, now);
  const gap = Object.values(state.accounts).some(a => a.status === 'data-gap');
  const ready = integrityOk && fresh && !gap && now >= time(policy.startedAt);
  processConfirmation(state, rows, policy, now, ready);
  for (const signal of [...(signals || [])].sort((a, b) => time(a.observedAt) - time(b.observedAt) || String(a.id).localeCompare(String(b.id)))) {
    if (!signal?.id || typeof signal.id !== 'string') continue;
    if (state.seen.includes(signal.id)) continue;
    state.seen.push(signal.id); state.firstSeen[signal.id] = iso(now);
    const event = { id: signal.id, parent: signal.parent, observedAt: signal.observedAt, decisionAt: iso(now), status: 'excluded', arms: {} };
    state.events.push(event);
    const parent = policy.parents.find(p => p.slug === signal.parent), setup = signal.setup;
    const origin = time(setup?.signalOriginAvailableAt || setup?.signalAvailableAt), observed = time(signal.observedAt);
    if (!ready || !parent || !setup || !Number.isFinite(observed) || observed < time(policy.startedAt) || observed > now || now - observed > 120000 || !Number.isFinite(origin) || origin < time(policy.startedAt) || origin > observed || !Number.isFinite(time(setup.signalAvailableAt)) || time(setup.signalAvailableAt) > now || time(setup.orderExpiresAt) <= now) { event.reason = 'Not a fresh prospective signal under the frozen policy'; continue; }
    const control = state.accounts[`${parent.slug}:control`], candidate = parent.slug === VWAP ? state.accounts[`${VWAP}:vwap-confirm`] : null;
    if ([control, candidate].filter(Boolean).some(a => a.open || a.pending)) { event.reason = 'Matched account cohort is still busy'; continue; }
    try {
      const plan = makePlan(signal, setup, control, budget(state, control, parent, policy, now), now);
      event.arms.control = { decision: 'admitted', contracts: plan.sizing.maxContracts };
      control.open = { eventId: signal.id, plan, candles: [] }; control.status = 'collecting'; event.status = 'observed';
      if (candidate) {
        event.arms['vwap-confirm'] = { decision: 'waiting-for-completed-turn' };
        const risk = budget(state, candidate, parent, policy, now);
        if (setup.side !== 'long' || risk <= 0) event.arms['vwap-confirm'].outcome = { status: 'filtered', pnlUsd: 0, reason: setup.side !== 'long' ? 'Bullish-turn comparison applies to long signals only' : 'Candidate risk guard' };
        else candidate.pending = { eventId: signal.id, signal: structuredClone(signal), observationFloor: Math.max(Math.ceil(now / minute) * minute, origin),
          referenceBar: structuredClone(latest), pathStart: time(latest.timestamp) + minute, riskBudgetUsd: risk, candles: [], checkedThrough: -1 };
      }
    } catch (error) { event.reason = error.message; event.arms.control = { decision: 'risk-block', outcome: { status: 'unfilled', pnlUsd: 0, reason: error.message } }; }
  }
  state.updatedAt = iso(now);
  state.status = !integrityOk ? 'integrity-blocked' : !fresh ? 'waiting-for-fresh-feed' : Object.values(state.accounts).some(a => a.status === 'data-gap') ? 'data-gap' : now < time(policy.startedAt) ? 'not-started' : 'collecting';
  state.reason = state.status === 'collecting' ? 'Independent paper accounts observe new admitted parent signals only.' : 'New entries are blocked. Existing positions retain their original exit rules and await a complete observable price path.';
  return state;
}
function report(state, policy) {
  validatePolicy(policy);
  if (!state || state.version !== VERSION || state.policyHash !== hash(policy) || state.id !== policy.id) throw Error('Cannot report mismatched paper policy/state');
  const accounts = Object.values(state.accounts).map(a => ({ id: a.id, parent: a.parent, name: policy.parents.find(p => p.slug === a.parent)?.name || a.parent,
    arm: a.arm, balanceUsd: a.balanceUsd, realizedPnlUsd: a.realizedPnlUsd, trades: a.trades.length,
    open: Boolean(a.open?.lifecycle?.filledAt), pending: Boolean(a.pending || (a.open && !a.open.lifecycle?.filledAt)), reservedRiskUsd: reserved(a), status: a.status,
    tradeList: a.trades.map(t => ({ id: t.id, side: t.side, contracts: t.contracts, entry: t.entry, exit: t.finalExitPrice, filledAt: t.filledAt,
      exitedAt: t.exitedAt, netPnlUsd: t.realizedPnlUsd, actualRiskUsd: t.actualRiskUsd, rMultiple: t.rMultiple })) }));
  const controls = accounts.filter(a => a.arm === 'control');
  const paired = state.events.filter(e => e.parent === VWAP && e.arms.control?.outcome && e.arms['vwap-confirm']?.outcome);
  const controlPnlUsd = money(paired.reduce((sum, e) => sum + e.arms.control.outcome.pnlUsd, 0));
  const candidatePnlUsd = money(paired.reduce((sum, e) => sum + e.arms['vwap-confirm'].outcome.pnlUsd, 0));
  const pairs = paired.map(event => {
    const result = arm => {
      const outcome = event.arms[arm].outcome;
      const trade = state.accounts[`${VWAP}:${arm}`].trades.find(t => t.eventId === event.id);
      if (outcome.status === 'closed' && (!trade || trade.realizedPnlUsd !== outcome.pnlUsd)) throw Error('Resolved paper comparison does not reconcile to a closed trade');
      if (outcome.status !== 'closed' && (!['filtered', 'unfilled'].includes(outcome.status) || outcome.pnlUsd !== 0 || trade)) throw Error('Invalid non-closed paper comparison outcome');
      return { status: outcome.status, pnlUsd: outcome.pnlUsd, tradeId: trade?.id || null };
    };
    return { id: event.id, control: result('control'), candidate: result('vwap-confirm') };
  });
  return { id: state.id, name: policy.name || '$1,000 risk paper trial', policyHash: state.policyHash, status: state.status, startedAt: state.startedAt, updatedAt: state.updatedAt,
    policy: Object.fromEntries(['riskPerTradeUsd', 'dailyLossLimitUsd', 'portfolioOpenRiskUsd', 'familyOpenRiskUsd', 'startingBalanceUsd'].map(k => [k, policy[k]])),
    summary: { realizedPnlUsd: money(controls.reduce((sum, a) => sum + a.realizedPnlUsd, 0)), closedTrades: controls.reduce((sum, a) => sum + a.trades, 0), openPositions: controls.filter(a => a.open).length, reservedRiskUsd: money(controls.reduce((sum, a) => sum + a.reservedRiskUsd, 0)) }, accounts,
    comparison: { pairedComparisons: paired.length, deltaUsd: money(candidatePnlUsd - controlPnlUsd), controlPnlUsd, candidatePnlUsd, pairs }, events: state.events.slice(-30).reverse(), reason: state.reason,
    scope: 'New independent paper accounts, not rescaled history. Main totals contain only five control accounts and closed trades. VWAP completed-turn comparison is separate and unvalidated. Planned risk includes modeled costs; gaps can exceed planned loss. No broker orders or automatic promotion.' };
}
module.exports = { initial, advance, report };
