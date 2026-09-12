const test=require('node:test'),assert=require('node:assert/strict');
const gold=require('../lib/gold-open-ema.cjs'),core=require('../lib/trader-core.cjs'),live=require('../lib/live-trader.cjs');
const config={...gold.config(core.normalizeConfig(require('../config.json'))),strategySlug:gold.SLUG};
function bars(short=false) {
  const c=Array.from({length:300},(_,i)=>({timestamp:new Date(Date.parse('2026-09-08T08:35:00Z')+i*60000).toISOString(),open:2500,high:2501,low:2499,close:2500,volume:100}));
  Object.assign(c.at(-1),short?{close:2498,low:2497}:{close:2502,high:2503});return c;
}
test('gold takes both EMA directions, refuses incomplete warmup, repeats and NQ config',()=>{
  for(const short of [false,true]) {const c=bars(short),s=gold.detect(c,config);assert.equal(s.found,true);assert.equal(s.side,short?'short':'long');assert.equal(gold.detect(c.slice(1),config).found,false);assert.equal(gold.detect(c,{...config,symbol:'NQ'}).found,false);assert.equal(gold.detect(c,config,{trades:[{date:s.date}]}).found,false);}
  assert.equal(gold.detect(bars(),config,{balanceUsd:47500}).found,false);
});
test('gold plans have $50k MGC pricing and a real trailing exit with no invented target',()=>{
  const signal=live.detectSignalFromCandles(bars(),config,core.createEmptyState(config));
  const plan=live.buildPlanFromSignal(signal,config,core.createEmptyState(config));
  assert.equal(plan.setup.symbol,'MGC');assert.deepEqual(plan.targets,[]);assert.equal(core.validateSetup(plan.setup,config).valid,true);
  assert.ok(plan.sizing.actualRiskUsd<=250);assert.equal(config.tickValueUsd,1);assert.equal(config.startingBalanceUsd,50000);
  const c=Array.from({length:5},(_,i)=>({timestamp:new Date(Date.parse('2026-09-08T13:35:00Z')+i*60000).toISOString(),open:i?2507:2502,high:2510,low:i?2506:2501,close:2508}));
  let r=core.trackTradeLifecycle(plan,c,config,{closeOpenAtEnd:false});assert.equal(r.status,'open');assert.equal(r.execution.currentStop,2500.9);
  c.push({timestamp:'2026-09-08T13:40:00Z',open:2500,high:2515,low:2499,close:2510});
  r=core.trackTradeLifecycle(plan,c,config,{closeOpenAtEnd:false});assert.equal(r.status,'closed');assert.equal(r.finalExitPrice,2499.8);assert.match(r.exitReason,/gap/);
});
test('short trailing tightens only after complete candles and never loosens',()=>{
 const c=Array.from({length:5},(_,i)=>({timestamp:new Date(Date.parse('2026-09-08T13:35:00Z')+i*60000).toISOString(),open:2490,high:2491,low:2488,close:2489}));
 assert.equal(gold.trail(c,'short',2500,2505,2505),2491.1);assert.equal(gold.trail(c.slice(1),'short',2500,2505,2505),2505);assert.equal(gold.trail(c,'short',2500,2505,2490),2490);
});
test('shared NQ backtest list never includes gold',()=>{assert.equal(require('../lib/strategy-registry.cjs').BACKTEST_STRATEGIES.some(s=>s.slug===gold.SLUG),false);});
test('live gold reader rejects a mislabeled NQ cache before using prices',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gold-identity-')),file=path.join(dir,'feed.json');
 const key=process.env.DATABENTO_API_KEY;process.env.DATABENTO_API_KEY='test';
 try {
  fs.writeFileSync(file,JSON.stringify({mode:'live',provider:'databento-live',symbol:'NQ.v.0',dataset:'GLBX.MDP3',schema:'ohlcv-1m',candles:bars()}));
  await assert.rejects(live.fetchLiveCandles({...config,live:{...config.live,liveCachePath:file}}),/identity mismatch/);
 } finally {if(key===undefined) delete process.env.DATABENTO_API_KEY;else process.env.DATABENTO_API_KEY=key;fs.rmSync(dir,{recursive:true,force:true});}
});
test('gold backtest executes a genuine next-bar trade using the same exit engine',()=>{
 const c=bars();c.push({timestamp:'2026-09-08T13:35:00Z',open:2502,high:2503,low:2490,close:2495,volume:100});
 const result=require('../lib/backtest-engine.cjs').runAllBacktests(c,config,{strategies:[require('../lib/strategy-registry.cjs').requireStrategyDefinition(gold.SLUG)]});
 assert.equal(result.strategies.length,1);assert.equal(result.strategies[0].trades.length,1);assert.ok(result.strategies[0].trades[0].realizedPnlUsd<0);
});
