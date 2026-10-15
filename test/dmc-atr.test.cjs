const test=require('node:test'),assert=require('node:assert/strict');
const {atrEvidence}=require('../lib/dmc-atr.cjs');
const bar=(timestamp,samples=60)=>({timestamp,samples,open:100,high:102,low:98,close:101});
test('ATR crosses regular maintenance without fabricating bars',()=>{
 const r=atrEvidence([bar('2026-10-13T20:00Z'),bar('2026-10-13T22:00Z')],1);
 assert.equal(r.valid,true);assert.equal(r.value,4);assert.equal(r.gaps[0].scheduledClosedMinutes,60);
});
test('ATR rejects missing active hours and unknown holiday schedules',()=>{
 assert.equal(atrEvidence([bar('2026-10-13T06:00Z'),bar('2026-10-13T08:00Z')],1).valid,false);
 assert.equal(atrEvidence([bar('2026-12-25T20:00Z'),bar('2026-12-25T23:00Z')],1).valid,false);
});
test('Partial halt hour requires every open minute exactly once',()=>{
 const bars=[bar('2026-10-13T19:00Z'),bar('2026-10-13T22:00Z')];
 const raw=Array.from({length:60},(_,i)=>({...bar(new Date(Date.parse('2026-10-13T20:00Z')+i*60000).toISOString()),i})).filter(c=>c.i<15||c.i>=30);
 const r=atrEvidence(bars,1,raw);assert.equal(r.valid,true);assert.equal(r.gaps[0].observedOpenMinutes,45);
 assert.equal(atrEvidence(bars,1,raw.slice(1)).valid,false);
 assert.equal(atrEvidence(bars,1,[...raw,raw[0]]).valid,false);
});
test('Weekend closure bridges a DST transition in New York',()=>{
 const r=atrEvidence([bar('2026-10-30T20:00Z'),bar('2026-11-01T23:00Z')],1);
 assert.equal(r.valid,true,r.reason);assert.equal(r.gaps[0].scheduledClosedMinutes,3000);
});
