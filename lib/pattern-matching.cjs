// Advisory nearest-neighbor research. Outcomes never enter feature construction.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const VERSION='pattern-shadow-v1';
const RULES=Object.freeze({neighbors:20,minHistory:50,maxDistance:2.5,embargoMs:86400000,maxAgeMs:730*86400000});
const FEATURES=['move5Atr','move30Atr','move60Atr','efficiency','volatilityRatio','volumeRatio','sessionSin','sessionCos'];
const ny=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
const quantile=(a,q)=>a[Math.floor((a.length-1)*q)];
function features(candles,at,side) {
  const time=Date.parse(at);if(!Number.isFinite(time)||!['long','short'].includes(side)) return null;
  // Candle timestamps mark their OPEN. Only bars completed before the signal count.
  let lo=0,hi=candles.length;
  while(lo<hi){const m=(lo+hi)>>1;if(Date.parse(candles[m].timestamp)+60000<=time)lo=m+1;else hi=m;}
  const b=candles.slice(Math.max(0,lo-61),lo);if(b.length!==61)return null;
  if(b.some((c,i)=>![c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)||c.volume<0||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close)||(i&&Date.parse(c.timestamp)-Date.parse(b[i-1].timestamp)!==60000)))return null;
  if(time-(Date.parse(b.at(-1).timestamp)+60000)>120000)return null;
  if(new Set(b.map(c=>c.instrumentId).filter(x=>x!=null)).size>1)return null;
  const tr=b.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-b[i].close),Math.abs(c.low-b[i].close)));
  const atr=mean(tr.slice(-14)),prior=mean(tr.slice(0,46)),volume=mean(b.slice(1,-5).map(c=>c.volume));
  if(!(atr>0&&prior>0&&volume>0))return null;
  const dir=side==='long'?1:-1,last=b.at(-1).close;
  const travel=b.slice(1).reduce((s,c,i)=>s+Math.abs(c.close-b[i].close),0);
  const parts=Object.fromEntries(ny.formatToParts(new Date(time)).map(x=>[x.type,x.value])),minute=+parts.hour*60 + +parts.minute;
  return [dir*(last-b.at(-6).close)/atr,dir*(last-b.at(-31).close)/atr,dir*(last-b[0].close)/atr,
    travel?Math.abs(last-b[0].close)/travel:0,atr/prior,mean(b.slice(-5).map(c=>c.volume))/volume,Math.sin(2*Math.PI*minute/1440),Math.cos(2*Math.PI*minute/1440)];
}
function score(model,query) {
  const empty=(status,extra={})=>({version:VERSION,mode:'shadow-only',status,tradeAction:'unchanged',...extra});
  if(model?.version!==VERSION)return empty('model-unavailable');
  if(!query.features||query.features.length!==FEATURES.length||!query.features.every(Number.isFinite))return empty('incomplete-candles');
  const at=Date.parse(query.at);if(!Number.isFinite(at))return empty('invalid-time');
  const pool=model.examples.filter(e=>e.symbol===query.symbol&&e.slug===query.slug&&e.side===query.side&&Date.parse(e.closedAt)<at-RULES.embargoMs&&Date.parse(e.at)<at-RULES.embargoMs&&Date.parse(e.at)>=at-RULES.maxAgeMs);
  if(pool.length<RULES.minHistory)return empty('insufficient-history',{eligible:pool.length,required:RULES.minHistory});
  // Fit normalization only to outcomes that were knowable at this query time.
  const scale=FEATURES.map((_,i)=>{const a=pool.map(e=>e.features[i]).sort((a,b)=>a-b);return Math.max(.1,quantile(a,.75)-quantile(a,.25));});
  const neighbors=pool.map(e=>({e,distance:Math.sqrt(mean(e.features.map((v,i)=>((v-query.features[i])/scale[i])**2)))})).filter(x=>x.distance<=RULES.maxDistance).sort((a,b)=>a.distance-b.distance||a.e.id.localeCompare(b.e.id)).slice(0,RULES.neighbors);
  if(neighbors.length<RULES.neighbors)return empty('no-close-match',{eligible:pool.length,matches:neighbors.length,required:RULES.neighbors});
  const returns=neighbors.map(n=>n.e.netR),expectancyR=mean(returns),winRate=returns.filter(r=>r>0).length/returns.length;
  return empty('scored',{eligible:pool.length,matches:neighbors.length,expectancyR,winRate,medianR:quantile([...returns].sort((a,b)=>a-b),.5),
    assessment:expectancyR>0?'positive historical neighborhood':'negative historical neighborhood',
    neighbors:neighbors.map(n=>({id:n.e.id,at:n.e.at,closedAt:n.e.closedAt,netR:n.e.netR,distance:n.distance})),
    caveat:'Historical neighbor outcomes, not a calibrated probability or promotion approval.'});
}
function build(candles,report) {
  const examples=[],skipped={};
  for(const strategy of report.strategies||[]) {
    const seen=new Set();
    for(const t of strategy.research?.trades||strategy.trades||[]) {
      const signalTime=t.signalAt||t.detectedAt||(t.evidenceType==='historical-simulated'&&Date.parse(t.createdAt)<Date.parse(t.filledAt)?t.createdAt:null);
      if(signalTime&&!Number.isFinite(Date.parse(signalTime)))continue;
      const at=signalTime?new Date(Date.parse(signalTime)+60000).toISOString():t.filledAt;
      if(!Number.isFinite(Date.parse(at))||!Number.isFinite(Date.parse(t.exitedAt))||Date.parse(t.exitedAt)<Date.parse(at))continue;
      const f=features(candles,at,t.side),risk=Number(t.actualRiskUsd),pnl=Number(t.realizedPnlUsd);
      const key=[strategy.slug,t.side,at].join(':');if(seen.has(key))continue;seen.add(key);
      if(!f||!(risk>0)||!Number.isFinite(pnl)||t.dataQuality==='gap-review-required'){skipped[strategy.slug]=(skipped[strategy.slug]||0)+1;continue;}
      const symbol=String(t.symbol||report.symbol||'').split('.')[0];
      examples.push({id:key,slug:strategy.slug,symbol,side:t.side,at,closedAt:t.exitedAt,features:f,netR:pnl/risk,pnl});
    }
  }
  examples.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
  const model={version:VERSION,generatedAt:new Date().toISOString(),features:FEATURES,rules:RULES,examples};
  model.hash=createHash('sha256').update(JSON.stringify(examples)).digest('hex');
  const rows=[];
  for(const strategy of report.strategies||[]) {
    const own=examples.filter(e=>e.slug===strategy.slug),scored=own.map(e=>({e,s:score(model,e)}));
    const known=scored.filter(x=>x.s.status==='scored'),positive=known.filter(x=>x.s.expectancyR>0),negative=known.filter(x=>x.s.expectancyR<=0);
    const stats=a=>({trades:a.length,netPnlUsd:a.reduce((s,x)=>s+x.e.pnl,0),meanNetR:a.length?mean(a.map(x=>x.e.netR)):null});
    rows.push({slug:strategy.slug,name:strategy.name,examples:own.length,skipped:skipped[strategy.slug]||0,scored:known.length,unscored:own.length-known.length,baseline:stats(known),positive:stats(positive),negative:stats(negative),latest:scored.at(-1)?.s||null});
  }
  return {model,report:{version:VERSION,mode:'shadow-only',generatedAt:model.generatedAt,modelHash:model.hash,features:FEATURES,rules:RULES,examples:examples.length,strategies:rows,
    methodology:'Retrospective chronological replay. Same instrument, strategy and side; outcomes must have closed more than 24 hours earlier. Scaling uses only that past pool. Positive/negative groups are diagnostics, not a validated filtered portfolio. No automatic entry changes. No untouched holdout claim.'}};
}
function saveModel(root,symbol,model) {
  if(!['NQ','MGC'].includes(symbol))throw new Error('Unsupported pattern model instrument');
  const file=path.join(root,'runtime',`pattern-model-${symbol}.json`);fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(model));fs.renameSync(tmp,file);
}
const cache=new Map();
function advisory(root,candles,config,signal) {
  if(!signal.found)return null;
  try {
    const symbol=config.symbol,file=path.join(root,'runtime',`pattern-model-${symbol}.json`),stat=fs.statSync(file);
    if(cache.get(file)?.mtime!==stat.mtimeMs)cache.set(file,{mtime:stat.mtimeMs,model:JSON.parse(fs.readFileSync(file,'utf8'))});
    const at=signal.setup.signalAvailableAt||new Date(Date.parse(signal.triggerTimestamp)+60000).toISOString();
    return score(cache.get(file).model,{symbol,slug:config.strategySlug,side:signal.setup.side,at,features:features(candles,at,signal.setup.side)});
  }catch{return {version:VERSION,mode:'shadow-only',status:'model-unavailable',tradeAction:'unchanged'};}
}
module.exports={VERSION,RULES,FEATURES,features,score,build,saveModel,advisory};
