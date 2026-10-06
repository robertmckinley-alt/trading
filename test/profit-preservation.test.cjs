const test=require('node:test'),assert=require('node:assert/strict');
const core=require('../lib/trader-core.cjs');
const {deadlines}=require('../lib/execution-policy.cjs');
const {bindForwardObservation}=require('../lib/watcher-observation.cjs');
const experiment=require('../lib/profit-experiment.cjs');
const config=core.normalizeConfig({startingBalanceUsd:50000,maxAccountDrawdownPercent:10,maxRiskPerTradeUsd:500,maxDailyLossUsd:750,tickSize:.25,tickValueUsd:5,commissionPerContractUsd:4.5,slippageTicks:1,sameCandleConflict:'stop-first'});
const at=m=>`2026-10-06T16:${String(m).padStart(2,'0')}:00Z`;
const bar=(m,open,high,low,close)=>({timestamp:at(m),open,high,low,close});
function plan(protection='profit-lock-v1',side='long') {
 return {setup:{side,entry:100,stop:side==='long'?95:105,execution:'next-bar-market',signalAvailableAt:at(1),orderExpiresAt:at(4),profitProtection:protection},
  targets:[{price:side==='long'?130:70,closeFraction:1}],sizing:{maxContracts:4,riskBudgetUsd:500,actualRiskUsd:440}};
}
const track=(p,b)=>core.trackTradeLifecycle(p,b,config,{closeOpenAtEnd:false});
test('profit lock uses completed closes and cannot retroactively stop the activation candle',()=>{
 const p=plan(),b=[bar(1,100,102,99,101),bar(2,101,110,99,106)];
 const live=track(p,b);assert.equal(live.status,'open');assert.equal(live.execution.currentStop,100.75);
 assert.equal(live.execution.stopChanges[0].effectiveAt,at(3).replace('Z','.000Z'));
 const stopped=track(p,[...b,bar(3,101,102,100,101)]);
 assert.equal(stopped.finalExitPrice,100.5);assert.ok(stopped.realizedPnlUsd>=0);
 assert.equal(track(plan(null),[...b,bar(3,101,102,100,101)]).status,'open');
});
test('intrabar MFE without a confirming close never tightens the stop',()=>{
 const r=track(plan(),[bar(1,100,115,99,101)]);assert.equal(r.execution.currentStop,95);
});
test('stop only tightens, mirrors shorts, and adverse gaps can still lose money',()=>{
 const p=plan(),b=[bar(1,100,102,99,101),bar(2,101,113,100,112),bar(3,112,113,108,109)];
 const r=track(p,b);assert.equal(r.status,'open');assert.ok(r.execution.currentStop>106);
 assert.ok(r.execution.stopChanges.every(s=>s.to>s.from));
 const gap=track(p,[...b,bar(4,90,95,89,91)]);assert.equal(gap.finalExitPrice,89.75);assert.ok(gap.realizedPnlUsd<0);
 const short=track(plan('profit-lock-v1','short'),[bar(1,100,101,99,99),bar(2,99,101,89,94),bar(3,99,100,98,99)]);
 assert.equal(short.finalExitPrice,99.5);assert.ok(short.realizedPnlUsd>=0);
});
test('partial exit is whole contracts, remaining contracts trail, and one contract cannot be divided',()=>{
 const p=plan('partial-trail-v1'),bars=[bar(1,100,101,99,100),bar(2,100,107,99,106)];
 const r=track(p,bars);assert.equal(r.contracts,4);assert.equal(r.remainingContracts,2);assert.ok(r.realizedPnlUsd>0);
 const one=structuredClone(p);one.sizing.maxContracts=1;
 const closed=track(one,bars);assert.equal(closed.status,'closed');assert.equal(closed.contracts,1);
 const conflict=track(p,[bar(1,100,107,94,106)]);assert.equal(conflict.exitReason,'stop-loss same-candle conflict');assert.deepEqual(conflict.targetsHit,[]);
});
test('VWAP actual-fill RR and entry drift reject poor fills and release pending plans',()=>{
 for(const [guards,reason]of [[{minimumEntryRewardRisk:1},'entry gap below minimum reward/risk'],[{maximumAdverseEntryRiskFraction:.25},'entry drift exceeds limit']]) {
  const p=plan(null);Object.assign(p.setup,{entry:31526,stop:31517.5,...guards});p.targets=[{price:31545,closeFraction:1}];
  const r=track(p,[bar(1,31536,31540,31535,31537)]);assert.equal(r.status,'not-filled');assert.equal(r.exitReason,reason);
  const state={live:{openPlan:p}};assert.equal(require('../lib/live-trader.cjs').clearTerminalUnfilledPlan(state,r),true);
 }
});
test('generic three-minute expiry stays anchored and rejects the reported eleven-minute delay',()=>{
 const p=plan(null);p.setup.signalAvailableAt=at(0);delete p.setup.orderExpiresAt;deadlines(p.setup);
 bindForwardObservation(p,Date.parse(at(0))+30000);bindForwardObservation(p,Date.parse(at(1))+1000);
 assert.equal(p.setup.orderExpiresAt,at(3).replace('Z','.000Z'));
 assert.equal(track(p,[bar(11,100,101,99,100)]).exitReason,'order expired');
 delete p.setup.orderExpiresAt;assert.equal(track(p,[bar(2,100,101,99,100)]).exitReason,'invalid order timing');
});
test('filters ignore future candles and reject missing history',()=>{
 const signal={observedAt:at(1),setup:{side:'long'}};
 assert.deepEqual(experiment.filters([bar(20,100,200,99,199)],signal),{trend:false,reversal:false});
});
test('cohort rejects retrospective signals and never mutates parent inputs',()=>{
 const signal={id:'past',parent:'live-9am-sweep',observedAt:at(0),setup:plan().setup,config};
 const before=JSON.stringify(signal),now=Date.parse(at(2));
 const state=experiment.advance(null,[signal],[bar(1,100,101,99,100)],now);
 assert.equal(state.events[0].status,'excluded');assert.equal(JSON.stringify(signal),before);
 assert.equal(Object.keys(state.accounts).length,0);
});
test('worker creates, resumes and settles matched accounts without rewriting parent state',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'profit-paper-'));
 const {tickAt}=require('../scripts/profit-paper.cjs');
 try {
  const dir=path.join(root,'runtime/profit-experiment');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({enabled:true,parents:['live-9am-sweep']}));
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({...config,live:{liveCachePath:'runtime/candles.json'}}));
  const cache=bars=>fs.writeFileSync(path.join(root,'runtime/candles.json'),JSON.stringify({candles:bars}));
  cache([bar(0,100,101,99,100)]);tickAt(root,Date.parse(at(1)));
  const parent={trades:[],live:{openPlan:{setup:{...plan(null).setup,symbol:'NQ',date:'2026-10-06',targets:[130],thesis:'fixture',setup:{},signalAvailableAt:at(1),observedAt:at(1)}}}};
  const parentFile=path.join(root,'state.json'),original=JSON.stringify(parent);fs.writeFileSync(parentFile,original);
  tickAt(root,Date.parse(at(1))+1000);
  let state=JSON.parse(fs.readFileSync(path.join(dir,'state.json')));
  assert.equal(Object.keys(state.accounts).length,3);
  assert.ok(Object.values(state.accounts).every(a=>a.open));
  const opens=Object.values(state.accounts).map(a=>a.open.plan);
  assert.equal(new Set(opens.map(p=>p.setup.signalAvailableAt)).size,1);
  assert.equal(new Set(opens.map(p=>p.sizing.maxContracts)).size,1);
  const bars=[bar(2,100,102,99,101),bar(3,101,112,100,111),bar(4,105,106,94,95)];
  cache(bars.slice(0,2));tickAt(root,Date.parse(at(4)));
  // Rotating cache keeps the saved earlier path, including the original fill.
  cache(bars.slice(-1));tickAt(root,Date.parse(at(5)));
  state=JSON.parse(fs.readFileSync(path.join(dir,'state.json')));
  assert.ok(Object.values(state.accounts).every(a=>a.trades.length===1));
  assert.equal(state.events.length,1);
  const report=experiment.report(state);assert.ok(report.accounts.every(a=>a.pairedComparisons===1));
  assert.ok(report.accounts.find(a=>a.arm==='profit-lock').pairedDeltaUsd>0);
  assert.equal(fs.readFileSync(parentFile,'utf8'),original);
  fs.writeFileSync(path.join(dir,'state.json'),'{bad');assert.throws(()=>tickAt(root,Date.parse(at(6))),/refusing to reset/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('limit entry candle cannot award the new partial target or tighten the stop using pre-fill prices',()=>{
 const p=plan('partial-trail-v1');p.setup.execution='limit-touch';
 const r=track(p,[bar(1,110,111,99,110)]);
 assert.equal(r.status,'open');assert.equal(r.remainingContracts,r.contracts);assert.equal(r.execution.currentStop,95);assert.deepEqual(r.targetsHit,[]);
});
test('trend and reversal filters use a completed contiguous history and are causal',()=>{
 const observed=Date.parse(at(1));
 const rows=Array.from({length:60},(_,i)=>({timestamp:new Date(observed-(60-i)*60000).toISOString(),open:100+i,high:100.75+i,low:99.5+i,close:100.5+i}));
 const signal={observedAt:at(1),setup:{side:'long'}};
 const expected={trend:true,reversal:true};
 assert.deepEqual(experiment.filters(rows,signal),expected);
 assert.deepEqual(experiment.filters([...rows,{...rows.at(-1),timestamp:at(2),close:0}],signal),expected);
 assert.deepEqual(experiment.filters(rows.filter((_,i)=>i!==20),signal),{trend:false,reversal:false});
});
