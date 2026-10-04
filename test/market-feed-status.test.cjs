const test = require('node:test');
const assert = require('node:assert/strict');
const { clock } = require('../lib/market-feed-status.cjs');
test('regular weekend closure and ORB entry window are labeled separately', () => {
  assert.equal(clock(new Date('2026-09-06T16:00:00Z')).regularMarketClosed, true);
  assert.equal(clock(new Date('2026-09-07T14:59:00Z')).orbEntryWindow, false);
  assert.equal(clock(new Date('2026-09-08T14:59:00Z')).orbEntryWindow, true);
  assert.equal(clock(new Date('2026-09-07T16:00:00Z')).orbEntryWindow, false);
});
test('reviewed UTC holiday closures are shared with the feed watchdog',()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const root=fs.mkdtempSync(path.join(os.tmpdir(),'cme-hours-'));
 try{fs.mkdirSync(path.join(root,'runtime'));fs.writeFileSync(path.join(root,'runtime/feed-watchdog-closures.json'),JSON.stringify([{start:'2026-11-26T18:00:00Z',end:'2026-11-26T23:00:00Z'}]));
 assert.equal(clock(new Date('2026-11-26T19:00:00Z'),root).holidayClosed,true);
 assert.equal(clock(new Date('2026-11-26T23:01:00Z'),root).regularMarketClosed,false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
