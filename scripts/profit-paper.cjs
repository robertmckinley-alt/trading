#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const experiment=require('../lib/profit-experiment.cjs');
const common=require('../lib/regime-experiment.cjs');
const {STRATEGIES,runtimeFilesForStrategy}=require('../lib/strategy-registry.cjs');
const root=path.resolve(__dirname,'..'),dir=experiment.folder(root);
const read=common.read,write=common.atomic;
function tickAt(root, now) {
  const dir=experiment.folder(root);
  const settings=read(path.join(dir,'settings.json'));
  if(!settings?.enabled)return;
  if(!Array.isArray(settings.parents))throw Error('Profit settings missing parents');
  const statePath=path.join(dir,'state.json');
  if(fs.existsSync(statePath) && !read(statePath))throw Error('Experiment state unreadable; refusing to reset balances');
  const prior=read(statePath);
  const base=read(path.join(root,'config.json'));
  if(!base)throw Error('Config unavailable');
  const cache=read(path.resolve(root,base.live?.liveCachePath||'runtime/databento-live.json'));
  if(!Array.isArray(cache?.candles))throw Error('NQ candle cache unavailable');
  for(const slug of new Set([...settings.parents,...(settings.entryResearchEnabled?experiment.RESEARCH_PARENTS:[])])) {
    const def=STRATEGIES.find(s=>s.slug===slug);
    if(!def)continue;
    const parent=read(runtimeFilesForStrategy(root,slug).statePath);
    // Read only. Existing strategies and their processes remain untouched.
    if(parent?.live?.openPlan)experiment.capture(root,{...base,...(slug==='nq-vwap-stretch-reversion'?require('../lib/vwap-stretch.cjs').ACCOUNT:{}),...(slug==='nq-fresh-level-retest'?require('../lib/fresh-level-retest.cjs').ACCOUNT:{}),strategySlug:slug,strategyFamily:def.strategyFamily,accountType:'baseline'},parent.live.openPlan);
  }
  const queue=path.join(dir,'signals');
  const files=fs.existsSync(queue)?fs.readdirSync(queue).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)):[];
  const seen=new Set(prior?.seen||[]);
  const signals=files.map(n=>read(path.join(queue,n))).filter(s=>s && !seen.has(s.id));
  const next=experiment.advance(prior,signals,cache.candles,now);
  write(statePath,next);
  const report=experiment.report(next);
  if(settings.entryResearchEnabled===true) {
    if(settings.entryResearchVersion!==experiment.RESEARCH_VERSION)throw Error('Entry research settings version mismatch');
    const researchPath=path.join(dir,'entry-research-state.json');
    if(fs.existsSync(researchPath)&&!read(researchPath))throw Error('Entry research state unreadable; refusing to reset balances');
    const researchPrior=read(researchPath),researchSeen=new Set(researchPrior?.seen||[]);
    const researchSignals=files.map(n=>read(path.join(queue,n))).filter(s=>s&&!researchSeen.has(s.id));
    const research=experiment.advanceResearch(researchPrior,researchSignals,cache.candles,now);
    write(researchPath,research);
    const researchReport=experiment.report(research);
    write(path.join(dir,'entry-research-report.json'),researchReport);
    report.entryResearch=researchReport;
    report.accounts.push(...researchReport.accounts);
    if(researchReport.status!=='collecting')report.status=researchReport.status;
  }
  write(path.join(dir,'report.json'),report);
}
function tick() {return tickAt(root,Date.now());}
function running() {
  if(!fs.existsSync('/proc'))throw Error('Profit protection worker requires Linux process discovery');
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
  child.on('error',e=>console.error('Profit protection worker:',e.message));child.unref();fs.closeSync(fd);
}
function enable() {
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'settings.json');
  if(!fs.existsSync(file))write(file,{enabled:true,parents:experiment.PARENTS});
  else if(read(file)?.enabled!==true)throw Error('Existing experiment is disabled. Review settings before restarting.');
  ensure();console.log('Profit protection worker enabled. Check runtime/profit-experiment/report.json for cohort and feed status.');
}
function enableResearch() {
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'settings.json');
  if(fs.existsSync(file)&&!read(file))throw Error('Profit settings unreadable; refusing to replace them');
  const settings=read(file)||{enabled:true,parents:experiment.PARENTS};
  if(settings.enabled!==true)throw Error('Existing profit experiment is disabled; refusing to silently enable it');
  settings.entryResearchEnabled=true;settings.entryResearchVersion=experiment.RESEARCH_VERSION;
  write(file,settings);ensure();
  console.log('Entry research enabled prospectively: separate matched $50k controls, three-minute origin expiry, half-stop retention, and one-M1-ATR stop admission. Baseline journals unchanged. Restart the existing profit worker to load updated code.');
}
function main() {
  if(process.argv.includes('--research-enable'))return enableResearch();
  if(process.argv.includes('--enable'))return enable();
  if(process.argv.includes('--start'))return ensure();
  fs.mkdirSync(dir,{recursive:true});
  const release=require('../lib/watcher-process.cjs').acquireWatcherLock(root,'profit-experiment',{findPids:()=>running()});
  process.on('exit',release);for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>process.exit(0));
  const run=()=>{try{tick();}catch(e){console.error(new Date().toISOString(),e.message);const prior=read(path.join(dir,'report.json'))||{};write(path.join(dir,'report.json'),{...prior,enabled:true,status:'error',error:e.message,updatedAt:new Date().toISOString()});}};
  run();if(!process.argv.includes('--once'))setInterval(run,5000);
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={tick,tickAt,ensure,enable,enableResearch};
