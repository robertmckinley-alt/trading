const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_VERSION = 1;
const LOCK_MAX_AGE_MS = 30_000;
const MAX_CHALLENGERS_PER_PARENT = 2;
const EXECUTABLE_CATALOG = new Set(['exclude-underperforming-segment-v1']);

function manifestPath(rootDir) {
  return path.join(rootDir, 'runtime', 'challenger-accounts.json');
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readChallengerManifest(rootDir) {
  const manifest = safeReadJson(manifestPath(rootDir));
  return {
    version: MANIFEST_VERSION,
    updatedAt: manifest?.updatedAt || null,
    accounts: Array.isArray(manifest?.accounts) ? manifest.accounts : []
  };
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporaryPath, filePath);
}

function acquireLock(rootDir) {
  const runtimeDir = path.join(rootDir, 'runtime');
  const lockPath = path.join(runtimeDir, 'challenger-accounts.lock');
  fs.mkdirSync(runtimeDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      return { handle, lockPath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (ageMs <= LOCK_MAX_AGE_MS || attempt > 0) return null;
      fs.unlinkSync(lockPath);
    }
  }
  return null;
}

function releaseLock(lock) {
  if (!lock) return;
  try {
    fs.closeSync(lock.handle);
  } finally {
    try {
      fs.unlinkSync(lock.lockPath);
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }
}

function safeSegment(value) {
  return String(value || 'segment').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'segment';
}

function experimentFingerprint(recommendation) {
  return [
    recommendation.parentStrategySlug,
    recommendation.catalogId,
    recommendation.dimension,
    recommendation.blockedValue
  ].join('|');
}

function challengerSlug(recommendation) {
  const fingerprint = experimentFingerprint(recommendation);
  const suffix = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 8);
  return `${safeSegment(recommendation.parentStrategySlug)}-x-${safeSegment(recommendation.dimension)}-${safeSegment(recommendation.blockedValue)}-${suffix}`;
}

function eligibleRecommendation(learning, parentDefinition) {
  const recommendation = learning?.experimentRecommendation;
  return Boolean(
    parentDefinition &&
    parentDefinition.accountType !== 'challenger' &&
    learning?.controls?.automaticChallengerCreationAllowed === true &&
    recommendation?.action === 'create-paper-challenger' &&
    recommendation?.status === 'eligible' &&
    recommendation?.parentStrategySlug === parentDefinition.slug &&
    EXECUTABLE_CATALOG.has(recommendation?.catalogId) &&
    ['market-regime', 'side'].includes(recommendation?.dimension) &&
    recommendation?.blockedValue
  );
}

function buildAccount({ config, learning, parentDefinition, recommendation, sequence, now }) {
  const slug = challengerSlug(recommendation);
  const blockedLabel = String(recommendation.blockedValue).replaceAll('-', ' ');
  const dimensionLabel = String(recommendation.dimension).replaceAll('-', ' ');
  return {
    slug,
    name: `${parentDefinition.name} · Exclude ${blockedLabel}`,
    shortName: `${parentDefinition.shortName || parentDefinition.name} challenger`,
    paperAccountLabel: `Challenger ${sequence}`,
    accountType: 'challenger',
    status: 'active',
    parentStrategySlug: parentDefinition.slug,
    parentStrategyName: parentDefinition.name,
    detectorStrategySlug: parentDefinition.detectorStrategySlug || parentDefinition.slug,
    strategyFamily: parentDefinition.strategyFamily,
    strategyFamilyName: parentDefinition.strategyFamilyName,
    activationTime: parentDefinition.activationTime,
    researchStage: 'Forward challenger test',
    evidenceLabel: 'Automatically created from a structured, evidence-gated learning recommendation',
    description: `Uses the parent entry rules but rejects signals when ${dimensionLabel} is ${blockedLabel}. The rules are frozen for a new forward paper sample.`,
    source: {
      label: 'Internal learning experiment catalog',
      url: null,
      license: 'Internal paper-only rules',
      status: 'Forward test; not validated'
    },
    startingBalanceUsd: Number(config.startingBalanceUsd || 50000),
    maxAccountDrawdownPercent: Number(config.maxAccountDrawdownPercent || 10),
    createdAt: now,
    experimentFingerprint: experimentFingerprint(recommendation),
    experiment: {
      catalogId: recommendation.catalogId,
      dimension: recommendation.dimension,
      blockedValue: recommendation.blockedValue,
      rationale: recommendation.rationale,
      evidence: recommendation.evidence,
      rulesFrozen: true,
      paperOnly: true,
      minimumForwardTrades: Number(recommendation.controls?.minimumForwardTrades || 20),
      createdFromLearningVersion: Number(learning.version || 0),
      createdAt: now
    }
  };
}

