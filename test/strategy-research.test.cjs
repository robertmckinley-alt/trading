const test=require('node:test'),assert=require('node:assert/strict');
const experiment=require('../lib/profit-experiment.cjs');
const common=require('../lib/regime-experiment.cjs');
const {normalizeConfig}=require('../lib/trader-core.cjs');
const now=Date.parse('2026-10-15T15:00:00Z');
const config=normalizeConfig({symbol:'NQ',startingBalanceUsd:50000,maxAccountDrawdownPercent:10,maxRiskPerTradeUsd:500,maxDailyLossUsd:750,tickSize:.25,tickValueUsd:5,commissionPerContractUsd:4.5,slippageTicks:1});
const history=()=>Array.from({length:15},(_,i)=>({timestamp:new Date(now-(15-i)*60000).toISOString(),open:100,high:103,low:97,close:100}));
const signal=(id='a')=>({id,parent:'nq-vwap-stretch-reversion',observedAt:new Date(now).toISOString(),config,setup:{symbol:'NQ',date:'2026-10-15',side:'long',entry:100,stop:95,targets:[120],execution:'next-bar-market',signalAvailableAt:new Date(now).toISOString(),signalOriginAvailableAt:new Date(now).toISOString(),orderExpiresAt:new Date(now+180000).toISOString(),setup:{},thesis:'test'}});
test('entry research ATR is causal and refuses missing completed minutes',()=>{
 const s=signal(),bars=history(),expected=experiment.entryEvidence(bars,s);
 assert.equal(expected.atr,6);assert.equal(expected.requestedStopDistance,5);
 assert.deepEqual(experiment.entryEvidence([...bars,{...bars[0],timestamp:new Date(now).toISOString(),high:1000}],s),expected);
 assert.equal(experiment.entryEvidence(bars.slice(1),s).valid,false);
 assert.equal(experiment.entryEvidence(bars.map((b,i)=>i===3?{...b,timestamp:bars[2].timestamp}:b),s).valid,false);
});
test('new research is matched, independent, preserves parent and blocks only tested arm',()=>{
 const s=signal(),before=JSON.stringify(s);
 const state=experiment.advanceResearch(null,[s],history(),now);
 assert.equal(state.version,experiment.RESEARCH_VERSION);
 assert.equal(state.events[0].arms['stop-one-atr'].decision,'filter-block');
 const accounts=Object.values(state.accounts);
 assert.equal(accounts.length,4);
 const control=accounts.find(a=>a.arm==='control'),half=accounts.find(a=>a.arm==='stop-room-half');
 assert.equal(control.open.plan.setup.minimumRemainingStopRiskFraction,undefined);
 assert.equal(half.open.plan.setup.minimumRemainingStopRiskFraction,.5);
 assert.equal(control.open.plan.sizing.maxContracts,half.open.plan.sizing.maxContracts);
 assert.equal(JSON.stringify(s),before);
 assert.throws(()=>experiment.advance(state,[],history(),now),/version mismatch/);
});
test('research expiry remains anchored to original signal and never extends deadline',()=>{
 const s=signal();s.setup.execution='limit-touch';s.setup.setup.entryModel='dmc-level-to-level';s.setup.orderExpiresAt=new Date(now+900000).toISOString();
 const state=experiment.advanceResearch(null,[s],history(),now),accounts=Object.values(state.accounts);
 const control=accounts.find(a=>a.arm==='control'),fresh=accounts.find(a=>a.arm==='fresh-entry-3m');
 assert.equal(Date.parse(control.open.plan.setup.orderExpiresAt),now+900000);
 assert.equal(Date.parse(fresh.open.plan.setup.orderExpiresAt),now+180000);
});
test('cohort will not give a faster filtered/expired arm extra opportunities',()=>{
 const state=experiment.advanceResearch(null,[signal()],history(),now);
 const second=signal('b');second.observedAt=new Date(now+1000).toISOString();
 const next=experiment.advanceResearch(state,[second],history(),now+1000);
 assert.equal(next.events[1].status,'excluded');assert.match(next.events[1].reason,/busy/);
});
test('current research report never pairs an old intrabar-policy outcome',()=>{
 const state=experiment.advanceResearch(null,[signal()],history(),now);
 const current=state.events[0];current.arms.control.outcome={pnlUsd:-10};current.arms['stop-room-half'].outcome={pnlUsd:0};
 const old=structuredClone(current);old.id='old';old.intrabarPolicyVersion='legacy';old.arms.control.outcome.pnlUsd=-1000;state.events.push(old);
 const account=experiment.report(state).accounts.find(a=>a.arm==='stop-room-half');
 assert.equal(account.pairedComparisons,1);assert.equal(account.pairedDeltaUsd,10);
});
test('captured strategy configuration is immutable when fallback recaptures same plan',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'entry-capture-'));
 try {
  const dir=experiment.folder(root);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({enabled:true,entryResearchEnabled:true}));
  const s=signal(),cfg={...config,strategySlug:s.parent,maxRiskPerTradeUsd:123};
  experiment.capture(root,cfg,{setup:s.setup,}); // requires actual observedAt, as the live watcher does
  s.setup.observedAt=s.observedAt;
  experiment.capture(root,cfg,{setup:s.setup});
  experiment.capture(root,{...cfg,maxRiskPerTradeUsd:999},{setup:s.setup});
  const files=fs.readdirSync(path.join(dir,'signals'));assert.equal(files.length,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'signals',files[0]))).config.maxRiskPerTradeUsd,123);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('worker persists separate research state and refuses corrupt research balances',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'entry-worker-'));
 try {
  const dir=experiment.folder(root);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({enabled:true,parents:[],entryResearchEnabled:true,entryResearchVersion:experiment.RESEARCH_VERSION}));
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({...config,live:{liveCachePath:'runtime/candles.json'}}));
  fs.writeFileSync(path.join(root,'runtime/candles.json'),JSON.stringify({candles:history()}));
  const {tickAt}=require('../scripts/profit-paper.cjs');tickAt(root,now);
  let report=JSON.parse(fs.readFileSync(path.join(dir,'report.json')));
  assert.equal(report.entryResearch.version,experiment.RESEARCH_VERSION);
  const s=signal();s.setup.observedAt=s.observedAt;
  experiment.capture(root,{...config,strategySlug:s.parent},{setup:s.setup});tickAt(root,now+1000);
  report=JSON.parse(fs.readFileSync(path.join(dir,'report.json')));
  assert.equal(report.entryResearch.accounts.length,4);
  assert.ok(report.entryResearch.accounts.every(a=>a.id.startsWith(experiment.RESEARCH_VERSION)));
  fs.writeFileSync(path.join(dir,'entry-research-state.json'),'{bad');
  assert.throws(()=>tickAt(root,now+2000),/refusing to reset balances/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('already aged research signal filters only the short-TTL arm while control observes it',()=>{
 const s=signal();s.setup.execution='limit-touch';s.setup.setup.entryModel='dmc-level-to-level';s.setup.signalOriginAvailableAt=new Date(now-240000).toISOString();s.setup.orderExpiresAt=new Date(now+660000).toISOString();
 const state=experiment.advanceResearch(null,[s],history(),now);
 assert.equal(state.events[0].status,'observed');assert.equal(state.events[0].arms['fresh-entry-3m'].decision,'filter-block');
 assert.ok(Object.values(state.accounts).find(a=>a.arm==='control').open);
});
test('ATR evidence rejects mixed contracts and nonpositive prices',()=>{
 const rows=history().map(c=>({...c,instrumentId:123}));rows[5].instrumentId=124;
 assert.equal(experiment.entryEvidence(rows,signal()).valid,false);
 const invalid=history();invalid[3].low=0;assert.equal(experiment.entryEvidence(invalid,signal()).valid,false);
});
