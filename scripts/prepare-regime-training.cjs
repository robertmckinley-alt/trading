#!/usr/bin/env node
// Verified cache only. Never purchase or download history implicitly.
const fs=require('node:fs'), path=require('node:path');
const {createHash}=require('node:crypto');
const model=require('../lib/regime-model.cjs');
function prepare(root=path.resolve(__dirname,'..')) {
  const identity=JSON.stringify({version:1,dataset:'GLBX.MDP3',symbol:'NQ.v.0',schema:'ohlcv-1m',stype:'continuous'});
  const cache=path.resolve(root,process.env.HISTORICAL_CACHE_DIR||'runtime/historical-candles',createHash('sha256').update(identity).digest('hex'));
  const candles=[];
  for(const name of fs.readdirSync(cache).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort()) {
    const saved=JSON.parse(fs.readFileSync(path.join(cache,name),'utf8'));
    if(saved.identity!==identity || !Array.isArray(saved.candles) || saved.checksum!==model.digest(saved.candles)) throw Error('Invalid cache: '+name);
    candles.push(...saved.candles);
  }
  candles.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
  const rows=model.features(candles);
  const folder=path.join(root,'runtime/regime-experiment');
  fs.mkdirSync(folder,{recursive:true});
  const output=path.join(folder,'training.json');
  fs.writeFileSync(output,JSON.stringify({features:model.FEATURES,sourceChecksum:model.digest(candles),rows}));
  console.log(JSON.stringify({output,rows:rows.length,dates:new Set(rows.map(r=>r.availableAt.slice(0,10))).size}));
}
if(require.main===module)try{prepare();}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={prepare};
