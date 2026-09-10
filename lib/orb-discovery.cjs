const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { summary } = require('./backtest-validation.cjs');
const BASE = 'nq-15m-orb-close-confirmation';
const VERSION = 'orb-discovery-v1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Finite, preregistered one-factor experiments. No executable model output.
const CATALOG = [
  ['time-1014', 'Confirm after 10:14', { earliestConfirmationEnd: '10:14' }],
  ['body-60', 'Minimum body 60%', { minimumBodyFraction: 0.6 }],
  ['volume-10', 'Relative volume at least 1.0', { useRelativeVolume: true, minimumRelativeVolume: 1 }],
  ['target-1r', 'Exit at 1R', { targetMultiples: [1] }],
  ['time-1029', 'Confirm after 10:29', { earliestConfirmationEnd: '10:29' }],
  ['body-70', 'Minimum body 70%', { minimumBodyFraction: 0.7 }],
  ['volume-15', 'Relative volume at least 1.5', { useRelativeVolume: true, minimumRelativeVolume: 1.5 }],
  ['target-2r', 'Exit at 2R', { targetMultiples: [2] }],
  ['time-1059', 'Confirm by 10:59', { latestConfirmationEnd: '10:59' }],
  ['body-80', 'Minimum body 80%', { minimumBodyFraction: 0.8 }],
  ['range-atr', 'Opening range 10–20% of prior ATR', { useAtr: true, minimumOpeningAtrRatio: 0.1, maximumOpeningAtrRatio: 0.2 }],
  ['target-3r', 'Exit at 3R', { targetMultiples: [3] }]
].map(([key, name, rules]) => ({ key, name, rules }));
function implementationHash() {
  return hash(['live-trader.cjs', 'trader-core.cjs', 'backtest-engine.cjs', 'orb-forward.cjs', 'orb-session.cjs', 'strategy-registry.cjs']
    .map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')));
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file);
}
function validate(trades, baseline, provenance, config) {
  const issues = [];
  const validTrade = t => t.status === 'closed' && Number.isFinite(t.realizedPnlUsd) && t.contracts === 1
    && /^202[56]-\d{2}-\d{2}$/.test(t.date || '') && (!t.dataQuality || t.dataQuality === 'complete');
  if (![...trades, ...baseline].every(validTrade)) issues.push('Invalid, open, or gap-affected trade evidence.');
  if (provenance.coverage?.complete !== true) issues.push('Incomplete cash-session candle coverage.');
  const cost = Number(config.commissionPerContractUsd) + 2 * Number(config.slippageTicks) * Number(config.tickValueUsd);
  if (!Number.isFinite(cost) || cost < 0 || !(config.tickValueUsd > 0)) issues.push('Execution costs unavailable.');
  const train = trades.filter(t => t.date < '2026-01-01');
  const test = trades.filter(t => t.date >= '2026-01-01');
  const reference = baseline.filter(t => t.date >= '2026-01-01');
  const training = summary(train), testing = summary(test), stress = summary(test, cost), comparison = summary(reference);
  if (training.trades < 50 || testing.trades < 20) issues.push('Need 50 training and 20 chronological test trades.');
  if (!(training.expectancyUsd > 0 && testing.expectancyUsd > 0 && stress.expectancyUsd > 0)) issues.push('Training, test, and doubled-cost expectancy must be positive.');
  if (!(testing.profitFactor === null && testing.netPnlUsd > 0) && !(testing.profitFactor >= 1.2)) issues.push('Test profit factor below 1.2.');
  if (!(testing.netPnlUsd > comparison.netPnlUsd)) issues.push('Does not improve test-period net P&L over the unchanged baseline.');
  return { status: issues.length ? 'rejected' : 'paper-candidate', issues, training, testing, doubledCosts: stress,
    baselineTest: comparison, improvementUsd: Math.round((testing.netPnlUsd - comparison.netPnlUsd) * 100) / 100 };
}
function monitor(accounts = []) {
  return accounts.map(a => {
    const complete = (a.trades || []).filter(t => t.dataQuality === 'complete');
    const recent = summary(complete.slice(-20));
    return { slug: a.slug, verifiedTrades: complete.length, gapTrades: (a.trades || []).length - complete.length,
      recent, status: complete.length < 20 ? 'collecting-evidence' : recent.expectancyUsd <= 0 ? 'deterioration-review' : 'positive-recent-expectancy' };
  });
}
function runDailyUnlocked({ root, candles, config, report, now = new Date(), onProgress, runStrategy, context }) {
  const file = path.join(root, 'runtime/orb-discovery/ledger.json');
  const day = now.toISOString().slice(0, 10);
  const code = implementationHash();
  const configHash = hash(config);
  let ledger;
  if (fs.existsSync(file)) ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    ledger = { version: VERSION, createdAt: now.toISOString(), configHash, implementationHash: code,
      catalog: CATALOG, trials: [], days: {} };
    atomic(file, ledger); // Register the full search space before seeing results.
  }
  if (ledger.version !== VERSION || ledger.configHash !== configHash || ledger.implementationHash !== code) {
    return { ...ledger, status: 'rules-changed-review-required', message: 'Research code or configuration changed. Existing evidence and paper accounts retained. Review before starting a new research generation.' };
  }
  const baseline = report.strategies.find(s => s.slug === BASE)?.research?.trades;
  if (!baseline) return { ...ledger, status: 'waiting-for-baseline' };
  const evaluate = runStrategy || require('./backtest-engine.cjs').runStrategyBacktest;
  const orbResearchContext = context || require('./live-trader.cjs').prepareOrbResearchContext(candles);
  const usedToday = ledger.days[day] || [];
  const pending = ledger.catalog.filter(c => !ledger.trials.some(t => t.key === c.key)).slice(0, Math.max(0, 4 - usedToday.length));
  for (const candidate of pending) {
    const id = hash({ version: VERSION, code, configHash, rules: candidate.rules }).slice(0, 16);
    const trial = { ...candidate, id, slug: `orb-discovery-${candidate.key}-${id.slice(0, 6)}`, baseSlug: BASE,
      registeredAt: ledger.createdAt, testedAt: now.toISOString(), window: report.window,
      implementationHash: code, dataFingerprint: report.provenance.dataFingerprint, status: 'testing' };
    ledger.trials.push(trial); usedToday.push(candidate.key); ledger.days[day] = usedToday;
    atomic(file, ledger); // Interrupted work remains visible and is not silently retried/tuned.
    onProgress?.({ phase: 'orb-discovery', candidate: candidate.name, completedToday: usedToday.length - 1, limit: 4 });
    try {
      const frozenConfig = { ...config, orbExperimentRules: candidate.rules };
      const result = evaluate(candles, { ...frozenConfig, orbResearchContext }, { slug: BASE, name: candidate.name });
      const verdict = validate(result.research.trades, baseline, report.provenance, config);
      const evidenceKey = list => hash(list.map(t => [t.date, t.side, t.entry, t.finalExitPrice, t.realizedPnlUsd]));
      const duplicate = result.research.trades.length && report.strategies.find(s => s.slug !== BASE
        && s.slug.startsWith('nq-15m-orb-') && s.forwardPaperEligible !== false
        && evidenceKey(s.research?.trades || []) === evidenceKey(result.research.trades));
      if (duplicate) {
        verdict.status = 'existing-paper-variant';
        verdict.issues.push(`Matches the existing ${duplicate.slug} history; no duplicate paper account created.`);
      }
      Object.assign(trial, verdict);
      atomic(path.join(root, `runtime/orb-discovery/trials/${id}.json`), { ...trial, frozenConfig,
        provenance: report.provenance, result });
      if (verdict.status === 'paper-candidate') trial.frozenConfig = frozenConfig;
    } catch (error) { trial.status = 'failed'; trial.issues = [error.message]; }
    atomic(file, ledger);
  }
  const eligible = ledger.trials.filter(t => t.status === 'paper-candidate').slice(0, 4);
  atomic(path.join(root, 'runtime/orb-discovery/paper-candidates.json'), eligible);
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(path.join(root, 'runtime/orb-forward/state.json'))).accounts; } catch { /* No forward evidence yet. */ }
  const output = { version: VERSION, generatedAt: now.toISOString(), status: ledger.trials.length === CATALOG.length ? 'catalog-complete' : 'daily-research',
    label: 'Retrospective research: 2025 training / 2026 chronological test. Both periods have informed prior development. No untouched holdout or calibrated confidence claim.',
    trialsRegistered: CATALOG.length, dailyLimit: 4, remaining: CATALOG.length - ledger.trials.length,
    testedToday: usedToday.length, paperCandidateLimit: 4, livePromotionAllowed: false,
    trials: ledger.trials.map(t => { const copy = { ...t, paperSelected: eligible.some(e => e.id === t.id) }; delete copy.frozenConfig; return copy; }),
    monitoring: monitor(accounts) };
  atomic(path.join(root, `runtime/orb-discovery/reports/${day}.json`), output);
  return output;
}
function runDaily(options) {
  const dir = path.join(options.root, 'runtime/orb-discovery');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'run.lock');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { status: 'locked-review-required', message: 'Another discovery run holds the lock. If it crashed, verify its process is stopped before removing runtime/orb-discovery/run.lock.' };
  }
  try { return runDailyUnlocked(options); }
  finally { fs.unlinkSync(lock); }
}
module.exports = { CATALOG, VERSION, implementationHash, validate, monitor, runDaily };
