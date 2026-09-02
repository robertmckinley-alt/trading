const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const core = require('../lib/trader-core.cjs');
const {
  detectEmaMomentumSignal,
  detectOpeningRangeBreakoutSignal,
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
const { STRATEGIES, runtimeFilesForStrategy } = require('../lib/strategy-registry.cjs');

const root = path.join(__dirname, '..');

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

test('strategy registry gives all five bots isolated runtime files', () => {
  assert.equal(STRATEGIES.length, 5);
  assert.equal(new Set(STRATEGIES.map((strategy) => strategy.slug)).size, 5);
  const paths = STRATEGIES.map((strategy) => runtimeFilesForStrategy(root, strategy.slug).statePath);
  assert.equal(new Set(paths).size, 5);
  assert.ok(paths.some((filePath) => filePath.endsWith('state-nq-opening-range-breakout.json')));
  assert.throws(() => runtimeFilesForStrategy(root, 'not-a-strategy'), /Unknown strategy/);
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
