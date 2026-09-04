const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const core = require('../lib/trader-core.cjs');
const {
  detectEmaMomentumSignal,
  detectOpeningRangeBreakoutSignal,
  detectOpeningRangeRetestSignal,
  computeAmdContext,
  detectSignalFromCandles,
  detectVolumePocReversionSignal,
  fetchLiveCandles,
  normalizeStrategyConfig,
  saveLiveState
} = require('../lib/live-trader.cjs');
const { parseLiveStatus, sanitizeRemoteSnapshot, summarizeJournal } = require('../lib/live-status.cjs');
const { formatTelegramAlert, getTelegramConfig, sendTelegramAlert } = require('../lib/telegram-alerts.cjs');
const { applyAdaptiveRisk, evaluateAdaptiveBots } = require('../lib/adaptive-bots.cjs');
const { synchronizeStrategyLearning } = require('../lib/strategy-learning.cjs');
const { evaluateStrategyJournal } = require('../lib/strategy-evaluation.cjs');
const { getPortfolioRiskSnapshot, reservePortfolioRisk } = require('../lib/portfolio-risk.cjs');
const { applyRiskDecision, buildResearchCouncilReview } = require('../lib/research-council.cjs');
const { STRATEGIES, runtimeFilesForStrategy } = require('../lib/strategy-registry.cjs');
const {
  auditCandles,
  auditResearchTrades,
  buildResearchLab,
  performanceMetrics,
  reviewEvidence,
  reviewBacktestEvidence,
  splitChronologically
} = require('../lib/research-lab.cjs');
const { checkpointsForDay, runStrategyBacktest } = require('../lib/backtest-engine.cjs');
const { historicalWindow, parseDatabentoJson } = require('../lib/historical-data.cjs');
const { getCachedBacktest, remoteBacktestResultUrls, remoteBacktestUrls } = require('../lib/backtest-service.cjs');

const root = path.join(__dirname, '..');

function researchTrades(count, pnlForIndex = (index) => index % 2 === 0 ? 100 : -50) {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.UTC(2026, 0, index + 1, 15));
    return {
      id: `research-${index + 1}`,
      date: at.toISOString().slice(0, 10),
      createdAt: at.toISOString(),
      realizedPnlUsd: pnlForIndex(index),
      rMultiple: pnlForIndex(index) / 100,
      side: index % 2 ? 'short' : 'long',
      session: 'New York',
      exitReason: pnlForIndex(index) > 0 ? 'target' : 'stop'
    };
  });
}

test('research lab uses an ordered 70/30 split and computes auditable metrics', () => {
  const trades = researchTrades(60);
  const split = splitChronologically([...trades].reverse());
  const metrics = performanceMetrics(trades);

  assert.equal(split.training.length, 42);
  assert.equal(split.holdout.length, 18);
  assert.equal(split.training[0].id, 'research-1');
  assert.equal(split.holdout[0].id, 'research-43');
  assert.equal(metrics.trades, 60);
  assert.equal(metrics.winRate, 50);
  assert.equal(metrics.netPnlUsd, 1500);
  assert.equal(metrics.profitFactor, 2);
  assert.equal(metrics.expectancyUsd, 25);
});

test('research reviewer promotes positive holdout evidence and rejects failed holdouts', () => {
  const candidate = reviewEvidence(researchTrades(60));
  const failedHoldout = reviewEvidence(researchTrades(60, (index) => index < 42 ? 100 : -100));

  assert.equal(candidate.verdict, 'PAPER CANDIDATE');
  assert.equal(candidate.gates.lockedHoldout, true);
  assert.equal(candidate.holdout.trades, 18);
  assert.equal(failedHoldout.verdict, 'REJECT');
  assert.ok(failedHoldout.redFlags.includes('Locked holdout expectancy is not positive.'));
});

test('research data audits catch malformed trades and candle gaps', () => {
  const tradeAudit = auditResearchTrades([
    { id: 'duplicate', date: '2026-01-01', realizedPnlUsd: 10 },
    { id: 'duplicate', date: 'not-a-date', realizedPnlUsd: 'missing' }
  ]);
  const candleAudit = auditCandles([
    { timestamp: '2026-01-01T14:00:00.000Z', open: 100, high: 102, low: 99, close: 101 },
    { timestamp: '2026-01-01T14:03:00.000Z', open: 101, high: 103, low: 100, close: 102 }
  ]);

  assert.equal(tradeAudit.ok, false);
  assert.equal(tradeAudit.errors, 3);
  assert.equal(candleAudit.ok, true);
  assert.equal(candleAudit.warnings, 1);
  assert.equal(candleAudit.issues[0].code, 'time-gap');
});

