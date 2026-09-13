// Uses cached NQ history only; never downloads missing candles.
const fs=require('node:fs'),path=require('node:path');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const file='runtime/backtest-results.json',original=fs.readFileSync(file,'utf8'),report=JSON.parse(original);
 if(!report.window)throw new Error('Backtest window missing');
 const {createHash}=require('node:crypto');
 const identity=JSON.stringify({version:1,dataset:'GLBX.MDP3',symbol:'NQ.v.0',schema:'ohlcv-1m',stype:'continuous'});
 const dir=path.join(process.env.HISTORICAL_CACHE_DIR||'runtime/historical-candles',createHash('sha256').update(identity).digest('hex'));
 const byTime=new Map();
 for(const name of fs.readdirSync(dir).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort()) {
  const saved=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
  if(saved.identity!==identity||!Array.isArray(saved.candles)||saved.checksum!==createHash('sha256').update(JSON.stringify(saved.candles)).digest('hex'))throw new Error('Invalid candle cache: '+name);
  for(const candle of saved.candles)if(Date.parse(candle.timestamp)>=Date.parse(report.window.start)&&Date.parse(candle.timestamp)<Date.parse(report.window.end))byTime.set(candle.timestamp,candle);
 }
 const h={candles:[...byTime.values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp))};
 if(!h.candles.length)throw new Error('No cached NQ history available');
 const p=require('../lib/pattern-matching.cjs'),result=p.build(h.candles,report);
 if(fs.readFileSync(file,'utf8')!==original)throw new Error('Backtest changed during model build; retry after it finishes');
 result.report.cacheNote='Built from verified cached days only. Trades lacking complete feature candles are excluded.';
 p.saveModel(process.cwd(),'NQ',result.model);report.patternMatching=result.report;
 const temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(report));fs.renameSync(temp,file);
 console.log('PATTERN MODEL READY',result.report.examples,'examples; shadow only');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
