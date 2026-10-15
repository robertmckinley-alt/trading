#!/usr/bin/env node
// Read-only: no orders, state writes, network calls, or retrospective fills.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
config.detectorStrategySlug='nq-dmc-market-open';
const {completeBars,timestampForWallClock,detectDmcMarketOpenSignal}=require('../lib/dmc-market-open.cjs');
const {atrEvidence,VERSION}=require('../lib/dmc-atr.cjs');
const {parts}=require('../lib/session-quality.cjs');
const input=path.resolve(root,config.live?.liveCachePath||'runtime/databento-live.json');
const candles=JSON.parse(fs.readFileSync(input,'utf8')).candles;
if(!Array.isArray(candles)||!candles.length)throw Error('No cached candles; repair the feed first');
if(candles.some((c,i)=>i&&Date.parse(c.timestamp)<=Date.parse(candles[i-1].timestamp)))throw Error('Duplicate or out-of-order candles; refusing replay');
const day=process.argv[2]||parts(candles.at(-1).timestamp).date;
if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('Expected YYYY-MM-DD');
const open=Date.parse(timestampForWallClock(day,'09:30'));
const history=candles.filter(c=>Date.parse(c.timestamp)<open);
const hours=completeBars(history,60).filter(b=>Date.parse(b.endTimestamp)+60000<=open).slice(-48);
const prior=hours.slice(0,-1),period=Number(config.live?.dmcMarketOpen?.hourlyAtrPeriod||14);
const evidence=atrEvidence(prior,period,history);
const strictGap=prior.slice(-period-1).some((b,i,a)=>i&&Date.parse(b.timestamp)-Date.parse(a[i-1].timestamp)!==3600000);
const reasons={},signals=[];let checks=0;
for(let i=0;i<candles.length;i++){
 const p=parts(candles[i].timestamp);
 if(p.date!==day||p.minute<574||p.minute>684||p.minute%5!==4)continue;
 checks++;
 const r=detectDmcMarketOpenSignal(candles.slice(0,i+1),config,{trades:[]});
 if(r.found)signals.push({at:candles[i].timestamp,side:r.setup.side,entry:r.setup.entry,stop:r.setup.stop});
 else reasons[r.reason]=(reasons[r.reason]||0)+1;
}
console.log(JSON.stringify({version:VERSION,mode:'read-only-signal-replay-not-trade-backtest',day,cache:{count:candles.length,first:candles[0].timestamp,last:candles.at(-1).timestamp},completePreopenHours:hours.length,oldStrictAtrWouldRejectGap:strictGap,atr:evidence,checks,reasons,signals,note:'Signals are independent checks with empty hypothetical state; repeated signals are not distinct trades. No historical journals changed.'},null,2));
if(!evidence.valid||!checks)process.exitCode=2;
