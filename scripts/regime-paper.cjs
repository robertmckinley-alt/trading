#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const experiment=require('../lib/regime-experiment.cjs');
const model=require('../lib/regime-model.cjs');
const {STRATEGIES,runtimeFilesForStrategy}=require('../lib/strategy-registry.cjs');
const root=path.resolve(__dirname,'..'),dir=experiment.folder(root);
const read=experiment.read,write=experiment.atomic;
function tick() {
  const settings=read(path.join(dir,'settings.json'));
  if(!settings?.enabled)return;
  const statePath=path.join(dir,'state.json');
  if(fs.existsSync(statePath) && !read(statePath))throw Error('Experiment state unreadable; refusing to reset balances');
  const prior=read(statePath);
  const frozen=prior?.model||read(path.join(dir,'model.json'));
  if(!frozen) {write(path.join(dir,'report.json'),{status:'awaiting-trained-model',updatedAt:new Date().toISOString(),accounts:[],events:[]});return;}
  model.validate(frozen);
  const base=read(path.join(root,'config.json'));
  if(!base)throw Error('Config unavailable');
  const cache=read(path.resolve(root,base.live?.liveCachePath||'runtime/databento-live.json'));
  if(!Array.isArray(cache?.candles))throw Error('NQ candle cache unavailable');
  for(const slug of settings.parents) {
    const def=STRATEGIES.find(s=>s.slug===slug);
    if(!def)continue;
    const parent=read(runtimeFilesForStrategy(root,slug).statePath);
    // Read only. Existing strategies and their processes remain untouched.
    if(parent?.live?.openPlan)experiment.capture(root,{...base,strategySlug:slug,strategyFamily:def.strategyFamily,accountType:'baseline'},parent.live.openPlan);
  }
  const queue=path.join(dir,'signals');
  const files=fs.existsSync(queue)?fs.readdirSync(queue).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)):[];
  const seen=new Set(prior?.seen||[]);
  const signals=files.map(n=>read(path.join(queue,n))).filter(s=>s && !seen.has(s.id));
  const next=experiment.advance(prior,signals,cache.candles,Date.now(),frozen);
  write(statePath,next);write(path.join(dir,'report.json'),experiment.report(next));
}
function running() {
  if(!fs.existsSync('/proc'))throw Error('Regime worker requires Linux process discovery');
  return fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)).flatMap(n=>{
    try {const cwd=fs.readlinkSync(`/proc/${n}/cwd`),args=fs.readFileSync(`/proc/${n}/cmdline`,'utf8').split('\0').filter(Boolean);
      return cwd===root && path.basename(args[0]||'')==='node' && path.resolve(cwd,args[1]||'')===__filename && args.includes('--worker')?[Number(n)]:[];
    }catch{return [];}
  });
}
function ensure() {
  if(read(path.join(dir,'settings.json'))?.enabled!==true || running().length)return;
  const fd=fs.openSync(path.join(dir,'worker.log'),'a');
  const child=spawn(process.execPath,[__filename,'--worker'],{cwd:root,detached:true,stdio:['ignore',fd,fd]});
  child.on('error',e=>console.error('Regime worker:',e.message));child.unref();fs.closeSync(fd);
}
function enable() {
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'settings.json');
  if(!fs.existsSync(file))write(file,{enabled:true,parents:['nq-15m-orb-close-confirmation','ema-20-60-momentum','volume-poc-reversion']});
  else if(read(file)?.enabled!==true)throw Error('Existing experiment is disabled. Review settings before restarting.');
  ensure();console.log('Regime worker enabled. Check runtime/regime-experiment/report.json for training and feed status.');
}
function main() {
  if(process.argv.includes('--enable'))return enable();
  if(process.argv.includes('--start'))return ensure();
  fs.mkdirSync(dir,{recursive:true});
  const release=require('../lib/watcher-process.cjs').acquireWatcherLock(root,'regime-experiment',{findPids:()=>running()});
  process.on('exit',release);for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>process.exit(0));
  const run=()=>{try{tick();}catch(e){console.error(new Date().toISOString(),e.message);const prior=read(path.join(dir,'report.json'))||{};write(path.join(dir,'report.json'),{...prior,status:'error',error:e.message,updatedAt:new Date().toISOString()});}};
  run();if(!process.argv.includes('--once'))setInterval(run,5000);
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={tick,ensure,enable};
