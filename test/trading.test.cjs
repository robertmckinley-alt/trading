const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const core = require('../lib/trader-core.cjs');
const { saveLiveState } = require('../lib/live-trader.cjs');
const { parseLiveStatus, sanitizeRemoteSnapshot, summarizeJournal } = require('../lib/live-status.cjs');

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
