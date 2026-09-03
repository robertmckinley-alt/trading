function role(name, status, summary) {
  return { name, status, summary };
}

function buildDirectionalEvidence(signal) {
  if (!signal?.found) {
    return {
      conclusion: 'standby',
      bull: [],
      bear: [],
      summary: signal?.reason || 'No qualified setup is ready for review.'
    };
  }

  const side = signal.setup?.side;
  const amd = signal.metadata?.amdContext;
  const orderFlow = signal.metadata?.orderFlow;
  const bull = [];
  const bear = [];
  if (side === 'long') bull.push('The deterministic setup detector qualified a long entry.');
  if (side === 'short') bear.push('The deterministic setup detector qualified a short entry.');
  if (amd?.supportsLong) bull.push('London swept the Asia low, supporting a bullish reversal hypothesis.');
  if (amd?.supportsShort) bear.push('London swept the Asia high, supporting a bearish reversal hypothesis.');
  if (orderFlow?.aligned && side === 'long') bull.push(orderFlow.reason);
  if (orderFlow?.aligned && side === 'short') bear.push(orderFlow.reason);
  if (amd?.suggestedBias === 'neutral') {
    bull.push('Asia/London context is neutral, so it does not strengthen the setup.');
    bear.push('Asia/London context is neutral, so it does not strengthen the setup.');
  }

  return {
    conclusion: side === 'long' ? 'bullish-qualified' : 'bearish-qualified',
    bull,
    bear,
    summary: `${String(side || 'unknown').toUpperCase()} setup qualified; evidence is advisory and cannot place a trade.`
  };
}

function buildResearchCouncilReview({ signal, adaptiveDecision, feedMetadata }) {
  const evidence = buildDirectionalEvidence(signal);
  const feedHealthy = Boolean(feedMetadata?.provider && feedMetadata?.ticker);
  const setupQualified = Boolean(signal?.found);
  const riskClear = adaptiveDecision?.risk?.allowed !== false;
  const learning = adaptiveDecision?.learning;
  return {
    mode: 'advisory-only',
    reviewedAt: new Date().toISOString(),
    strategyRulesMutable: false,
    canPlaceTrades: false,
    canIncreaseRisk: false,
    evidence,
    roles: [
      role('Feed health', feedHealthy ? 'clear' : 'blocked', feedHealthy
        ? `${feedMetadata.provider} is supplying ${feedMetadata.ticker}.`
        : 'No verified live-feed metadata is available.'),
      role('Setup detector', setupQualified ? 'qualified' : 'standby', setupQualified
        ? `${signal.setup.side} ${signal.setup.setup?.entryModel || 'setup'} detected.`
        : signal?.reason || 'Waiting for a rule-qualified setup.'),
      role('Market regime', adaptiveDecision?.market?.status || 'standby', adaptiveDecision?.market?.reason || 'Waiting for market bars.'),
      role('Bull / bear review', evidence.conclusion, evidence.summary),
      role('Risk veto', riskClear ? 'pending-portfolio-check' : 'vetoed', adaptiveDecision?.risk?.reason || 'Waiting for deterministic risk checks.'),
      role('Post-trade review', learning?.tradesLearned ? 'active' : 'learning', learning?.tradesLearned
        ? `${learning.tradesLearned} closed outcomes have been graded.`
        : 'Waiting for a closed paper trade.')
    ]
  };
}

function applyRiskDecision(review, decision) {
  if (!review) return review;
  const allowed = Boolean(decision?.allowed);
  return {
    ...review,
    reviewedAt: new Date().toISOString(),
    riskDecision: {
      allowed,
      reason: decision?.reason || 'No deterministic risk decision was supplied.',
      portfolioProjectedRiskUsd: decision?.projectedRiskUsd ?? null,
      familyProjectedRiskUsd: decision?.projectedFamilyRiskUsd ?? null
    },
    roles: review.roles.map((item) => item.name === 'Risk veto'
      ? role('Risk veto', allowed ? 'clear' : 'vetoed', decision?.reason || 'Risk check did not clear the setup.')
      : item)
  };
}

module.exports = {
  applyRiskDecision,
  buildDirectionalEvidence,
  buildResearchCouncilReview
};
