// RUNNER: independently specified, non-repainting NQ trend continuation experiment.
// Candle timestamps are bar starts. Only evaluate completed 1-minute bars.
const tz = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false,year:'numeric',month:'2-digit',day:'2-digit'});
const parts = t => Object.fromEntries(tz.formatToParts(new Date(t)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
const ema=(values,n)=>values.reduce((a,v,i)=>{a.push(i? a[i-1]+(v-a[i-1])*2/(n+1):v);return a;},[]);
const tick=(v,t)=>Math.round(v/t)*t;
function detect(candles,config,state={}){
 if(candles.length<90)return {found:false,reason:'RUNNER warming 90 bars'};
 const now=Date.now();
 if(now<Date.parse('2026-10-23T13:45:00Z'))return {found:false,reason:'RUNNER scheduled to begin Friday October 23 at 09:45 New York'};
 const completed=candles.filter(c=>Date.parse(c.timestamp)+60000<=now);
 if(completed.length<90)return {found:false,reason:'RUNNER waiting for completed candles'};
 const c=completed.at(-1), p=parts(c.timestamp), minute=Number(p.hour)*60+Number(p.minute);
 if(minute<9*60+45||minute>15*60+15)return {found:false,reason:'RUNNER outside 09:45-15:15 NY'};
 const date=`${p.year}-${p.month}-${p.day}`;
 if((state.trades||[]).filter(t=>t.date===date).length>=2)return {found:false,reason:'RUNNER daily trade cap'};
 const recent=completed.slice(-90), closes=recent.map(x=>x.close), fast=ema(closes,20),slow=ema(closes,60);
 const i=recent.length-1, prior=recent.slice(-7,-1), range=recent.slice(-15);
 const tr=range.slice(1).map((x,j)=>Math.max(x.high-x.low,Math.abs(x.high-range[j].close),Math.abs(x.low-range[j].close)));
 const atr=tr.reduce((a,b)=>a+b,0)/tr.length;
 if(!Number.isFinite(atr)||atr<=0)return {found:false,reason:'RUNNER invalid ATR'};
 const body=Math.abs(c.close-c.open), width=c.high-c.low;
 if(width<=0||body/width<0.55)return {found:false,reason:'RUNNER weak signal body'};
 const high=Math.max(...prior.map(x=>x.high)),low=Math.min(...prior.map(x=>x.low));
 // Optional contraction/expansion filter: independent Locked In Profits-inspired experiment.
 const base=recent.slice(-36,-16), compression=recent.slice(-16,-1);
 const avgRange=a=>a.reduce((sum,x)=>sum+x.high-x.low,0)/a.length;
 if(avgRange(compression)>avgRange(base)*0.85)return {found:false,reason:'RUNNER waiting for range contraction'};
 if(width<1.15*avgRange(compression))return {found:false,reason:'RUNNER waiting for breakout expansion'};
 const long=c.close>high&&fast[i]>slow[i]&&fast[i]>fast[i-5]&&c.close>c.open;
 const short=c.close<low&&fast[i]<slow[i]&&fast[i]<fast[i-5]&&c.close<c.open;
 if(!long&&!short)return {found:false,reason:'RUNNER no aligned six-bar breakout'};
 const side=long?'long':'short', t=config.tickSize||0.25;
 const entry=tick(c.close,t), structural=long?Math.min(...recent.slice(-6).map(x=>x.low)):Math.max(...recent.slice(-6).map(x=>x.high));
 const stop=tick(long?Math.max(structural,entry-1.5*atr)-t:Math.min(structural,entry+1.5*atr)+t,t);
 const risk=Math.abs(entry-stop);
 if(risk<4||risk>20||body>1.8*atr)return {found:false,reason:'RUNNER risk/extension filter'};
 const targets=[1,2,3.5].map(r=>tick(entry+(long?1:-1)*risk*r,t));
 return {found:true,triggerTimestamp:c.timestamp,metadata:{side,atr,breakoutLevel:long?high:low,model:'independent-runner-v1'},rangeSummary:[],sessionRanges:{},
 setup:{symbol:config.symbol||'NQ',date,session:'NY cash momentum',side,entry,stop,targets,thesis:'Confirmed 6-bar breakout with EMA20/60 trend and ATR stop; independent video-inspired hypothesis',execution:'next-bar-market',signalAvailableAt:new Date(Date.parse(c.timestamp)+60000).toISOString(),orderExpiresAt:new Date(Date.parse(c.timestamp)+180000).toISOString(),setup:{entryModel:'runner-breakout-v1',gapType:'momentum-breakout',entryTimeframe:'M1',activationTime:'09:45-15:15 America/New_York',referenceSessions:['cash-session'],liquidityPool:'recent-six-bar-extreme',liquidityLabel:String(long?high:low),drawOnLiquidity:['1R','2R','3.5R'],stopPlacement:'six-bar-structural-atr'}}};
}
module.exports={detect};