test('research lab reads closed journal entries without altering live strategy state', () => {
  const trades = researchTrades(2);
  const snapshot = {
    source: 'test',
    strategies: [{
      slug: STRATEGIES[0].slug,
      name: STRATEGIES[0].name,
      strategyFamilyName: STRATEGIES[0].strategyFamilyName,
      journal: { dailyRecaps: [{ date: trades[0].date, tradesList: trades }] },
      live: { activeTrade: { status: 'open', unrealizedPnlUsd: 250 } }
    }]
  };
  const before = structuredClone(snapshot);
  const lab = buildResearchLab(snapshot);

  assert.equal(lab.summary.closedTrades, 2);
  assert.equal(lab.reports[0].review.execution, 'paper-only');
  assert.deepEqual(snapshot, before);
});

test('Databento historical records normalize fixed prices and timestamps', () => {
  const candles = parseDatabentoJson([
    JSON.stringify({ hd: { ts_event: '1788445800000000000', instrument_id: 42004177 }, open: '29343000000000', high: '29360500000000', low: '29338750000000', close: '29356000000000', volume: '1427' }),
    JSON.stringify({ ts_event: '2026-08-01T14:31:00.000Z', open: 23000.5, high: 23002, low: 23000, close: 23001.5, volume: 12, instrument_id: 42 })
  ].join('\n'));

  assert.equal(candles.length, 2);
  assert.equal(candles[0].close, 23001.5);
  assert.equal(candles[1].timestamp, '2026-09-03T14:30:00.000Z');
  assert.equal(candles[1].open, 29343);
  assert.equal(candles[1].instrumentId, 42004177);
});

test('historical backtest window defaults to the prior 60 calendar days', () => {
  const window = historicalWindow(60, new Date('2026-09-04T12:34:56.000Z'));
  assert.equal(window.days, 60);
  assert.equal(window.end, '2026-09-04T12:14:00.000Z');
  assert.equal(window.start, '2026-07-06T12:14:00.000Z');
});

test('remote backtest URL derives from the existing private live bridge', () => {
  assert.deepEqual(remoteBacktestUrls({ LIVE_STATUS_SOURCE_URL: 'https://private.example/api/live-status' }), ['https://private.example/api/backtest']);
  assert.deepEqual(remoteBacktestResultUrls({ LIVE_STATUS_SOURCE_URL: 'https://private.example/api/live-status' }), ['https://private.example/api/backtest-results']);
});

test('cached backtest results use the existing private bridge token', async () => {
  let request;
  const result = await getCachedBacktest({
    env: {
      LIVE_STATUS_SOURCE_URL: 'https://private.example/api/live-status',
      LIVE_STATUS_TOKEN: 'private-token'
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ ok: true, result: { evidenceClass: 'historical-simulated' } }) };
    }
  });

  assert.equal(request.url, 'https://private.example/api/backtest-results');
  assert.equal(request.options.headers.authorization, 'Bearer private-token');
  assert.equal(result.evidenceClass, 'historical-simulated');
});

test('historical strategies are evaluated inside their actual entry windows', () => {
  const records = Array.from({ length: 961 }, (_, minute) => ({ minute }));
  const retest = checkpointsForDay('nq-15m-opening-range-retest', records).map((record) => record.minute);
  const breakout = checkpointsForDay('nq-opening-range-breakout', records).map((record) => record.minute);
  const nineAm = checkpointsForDay('live-9am-sweep', records).map((record) => record.minute);

  assert.equal(retest[0], 585);
  assert.equal(retest.at(-1), 690);
  assert.equal(breakout[0], 660);
  assert.equal(breakout.at(-1), 930);
  assert.equal(nineAm[0], 540);
  assert.equal(nineAm.at(-1), 960);
});

