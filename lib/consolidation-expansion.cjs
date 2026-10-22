// CE-v1: completed, consecutive bars. A preregistered paper hypothesis.
const VERSION = 'consolidation-expansion-entry-v1';
const enabled = config => config.live?.consolidationExpansion?.enabled === true;
function evaluationTime(config = {}) {
  const value = config.live?.consolidationExpansion?.asOf ?? config.evaluationTime ?? config.asOf ?? Date.now();
  return typeof value === 'number' ? value : Date.parse(value);
}
function validBar(c) {
  return [c.open,c.high,c.low,c.close].every(Number.isFinite)
    && c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close) && c.high >= c.low;
}
function completed(candles, config = {}, minutes = 1) {
  const asOf = evaluationTime(config), duration = minutes * 60000;
  return (candles || []).filter(c => !Number.isFinite(Date.parse(c.timestamp)) || Date.parse(c.timestamp) + duration <= asOf);
}
function validSequence(candles, minutes = 1, consecutive = false) {
  let previous = -Infinity; const ids = new Set();
  for (const c of candles) {
    const t = Date.parse(c.timestamp);
    if (!Number.isFinite(t) || t % (minutes * 60000) !== 0 || t <= previous || !validBar(c)
      || (consecutive && previous !== -Infinity && t - previous !== minutes * 60000)) return false;
    previous = t; if ((c.instrumentId ?? c.instrument_id) != null) ids.add(c.instrumentId ?? c.instrument_id);
  }
  return candles.length > 0 && ids.size <= 1;
}
function aggregate(candles, minutes) {
  if (!validSequence(candles)) return [];
  const out = []; let group = [], bucket = null;
  for (const c of candles) {
    const key = Math.floor(Date.parse(c.timestamp)/(minutes*60000));
    if (key !== bucket) { group = []; bucket = key; }
    group.push(c);
    if (group.length !== minutes || Date.parse(group[0].timestamp) !== bucket*minutes*60000
      || !validSequence(group,1,true)) continue;
    out.push({ timestamp:group[0].timestamp, endTimestamp:c.timestamp,
      open:group[0].open, close:c.close, high:Math.max(...group.map(x=>x.high)), low:Math.min(...group.map(x=>x.low)),
      samples:minutes, volume:group.reduce((sum,x)=>sum+Number(x.volume||0),0), instrumentId:group[0].instrumentId });
  }
  return out;
}
function assess(candles, side, options = {}) {
  const minutes = options.timeframeMinutes || 1, tick = options.tickSize ?? 0.25;
  const bars = completed(candles, options, minutes).slice(-37);
  const no = reason => ({available:false,qualifies:false,reason,version:VERSION});
  if (bars.length < 37) return no('insufficient candles');
  if (!(tick > 0) || !validSequence(bars,minutes,true)) return no('invalid, mixed, incomplete or nonconsecutive bars');
  const baseline=bars.slice(0,20),compression=bars.slice(20,36),breakout=bars[36];
  const mean=a=>a.reduce((s,x)=>s+x.high-x.low,0)/a.length;
  const baselineRange=mean(baseline),compressedRange=mean(compression),range=breakout.high-breakout.low;
  const contractionRatio=compressedRange/baselineRange,expansionRatio=range/compressedRange;
  const high=Math.max(...compression.map(x=>x.high)),low=Math.min(...compression.map(x=>x.low));
  const contraction=baselineRange>0&&compressedRange>0&&contractionRatio<=0.85;
  const expansion=compressedRange>0&&expansionRatio>=1.15;
  const direction=side==='long'?breakout.close>=high+tick&&breakout.close>breakout.open
    :side==='short'?breakout.close<=low-tick&&breakout.close<breakout.open:false;
  const bodyFraction=range>0?Math.abs(breakout.close-breakout.open)/range:0;
  return {available:true,version:VERSION,contraction,expansion,direction,bodyFraction,
    qualifies:contraction&&expansion&&direction&&bodyFraction>=0.55,baselineRange,compressedRange,
    contractionRatio,expansionRatio,high,low,start:bars[0].timestamp,breakoutAt:breakout.timestamp,
    availableAt:new Date(Date.parse(breakout.timestamp)+minutes*60000).toISOString()};
}
module.exports={VERSION,enabled,evaluationTime,validBar,validSequence,completed,aggregate,assess};
