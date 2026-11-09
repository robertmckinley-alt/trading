const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLiveStrategy, normalizeRemoteSnapshot } = require('../lib/live-status.cjs');

function snapshot(now, candle, ticker = 'NQ.v.0', logText = '') {
  const originalNow = Date.now;
  Date.now = () => Date.parse(now);
  try {
    return buildLiveStrategy({
      config: { startingBalanceUsd: 50000, live: { ticker } },
      state: { trades: [], live: { heartbeat: {
        at: now, ok: false, error: 'Databento live candle is stale', lastCandle: { timestamp: candle }
      } } },
      processCount: 1, logText
    });
  } finally { Date.now = originalNow; }
}

test('a new heartbeat candle supersedes a stale logged candle', () => {
  const result = snapshot('2026-11-09T22:30:00Z', '2026-11-09T21:59:00Z', 'NQ.v.0',
    '[2026-10-16T18:14:00Z] live tick\nLast candle: 2026-10-16T18:13:00Z O:1 H:2 L:1 C:2');
  assert.equal(result.live.lastCandle.timestamp, '2026-11-09T21:59:00Z');
  assert.equal(result.watcher.isHealthy, true);
});

test('daily closure does not hide a gold feed outage from an earlier session', () => {
  const result = snapshot('2026-11-09T22:30:00Z', '2026-10-16T18:13:00Z', 'MGC.v.0');
  assert.equal(result.watcher.isHealthy, false);
  assert.match(result.live.latestError.message, /stale/);
  assert.equal(result.live.recoveredFromError, false);
});

test('weekend closure admits the Friday final bar across daylight saving changes', () => {
  const current = snapshot('2026-11-01T21:30:00Z', '2026-10-30T20:59:00Z');
  assert.equal(current.watcher.isHealthy, true);
  assert.equal(current.watcher.statusLabel, 'Market closed');
  const old = snapshot('2026-11-01T21:30:00Z', '2026-10-29T20:59:00Z');
  assert.equal(old.watcher.isHealthy, false);
});

test('another strategy log update cannot clear a continuing remote error', () => {
  const error = { at: '2026-11-09T20:00:00Z', message: 'Gold feed failed' };
  const input = {
    logUpdatedAt: '2026-11-09T22:30:00Z',
    strategies: [{ slug: 'mgc-open-ema12', watcher: { isHealthy: false }, live: {
      latestError: error, lastCandle: { timestamp: '2026-10-16T18:13:00Z' }, recoveredFromError: true
    } }]
  };
  assert.deepEqual(normalizeRemoteSnapshot(input).strategies[0].live.latestError, error);
  assert.equal(normalizeRemoteSnapshot(input).strategies[0].live.recoveredFromError, false);
});

test('remote recovery requires a successful tick from the same healthy watcher', () => {
  const strategy = { watcher: { isHealthy: true }, live: {
    latestError: { at: '2026-11-09T20:00:00Z', message: 'feed failed' },
    lastSuccessfulTickAt: '2026-11-09T20:02:00Z', lastCandle: { timestamp: '2026-11-09T20:01:00Z' }
  } };
  const recovered = normalizeRemoteSnapshot({ strategies: [strategy] }).strategies[0];
  assert.equal(recovered.live.latestError, null);
  assert.equal(recovered.live.recoveredFromError, true);
  const unhealthy = normalizeRemoteSnapshot({ strategies: [{ ...strategy, watcher: { isHealthy: false } }] }).strategies[0];
  assert.ok(unhealthy.live.latestError);
});