test('60-day backtest fills only after the signal candle and reaches its separate 50-trade gate', () => {
  const candles = [];
  for (let day = 0; day < 60; day += 1) {
    const first = new Date(Date.UTC(2026, 0, day + 1, 15, 0));
    const second = new Date(first.getTime() + 60_000);
    candles.push({ timestamp: first.toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 });
    candles.push({ timestamp: second.toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 });
  }
  const config = core.normalizeConfig(core.loadJson(path.join(root, 'config.json')));
  let sequence = 0;
  const definition = { slug: 'test-strategy', name: 'Test strategy', strategyFamily: 'test', strategyFamilyName: 'Test' };
  const result = runStrategyBacktest(candles, config, definition, {
    detectSignal(context) {
      const trigger = context.at(-2);
      const date = trigger.timestamp.slice(0, 10);
      return {
        found: true,
        triggerTimestamp: trigger.timestamp,
        sweepTimestamp: trigger.timestamp,
        setup: { symbol: 'NQ', date, session: 'Test', side: 'long', entry: 100, stop: 99, targets: [101], thesis: 'test', setup: {} }
      };
    },
    buildPlan(signal) {
      return { setup: signal.setup, sizing: { maxContracts: 1, actualRiskUsd: 100 }, targets: [], triggerTimestamp: signal.triggerTimestamp };
    },
    replay(plan, future) {
      assert.ok(future.every((candle) => Date.parse(candle.timestamp) > Date.parse(plan.triggerTimestamp)));
      const pnl = sequence % 2 === 0 ? 100 : -50;
      sequence += 1;
      return { status: 'closed', contracts: 1, filledAt: future[0].timestamp, exitReason: pnl > 0 ? 'target' : 'stop-loss', finalExitPrice: 100, realizedPnlUsd: pnl, rMultiple: pnl / 100, targetsHit: [], mfePoints: 1, maePoints: 1, mfeUsd: 20, maeUsd: -20 };
    }
  });

  assert.equal(result.trades.length, 60);
  assert.equal(result.review.recommendation, 'ADVANCE TO FORWARD TEST');
  assert.equal(result.review.evidenceType, 'historical-simulated');
  assert.ok(result.trades.every((trade) => trade.evidenceType === 'historical-simulated'));
});

test('historical recommendations never use the forward-paper promotion label', () => {
  const review = reviewBacktestEvidence(researchTrades(60));
  assert.equal(review.recommendation, 'ADVANCE TO FORWARD TEST');
  assert.notEqual(review.recommendation, 'PAPER CANDIDATE');
});

test('sample setup builds and replays through the shared trading engine', () => {
  const config = core.normalizeConfig(core.loadJson(path.join(root, 'config.json')));
  const setup = core.normalizeSetup(core.loadJson(path.join(root, 'examples', 'lucid-sweep-short.setup.json')), config);
  const validation = core.validateSetup(setup, config);
  assert.equal(validation.valid, true, validation.errors.join('\n'));

  const plan = core.buildTradePlan(setup, config, core.createEmptyState(config));
  const candles = core.parseCsvFile(path.join(root, 'examples', 'sample-nq-1m.csv'));
  const replay = core.replayPlan(plan, candles, config);

  assert.ok(plan.sizing.maxContracts > 0);
  assert.ok(Number.isFinite(replay.realizedPnlUsd));
  assert.ok(replay.mfePoints >= 0);
  assert.ok(replay.maePoints >= 0);
  assert.ok(replay.mfeUsd >= 0);
  assert.ok(replay.maeUsd <= 0);
  assert.ok(['closed', 'open', 'not-filled'].includes(replay.status));
});

test('live log parser returns the latest candle and reason', () => {
  const status = parseLiveStatus([
    '[2026-08-28T14:01:00.000Z] live tick',
    'Feed: databento NQ.v.0',
    'Last candle: 2026-08-28T14:00:00Z O:20000 H:20005 L:19995 C:20002',
    'No trade: Waiting for a qualifying sweep'
  ].join('\n'));

  assert.equal(status.lastCandle.close, 20002);
  assert.equal(status.latestReason, 'Waiting for a qualifying sweep');
  assert.equal(status.latestError, null);
});

test('daily summaries preserve per-day PnL and detailed trades', () => {
  const state = {
    balanceUsd: 50_075,
    realizedPnlUsd: 75,
    trades: [
      { id: 'a', date: '2026-08-27', realizedPnlUsd: -25, rMultiple: -1 },
      { id: 'b', date: '2026-08-28', realizedPnlUsd: 100, rMultiple: 2 }
    ],
    live: {}
  };
  const summary = summarizeJournal(state, {
    lastCandle: { timestamp: '2026-08-28T14:00:00Z' },
    activeTrade: null
  });

  assert.equal(summary.daily.date, '2026-08-28');
  assert.equal(summary.daily.realizedPnlUsd, 100);
  assert.equal(summary.dailyRecaps.length, 2);
  assert.equal(summary.dailyRecaps[0].tradesList[0].id, 'b');
});

