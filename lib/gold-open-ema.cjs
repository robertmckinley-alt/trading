// Gold adaptation of the supplied opening-candle/EMA clip. See GOLD_OPEN_EMA.md.
const SLUG = 'mgc-open-ema12';
const ACCOUNT = Object.freeze({symbol:'MGC',startingBalanceUsd:50000,maxAccountDrawdownPercent:5,maxRiskPerTradeUsd:250,tickSize:0.1,tickValueUsd:1,commissionPerContractUsd:2.5,slippageTicks:2});
function config(base) {
  return {...base,...ACCOUNT,live:{...base.live,provider:'databento-live',ticker:'MGC.v.0',dataset:'GLBX.MDP3',schema:'ohlcv-1m',stypeIn:'continuous',liveCachePath:'runtime/databento-gold-live.json',lookbackBars:1600}};
}
const fmt = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function parts(timestamp) {
  const p=Object.fromEntries(fmt.formatToParts(new Date(timestamp)).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,minute:+p.hour*60 + +p.minute};
}
function complete(bars) {
  return bars.length===5 && Date.parse(bars[0].timestamp)%300000===0 && bars.every((b,i)=>Date.parse(b.timestamp)===Date.parse(bars[0].timestamp)+i*60000 && [b.open,b.high,b.low,b.close].every(Number.isFinite) && b.low<=Math.min(b.open,b.close) && b.high>=Math.max(b.open,b.close));
}
function detect(candles, rawConfig, state={}) {
  const no=reason=>({found:false,reason:`Gold EMA: ${reason}`});
  if(rawConfig.symbol!=='MGC') return no('requires MGC configuration');
  const last=candles.at(-1);if(!last) return no('no candles');
  const p=parts(last.timestamp),session=require('./orb-session.cjs').session(p.date);
  if(!session.open || p.minute!==574) return no('waits for completed 09:30–09:35 New York candle');
  if((state.trades||[]).some(t=>t.date===p.date)) return no('one opening trade per session');
  if(state.balanceUsd<=47500) return no('account floor reached; review required');
  // Fixed 60-bar seed window makes the EMA independent of cache length.
  const bars=candles.slice(-300);
  if(bars.length!==300 || bars.some((b,i)=>Date.parse(b.timestamp)!==Date.parse(last.timestamp)-(299-i)*60000)) return no('requires 300 contiguous one-minute warmup candles');
  const groups=Array.from({length:60},(_,i)=>bars.slice(i*5,i*5+5));
  if(groups.some(g=>!complete(g))) return no('invalid or incomplete five-minute candles');
  const closes=groups.map(g=>g[4].close);
  let ema=closes.slice(0,12).reduce((a,b)=>a+b,0)/12;
  for(const c of closes.slice(12)) ema+=(c-ema)*2/13;
  const entry=last.close;if(Math.abs(entry-ema)<0.00000001) return no('close equals EMA');
  const side=entry>ema?'long':'short',opening=groups.at(-1);
  const stop=Number((side==='long'?Math.min(...opening.map(b=>b.low))-0.1:Math.max(...opening.map(b=>b.high))+0.1).toFixed(1));
  return {found:true,date:p.date,side,entry,stop,targets:[],ema,triggerTimestamp:last.timestamp,
    flattenAt:new Date(Date.parse(last.timestamp)+(session.closeMinute-p.minute)*60000).toISOString()};
}
function trail(bars,side,entry,initialStop,currentStop) {
  if(!complete(bars)) return currentStop;
  const direction=side==='long'?1:-1;
  if(direction*(bars[4].close-entry)<Math.abs(entry-initialStop)) return currentStop;
  const candidate=Number((side==='long'?Math.min(...bars.map(b=>b.low))-0.1:Math.max(...bars.map(b=>b.high))+0.1).toFixed(1));
  return side==='long'?Math.max(currentStop,candidate):Math.min(currentStop,candidate);
}
module.exports={SLUG,ACCOUNT,config,detect,trail};