function initialState(account) {
  return {
    startingBalanceUsd: account.startingBalanceUsd,
    balanceUsd: account.startingBalanceUsd,
    realizedPnlUsd: 0,
    trades: [],
    lastUpdatedAt: account.createdAt,
    challenger: {
      parentStrategySlug: account.parentStrategySlug,
      experimentFingerprint: account.experimentFingerprint,
      experiment: account.experiment
    },
    live: {
      openSignalKey: null,
      openPlan: null,
      openTriggeredAt: null,
      signalHistory: [],
      heartbeat: null,
      adaptive: null,
      portfolioRisk: null,
      researchContext: null,
      researchCouncil: null
    }
  };
}

function synchronizeChallengerAccount({ rootDir, config, learning, parentDefinition, now = new Date().toISOString() }) {
  if (!eligibleRecommendation(learning, parentDefinition)) {
    return { state: 'not-eligible', checkedAt: now };
  }

  const lock = acquireLock(rootDir);
  if (!lock) return { state: 'busy', checkedAt: now };
  try {
    const manifest = readChallengerManifest(rootDir);
    const recommendation = learning.experimentRecommendation;
    const fingerprint = experimentFingerprint(recommendation);
    const existing = manifest.accounts.find((account) => account.experimentFingerprint === fingerprint);
    if (existing) {
      return { state: 'exists', checkedAt: now, accountSlug: existing.slug, accountLabel: existing.paperAccountLabel };
    }
    const parentAccounts = manifest.accounts.filter((account) => account.parentStrategySlug === parentDefinition.slug);
    if (parentAccounts.length >= MAX_CHALLENGERS_PER_PARENT) {
      return {
        state: 'parent-cap-reached',
        checkedAt: now,
        maximum: MAX_CHALLENGERS_PER_PARENT,
        reason: 'The parent strategy already has the maximum number of automatic challengers.'
      };
    }

    const account = buildAccount({
      config,
      learning,
      parentDefinition,
      recommendation,
      sequence: manifest.accounts.length + 1,
      now
    });
    const statePath = path.join(rootDir, `state-${account.slug}.json`);
    if (!fs.existsSync(statePath)) {
      fs.writeFileSync(statePath, JSON.stringify(initialState(account), null, 2) + '\n', { flag: 'wx' });
    }
    const nextManifest = {
      version: MANIFEST_VERSION,
      updatedAt: now,
      accounts: [...manifest.accounts, account]
    };
    writeJsonAtomic(manifestPath(rootDir), nextManifest);
    return {
      state: 'created',
      checkedAt: now,
      accountSlug: account.slug,
      accountLabel: account.paperAccountLabel,
      startingBalanceUsd: account.startingBalanceUsd,
      maxAccountDrawdownPercent: account.maxAccountDrawdownPercent,
      experiment: account.experiment
    };
  } finally {
    releaseLock(lock);
  }
}

function applyChallengerExperiment(signal, config, adaptiveDecision) {
  const experiment = config?.challengerExperiment;
  if (!signal?.found || !experiment) return signal;
  const observedValue = experiment.dimension === 'market-regime'
    ? String(adaptiveDecision?.market?.regime || '')
    : experiment.dimension === 'side'
      ? String(signal?.setup?.side || '').toLowerCase()
      : '';
  if (observedValue !== String(experiment.blockedValue || '')) return signal;
  return {
    ...signal,
    found: false,
    reason: `Challenger filter rejected the parent signal: ${experiment.dimension.replaceAll('-', ' ')} is ${observedValue.replaceAll('-', ' ')}.`,
    metadata: {
      ...(signal.metadata || {}),
      challengerExperiment: {
        catalogId: experiment.catalogId,
        dimension: experiment.dimension,
        blockedValue: experiment.blockedValue,
        decision: 'rejected'
      }
    }
  };
}

module.exports = {
  EXECUTABLE_CATALOG,
  applyChallengerExperiment,
  challengerSlug,
  experimentFingerprint,
  manifestPath,
  readChallengerManifest,
  synchronizeChallengerAccount
};