test('live state writes atomically without leaving temporary files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctortrades-'));
  const statePath = path.join(directory, 'state.json');
  saveLiveState(statePath, { balanceUsd: 50_000, live: { heartbeat: { ok: true } } });

  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).live.heartbeat.ok, true);
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('remote snapshots do not expose bridge URLs or private watcher commands', () => {
  const snapshot = sanitizeRemoteSnapshot({
    remoteUrl: 'https://secret.example/status',
    error: 'private bridge detail',
    strategies: [{
      live: {
        latestError: {
          at: '2026-08-29T12:00:00.000Z',
          message: 'python3 /private/path/fetch.py --key-env DATABENTO_API_KEY'
        }
      }
    }]
  });

  assert.equal(snapshot.remoteUrl, undefined);
  assert.equal(snapshot.error, undefined);
  assert.equal(snapshot.strategies[0].live.latestError.at, '2026-08-29T12:00:00.000Z');
  assert.equal(
    snapshot.strategies[0].live.latestError.message,
    'Live data refresh failed. Check the private watcher logs on the VPS.'
  );
});

test('operator sessions use a server-only derived cookie and accept bearer access', async () => {
  const originalToken = process.env.TRADING_ADMIN_TOKEN;
  process.env.TRADING_ADMIN_TOKEN = 'test-operator-token-with-adequate-length';
  try {
    const auth = await import('../lib/operator-auth.mjs');
    const session = auth.operatorSessionValue();
    assert.ok(session);
    assert.notEqual(session, process.env.TRADING_ADMIN_TOKEN);
    assert.equal(auth.verifyOperatorPasscode(process.env.TRADING_ADMIN_TOKEN), true);
    assert.equal(auth.verifyOperatorPasscode('wrong-token'), false);
    assert.equal(auth.isOperatorRequest({
      headers: new Headers({ authorization: `Bearer ${process.env.TRADING_ADMIN_TOKEN}` }),
      cookies: { get: () => undefined }
    }), true);
    assert.equal(auth.isTrustedMutationOrigin({
      url: 'http://localhost:3000/api/operator-session',
      headers: new Headers({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' })
    }), true);
  } finally {
    if (originalToken === undefined) delete process.env.TRADING_ADMIN_TOKEN;
    else process.env.TRADING_ADMIN_TOKEN = originalToken;
  }
});

test('cloud journal validation rejects malformed and oversized batches before database access', async () => {
  const { validateJournalEntries } = await import('../lib/cloud-journal.mjs');
  assert.deepEqual(validateJournalEntries([{ id: 'trade-1', date: '2026-08-29' }]), [{ id: 'trade-1', date: '2026-08-29' }]);
  assert.throws(() => validateJournalEntries([{ date: '2026-08-29' }]), /non-empty id/);
  assert.throws(() => validateJournalEntries(Array.from({ length: 251 }, (_, index) => ({ id: String(index) }))), /up to 250/);
});

test('Telegram alerts require a token and destination without exposing either in the message', () => {
  const config = getTelegramConfig({
    TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz_ABCDEF',
    TELEGRAM_CHAT_ID: '-1001234567890'
  });
  const message = formatTelegramAlert({
    type: 'trade-closed',
    status: 'closed',
    strategy: 'live-9am-sweep',
    symbol: 'NQ',
    side: 'long',
    realizedPnlUsd: 125.5,
    rMultiple: 1.25,
    at: '2026-08-29T15:00:00.000Z'
  });

  assert.equal(config.ready, true);
  assert.equal(config.validTokenFormat, true);
  assert.match(message, /paper trade closed/);
  assert.match(message, /Realized P&L: \$125\.50/);
  assert.doesNotMatch(message, /123456789/);
  assert.doesNotMatch(message, /-1001234567890/);
});

test('Telegram sender posts trade events and filters every non-trade event', async () => {
  let request = null;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } })
    };
  };
  const env = {
    TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz_ABCDEF',
    TELEGRAM_CHAT_ID: '987654321'
  };

  const result = await sendTelegramAlert({
    type: 'trade-opened',
    status: 'opened',
    symbol: 'NQ',
    side: 'long',
    entry: 20000,
    stop: 19990
  }, { env, fetchImpl });
  const filtered = await sendTelegramAlert({ type: 'watcher-health' }, {
    env,
    fetchImpl: () => assert.fail('fetch should not be called for watcher-health events')
  });
  const skipped = await sendTelegramAlert({ type: 'trade-closed' }, {
    env: { TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN },
    fetchImpl: () => assert.fail('fetch should not be called without a chat ID')
  });

  assert.equal(result.sent, true);
  assert.equal(result.messageId, 42);
  assert.match(request.url, /\/sendMessage$/);
  assert.deepEqual(JSON.parse(request.options.body).chat_id, '987654321');
  assert.deepEqual(filtered, { sent: false, reason: 'event-filtered' });
  assert.deepEqual(skipped, { sent: false, reason: 'missing-chat-id' });
});

