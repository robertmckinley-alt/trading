const { createHash } = require('node:crypto');

const finite = value => typeof value === 'number' && Number.isFinite(value);
const money = value => Math.round(value * 100) / 100;

function buildFocusPaperView(snapshot, policy, now = Date.now()) {
  const reasons = [];
  const report = snapshot?.focusPaperTrial;
  const parents = new Set(policy.parents.map(parent => parent.slug));
  const policyHash = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  const fresh = (at, maxAge) => Number.isFinite(Date.parse(at || '')) && now - Date.parse(at) <= maxAge && Date.parse(at) <= now + 5000;
  if (snapshot?.source !== 'remote-bridge' || snapshot?.ok !== true || !fresh(snapshot?.generatedAt, 180000)) reasons.push('A fresh live worker-server connection is required.');
  for (const parent of policy.parents) {
    const source = snapshot?.strategies?.find?.(strategy => strategy.slug === parent.slug);
    if (source?.watcher?.isHealthy !== true || source?.watcher?.processCount !== 1) reasons.push(`The parent signal source is not healthy: ${parent.name}.`);
  }
  if (!report || report.id !== policy.id || report.policyHash !== policyHash || report.startedAt !== policy.startedAt) reasons.push('The registered $1,000 paper trial is unavailable or its policy changed.');
  if (!fresh(report?.updatedAt, 90000)) reasons.push('The paper worker heartbeat is stale or unavailable.');
  if (report?.integrityOk !== true || report?.sourceRulesHash !== policy.sourceRulesHash || report?.engineCodeHash !== policy.engineCodeHash) reasons.push('Frozen source or paper-worker integrity is not confirmed.');
  if (!['collecting', 'market-closed'].includes(report?.status)) reasons.push(report?.reason || `Paper worker status: ${report?.status || 'not started'}.`);
  const accounts = Array.isArray(report?.accounts) ? report.accounts : [];
  const controls = accounts.filter(account => account.arm === 'control');
  const candidates = accounts.filter(account => account.arm === 'vwap-confirm' && account.parent === 'nq-vwap-stretch-reversion');
  if (controls.length !== policy.parents.length || new Set(controls.map(account => account.parent)).size !== parents.size || controls.some(account => !parents.has(account.parent))) reasons.push('The five selected paper accounts are not uniquely confirmed.');
  if (accounts.length !== policy.parents.length + 1 || candidates.length !== 1 || new Set(accounts.map(account => account.id)).size !== accounts.length) reasons.push('The separate VWAP comparison account is not uniquely confirmed.');
  let total = 0, count = 0;
  for (const account of accounts) {
    const trades = Array.isArray(account.tradeList) ? account.tradeList : [];
    let pnl = 0;
    if (!Array.isArray(account.tradeList) || !finite(account.realizedPnlUsd) || account.trades !== trades.length) reasons.push('The paper trade ledger is incomplete.');
    const ids = new Set();
    for (const trade of trades) {
      const entered = Date.parse(trade.filledAt || ''), exited = Date.parse(trade.exitedAt || '');
      if (!trade.id || ids.has(trade.id) || !finite(trade.netPnlUsd) || !finite(trade.actualRiskUsd) || trade.actualRiskUsd <= 0 || trade.actualRiskUsd > policy.riskPerTradeUsd + 0.01 || !Number.isInteger(trade.contracts) || trade.contracts <= 0 || !Number.isFinite(entered) || !Number.isFinite(exited) || entered < Date.parse(policy.startedAt) || exited < entered || exited > now) reasons.push('A counted paper trade has invalid identity, timing, size, or risk evidence.');
      ids.add(trade.id);
      if (finite(trade.netPnlUsd)) pnl += trade.netPnlUsd;
    }
    if (Math.abs(money(pnl) - account.realizedPnlUsd) > 0.011) reasons.push('A paper account P&L does not reconcile to its trade ledger.');
    if (account.arm === 'control') { total += pnl; count += trades.length; }
  }
  if (!finite(report?.summary?.realizedPnlUsd) || money(total) !== report.summary.realizedPnlUsd || count !== report?.summary?.closedTrades) reasons.push('Combined P&L does not reconcile to the five control-account ledgers.');
  const pairs = report?.comparison?.pairs;
  let pairedControl = 0, pairedCandidate = 0;
  const pairIds = new Set();
  if (!Array.isArray(pairs)) reasons.push('Resolved comparison evidence is unavailable.');
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    if (!pair.id || pairIds.has(pair.id)) reasons.push('Comparison event identity is missing or duplicated.');
    pairIds.add(pair.id);
    for (const [key, arm] of [['control', 'control'], ['candidate', 'vwap-confirm']]) {
      const result = pair[key];
      if (!result || !finite(result.pnlUsd) || !['closed', 'filtered', 'unfilled'].includes(result.status)) { reasons.push('A comparison outcome is not terminal and reconciled.'); continue; }
      if (result.status === 'closed') {
        const account = accounts.find(item => item.parent === 'nq-vwap-stretch-reversion' && item.arm === arm);
        const trade = account?.tradeList?.find(item => item.id === result.tradeId);
        if (!trade || trade.netPnlUsd !== result.pnlUsd) reasons.push('A closed comparison outcome does not match its paper trade.');
      } else if (result.pnlUsd !== 0 || result.tradeId) reasons.push('An unfilled or filtered comparison cannot carry realized P&L.');
    }
    if (finite(pair.control?.pnlUsd)) pairedControl += pair.control.pnlUsd;
    if (finite(pair.candidate?.pnlUsd)) pairedCandidate += pair.candidate.pnlUsd;
  }
  if (!report?.comparison || report.comparison.pairedComparisons !== (pairs?.length ?? -1) || report.comparison.controlPnlUsd !== money(pairedControl) || report.comparison.candidatePnlUsd !== money(pairedCandidate) || report.comparison.deltaUsd !== money(pairedCandidate - pairedControl)) reasons.push('The comparison totals do not reconcile to resolved pairs.');
  const ok = reasons.length === 0;
  return {
    id: policy.id, name: policy.name, startedAt: policy.startedAt,
    updatedAt: report?.updatedAt || null, source: snapshot?.source || 'unavailable',
    policy: Object.fromEntries(['riskPerTradeUsd', 'dailyLossLimitUsd', 'portfolioOpenRiskUsd', 'familyOpenRiskUsd', 'startingBalanceUsd'].map(key => [key, policy[key]])),
    status: ok ? report.status : 'blocked', dataStatus: { ok, reasons: [...new Set(reasons)] },
    summary: ok ? report.summary : { realizedPnlUsd: null, closedTrades: null, openPositions: null, reservedRiskUsd: null },
    accounts: ok ? accounts : policy.parents.map(parent => ({ id: `${parent.slug}:control`, parent: parent.slug, name: parent.name, arm: 'control', balanceUsd: null, realizedPnlUsd: null, trades: null, open: null, reservedRiskUsd: null, status: 'unavailable', tradeList: [] })),
    comparison: ok ? report.comparison : { pairedComparisons: null, deltaUsd: null, controlPnlUsd: null, candidatePnlUsd: null },
    events: ok ? report.events : [],
    scope: 'New independent paper accounts copying prospectively observed, parent-admitted signals only. Main P&L counts the five control accounts; the VWAP confirmation comparison is separate. Planned risk includes modeled fees and slippage. Gaps can exceed planned loss.'
  };
}

module.exports = { buildFocusPaperView };
