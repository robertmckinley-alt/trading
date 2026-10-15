// Frozen forward-only, matched paper cohorts. No parent writes or broker calls.
const fs=require('node:fs'),path=require('node:path');
const common=require('./regime-experiment.cjs');
const {digest}=require('./regime-model.cjs');
const {normalizeConfig}=require('./trader-core.cjs');
const {buildPlanFromSignal}=require('./live-trader.cjs');
const {bindForwardObservation}=require('./watcher-observation.cjs');
const VERSION='profit-preservation-v1';
const RESEARCH_VERSION='entry-research-v1-post-fill';
const RESEARCH_ARMS=['control','fresh-entry-3m','stop-room-half','stop-one-atr'];
const PARENTS=['live-9am-sweep','nq-vwap-stretch-reversion','volume-poc-reversion','hourly-sweep-ifvg-bos'];
const RESEARCH_PARENTS=[...PARENTS,'nq-15m-opening-range-retest','nq-15m-orb-close-confirmation','nq-opening-range-breakout','nq-dmc-failed-level-reversal','nq-dmc-gain-retest','nq-fresh-level-retest'];
const folder=root=>path.join(root,'runtime/profit-experiment');
const armsFor=parent=>['control','profit-lock','partial-trail',...(['volume-poc-reversion','hourly-sweep-ifvg-bos'].includes(parent)?['trend-confirm','reversal-confirm']:[])];
function capture(root,config,plan) {
  const settings=common.read(path.join(folder(root),'settings.json'));
  if(settings?.enabled!==true || !(PARENTS.includes(config.strategySlug)||(settings.entryResearchEnabled===true&&RESEARCH_PARENTS.includes(config.strategySlug))) || config.accountType==='challenger' || (config.symbol&&config.symbol!=='NQ'))return;
  if(!Number.isFinite(Date.parse(plan.setup.observedAt)))return;
  const keys=['symbol','startingBalanceUsd','maxAccountDrawdownPercent','maxRiskPerTradeUsd','maxDailyLossUsd','tickSize','tickValueUsd','commissionPerContractUsd','slippageTicks','minimumRMultiple','sameCandleConflict','limitFillModel','defaultScaleOuts'];
  const riskConfig=Object.fromEntries(keys.map(k=>[k,config[k]]));riskConfig.startingBalanceUsd=50000;
  const event={parent:config.strategySlug,observedAt:plan.setup.observedAt,setup:plan.setup,config:riskConfig};
  event.id=digest([event.parent,event.observedAt,event.setup]);
  const queue=path.join(folder(root),'signals');fs.mkdirSync(queue,{recursive:true});
  const file=path.join(queue,`${event.id}.json`);
  // The watcher captured the actual strategy configuration. A worker fallback must not overwrite it.
  if(fs.existsSync(file))return;
  const temporary=`${file}.${process.pid}.${require('node:crypto').randomUUID()}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(event));
  try{fs.linkSync(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;}finally{fs.unlinkSync(temporary);}
}
function filters(candles,signal) {
  // Use only candles completed before the PARENT's observation, not worker time.
  const rows=candles.filter(c=>Date.parse(c.timestamp)+60000<=Date.parse(signal.observedAt)).slice(-60);
  if(rows.length!==60 || rows.some((c,i)=>!Number.isFinite(c.close) || (i && Date.parse(c.timestamp)-Date.parse(rows[i-1].timestamp)!==60000)))return {trend:false,reversal:false};
  const direction=signal.setup.side==='long'?1:-1,last=rows.at(-1),prior=rows.at(-2);
  const fast=rows.slice(-20).reduce((s,c)=>s+c.close,0)/20,slow=rows.reduce((s,c)=>s+c.close,0)/60;
  return {trend:direction*(fast-slow)>0 && direction*(last.close-fast)>0,
    reversal:direction*(last.close-last.open)>0 && (direction===1?last.close>prior.high:last.close<prior.low)};
}
function entryEvidence(candles,signal) {
  const at=Date.parse(signal.observedAt);
  const rows=candles.filter(c=>Date.parse(c.timestamp)+60000<=at).slice(-15);
  if(rows.length!==15||rows.some((c,i)=>!['open','high','low','close'].every(k=>Number.isFinite(c[k])&&c[k]>0)||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close)||(c.instrumentId??c.instrument_id)!==(rows[0].instrumentId??rows[0].instrument_id)||(i&&Date.parse(c.timestamp)-Date.parse(rows[i-1].timestamp)!==60000)))return {valid:false,reason:'Missing contiguous completed ATR history'};
  const atr=rows.slice(1).reduce((sum,c,i)=>sum+Math.max(c.high-c.low,Math.abs(c.high-rows[i].close),Math.abs(c.low-rows[i].close)),0)/14;
  return {valid:atr>0,atr,requestedStopDistance:Math.abs(signal.setup.entry-signal.setup.stop),lastCompletedAt:rows.at(-1).timestamp};
}
function advance(previous,signals,candles,now,options={}) {
  const research=options.research===true,version=research?RESEARCH_VERSION:VERSION,parents=research?RESEARCH_PARENTS:PARENTS;
  const state=structuredClone(previous||{version,evidenceType:research?'forward-entry-research':'forward-profit-paper',startedAt:new Date(now).toISOString(),accounts:{},events:[],seen:[]});
  if(state.version!==version)throw Error('Profit cohort version mismatch; refusing to reinterpret saved results');
  common.settle(state,candles,now);
  const latest=candles.filter(c=>Date.parse(c.timestamp)+60000<=now).at(-1);
  const fresh=latest && now-Date.parse(latest.timestamp)<=180000;
  for(const signal of signals.sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt))) {
    if(state.seen.includes(signal.id))continue;
    state.seen.push(signal.id);
    const event={executionModelVersion:'bounded-fill-v1',intrabarPolicyVersion:common.INTRABAR_VERSION,id:signal.id,parent:signal.parent,observedAt:signal.observedAt,decisionAt:new Date(now).toISOString(),arms:{}};
    state.events.push(event);
    if(!parents.includes(signal.parent) || !fresh || now-Date.parse(signal.observedAt)>120000 || Date.parse(signal.observedAt)>now || Date.parse(signal.observedAt)<Date.parse(state.startedAt)) {
      event.reason='Not observed prospectively with fresh data';event.status='excluded';continue;
    }
    const config=normalizeConfig({...signal.config,startingBalanceUsd:50000}),arms=research?RESEARCH_ARMS:armsFor(signal.parent);
    const accounts=arms.map(arm=>common.account(state,signal.parent,arm,config,common.INTRABAR_VERSION));
    // All arms start the same cohort. Do not give a faster exit extra entry opportunities.
    if(accounts.some(a=>a.open || digest(a.config)!==digest(config))) {event.status='excluded';event.reason='Cohort busy or frozen configuration changed';continue;}
    const selected=filters(candles,signal);
    const evidence=research?entryEvidence(candles,signal):null;
    if(research)event.entryEvidence=evidence;
    const plans=[];
    try {
      for(const a of accounts) {
        if(research&&a.arm==='stop-one-atr'&&(!evidence.valid||evidence.requestedStopDistance<evidence.atr)) {
          event.arms[a.arm]={decision:'filter-block',reason:evidence.valid?'Requested stop distance below one completed M1 ATR':evidence.reason,outcome:{status:'filtered',pnlUsd:0}};continue;
        }
        if(research&&a.arm==='fresh-entry-3m') {
          const origin=Date.parse(signal.setup.signalOriginAvailableAt||signal.setup.signalAvailableAt);
          const expiry=Math.min(origin+180000,Date.parse(signal.setup.orderExpiresAt)||Infinity);
          if(!Number.isFinite(origin)||expiry<=Math.max(Math.ceil(now/60000)*60000,Date.parse(signal.setup.signalAvailableAt))) {
            event.arms[a.arm]={decision:'filter-block',reason:'Three-minute origin deadline precedes next observable fill',outcome:{status:'filtered',pnlUsd:0}};continue;
          }
        }
        const daily=a.trades.filter(t=>t.date===signal.setup.date).reduce((s,t)=>s+t.realizedPnlUsd,0);
        const risk=Math.min(config.maxRiskPerTradeUsd,Math.max(0,config.maxDailyLossUsd+Math.min(0,daily)));
        if(risk<=0)throw Error('Cohort daily loss guard');
        const setup=structuredClone(signal.setup);
        if(research&&a.arm==='fresh-entry-3m') {
          const origin=Date.parse(setup.signalOriginAvailableAt||setup.signalAvailableAt);
          if(!Number.isFinite(origin))throw Error('Research signal origin unavailable');
          setup.orderExpiresAt=new Date(Math.min(origin+180000,Date.parse(setup.orderExpiresAt)||Infinity)).toISOString();
        }
        if(research&&a.arm==='stop-room-half')setup.minimumRemainingStopRiskFraction=.5;
        if(a.arm==='profit-lock')setup.profitProtection='profit-lock-v1';
        if(a.arm==='partial-trail')setup.profitProtection='partial-trail-v1';
        const plan=buildPlanFromSignal({found:true,setup,triggerTimestamp:setup.signalAvailableAt,metadata:{eventId:signal.id,observedAt:signal.observedAt}}, {...config,maxRiskPerTradeUsd:risk},a);
        bindForwardObservation(plan,now);
        plans.push({a,plan});
      }
      // Equal size across arms: conservative minimum of each independent account's cap.
      const contracts=Math.min(...plans.map(p=>p.plan.sizing.maxContracts));
      const budget=Math.min(...plans.map(p=>p.plan.sizing.riskBudgetUsd));
      for(const {a,plan}of plans) {
        const blocked=(a.arm==='trend-confirm'&&!selected.trend)||(a.arm==='reversal-confirm'&&!selected.reversal);
        event.arms[a.arm]={decision:blocked?'filter-block':'admitted'};
        if(blocked){event.arms[a.arm].outcome={status:'filtered',pnlUsd:0};continue;}
        plan.sizing.maxContracts=contracts;plan.sizing.riskBudgetUsd=budget;
        a.open={eventId:signal.id,plan,candles:[]};
      }
      event.status='observed';
    }catch(e){event.status='excluded';event.reason=e.message;}
  }
  state.updatedAt=new Date(now).toISOString();
  state.status=!fresh?'waiting-for-fresh-feed':Object.values(state.accounts).some(a=>a.status==='data-gap')?'data-gap':'collecting';
  return state;
}
function advanceResearch(previous,signals,candles,now){return advance(previous,signals,candles,now,{research:true});}
function report(state) {
  if(!state)return {status:'not-started',accounts:[],events:[]};
  const accounts=Object.values(state.accounts).map(a=>{
    const paired=state.events.filter(e=>e.parent===a.parent && e.executionModelVersion===a.executionModelVersion && (e.intrabarPolicyVersion||null)===(a.intrabarPolicyVersion||null) && e.arms.control?.outcome && e.arms[a.arm]?.outcome);
    const differences=paired.map(e=>e.arms[a.arm].outcome.pnlUsd-e.arms.control.outcome.pnlUsd);
    return {id:state.version===RESEARCH_VERSION?`${RESEARCH_VERSION}:${a.id}`:a.id,cohortVersion:state.version,parent:a.parent,intrabarPolicyVersion:a.intrabarPolicyVersion||null,executionModelVersion:a.executionModelVersion||'legacy-unbounded-fill',arm:a.arm,status:a.status,balanceUsd:a.balanceUsd,trades:a.trades.length,realizedPnlUsd:a.realizedPnlUsd,
      open:Boolean(a.open),currentStop:a.open?.lifecycle?.execution?.currentStop??null,
      unrealizedPnlUsd:a.open?.lifecycle?.unrealizedPnlUsd||0,partialPnlUsd:a.open?.lifecycle?.realizedPnlUsd||0,
      maxDrawdownUsd:a.maxDrawdownUsd,pairedComparisons:paired.length,pairedDeltaUsd:differences.reduce((s,x)=>s+x,0),
      improvedUsd:differences.reduce((s,x)=>s+Math.max(0,x),0),sacrificedUsd:differences.reduce((s,x)=>s+Math.max(0,-x),0)};
  });
  return {version:state.version,enabled:true,status:state.status,startedAt:state.startedAt,updatedAt:state.updatedAt,accounts,events:state.events.slice(-60).reverse(),
    scope:'Independent $50k paper accounts copying admitted parent signals only. Matched prospective observation and size. All arms wait for the prior cohort to finish. Original exits unchanged. No live promotion.'};
}
module.exports={VERSION,RESEARCH_VERSION,RESEARCH_ARMS,RESEARCH_PARENTS,advanceResearch,entryEvidence,PARENTS,folder,armsFor,capture,advance,report,filters};
