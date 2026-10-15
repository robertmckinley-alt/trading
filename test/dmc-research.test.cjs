const test = require('node:test');
const assert = require('node:assert/strict');
const base = require('../config.json');
const { detectDmcMarketOpenSignal: detect, timestampForWallClock } = require('../lib/dmc-market-open.cjs');
const { candidateSignals, freshBefore } = require('../lib/dmc-level-bots.cjs');
function fixture() {
  const start = Date.parse('2026-02-02T18:00:00Z');
  return Array.from({ length: 1235 }, (_, i) => ({ timestamp: new Date(start + i * 60000).toISOString(), open: 100, close: 101, high: 102, low: 99, volume: 10, instrumentId: 1 }));
}
function collectionConfig() { const c = structuredClone(base); c.detectorStrategySlug = 'nq-dmc-market-open'; c.live.paperCollection = { enabled: true }; return c; }
test('DMC cannot reuse an earlier M5 confirmation on the next partial minute', () => {
  const rows = fixture();
  const next = { ...rows.at(-1), timestamp: new Date(Date.parse(rows.at(-1).timestamp) + 60000).toISOString() };
  assert.match(detect([...rows, next], collectionConfig()).reason, /freshly completed/);
});
test('DMC cannot replace missing 08:00 context with an older valid hourly bar', () => {
  const rows = fixture().filter(c => !c.timestamp.startsWith('2026-02-03T13:'));
  assert.match(detect(rows, collectionConfig()).reason, /final pre-open hour is stale or incomplete/);
});
test('DMC rejects mixed contracts, invalid OHLC and duplicate rows before aggregation', () => {
  const rows = fixture();
  assert.match(detect([...rows, rows.at(-1)], collectionConfig()).reason, /duplicate/);
  const mixed = structuredClone(rows); mixed.at(-1).instrumentId = 2;
  assert.match(detect(mixed, collectionConfig()).reason, /mixed contracts/);
  const invalid = structuredClone(rows); invalid.at(-1).low = 105;
  assert.match(detect(invalid, collectionConfig()).reason, /invalid OHLCV/);
});
test('DMC expected preopen hour tracks DST in winter and summer', () => {
  assert.equal(timestampForWallClock('2026-02-03', '08:00'), '2026-02-03T13:00:00.000Z');
  assert.equal(timestampForWallClock('2026-10-15', '08:00'), '2026-10-15T12:00:00.000Z');
});
test('DMC failure and progression patterns remain symmetric without forced direction', () => {
  const low = [{ kind: 'pivot-low', price: 100 }], high = [{ kind: 'pivot-high', price: 100 }];
  assert.equal(candidateSignals('failure', {open:101,low:99,high:103,close:102}, {}, low, .25)[0].side, 'long');
  assert.equal(candidateSignals('failure', {open:99,low:97,high:101,close:98}, {}, high, .25)[0].side, 'short');
  assert.equal(candidateSignals('progression', {open:99,low:98,high:102,close:101}, {close:99}, high, .25)[0].side, 'long');
  assert.equal(candidateSignals('progression', {open:101,low:98,high:102,close:99}, {close:101}, low, .25)[0].side, 'short');
});
test('collection pivot freshness starts after right-hand H1 confirmation, not during formation', () => {
 const hour = (h,open,close,high,low) => ({ timestamp:`2026-10-15T0${h}:00:00Z`,endTimestamp:`2026-10-15T0${h}:59:00Z`,open,close,high,low });
 const hours = [hour(0,100,101,102,99),hour(1,104,105,106,103),hour(2,101,102,106,100)];
 // Right-hand wick hits 105 before the pivot can be known, so this is not a prior test.
 assert.equal(freshBefore(hours, [], Date.parse('2026-10-15T04:00Z'), .25, 0).some(l=>l.price===105), true);
 const rows=Array.from({length:15},(_,i)=>({timestamp:new Date(Date.parse('2026-10-15T03:00Z')+i*60000).toISOString(),open:104,close:104,high:106,low:103,volume:10}));
 assert.equal(freshBefore(hours, rows, Date.parse('2026-10-15T04:00Z'), .25, 0).some(l=>l.price===105), false);
});
test('Fresh Retest cannot assert a first touch across a missing post-break minute', () => {
 const fresh = require('../lib/fresh-level-retest.cjs');
 const rows=[];
 for(let t=Date.parse('2026-09-29T13:35:00Z');t<=Date.parse('2026-09-30T14:07:00Z');t+=60000)rows.push({timestamp:new Date(t).toISOString(),open:80,high:81,low:79,close:80,volume:10});
 function set(time,values){Object.assign(rows.find(c=>c.timestamp===`2026-09-30T${time}:00.000Z`),values);}
 set('12:10',{high:120});set('13:00',{high:100});
 for(let m=0;m<7;m++)set(`14:0${m}`,{open:103,high:106,low:102,close:105});
 set('14:07',{open:104,high:105,low:100,close:103});
 assert.equal(fresh.detect(rows,base).found,true);
 assert.equal(fresh.detect(rows.filter(c=>!c.timestamp.includes('T14:06:')),base).found,false);
});
