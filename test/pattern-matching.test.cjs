const test=require('node:test'),assert=require('node:assert/strict');
const p=require('../lib/pattern-matching.cjs');
const query={symbol:'NQ',slug:'orb',side:'long',at:'2026-09-01T14:00:00Z',features:[1,1,1,.5,1,1,0,1]};
function example(i){return {id:String(i),symbol:'NQ',slug:'orb',side:'long',at:new Date(Date.UTC(2026,0,1+i,14)).toISOString(),closedAt:new Date(Date.UTC(2026,0,1+i,15)).toISOString(),features:[...query.features],netR:i%2?-.5:1,pnl:i%2?-50:100};}
function model(){return {version:p.VERSION,examples:Array.from({length:60},(_,i)=>example(i))};}
test('nearest matches use net outcomes; advisory never changes trade action',()=>{
 const s=p.score(model(),query);assert.equal(s.status,'scored');assert.equal(s.matches,20);assert.equal(s.tradeAction,'unchanged');assert.ok(Number.isFinite(s.expectancyR));assert.equal(s.mode,'shadow-only');
});
test('future outcomes and feature extremes cannot change a past score or scaling',()=>{
 const m=model(),before=p.score(m,query);
 m.examples.push({...example(100),id:'future',at:'2026-09-02T14:00:00Z',closedAt:'2026-09-02T15:00:00Z',features:query.features.map(()=>100000),netR:999});
 assert.deepEqual(p.score(m,query),before);
 m.examples.push({...example(0),id:'still-open',closedAt:'2026-09-02T15:00:00Z',netR:999});assert.deepEqual(p.score(m,query),before);
});
test('embargo, instrument, strategy and direction segregation are mandatory',()=>{
 const m=model();assert.equal(p.score(m,{...query,symbol:'MGC'}).status,'insufficient-history');
 assert.equal(p.score(m,{...query,slug:'different'}).status,'insufficient-history');assert.equal(p.score(m,{...query,side:'short'}).status,'insufficient-history');
 const at=Date.parse(query.at)-p.RULES.embargoMs;m.examples.forEach(e=>e.closedAt=new Date(at).toISOString());assert.equal(p.score(m,query).eligible,0);
});
test('sparse, distant, malformed and incompatible inputs produce no score',()=>{
 const m=model();m.examples=m.examples.slice(0,49);assert.equal(p.score(m,query).status,'insufficient-history');
 assert.equal(p.score(model(),{...query,features:query.features.map(()=>10000)}).status,'no-close-match');
 assert.equal(p.score(model(),{...query,features:null}).status,'incomplete-candles');assert.equal(p.score({version:'old'},query).status,'model-unavailable');
});
function candles(){return Array.from({length:70},(_,i)=>({timestamp:new Date(Date.UTC(2026,8,1,12,i)).toISOString(),open:100+i*.1,high:101+i*.1,low:99+i*.1,close:100.5+i*.1,volume:100+i,instrumentId:1}));}
test('features reject gaps and rolls and cannot use an incomplete or future candle',()=>{
 const c=candles(),at=c[61].timestamp,f=p.features(c,at,'long');assert.equal(f.length,8);
 c[61].close=99999;assert.deepEqual(p.features(c,at,'long'),f);
 assert.equal(p.features(c.filter((_,i)=>i!==30),at,'long'),null);
 c[30].instrumentId=2;assert.equal(p.features(c,at,'long'),null);
});
test('report keeps research and account duplicates out and excludes missing outcome times',()=>{
 const c=candles(),t={side:'long',symbol:'NQ',signalAt:c[60].timestamp,filledAt:c[61].timestamp,exitedAt:c[65].timestamp,actualRiskUsd:100,realizedPnlUsd:-50};
 const r=p.build(c,{strategies:[{slug:'orb',name:'ORB',trades:[t],research:{trades:[t,t,{...t,exitedAt:null}]}}]});
 assert.equal(r.model.examples.length,1);assert.equal(r.model.examples[0].netR,-.5);assert.equal(r.report.strategies[0].scored,0);
});
