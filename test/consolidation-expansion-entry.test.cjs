const test=require('node:test'),assert=require('node:assert/strict');
const ce=require('../lib/consolidation-expansion.cjs'),live=require('../lib/live-trader.cjs'),dmc=require('../lib/dmc-level-bots.cjs'),fresh=require('../lib/fresh-level-retest.cjs'),core=require('../lib/trader-core.cjs');
const base=require('../config.json');
const bar=(t,v={})=>({timestamp:new Date(t).toISOString(),open:100,high:104,low:96,close:100,volume:100,instrumentId:1,...v});
function expand(start,minutes,shape){return Array.from({length:minutes},(_,i)=>bar(start+i*60000,shape));}
function cfg(slug,candles,enabled=true){const c=structuredClone(base);c.strategySlug=slug;c.detectorStrategySlug=slug;c.live.consolidationExpansion={enabled,asOf:Date.parse(candles.at(-1).timestamp)+60000};return c;}
const mirror=c=>c.map(b=>({...b,open:214-b.open,high:214-b.low,low:214-b.high,close:214-b.close}));
function shared(){return Array.from({length:37},(_,i)=>bar(Date.UTC(2026,8,2,13,i),i<20?{open:100,high:104,low:96,close:100}:i<36?{open:100,high:101,low:99,close:100}:{open:100,high:104,low:99,close:103.5}));}
function emaFixture(){const end=Date.parse('2026-09-02T14:45:00Z'),out=[];for(let i=0;i<70;i++){const price=80+i*.5;const shape=i<33?{open:price,close:price,high:price+2,low:price-2}:i<53?{open:100,close:100,high:104,low:96}:i<69?{open:104,close:104,high:105,low:103}:{open:104,close:107,high:108,low:103};out.push(...expand(end-(70-i)*15*60000,15,shape));}return out;}
function orFixture(){const out=[],start=Date.parse('2026-09-02T11:30:00Z');for(let t=start;t<Date.parse('2026-09-02T14:07:00Z');t+=60000){let shape={open:98,close:99,high:100,low:96};if(t>=Date.parse('2026-09-02T13:29:00Z'))shape={open:100,close:100,high:110,low:90};if(t>=Date.parse('2026-09-02T13:49:00Z'))shape={open:110,close:110.25,high:110.5,low:109};if(t===Date.parse('2026-09-02T14:05:00Z'))shape={open:110.5,close:113,high:113.25,low:109.5};if(t===Date.parse('2026-09-02T14:06:00Z'))shape={open:112,close:111,high:112.5,low:109.75};out.push(bar(t,shape));}return out;}
function freshFixture(delay=31,qualified=true){const out=[],start=Date.parse('2026-09-29T13:35:00Z'),breakAt=Date.parse('2026-09-30T14:00:00Z'),end=breakAt+5*60000+(delay-1)*60000;for(let t=start;t<=end;t+=60000){let v={open:80,high:81,low:79,close:80};if(t>=Date.parse('2026-09-30T11:00:00Z')&&t<breakAt)v={open:90,close:90,high:96,low:80};if(t>=Date.parse('2026-09-30T12:40:00Z')&&t<breakAt)v={open:97,close:97,high:99,low:96};if(t===Date.parse('2026-09-30T12:10:00Z'))v.high=120;if(t===Date.parse('2026-09-30T13:00:00Z'))v.high=100;if(t>=breakAt&&t<breakAt+300000)v={open:qualified?97:104,close:106,high:107,low:qualified?96:103};if(t>=breakAt+300000)v={open:105,close:105,high:108,low:104};if(t===end)v={open:104,close:103,high:105,low:100};out.push(bar(t,v));}return out;}
function dmcFixture(){const start=Date.parse('2026-02-02T18:00:00Z'),out=[];for(let i=0;i<20;i++){let v={open:94,close:94.25,high:96,low:92};if(i===10)v={open:112,close:115,high:116,low:111};if(i===14)v={open:99,close:100,high:101,low:98};if(i===18)v={open:94,close:96,high:97,low:93};if(i===19)v={open:96,close:98,high:99,low:95};for(let m=0;m<60;m++)out.push(bar(start+(i*60+m)*60000,{...v,open:v.open+(v.close-v.open)*m/60,close:v.open+(v.close-v.open)*(m+1)/60}));}
 out.push(...expand(Date.parse('2026-02-03T14:00:00Z'),45,{open:98,close:98.5,high:99,low:95}));
 const b=Date.parse('2026-02-03T14:40:00Z');for(let j=0;j<37;j++){const t=b-(36-j)*300000;let v=j<20?{open:95,close:95.5,high:97.5,low:92.5}:j<35?{open:97,close:98,high:99.75,low:96}:j===35?{open:100.25,close:100.5,high:100.5,low:100.25}:{open:100.25,close:103.5,high:103.5,low:98};for(let m=0;m<5;m++)Object.assign(out.find(x=>Date.parse(x.timestamp)===t+m*60000),v);}return out;}
