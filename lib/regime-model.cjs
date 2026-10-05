// Causal, completed-minute features and forward-only diagonal Gaussian HMM inference.
// Never use full-sequence posterior decoding for trading decisions.
const crypto = require('node:crypto');
const VERSION = 'regime-v1';
const FEATURES = ['logReturn', 'volatility', 'range', 'volumeRatio', 'trend'];
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const variance = a => { const m=mean(a); return mean(a.map(x => (x-m)**2)); };
const ms = x => Date.parse(x);
const instrument = c => c.instrumentId ?? c.instrument_id ?? null;
function features(candles, now = Date.now()) {
  const rows = [], window = [];
  let previous;
  for (const c of candles) {
    const t = ms(c.timestamp);
    if (!Number.isFinite(t) || t + 60000 > now) continue;
    if (previous && t <= ms(previous.timestamp)) throw Error('Candles must be strictly ordered without duplicates');
    const valid = ['open','high','low','close','volume'].every(k => Number.isFinite(c[k])) && c.low > 0 && c.volume >= 0 && c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close);
    if (!valid || (previous && (t - ms(previous.timestamp) !== 60000 || instrument(c) !== instrument(previous)))) window.length = 0;
    if (!valid) { previous = undefined; continue; }
    window.push(c);
    if (window.length > 61) window.shift();
    previous = c;
    if (window.length < 61) continue;
    const returns = window.slice(1).map((v, i) => Math.log(v.close / window[i].close));
    const vol = Math.sqrt(variance(returns.slice(-20)));
    const priorVolume = mean(window.slice(0,-1).map(v => v.volume));
    rows.push({ timestamp: c.timestamp, availableAt: new Date(t + 60000).toISOString(),
      x: [returns.at(-1), vol, (c.high-c.low)/c.close, Math.log1p(c.volume / Math.max(1,priorVolume)),
        Math.log(c.close / window[0].close) / Math.max(1e-8, Math.sqrt(variance(returns)) * Math.sqrt(60))] });
  }
  return rows;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validate(model) {
  if (model?.version !== VERSION || model.symbol !== 'NQ' || JSON.stringify(model.features) !== JSON.stringify(FEATURES)) throw Error('Unsupported regime model');
  const n = model.means?.length;
  if (!(n >= 2 && n <= 5) || !Number.isFinite(ms(model.trainedThrough)) || !Number.isFinite(ms(model.usableAfter)) || ms(model.usableAfter) < ms(model.trainedThrough)) throw Error('Invalid model dates or states');
  const probability = a => Array.isArray(a) && a.length === n && a.every(v=>Number.isFinite(v)&&v>=0&&v<=1) && Math.abs(a.reduce((s,v)=>s+v,0)-1)<1e-6;
  if (!probability(model.start) || !Array.isArray(model.transition) || model.transition.length !== n || !model.transition.every(probability)) throw Error('Invalid HMM probabilities');
  for (const [name, matrix] of [['means',model.means],['variances',model.variances]]) {
    if (!Array.isArray(matrix) || matrix.length !== n || !matrix.every(a=>a.length===5 && a.every(v=>Number.isFinite(v) && (name !== 'variances' || v>0)))) throw Error('Invalid HMM emissions');
  }
  if (!model.scaler?.mean || model.scaler.mean.length!==5 || !model.scaler.mean.every(Number.isFinite) || model.scaler.scale?.length!==5 || !model.scaler.scale.every(v=>Number.isFinite(v)&&v>0)) throw Error('Invalid scaler');
  if (model.labels?.length!==n || !model.labels.every(l=>['trend-up','trend-down','range','high-volatility'].includes(l))) throw Error('Invalid state labels');
  if (!Number.isFinite(model.highVolatility) || model.highVolatility<=0) throw Error('Invalid volatility threshold');
  return model;
}
function step(model, x, prior) {
  const n = model.means.length;
  const predicted = prior ? model.start.map((_,j)=>prior.reduce((s,p,i)=>s+p*model.transition[i][j],0)) : model.start;
  const z = x.map((v,i)=>(v-model.scaler.mean[i])/model.scaler.scale[i]);
  const log = model.means.map((mu,i)=>Math.log(Math.max(1e-300,predicted[i])) - .5 * mu.reduce((s,v,j)=>s+Math.log(2*Math.PI*model.variances[i][j])+(z[j]-v)**2/model.variances[i][j],0));
  const max = Math.max(...log), weights = log.map(v=>Math.exp(v-max)), sum = weights.reduce((s,v)=>s+v,0);
  return { probabilities: weights.map(v=>v/sum), logLikelihood: max+Math.log(sum) };
}
function classify(rows, model, previous = null) {
  validate(model);
  const id = digest(model);
  let cursor = previous?.modelId === id ? structuredClone(previous) : { modelId:id, probabilities:null, lastAt:null, count:0 };
  for (const row of rows) {
    if (ms(row.availableAt) <= ms(model.usableAfter) || (cursor.lastAt && ms(row.availableAt)<=ms(cursor.lastAt))) continue;
    if (cursor.lastAt && ms(row.availableAt)-ms(cursor.lastAt)!==60000) { cursor.probabilities=null; cursor.count=0; }
    const result = step(model,row.x,cursor.probabilities);
    cursor = { ...cursor, ...result, lastAt:row.availableAt, count:cursor.count+1 };
  }
  if (!cursor.probabilities || cursor.count<20) return { ...cursor, status:'warming-up' };
  const sorted=cursor.probabilities.map((p,i)=>({p,i})).sort((a,b)=>b.p-a.p);
  const uncertain=sorted[0].p<.7 || sorted[0].p-sorted[1].p<.15;
  return { ...cursor, status:'ready', label:model.labels[sorted[0].i], probability:sorted[0].p, uncertain };
}
function simple(row, model) {
  if (!row) return { status:'warming-up' };
  return { status:'ready', label:row.x[1]>model.highVolatility ? 'high-volatility' : row.x[4]>1 ? 'trend-up' : row.x[4]<-1 ? 'trend-down' : 'range', uncertain:false, lastAt:row.availableAt };
}
function multiplier(classification, family, side, sizing = false) {
  if (classification?.status!=='ready') return 0;
  const label=classification.label;
  const trendFamily=['cash-breakout','trend-momentum'].includes(family);
  const favorable = !classification.uncertain && label!=='high-volatility' && (trendFamily ? label === (side==='long'?'trend-up':'trend-down') : label==='range');
  return favorable ? 1 : sizing ? .5 : 0;
}
module.exports={ VERSION, FEATURES, features, validate, step, classify, simple, multiplier, digest };
