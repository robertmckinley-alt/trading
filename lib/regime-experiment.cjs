// Independent counterfactual paper accounts. Never write parent state or submit orders.
const fs=require('node:fs'), path=require('node:path');
const model=require('./regime-model.cjs');
const {buildPlanFromSignal}=require('./live-trader.cjs');
const {trackTradeLifecycle,toJournalTrade,createEmptyState,normalizeConfig}=require('./trader-core.cjs');
const {bindForwardObservation}=require('./watcher-observation.cjs');
const VERSION='regime-paper-v1';
const ARMS=['control','simple-filter','hmm-filter','hmm-sizing'];
const FAMILIES=['cash-breakout','trend-momentum','value-reversion','liquidity-reversal'];
const ms=Date.parse;
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const atomic=(file,data)=>{const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(data));fs.renameSync(tmp,file);};
const folder=root=>path.join(root,'runtime/regime-experiment');
function capture(root,config,plan) {
  // Runtime opt-in. Original watchers do no experiment work before activation.
  const settings=read(path.join(folder(root),'settings.json'));
  if(settings?.enabled!==true || config.accountType==='challenger' || config.symbol!=='NQ' || !FAMILIES.includes(config.strategyFamily) || !settings.parents?.includes(config.strategySlug))return;
  const observedAt=plan.setup.observedAt;
  if(!Number.isFinite(ms(observedAt)))return;
  const id=model.digest([config.strategySlug,observedAt,plan.setup]);
  const queue=path.join(folder(root),'signals');fs.mkdirSync(queue,{recursive:true});
  const allowed=['symbol','startingBalanceUsd','maxAccountDrawdownPercent','maxRiskPerTradeUsd','maxDailyLossUsd','tickSize','tickValueUsd','commissionPerContractUsd','slippageTicks','minimumRMultiple','sameCandleConflict','limitFillModel','defaultScaleOuts'];
  const riskConfig=Object.fromEntries(allowed.map(k=>[k,config[k]]));
  riskConfig.startingBalanceUsd=50000;
  const event={id,parent:config.strategySlug,family:config.strategyFamily,observedAt,setup:plan.setup,config:riskConfig};
  // Unique ID and atomic rename; no keys, headers or environment variables in events.
  atomic(path.join(queue,`${id}.json`),event);
}
function initial(now, frozen) {
  return {version:VERSION,startedAt:new Date(now).toISOString(),modelId:model.digest(frozen),model:structuredClone(frozen),accounts:{},events:[],seen:[],cursor:null};
}
function account(state,parent,arm,config) {
  const id=`${parent}:${arm}`;
  state.accounts[id]??={...createEmptyState(config),id,parent,arm,config:structuredClone(config),open:null,peakEquityUsd:50000,maxDrawdownUsd:0,status:'collecting'};
  return state.accounts[id];
}
function validPath(candles,start,end) {
  const rows=candles.filter(c=>ms(c.timestamp)>=start && ms(c.timestamp)<=end);
  return rows.length>0 && ms(rows[0].timestamp)===start && ms(rows.at(-1).timestamp)===end && rows.every((c,i)=>['open','high','low','close'].every(k=>Number.isFinite(c[k])) && c.low>0 && c.high>=Math.max(c.open,c.close) && c.low<=Math.min(c.open,c.close) && (!i || (ms(c.timestamp)-ms(rows[i-1].timestamp)===60000 && (c.instrumentId??c.instrument_id)===(rows[0].instrumentId??rows[0].instrument_id))));
}
function settle(state,candles,now) {
  for(const a of Object.values(state.accounts)) {
    if(!a.open)continue;
    const {plan,eventId}=a.open;
    const start=ms(plan.setup.signalAvailableAt);
    const end=Math.floor(now/60000)*60000-60000;
    if(end<start)continue;
    // Accumulate the complete path across cache rotation and process restarts.
    const saved=new Map((a.open.candles||[]).map(c=>[c.timestamp,c]));
    for(const c of candles)if(ms(c.timestamp)>=start && ms(c.timestamp)<=end)saved.set(c.timestamp,c);
    const all=[...saved.values()].sort((x,y)=>ms(x.timestamp)-ms(y.timestamp));
    a.open.candles=all;
    const contiguous=[];
    for(const c of all) {
      const expected=start+contiguous.length*60000;
      if(!validPath([c],expected,expected) || (contiguous.length && (c.instrumentId??c.instrument_id)!==(contiguous[0].instrumentId??contiguous[0].instrument_id)))break;
      contiguous.push(c);
    }
    if(!contiguous.length) {a.status='data-gap';continue;}
    const complete=ms(contiguous.at(-1).timestamp)===end;
    const life=trackTradeLifecycle(plan,contiguous,a.config,{closeOpenAtEnd:false,now});
    a.open.lifecycle=life;
    const equity=50000+a.realizedPnlUsd+Number(life.realizedPnlUsd||0)+Number(life.unrealizedPnlUsd||0);
    a.peakEquityUsd=Math.max(a.peakEquityUsd,equity);
    a.maxDrawdownUsd=Math.max(a.maxDrawdownUsd,a.peakEquityUsd-equity);
    if(life.status==='closed') {
      const trade={...toJournalTrade(plan,life),evidenceType:state.evidenceType||'forward-regime-paper',eventId};
      a.trades.push(trade);a.realizedPnlUsd=Math.round((a.realizedPnlUsd+trade.realizedPnlUsd)*100)/100;
      a.balanceUsd=50000+a.realizedPnlUsd;a.open=null;a.status='collecting';
      state.events.find(e=>e.id===eventId).arms[a.arm].outcome={status:'closed',pnlUsd:trade.realizedPnlUsd};
    } else if(life.status==='not-filled' && ((ms(contiguous.at(-1).timestamp)+60000>=ms(plan.setup.orderExpiresAt)) || ['entry gap beyond stop or target','entry gap exceeds risk budget','entry gap below minimum reward/risk','entry drift exceeds limit','invalid order timing','order expired'].includes(life.exitReason))) {
      state.events.find(e=>e.id===eventId).arms[a.arm].outcome={status:'unfilled',pnlUsd:0};
      a.open=null;a.status='collecting';
    } else a.status=complete?'collecting':'data-gap';
  }
}
function advance(previous,signals,candles,now,frozen) {
  model.validate(frozen);
  const state=structuredClone(previous||initial(now,frozen));
  if(state.version!==VERSION || state.modelId!==model.digest(frozen))throw Error('Frozen cohort/model mismatch; create a new experiment directory');
  settle(state,candles,now);
  const rows=model.features(candles,now);
  state.cursor=model.classify(rows,frozen,state.cursor);
  const latest=rows.at(-1);
  const ready=state.cursor.status==='ready' && latest && state.cursor.lastAt===latest.availableAt && now-ms(latest.availableAt)<=120000;
  state.status=ready?'collecting':'waiting-for-fresh-model-state';
  for(const signal of signals.sort((a,b)=>ms(a.observedAt)-ms(b.observedAt))) {
    if(state.seen.includes(signal.id))continue;
    state.seen.push(signal.id);
    if(!ready || now-ms(signal.observedAt)>120000 || ms(signal.observedAt)>now || ms(signal.observedAt)<ms(state.startedAt)) {
      state.events.push({id:signal.id,parent:signal.parent,observedAt:signal.observedAt,status:'excluded',reason:'Not observed prospectively with a fresh, warmed model',arms:{}});continue;
    }
    const config=normalizeConfig({...signal.config,startingBalanceUsd:50000});
    const event={id:signal.id,parent:signal.parent,observedAt:signal.observedAt,decisionAt:new Date(now).toISOString(),status:'observed',regime:{label:state.cursor.label,probability:state.cursor.probability,uncertain:state.cursor.uncertain,probabilities:state.cursor.probabilities,lastAt:state.cursor.lastAt,modelId:state.modelId},arms:{}};
    state.events.push(event);
    for(const arm of ARMS) {
      const a=account(state,signal.parent,arm,config);
      if(model.digest(a.config)!==model.digest(config)) {event.arms[arm]={decision:'risk-block',reason:'Parent risk settings changed; frozen cohort requires a new version'};continue;}
      const classification=arm==='simple-filter'?model.simple(latest,frozen):state.cursor;
      const scale=arm==='control'?1:model.multiplier(classification,signal.family,signal.setup.side,arm==='hmm-sizing');
      event.arms[arm]={decision:scale===0?'regime-block':scale===1?'full-risk':'half-risk',riskMultiplier:scale};
      if(scale===0)continue;
      if(a.open) {event.arms[arm]={decision:'risk-block',reason:'Account already has an open or pending order'};continue;}
      const daily=a.trades.filter(t=>t.date===signal.setup.date).reduce((s,t)=>s+t.realizedPnlUsd,0);
      const remainingDaily=Math.max(0,config.maxDailyLossUsd+Math.min(0,daily));
      const risk=Math.min(config.maxRiskPerTradeUsd*scale,remainingDaily);
      try {
        if(risk<=0)throw Error('Daily loss guard');
        const plan=buildPlanFromSignal({found:true,setup:structuredClone(signal.setup),triggerTimestamp:signal.setup.signalAvailableAt,metadata:{regime:event.regime,eventId:signal.id}}, {...config,maxRiskPerTradeUsd:risk},a);
        // All arms share this same prospective observation time and fill engine.
        bindForwardObservation(plan,now);
        a.open={eventId:signal.id,plan,candles:[]};
        event.arms[arm].contracts=plan.sizing.maxContracts;
      } catch(e) {event.arms[arm]={decision:'risk-block',reason:e.message,riskMultiplier:scale};}
    }
  }
  state.updatedAt=new Date(now).toISOString();
  return state;
}
function report(state) {
  if(!state)return {status:'not-started',accounts:[],events:[]};
  const accounts=Object.values(state.accounts).map(a=>{
    const grossWin=a.trades.reduce((s,t)=>s+Math.max(0,t.realizedPnlUsd),0),grossLoss=a.trades.reduce((s,t)=>s+Math.max(0,-t.realizedPnlUsd),0);
    const blocked=state.events.filter(e=>e.parent===a.parent && e.arms[a.arm]?.decision==='regime-block' && e.arms.control?.outcome?.status==='closed');
    const lossesAvoided=blocked.reduce((s,e)=>s+Math.max(0,-e.arms.control.outcome.pnlUsd),0);
    const missedProfit=blocked.reduce((s,e)=>s+Math.max(0,e.arms.control.outcome.pnlUsd),0);
    const control=state.accounts[`${a.parent}:control`];
    // Only resolve comparisons once both sides have a known terminal result.
    const paired=state.events.filter(e=>e.parent===a.parent && e.arms.control?.outcome && (e.arms[a.arm]?.outcome || e.arms[a.arm]?.decision==='regime-block'));
    const pairedDelta=paired.reduce((s,e)=>s+(e.arms[a.arm]?.outcome?.pnlUsd||0)-e.arms.control.outcome.pnlUsd,0);
    return {id:a.id,parent:a.parent,arm:a.arm,status:a.status,balanceUsd:a.balanceUsd,realizedPnlUsd:a.realizedPnlUsd,trades:a.trades.length,winRate:a.trades.length?a.trades.filter(t=>t.realizedPnlUsd>0).length/a.trades.length:null,profitFactor:grossLoss?grossWin/grossLoss:null,expectancyUsd:a.trades.length?a.realizedPnlUsd/a.trades.length:null,maxDrawdownUsd:a.maxDrawdownUsd,unrealizedPnlUsd:a.open?.lifecycle?.unrealizedPnlUsd||0,partialPnlUsd:a.open?.lifecycle?.realizedPnlUsd||0,open:a.open?true:false,lossesAvoided,missedProfit,filterNetUsd:lossesAvoided-missedProfit,blockedResolved:blocked.length,pairedComparisons:paired.length,pairedDeltaUsd:pairedDelta,deltaUsd:a.realizedPnlUsd-(control?.realizedPnlUsd||0)};
  });
  return {version:VERSION,status:state.status,startedAt:state.startedAt,updatedAt:state.updatedAt,modelId:state.modelId,modelEvidence:state.model.evidence,regime:state.cursor,accounts,events:state.events.slice(-100).reverse(),excludedSignals:state.events.filter(e=>e.status==='excluded').length,scope:'Copies of admitted parent signals only. Independent $50,000 accounts, frozen fixed-risk rules, shared prospective observation time. Not a test of signals rejected by the parent.'};
}
module.exports={settle,account,VERSION,ARMS,FAMILIES,read,atomic,folder,capture,initial,advance,report,validPath};