const fixtures=[['nq-dmc-gain-retest',dmcFixture,dmc.detect],['nq-15m-opening-range-retest',orFixture,live.detectOpeningRangeRetestSignal],['ema-20-60-momentum',emaFixture,live.detectEmaMomentumSignal],['nq-fresh-level-retest',freshFixture,fresh.detect]];
test('CE independent hand-computed window and exact mirrored semantics',()=>{for(const [side,c]of [['long',shared()],['short',mirror(shared())]]){const a=ce.assess(c,side,{asOf:Date.parse(c.at(-1).timestamp)+60000,tickSize:.25});assert.equal(a.qualifies,true);assert.equal(a.baselineRange,8);assert.equal(a.compressedRange,2);assert.equal(a.contractionRatio,.25);assert.equal(a.expansionRatio,2.5);assert.equal(a.bodyFraction,.7);}});
test('CE rejects malformed OHLC, duplicates, order, holes, identity and weak direction/body',()=>{const source=shared(),opts={asOf:Date.parse(source.at(-1).timestamp)+120000};for(const mutate of [c=>c.splice(9,1),c=>c.splice(9,0,c[9]),c=>c.reverse(),c=>c[7].high=95,c=>c[7].instrumentId=2,c=>c[7].timestamp='bad',c=>c.at(-1).close=100,c=>c.at(-1).open=104]){const c=structuredClone(source);mutate(c);assert.equal(ce.assess(c,'long',opts).qualifies,false);}});
test('CE aggregation rejects count-only completeness and requires aligned exact minutes',()=>{const c=expand(Date.parse('2026-09-02T13:30:00Z'),15,{});assert.equal(ce.aggregate(c,15).length,1);assert.equal(ce.aggregate([...c.slice(0,14),c[13]],15).length,0);assert.equal(ce.aggregate(c.map(x=>({...x,timestamp:new Date(Date.parse(x.timestamp)+60000).toISOString()})),15).length,0);});
for(const [slug,build,detect]of fixtures)test(`${slug}: additive entries, mirrored direct/dispatcher equality, prefix stability, future execution`,()=>{for(const [side,c]of [['long',build()],['short',mirror(build())]]){const config=cfg(slug,c);if(slug==='nq-dmc-gain-retest')config.live.paperCollection={enabled:true};const before=detect(c,{...config,live:{...config.live,consolidationExpansion:{...config.live.consolidationExpansion,enabled:false}}},{trades:[]});const after=detect(c,config,{trades:[]});assert.equal(before.found,false,`before ${slug}: ${JSON.stringify(before)}`);assert.equal(after.found,true,`after ${slug}: ${JSON.stringify(after)}`);assert.equal(after.setup.side,side);assert.match(after.metadata.entryRoute,/ce-/);assert.equal(after.metadata.consolidationExpansion.qualifies,true);assert.deepEqual(live.detectSignalFromCandles(c,config,{trades:[]}),after);const future=bar(Date.parse(c.at(-1).timestamp)+60000,{instrumentId:99,high:999,low:1});assert.deepEqual(detect([...c,future],config,{trades:[]}),after);assert.deepEqual(live.detectSignalFromCandles([...c,future],config,{trades:[]}),after);const normalized=core.normalizeConfig(config),state=core.createEmptyState(normalized),plan=live.buildPlanFromSignal(after,normalized,state);assert.ok(plan);assert.equal(core.validateSetup(core.normalizeSetup(after.setup,normalized),normalized).valid,true);assert.ok(Date.parse(after.setup.signalAvailableAt)>Date.parse(c.at(-1).timestamp));assert.equal(core.replayPlan(plan,c,normalized).status,'not-filled');}});
test('Fresh CE window retains first-touch rules and fixed 45 minute inclusive boundary',()=>{for(const [delay,want]of [[30,true],[31,true],[45,true],[46,false]]){const c=freshFixture(delay),config=cfg(fresh.SLUG,c);assert.equal(fresh.detect(c,config).found,want,`delay ${delay}`);}const ordinary=freshFixture(31,false);assert.equal(fresh.detect(ordinary,cfg(fresh.SLUG,ordinary)).found,false);const c=freshFixture();c.at(-3).low=100;assert.equal(fresh.detect(c,cfg(fresh.SLUG,c)).found,false);const hole=freshFixture();hole.splice(-3,1);assert.equal(fresh.detect(hole,cfg(fresh.SLUG,hole)).found,false);});
test('EMA stale M15 and incomplete bars cannot repeat a continuation',()=>{const c=emaFixture();c.push(bar(Date.parse(c.at(-1).timestamp)+60000,{open:107,close:107,high:108,low:106}));assert.equal(live.detectEmaMomentumSignal(c,cfg('ema-20-60-momentum',c),{trades:[]}).found,false);c.splice(-3,1);assert.equal(live.detectEmaMomentumSignal(c,cfg('ema-20-60-momentum',c),{trades:[]}).found,false);});
function dmcM15Fixture() {
  const candles=dmcFixture(), trigger=Date.parse('2026-02-03T14:30:00Z');
  for(let j=0;j<37;j++) {
    const at=trigger-(36-j)*900000;
    let shape=j<20?{open:95,close:95.5,high:97.5,low:92.5}
      :j<35?{open:97,close:98,high:99.75,low:96}
      :j===35?{open:100.25,close:100.5,high:100.5,low:100.25}
      :{open:100.25,close:103.5,high:103.5,low:98};
    // H1 pivot confirmed before compression; two rising H1 bodies support baseline bias.
    if(at>=Date.parse('2026-02-03T09:00:00Z')&&at<Date.parse('2026-02-03T10:00:00Z'))
      shape={open:99,close:100,high:101,low:98};
    if(at===Date.parse('2026-02-03T13:45:00Z'))shape.close=98.5;
    for(let m=0;m<15;m++)Object.assign(candles.find(c=>Date.parse(c.timestamp)===at+m*60000),shape);
  }
  return candles;
}
test('DMC baseline M15 CE route independently admits both directions without a legacy crossing',()=>{
  for(const [side,candles] of [['long',dmcM15Fixture()],['short',mirror(dmcM15Fixture())]]) {
    const config=cfg('nq-dmc-gain-retest',candles);config.live.paperCollection={enabled:false};
    const disabled={...config,live:{...config.live,consolidationExpansion:{...config.live.consolidationExpansion,enabled:false}}};
    assert.equal(dmc.detect(candles,disabled).found,false);
    const signal=dmc.detect(candles,config);
    assert.equal(signal.found,true,signal.reason);assert.equal(signal.setup.side,side);
    assert.equal(signal.setup.setup.entryTimeframe,'M15');assert.equal(signal.metadata.entryRoute,'ce-continuation');
    assert.deepEqual(live.detectSignalFromCandles(candles,config,{trades:[],live:{}}),signal);
    assert.equal(core.validateSetup(core.normalizeSetup(structuredClone(signal.setup),config),config).valid,true);
  }
});
module.exports={fixtures,cfg,mirror,bar,expand,shared,emaFixture,orFixture,freshFixture,dmcFixture,dmcM15Fixture};

