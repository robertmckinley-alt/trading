const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const m=require('../lib/regime-model.cjs'),e=require('../lib/regime-experiment.cjs');
const core=require('../lib/trader-core.cjs');
const start=Date.parse('2026-10-05T12:00:00Z'),now=start+120*60000+1000;
const at=minutes=>new Date(start+minutes*60000).toISOString();
const candles=Array.from({length:120},(_,i)=>({timestamp:at(i),open:100,high:100.5,low:99.5,close:100+Math.sin(i)*.01,volume:100,instrumentId:1}));
const frozen=()=>({version:m.VERSION,symbol:'NQ',features:m.FEATURES,trainedThrough:'2026-09-01T00:00:00Z',usableAfter:'2026-09-15T00:00:00Z',scaler:{mean:[0,0,0,0,0],scale:[1,1,1,1,1]},means:[[0,0,0,0,0],[100,100,100,100,100]],variances:[[1,1,1,1,1],[1,1,1,1,1]],start:[.5,.5],transition:[[.95,.05],[.05,.95]],labels:['range','high-volatility'],highVolatility:.1,evidence:{status:'test-fixture'}});
const config=core.normalizeConfig({symbol:'NQ',startingBalanceUsd:50000,maxAccountDrawdownPercent:10,maxRiskPerTradeUsd:500,maxDailyLossUsd:750,tickSize:.25,tickValueUsd:5,slippageTicks:1,commissionPerContractUsd:4.5,defaultScaleOuts:[{targetIndex:0,closeFraction:1}]});
const signal=()=>({id:'signal-1',parent:'nq-15m-orb-close-confirmation',family:'cash-breakout',observedAt:at(120),config,setup:{symbol:'NQ',date:'2026-10-05',side:'long',entry:100,stop:95,targets:[110],execution:'next-bar-market',signalAvailableAt:at(120),detectedAt:at(119),setup:{},thesis:'fixture'}});
const init=()=>e.initial(now-60000,frozen());
test('causal features ignore future and unfinished candles, and never bridge a roll or missing minute',()=>{
  const rows=m.features(candles,now);
  const future=[...candles,{...candles.at(-1),timestamp:at(120),close:100000,high:100001}];
  assert.deepEqual(m.features(future,now),rows);
  assert.equal(m.features(candles.filter((_,i)=>i!==90),now).length,30);
  const roll=candles.map((c,i)=>({...c,instrumentId:i<90?1:2}));
  assert.equal(m.features(roll,now).length,30);
  assert.throws(()=>m.features([...candles,candles[0]],now),/ordered/);
});
test('forward recursion agrees with a hand-computed Gaussian Bayes update',()=>{
  const f=frozen();f.means=[[0,0,0,0,0],[1,0,0,0,0]];
  const result=m.step(f,[0,0,0,0,0],null);
  assert.ok(Math.abs(result.probabilities[0]-1/(1+Math.exp(-.5)))<1e-12);
  const prior=[.8,.2],prediction=.8*.95+.2*.05;
  assert.ok(Math.abs(m.step(f,[0,0,0,0,0],prior).probabilities[0]-prediction/(prediction+(1-prediction)*Math.exp(-.5)))<1e-12);
});
test('streaming inference matches batch filtering; adding future rows does not revise a saved decision',()=>{
  const rows=m.features(candles,now),f=frozen();
  const first=m.classify(rows.slice(0,30),f);
  const snapshot=structuredClone(first);
  const resumed=m.classify(rows,f,first);
  assert.deepEqual(resumed,m.classify(rows,f));assert.deepEqual(first,snapshot);
  assert.equal(m.classify(rows,{...f,usableAfter:at(120)}).status,'warming-up');
});
test('invalid probabilities, emissions and scalers fail closed',()=>{
  for(const edit of [{start:[2,-1]},{variances:[[0,1,1,1,1],[1,1,1,1,1]]},{scaler:{mean:[0,0,0,0,0],scale:[0,1,1,1,1]}}])assert.throws(()=>m.validate({...frozen(),...edit}));
});
test('four independent accounts share future availability and preserve parent inputs',()=>{
  const s=signal(),original=structuredClone(s),state=init(),prior=structuredClone(state);
  const next=e.advance(state,[s],candles,now,frozen());
  assert.deepEqual(state,prior);assert.deepEqual(s,original);
  assert.equal(Object.keys(next.accounts).length,4);
  assert.ok(Object.values(next.accounts).every(a=>a.balanceUsd===50000));
  const control=next.accounts[`${s.parent}:control`],sizing=next.accounts[`${s.parent}:hmm-sizing`];
  assert.equal(control.open.plan.setup.signalAvailableAt,at(121));
  assert.equal(sizing.open.plan.setup.signalAvailableAt,at(121));
  assert.ok(sizing.open.plan.sizing.maxContracts<control.open.plan.sizing.maxContracts);
  assert.equal(next.events[0].arms['hmm-filter'].decision,'regime-block');
  assert.equal(e.advance(next,[s],candles,now,frozen()).events.length,1);
});
test('blocked loser resolves to avoided loss and blocked winner resolves to missed profit, with costs',()=>{
  for(const win of [false,true]) {
    const s=signal(),next=e.advance(init(),[s],candles,now,frozen());
    const bar={timestamp:at(121),open:100,close:win?110:95,high:win?111:101,low:win?99:94,volume:100,instrumentId:1};
    const done=e.advance(next,[],[...candles,{...candles.at(-1),timestamp:at(120)},bar],start+122*60000,frozen());
    const report=e.report(done),control=report.accounts.find(a=>a.arm==='control'),filter=report.accounts.find(a=>a.arm==='hmm-filter');
    assert.equal(control.trades,1);assert.equal(filter.trades,0);assert.equal(filter.pairedComparisons,1);
    if(win){assert.ok(control.realizedPnlUsd>0);assert.equal(filter.missedProfit,control.realizedPnlUsd);assert.equal(filter.lossesAvoided,0);}
    else{assert.ok(control.realizedPnlUsd<0);assert.equal(filter.lossesAvoided,-control.realizedPnlUsd);assert.equal(filter.missedProfit,0);}
    assert.equal(filter.pairedDeltaUsd,-control.realizedPnlUsd);
    const restored=e.advance(JSON.parse(JSON.stringify(done)),[],[...candles,bar],start+122*60000,frozen());
    assert.equal(e.report(restored).accounts.find(a=>a.arm==='control').trades,1);
  }
});
test('future, stale or pre-cohort signals never create retrospective fills',()=>{
  for(const time of [at(123),at(110),at(119)]) {
    const next=e.advance(e.initial(now,frozen()),[{...signal(),observedAt:time}],candles,now,frozen());
    assert.equal(Object.keys(next.accounts).length,0);assert.equal(next.events[0].status,'excluded');
  }
});
test('missing execution candles block outcomes and retain position until data is recovered',()=>{
  const next=e.advance(init(),[signal()],candles,now,frozen());
  const bars=[{timestamp:at(121),open:100,close:100,high:101,low:99,volume:100,instrumentId:1},{timestamp:at(123),open:100,close:94,high:101,low:94,volume:100,instrumentId:1}];
  const broken=e.advance(next,[],[...candles,...bars],start+124*60000,frozen());
  const a=broken.accounts[`${signal().parent}:control`];assert.equal(a.status,'data-gap');assert.equal(a.trades.length,0);assert.ok(a.open);
  const repaired=e.advance(broken,[],[{...bars[0],timestamp:at(122)}],start+124*60000,frozen());
  assert.equal(repaired.accounts[a.id].trades.length,1);
});
test('daily loss and account floor cap each arm independently; a frozen risk config cannot drift',()=>{
  let next=e.advance(init(),[signal()],candles,now,frozen());
  for(const a of Object.values(next.accounts)){a.open=null;a.trades=[{date:'2026-10-05',realizedPnlUsd:-750}];a.realizedPnlUsd=-750;a.balanceUsd=49250;}
  next=e.advance(next,[{...signal(),id:'signal-2'}],candles,now,frozen());
  assert.match(next.events.at(-1).arms.control.reason,/Daily loss/);
  for(const a of Object.values(next.accounts)){a.trades=[];a.realizedPnlUsd=-5000;a.balanceUsd=45000;}
  next=e.advance(next,[{...signal(),id:'signal-3'}],candles,now,frozen());
  assert.match(next.events.at(-1).arms.control.reason,/drawdown guard/);
  next=e.advance(next,[{...signal(),id:'signal-4',config:{...config,maxRiskPerTradeUsd:1000}}],candles,now,frozen());
  assert.match(next.events.at(-1).arms.control.reason,/settings changed/);
});
test('model replacement cannot silently contaminate an existing cohort',()=>{
  assert.throws(()=>e.advance(init(),[],candles,now,{...frozen(),highVolatility:.2}),/mismatch/);
});
test('signal capture is opt-in and never copies credentials or modifies parent state',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'regime-'));
  try {
    const s=signal(),p={setup:{...s.setup,observedAt:s.observedAt}},cfg={...config,strategySlug:s.parent,strategyFamily:s.family,apiKey:'do-not-copy'};
    e.capture(root,cfg,p);assert.equal(fs.existsSync(e.folder(root)),false);
    fs.mkdirSync(e.folder(root),{recursive:true});e.atomic(path.join(e.folder(root),'settings.json'),{enabled:true,parents:[s.parent]});
    e.capture(root,cfg,p);e.capture(root,cfg,p);
    const files=fs.readdirSync(path.join(e.folder(root),'signals'));assert.equal(files.length,1);
    assert.equal(fs.readFileSync(path.join(e.folder(root),'signals',files[0]),'utf8').includes('do-not-copy'),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
