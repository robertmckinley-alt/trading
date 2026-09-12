// Explicit gold input only. Never reads the shared NQ history cache.
const fs=require('node:fs'),path=require('node:path');
process.chdir(path.resolve(__dirname,'..'));
try {
  if(!process.argv[2]) throw new Error('Usage: node scripts/backtest-gold.cjs /path/to/gold-candles.json');
  const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  if(input.symbol!=='MGC.v.0'||input.dataset!=='GLBX.MDP3'||input.schema!=='ohlcv-1m'||!input.candles?.length) throw new Error('Requires labeled MGC.v.0 GLBX.MDP3 ohlcv-1m candles; NQ input refused');
  const core=require('../lib/trader-core.cjs'),gold=require('../lib/gold-open-ema.cjs');
  const config=gold.config(core.normalizeConfig(require('../config.json')));
  const result=require('../lib/backtest-engine.cjs').runAllBacktests(input.candles,config,{strategies:[require('../lib/strategy-registry.cjs').requireStrategyDefinition(gold.SLUG)]});
  const hash=require('node:crypto').createHash('sha256');
  for(const file of ['lib/gold-open-ema.cjs','lib/trader-core.cjs','lib/live-trader.cjs','lib/backtest-engine.cjs','lib/orb-session.cjs']) hash.update(fs.readFileSync(file));
  result.codeHash=hash.digest('hex');result.dataHash=require('node:crypto').createHash('sha256').update(JSON.stringify(input)).digest('hex');
  result.symbol='MGC.v.0';result.firstCandleAt=input.candles[0].timestamp;result.lastCandleAt=input.candles.at(-1).timestamp;
  result.methodology='Gold opening EMA12 adaptation: next-bar market fills, costs, stop gaps and completed-five-minute trailing after 1R. Research and guarded $50k account are separate; no claim of source replication.';
  fs.mkdirSync('runtime',{recursive:true});
  const out='runtime/gold-backtest-results.json';fs.writeFileSync(out+'.tmp',JSON.stringify(result));fs.renameSync(out+'.tmp',out);
  console.log(`Gold results saved: ${result.candles} candles, ${result.tradingDays} dates. ${out}`);
} catch(e) {console.error(e.message);process.exitCode=1;}