test('Databento watcher accepts only fresh live-stream cache payloads', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctortrades-live-'));
  const cachePath = path.join(directory, 'databento-live.json');
  const timestamp = new Date(Date.now() - 30_000).toISOString();
  fs.writeFileSync(cachePath, JSON.stringify({
    mode: 'live',
    provider: 'databento-live',
    startedAt: timestamp,
    updatedAt: timestamp,
    candles: [{ timestamp, open: 20000, high: 20005, low: 19995, close: 20002, volume: 10 }]
  }));
  const previousKey = process.env.DATABENTO_API_KEY;
  process.env.DATABENTO_API_KEY = 'test-key';
  try {
    const config = { live: { provider: 'databento', liveCachePath: cachePath, maxLiveCandleAgeMinutes: 3 } };
    assert.equal(normalizeStrategyConfig(config).provider, 'databento-live');
    const result = await fetchLiveCandles(config);
    assert.equal(result.metadata.provider, 'databento-live');
    assert.equal(result.candles[0].close, 20002);

    fs.writeFileSync(cachePath, JSON.stringify({
      mode: 'historical',
      provider: 'databento',
      candles: [{ timestamp, open: 1, high: 1, low: 1, close: 1 }]
    }));
    await assert.rejects(() => fetchLiveCandles(config), /not marked as live-stream data/);
  } finally {
    if (previousKey === undefined) delete process.env.DATABENTO_API_KEY;
    else process.env.DATABENTO_API_KEY = previousKey;
  }
});

test('adaptive bots can only hold or reduce paper-trade risk', () => {
  const now = Date.now();
  const candles = Array.from({ length: 180 }, (_, index) => ({
    timestamp: new Date(now - ((179 - index) * 60_000)).toISOString(),
    open: 20000 + index,
    high: 20002 + index,
    low: 19998 + index,
    close: 20001 + index
  }));
  const config = {
    startingBalanceUsd: 50_000,
    maxAccountDrawdownPercent: 10,
    maxRiskPerTradeUsd: 500,
    adaptiveRiskFloorUsd: 250,
    maxDailyLossUsd: 750
  };
  const state = {
    balanceUsd: 49_500,
    trades: [
      { date: '2026-08-28', realizedPnlUsd: -100, rMultiple: -1 },
      { date: '2026-08-29', realizedPnlUsd: -100, rMultiple: -1 }
    ]
  };
  const decision = evaluateAdaptiveBots(candles, config, state);
  const adjusted = applyAdaptiveRisk(config, decision);

  assert.equal(decision.mode, 'paper-only-bounded');
  assert.ok(decision.risk.riskMultiplier >= 0.5);
  assert.ok(decision.risk.riskMultiplier <= 1);
  assert.equal(decision.risk.riskFloorUsd, 250);
  assert.equal(decision.risk.adjustedRiskUsd, 325);
  assert.equal(adjusted.maxRiskPerTradeUsd, 325);
  assert.ok(adjusted.maxRiskPerTradeUsd <= config.maxRiskPerTradeUsd);
  assert.ok(['market-regime', 'performance', 'risk-guard'].every((name) => (
    [decision.market.name, decision.performance.name, decision.risk.name].includes(name)
  )));
});

test('every closed paper trade creates one auditable learning update', () => {
  const firstTwoTrades = [
    { id: 'trade-1', date: '2026-08-28', createdAt: '2026-08-28T15:00:00.000Z', realizedPnlUsd: -100, rMultiple: -1 },
    { id: 'trade-2', date: '2026-08-29', createdAt: '2026-08-29T15:00:00.000Z', realizedPnlUsd: -75, rMultiple: -0.75 }
  ];
  const learned = synchronizeStrategyLearning(firstTwoTrades, {
    strategySlug: 'nq-opening-range-breakout',
    now: '2026-08-29T16:00:00.000Z'
  });

  assert.equal(learned.version, 2);
  assert.equal(learned.tradesLearned, 2);
  assert.equal(learned.changeLog.length, 2);
  assert.equal(learned.lastTradeId, 'trade-2');
  assert.equal(learned.adjustment.riskMultiplier, 0.65);
  assert.equal(learned.controls.entryRulesLocked, true);
  assert.equal(learned.controls.paperOnly, true);
  assert.ok(learned.changeLog.every((event) => event.entryRulesChanged === false));

  const duplicateSync = synchronizeStrategyLearning(firstTwoTrades, {
    previous: learned,
    strategySlug: 'nq-opening-range-breakout',
    now: '2026-08-29T16:01:00.000Z'
  });
  assert.equal(duplicateSync.version, 2);
  assert.equal(duplicateSync.changeLog.length, 2);

  const restored = synchronizeStrategyLearning([
    ...firstTwoTrades,
    { id: 'trade-3', date: '2026-08-30', createdAt: '2026-08-30T15:00:00.000Z', realizedPnlUsd: 250, rMultiple: 2.5 }
  ], {
    previous: duplicateSync,
    strategySlug: 'nq-opening-range-breakout',
    now: '2026-08-30T16:00:00.000Z'
  });
  assert.equal(restored.version, 3);
  assert.equal(restored.changeLog.length, 3);
  assert.equal(restored.changeLog.at(-1).action, 'risk-restored');
  assert.equal(restored.adjustment.riskMultiplier, 1);
});

