const fs = require('fs');
const path = require('path');

const { STRATEGIES, runtimeFilesForStrategy } = require('./strategy-registry.cjs');

const LOCK_MAX_AGE_MS = 30_000;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function planRiskUsd(plan) {
  return Math.max(0, Number(plan?.sizing?.actualRiskUsd || 0));
}

function getPortfolioRiskSnapshot(rootDir, config) {
  const capUsd = Math.max(0, Number(config.maxPortfolioOpenRiskUsd || 0));
  const reservations = STRATEGIES.flatMap((strategy) => {
    const files = runtimeFilesForStrategy(rootDir, strategy.slug);
    const state = safeReadJson(files.statePath);
    const openPlan = state?.live?.openPlan;
    const riskUsd = planRiskUsd(openPlan);
    if (!openPlan || riskUsd <= 0) return [];
    return [{
      strategySlug: strategy.slug,
      strategyName: strategy.name,
      paperAccountLabel: strategy.paperAccountLabel,
      riskUsd: round(riskUsd),
      reservedAt: state.live?.openTriggeredAt || null
    }];
  });
  const reservedRiskUsd = round(reservations.reduce((sum, reservation) => sum + reservation.riskUsd, 0));
  const availableRiskUsd = round(Math.max(0, capUsd - reservedRiskUsd));

  return {
    mode: 'paper-only-shared-cap',
    status: reservedRiskUsd >= capUsd ? 'cap-reached' : 'clear',
    capUsd: round(capUsd),
    reservedRiskUsd,
    availableRiskUsd,
    utilizationPercent: capUsd > 0 ? round((reservedRiskUsd / capUsd) * 100, 1) : 100,
    reservations
  };
}

function acquirePortfolioLock(rootDir) {
  const runtimeDir = path.join(rootDir, 'runtime');
  const lockPath = path.join(runtimeDir, 'portfolio-risk.lock');
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

function releasePortfolioLock(lock) {
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

function reservePortfolioRisk({ rootDir, config, strategySlug, proposedRiskUsd, commit }) {
  const proposed = round(Math.max(0, Number(proposedRiskUsd || 0)));
  const lock = acquirePortfolioLock(rootDir);
  if (!lock) {
    return {
      ...getPortfolioRiskSnapshot(rootDir, config),
      allowed: false,
      busy: true,
      proposedRiskUsd: proposed,
      reason: 'Another strategy is reserving paper risk. This signal will be checked again on the next live tick.'
    };
  }

  try {
    const snapshot = getPortfolioRiskSnapshot(rootDir, config);
    const projectedRiskUsd = round(snapshot.reservedRiskUsd + proposed);
    const existingReservation = snapshot.reservations.find(
      (reservation) => reservation.strategySlug === strategySlug
    );
    const allowed = !existingReservation && proposed > 0 && projectedRiskUsd <= snapshot.capUsd;
    const decision = {
      ...snapshot,
      allowed,
      busy: false,
      strategySlug,
      proposedRiskUsd: proposed,
      projectedRiskUsd,
      reason: existingReservation
        ? `${existingReservation.strategyName} already holds a $${existingReservation.riskUsd.toFixed(2)} paper-risk reservation.`
        : allowed
          ? `Shared paper risk remains within the $${snapshot.capUsd.toFixed(2)} portfolio cap.`
          : `Proposed $${proposed.toFixed(2)} risk would raise shared open risk to $${projectedRiskUsd.toFixed(2)}, above the $${snapshot.capUsd.toFixed(2)} cap.`
    };
    if (allowed && typeof commit === 'function') commit(decision);
    return decision;
  } finally {
    releasePortfolioLock(lock);
  }
}

module.exports = {
  getPortfolioRiskSnapshot,
  planRiskUsd,
  reservePortfolioRisk
};