test('CE exact contraction, expansion and body boundaries are inclusive; weaker values fail',()=>{
 const source=shared(),opts={asOf:Date.parse(source.at(-1).timestamp)+60000};
 const contraction=source.map((x,i)=>({...x,...(i<20?{open:0,close:0,high:5,low:-5}:i<36?{open:0,close:0,high:4.25,low:-4.25}:{open:0,close:10,high:10,low:0})}));
 assert.equal(ce.assess(contraction,'long',opts).contractionRatio,.85);assert.equal(ce.assess(contraction,'long',opts).qualifies,true);
 const over=structuredClone(contraction);over[20].high+=.25;assert.equal(ce.assess(over,'long',opts).contraction,false);
 const expansion=source.map((x,i)=>({...x,...(i<20?{open:0,close:0,high:4,low:-4}:i<36?{open:0,close:0,high:2,low:-2}:{open:1,close:4.6,high:4.6,low:0})}));
 assert.equal(ce.assess(expansion,'long',opts).expansionRatio,1.15);assert.equal(ce.assess(expansion,'long',opts).qualifies,true);
 expansion.at(-1).high-=.25;expansion.at(-1).close-=.25;assert.equal(ce.assess(expansion,'long',opts).expansion,false);
 const body=structuredClone(source);body.at(-1).open=100.75;assert.equal(ce.assess(body,'long',opts).bodyFraction,.55);assert.equal(ce.assess(body,'long',opts).qualifies,true);body.at(-1).close-=.25;assert.equal(ce.assess(body,'long',opts).qualifies,false);
 for(const c of [source.map(x=>({...x,open:100,close:100,high:100,low:100})),source.map((x,i)=>i<20?{...x,high:101,low:99}:x)])assert.equal(ce.assess(c,'long',opts).qualifies,false);
});
test('asOf excludes forming/future breakout; invalid old history cannot disappear',()=>{
 const c=shared(),forming=Date.parse(c.at(-1).timestamp)+59999;
 assert.equal(ce.assess(c,'long',{asOf:forming}).qualifies,false);
 for(const [slug,build,detect]of fixtures){const c=build(),config=cfg(slug,c);if(slug==='nq-dmc-gain-retest')config.live.paperCollection={enabled:true};config.live.consolidationExpansion.asOf=Date.parse(c.at(-1).timestamp)+59999;assert.equal(detect(c,config,{trades:[]}).found,false,slug);const invalid=build();invalid[3].timestamp='malformed';const bad=cfg(slug,invalid);assert.equal(detect(invalid,bad,{trades:[]}).found,false,slug);assert.equal(live.detectSignalFromCandles(invalid,bad,{trades:[]}).found,false,slug);}
});
test('DMC H1 freshness begins only after right-hand confirmation closes',()=>{
 const start=Date.parse('2026-02-03T10:00:00Z');
 const hours=[{open:95,close:96,high:97,low:94},{open:99,close:100,high:101,low:98},{open:95,close:96,high:101,low:94}].map((x,i)=>({...bar(start+i*3600000,x),endTimestamp:new Date(start+(i+1)*3600000-60000).toISOString()}));
 const rightTouch=bar(start+2*3600000,{open:96,close:96,high:101,low:95});
 assert.equal(dmc.freshBefore(hours,[rightTouch],start+4*3600000,.25).some(x=>x.price===100),true);
 assert.equal(dmc.freshBefore(hours,[rightTouch,bar(start+3*3600000,{open:96,close:96,high:101,low:95})],start+4*3600000,.25).some(x=>x.price===100),false);
});
test('OR rejects reused first touch, invalidation, opening gaps and >20 point structural risk',()=>{
 const source=orFixture();for(const mutate of [c=>c.splice(c.findIndex(x=>x.timestamp==='2026-09-02T13:35:00.000Z'),1),c=>c.splice(-1,0,{...c.at(-1),timestamp:new Date(Date.parse(c.at(-1).timestamp)-60000).toISOString()}),c=>{c.at(-1).low=89;},c=>{c.at(-2).close=109;c.at(-2).open=110;c.at(-2).high=113.25;}]){const c=structuredClone(source);mutate(c);assert.equal(live.detectOpeningRangeRetestSignal(c,cfg('nq-15m-opening-range-retest',c),{trades:[]}).found,false);}
 const c=structuredClone(source);c.push({...c.at(-1),timestamp:new Date(Date.parse(c.at(-1).timestamp)+60000).toISOString()});assert.equal(live.detectOpeningRangeRetestSignal(c,cfg('nq-15m-opening-range-retest',c),{trades:[]}).found,false);
});