test('negative rolling expectancy can reduce risk without changing strategy rules', () => {
  const trades = Array.from({ length: 5 }, (_, index) => ({
    id: `negative-${index + 1}`,
    date: `2026-08-${20 + index}`,
    realizedPnlUsd: index % 2 === 0 ? -100 : 50,
    rMultiple: index % 2 === 0 ? -1 : 0.5
  }));
  const learned = synchronizeStrategyLearning(trades, { strategySlug: 'test-strategy' });

  assert.equal(learned.rolling.expectancyUsd, -40);
  assert.equal(learned.adjustment.riskMultiplier, 0.75);
  assert.equal(learned.adjustment.entryRulesChanged, false);
  assert.match(learned.adjustment.reason, /expectancy is negative/);
});

test('strategy registry gives all six bots isolated runtime files and risk families', () => {
  assert.equal(STRATEGIES.length, 6);
  assert.equal(new Set(STRATEGIES.map((strategy) => strategy.slug)).size, 6);
  const paths = STRATEGIES.map((strategy) => runtimeFilesForStrategy(root, strategy.slug).statePath);
  assert.equal(new Set(paths).size, 6);
  assert.ok(paths.some((filePath) => filePath.endsWith('state-nq-opening-range-breakout.json')));
  assert.ok(paths.some((filePath) => filePath.endsWith('state-nq-15m-opening-range-retest.json')));
  assert.ok(STRATEGIES.every((strategy) => strategy.strategyFamily));
  assert.throws(() => runtimeFilesForStrategy(root, 'not-a-strategy'), /Unknown strategy/);
});

test('strategy-family guard prevents correlated paper positions from stacking', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctortrades-family-risk-'));
  const config = {
    maxPortfolioOpenRiskUsd: 2500,
    maxStrategyFamilyOpenRiskUsd: { 'liquidity-reversal': 750 }
  };
  const first = STRATEGIES.find((strategy) => strategy.slug === 'live-9am-sweep');
  const second = STRATEGIES.find((strategy) => strategy.slug === 'hourly-sweep-ifvg-bos');
  fs.writeFileSync(runtimeFilesForStrategy(directory, first.slug).statePath, JSON.stringify({
    live: { openPlan: { sizing: { actualRiskUsd: 500 } } }
  }));

  const blocked = reservePortfolioRisk({
    rootDir: directory,
    config,
    strategySlug: second.slug,
    proposedRiskUsd: 300
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.projectedFamilyRiskUsd, 800);
  assert.match(blocked.reason, /Liquidity reversal family.*above its \$750\.00 cap/);
});

test('Asia/London context records which side London swept without changing entries', () => {
  const sessionRanges = {
    asia: { high: 20_010, low: 19_990, start: '2026-09-02T00:00:00.000Z', end: '2026-09-02T05:59:00.000Z' },
    london: { high: 20_005, low: 19_985, start: '2026-09-02T06:00:00.000Z', end: '2026-09-02T11:59:00.000Z' }
  };
  const context = computeAmdContext([
    { timestamp: '2026-09-02T06:30:00.000Z', high: 20_005, low: 19_985 }
  ], sessionRanges);
  assert.equal(context.classification, 'asia-low-swept');
  assert.equal(context.supportsLong, true);
  assert.equal(context.supportsShort, false);
});

test('hourly watcher reports its daily cap without requiring Asia/London context', () => {
  const config = {
    ...core.loadJson(path.join(root, 'config.json')),
    strategySlug: 'hourly-sweep-ifvg-bos'
  };
  const result = detectSignalFromCandles([
    { timestamp: '2026-09-03T14:00:00.000Z', open: 20_000, high: 20_010, low: 19_990, close: 20_005 }
  ], config, {
    trades: [{ date: '2026-09-03' }]
  });

  assert.equal(result.found, false);
  assert.match(result.reason, /Daily trade cap already reached/);
  assert.equal(result.metadata.tradingDate, '2026-09-03');
});

