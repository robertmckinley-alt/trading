const test = require('node:test');
const assert = require('node:assert/strict');
const { clock } = require('../lib/market-feed-status.cjs');
test('regular weekend closure and ORB entry window are labeled separately', () => {
  assert.equal(clock(new Date('2026-09-06T16:00:00Z')).regularMarketClosed, true);
  assert.equal(clock(new Date('2026-09-07T14:59:00Z')).orbEntryWindow, false);
  assert.equal(clock(new Date('2026-09-08T14:59:00Z')).orbEntryWindow, true);
  assert.equal(clock(new Date('2026-09-07T16:00:00Z')).orbEntryWindow, false);
});
