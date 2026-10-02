const test=require('node:test'),assert=require('node:assert/strict');
const base=require('../config.json'),bots=require('../lib/dmc-level-bots.cjs'),dmc=require('../lib/dmc-market-open.cjs');
const live=require('../lib/live-trader.cjs'),core=require('../lib/trader-core.cjs'),profile=require('../lib/paper-collection.cjs');
function minuteBlock(start,count,shape){return Array.from({length:count},(_,i)=>({timestamp:new Date(start+i*60000).toISOString(),open:shape.open+(shape.close-shape.open)*i/count,close:shape.open+(shape.close-shape.open)*(i+1)/count,high:shape.high,low:shape.low,volume:100}));}
function levelFixture(gain=false){
  const start=Date.parse('2026-02-02T18:00:00Z'),c=[];
  for(let i=0;i<20;i++){
    let s=gain?{open:94,close:94.25,high:96,low:92}:{open:106,close:106.25,high:108,low:104};
    if(i===10)s={open:112,close:115,high:116,low:111};
    if(i===14)s=gain?{open:99,close:100,high:101,low:98}:{open:101,close:100,high:102,low:99};
    if(gain&&i===18)s={open:94,close:96,high:97,low:93};
    if(gain&&i===19)s={open:96,close:98,high:99,low:95};
    c.push(...minuteBlock(start+i*3600000,60,s));
  }
  c.push(...minuteBlock(Date.parse('2026-02-03T14:00:00Z'),40,gain?{open:98.5,close:98.5,high:99,low:98}:{open:106,close:106.25,high:108,low:104}));
  c.push(...minuteBlock(Date.parse('2026-02-03T14:40:00Z'),5,gain?{open:98.5,close:102,high:102.25,low:97.75}:{open:101,close:102,high:102.25,low:97.75}));
  return c;
}
const config=slug=>({...structuredClone(base),strategySlug:slug,detectorStrategySlug:slug});
test('collection reversal and gain use completed M5 structure without changing risk ceilings',()=>{
  for(const [slug,c]of [[bots.SLUGS[0],levelFixture()],[bots.SLUGS[1],levelFixture(true)]]){
    const cfg=config(slug),s=bots.detect(c,cfg);assert.equal(s.found,true,s.reason);
    assert.equal(s.metadata.rulesVersion,profile.VERSION);assert.equal(s.setup.setup.entryTimeframe,'M5');
    assert.ok(s.metadata.rewardRisk>=1.5);assert.ok(s.metadata.stopDistancePoints>=2&&s.metadata.stopDistancePoints<=22);
    const plan=live.buildPlanFromSignal(s,cfg,core.createEmptyState(cfg));assert.ok(plan.sizing.actualRiskUsd<=500);
    assert.equal(plan.setup.execution,'limit-touch');assert.equal(plan.targets[0].closeFraction,1);
    assert.equal(bots.detect(c.slice(0,-1),cfg).found,false);
  }
});
test('M5 collection extends cash-session checks, while baseline M15 remains selectable',()=>{
  const records=Array.from({length:400},(_,i)=>({minute:570+i})),engine=require('../lib/backtest-engine.cjs');
  const checks=engine.checkpointsForDay(bots.SLUGS[0],records,config(bots.SLUGS[0]));
  assert.equal(checks.at(-1).minute,929);assert.equal(checks[1].minute-checks[0].minute,5);
  assert.equal(engine.checkpointsForDay(bots.SLUGS[0],records).at(-1).minute,674);
  const cfg=config(bots.SLUGS[0]);assert.match(bots.detect(levelFixture(),cfg,{trades:[{date:'2026-02-03'}]}).reason,/one filled/);
});
test('collection market-open uses a completed M5 reaction and real three-minute structural swing',()=>{
  const c=levelFixture();
  // Synthetic execution reaction, not market observations.
  const reaction=minuteBlock(Date.parse('2026-02-03T14:40:00Z'),5,{open:100.75,close:103,high:103.25,low:99});
  c.splice(-5,5,...reaction);
  const cfg=config('nq-dmc-market-open'),s=dmc.detectDmcMarketOpenSignal(c,cfg);
  assert.equal(s.found,true,s.reason);assert.equal(s.setup.execution,'next-bar-market');
  assert.equal(s.setup.stop,98.75);assert.equal(s.metadata.executionSwingMinutes,3);
  assert.equal(s.setup.exitAllAtTarget,true);assert.equal(s.setup.targets.length,1);
  const plan=live.buildPlanFromSignal(s,cfg,core.createEmptyState(cfg));assert.ok(plan.sizing.actualRiskUsd<=500);
});
test('VWAP deadline survives realistic feed latency but two-loss pause and 5% floor remain',()=>{
  const cfg=config('nq-vwap-stretch-reversion');
  const c=minuteBlock(Date.parse('2026-10-01T13:30:00Z'),20,{open:100,close:100,high:101,low:99});
  Object.assign(c.at(-1),{close:90,low:89});
  const s=live.detectSignalFromCandles(c,cfg,core.createEmptyState(cfg));assert.equal(s.found,true);
  const plan=live.buildPlanFromSignal(s,cfg,core.createEmptyState(cfg));
  require('../lib/watcher-observation.cjs').bindForwardObservation(plan,Date.parse('2026-10-01T13:51:20Z'));
  assert.equal(plan.setup.signalAvailableAt,'2026-10-01T13:52:00.000Z');
  assert.ok(Date.parse(plan.setup.orderExpiresAt)>Date.parse(plan.setup.signalAvailableAt));
  const next={timestamp:'2026-10-01T13:52:00Z',open:90,close:91,high:92,low:90,volume:100};
  assert.equal(core.trackTradeLifecycle(plan,[...c,next],cfg,{closeOpenAtEnd:false}).filledAt,next.timestamp);
});