test('shared portfolio guard caps simultaneous paper risk at $2,500', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctortrades-portfolio-'));
  const config = { maxPortfolioOpenRiskUsd: 2500 };
  for (const strategy of STRATEGIES.slice(0, 4)) {
    const files = runtimeFilesForStrategy(directory, strategy.slug);
    fs.writeFileSync(files.statePath, JSON.stringify({
      live: { openPlan: { sizing: { actualRiskUsd: 500 } } }
    }));
  }

  const before = getPortfolioRiskSnapshot(directory, config);
  assert.equal(before.reservedRiskUsd, 2000);
  assert.equal(before.availableRiskUsd, 500);

  const fifth = STRATEGIES[4];
  const allowed = reservePortfolioRisk({
    rootDir: directory,
    config,
    strategySlug: fifth.slug,
    proposedRiskUsd: 500,
    commit: () => {
      fs.writeFileSync(runtimeFilesForStrategy(directory, fifth.slug).statePath, JSON.stringify({
        live: { openPlan: { sizing: { actualRiskUsd: 500 } } }
      }));
    }
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.projectedRiskUsd, 2500);

  const atCap = getPortfolioRiskSnapshot(directory, config);
  assert.equal(atCap.status, 'cap-reached');
  assert.equal(atCap.availableRiskUsd, 0);

  const blocked = reservePortfolioRisk({
    rootDir: directory,
    config,
    strategySlug: STRATEGIES[0].slug,
    proposedRiskUsd: 100
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /already holds a \$500\.00 paper-risk reservation/);

  fs.unlinkSync(runtimeFilesForStrategy(directory, fifth.slug).statePath);
  const overCap = reservePortfolioRisk({
    rootDir: directory,
    config,
    strategySlug: fifth.slug,
    proposedRiskUsd: 600
  });
  assert.equal(overCap.allowed, false);
  assert.match(overCap.reason, /above the \$2500\.00 cap/);
});

test('opening-range bot detects a fresh 90-minute NQ cash-session breakout', () => {
  const config = core.normalizeConfig(core.loadJson(path.join(root, 'config.json')));
  const start = Date.parse('2026-09-02T13:30:00.000Z');
  const candles = Array.from({ length: 90 }, (_, index) => ({
    timestamp: new Date(start + (index * 60_000)).toISOString(),
    open: 20_000,
    high: 20_010,
    low: 19_990,
    close: 20_000,
    volume: 100
  }));
  candles.push({ timestamp: '2026-09-02T15:00:00.000Z', open: 20_000, high: 20_005, low: 19_998, close: 20_001, volume: 100 });
  candles.push({ timestamp: '2026-09-02T15:01:00.000Z', open: 20_001, high: 20_014, low: 20_000, close: 20_012, volume: 140 });

  const signal = detectOpeningRangeBreakoutSignal(candles, { ...config, strategySlug: 'nq-opening-range-breakout' }, { trades: [] });
  assert.equal(signal.found, true);
  assert.equal(signal.setup.side, 'long');
  assert.equal(signal.setup.setup.entryModel, 'opening-range-breakout');
  assert.equal(core.validateSetup(core.normalizeSetup(signal.setup, config), config).valid, true);
  const plan = core.buildTradePlan(core.normalizeSetup(signal.setup, config), config, core.createEmptyState(config));
  assert.ok(plan.sizing.actualRiskUsd <= 500);
});

test('15-minute opening-range bot waits for a break, retest, and aligned order flow', () => {
  const config = core.normalizeConfig(core.loadJson(path.join(root, 'config.json')));
  const candles = [];
  const premarketStart = Date.parse('2026-09-02T11:30:00.000Z');
  for (let index = 0; index < 120; index += 1) {
    const close = 19_980 + (index * 0.1);
    candles.push({
      timestamp: new Date(premarketStart + (index * 60_000)).toISOString(),
      open: close - 0.1,
      high: close + 0.4,
      low: close - 0.4,
      close,
      volume: 100
    });
  }
  const openStart = Date.parse('2026-09-02T13:30:00.000Z');
  for (let index = 0; index < 15; index += 1) {
    candles.push({
      timestamp: new Date(openStart + (index * 60_000)).toISOString(),
      open: 20_000,
      high: 20_010,
      low: 19_990,
      close: 20_000,
      volume: 120
    });
  }
  candles.push({ timestamp: '2026-09-02T13:45:00.000Z', open: 20_009, high: 20_013, low: 20_008, close: 20_012, volume: 180 });
  candles.push({ timestamp: '2026-09-02T13:46:00.000Z', open: 20_012, high: 20_012.5, low: 20_009.75, close: 20_011, volume: 150 });

  const signal = detectOpeningRangeRetestSignal(candles, { ...config, strategySlug: 'nq-15m-opening-range-retest' }, { trades: [] });
  assert.equal(signal.found, true, signal.reason);
  assert.equal(signal.setup.side, 'long');
  assert.equal(signal.setup.setup.entryModel, 'opening-range-breakout-retest');
  assert.equal(signal.metadata.retestBars, 1);
  assert.equal(signal.metadata.orderFlow.aligned, true);
  assert.equal(core.validateSetup(core.normalizeSetup(signal.setup, config), config).valid, true);
});

test('research council remains advisory and records a deterministic risk veto', () => {
  const review = buildResearchCouncilReview({
    signal: { found: true, setup: { side: 'long', setup: { entryModel: 'opening-range-breakout-retest' } }, metadata: {} },
    adaptiveDecision: {
      market: { status: 'active', reason: 'Balanced market.' },
      risk: { allowed: true, reason: 'Clear.' },
      learning: { tradesLearned: 0 }
    },
    feedMetadata: { provider: 'databento-live', ticker: 'NQ.v.0' }
  });
  const vetoed = applyRiskDecision(review, { allowed: false, reason: 'Family risk cap reached.' });
  assert.equal(vetoed.canPlaceTrades, false);
  assert.equal(vetoed.canIncreaseRisk, false);
  assert.equal(vetoed.roles.find((item) => item.name === 'Risk veto').status, 'vetoed');
});

test('EMA bot detects a completed 15-minute 20/60 bullish crossover', () => {
  const config = core.normalizeConfig(core.loadJson(path.join(root, 'config.json')));
  const start = Date.parse('2026-09-01T22:45:00.000Z');
  const candles = [];
  for (let bar = 0; bar < 62; bar += 1) {
    const close = bar === 61 ? 20_010 : 20_000;
    for (let minute = 0; minute < 15; minute += 1) {
      candles.push({
        timestamp: new Date(start + (((bar * 15) + minute) * 60_000)).toISOString(),
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 100
      });
    }
  }

  const signal = detectEmaMomentumSignal(candles, { ...config, strategySlug: 'ema-20-60-momentum' }, { trades: [] });
  assert.equal(signal.found, true);
  assert.equal(signal.setup.side, 'long');
  assert.equal(signal.setup.setup.entryTimeframe, 'M15');
  assert.equal(core.validateSetup(core.normalizeSetup(signal.setup, config), config).valid, true);
});

test('volume POC bot requires both distance and high-volume exhaustion', () => {
  const config = core.normalizeConfig(core.loadJson(path.join(root, 'config.json')));
  const start = Date.parse('2026-09-02T13:30:00.000Z');
  const candles = Array.from({ length: 60 }, (_, index) => ({
    timestamp: new Date(start + (index * 60_000)).toISOString(),
    open: 20_000,
    high: 20_001,
    low: 19_999,
    close: 20_000,
    volume: 100
  }));
  candles.push({
    timestamp: '2026-09-02T14:30:00.000Z',
    open: 20_010,
    high: 20_015,
    low: 20_008,
    close: 20_009,
    volume: 200
  });

  const signal = detectVolumePocReversionSignal(candles, { ...config, strategySlug: 'volume-poc-reversion' }, { trades: [] });
  assert.equal(signal.found, true);
  assert.equal(signal.setup.side, 'short');
  assert.equal(signal.metadata.poc, 20_000);
  assert.ok(signal.metadata.volumeRatio > 1.3);
  assert.equal(core.validateSetup(core.normalizeSetup(signal.setup, config), config).valid, true);
});

test('research scorecard only promotes a strategy after every paper gate passes', () => {
  const trades = Array.from({ length: 50 }, (_, index) => ({
    date: `2026-08-${String((index % 25) + 1).padStart(2, '0')}`,
    realizedPnlUsd: index % 5 === 0 ? -100 : 100,
    rMultiple: index % 5 === 0 ? -1 : 1
  }));
  const evaluation = evaluateStrategyJournal({ trades });
  assert.equal(evaluation.status, 'Paper candidate');
  assert.equal(evaluation.passedGates, evaluation.totalGates);
  assert.equal(evaluation.execution, 'paper-only');
});
