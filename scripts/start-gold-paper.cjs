const fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
require('dotenv').config({path:'.env.local',quiet:true});
if(!process.env.DATABENTO_API_KEY) throw new Error('DATABENTO_API_KEY is required for the separate gold feed');
fs.mkdirSync('runtime',{recursive:true});
function launch(command,args,label,pattern) {
  let existing='';try {existing=execFileSync('pgrep',['-f',pattern],{encoding:'utf8'}).trim();} catch(e) {if(e.status!==1) throw e;}
  if(existing) {if(existing.split(/\s+/).length!==1) throw new Error(`${label}: duplicate processes; inspect before starting`);fs.writeFileSync(`runtime/${label}.pid`,existing);console.log(`${label} already running: ${existing}`);return;}
  const fd=fs.openSync(`runtime/${label}.log`,'a');
  const child=spawn(command,args,{cwd:root,env:process.env,detached:true,stdio:['ignore',fd,fd]});
  child.on('error',e=>{console.error(`${label}: ${e.message}`);process.exitCode=1;});
  child.unref();fs.closeSync(fd);
  if(child.pid) {fs.writeFileSync(`runtime/${label}.pid`,String(child.pid));console.log(`${label} launched PID ${child.pid}; check log and feed timestamp to verify readiness`);}
}
launch('python3',['scripts/databento-live-feed.py','--symbol','MGC.v.0','--output','runtime/databento-gold-live.json'],'databento-gold-feed','^python3 scripts/databento-live-feed.py --symbol MGC.v.0 --output runtime/databento-gold-live.json$');
launch('node',['paper-trader.cjs','watch-live','--provider=databento-live','--interval=60000','--strategy=mgc-open-ema12'],'mgc-open-ema12-watch','^node paper-trader.cjs watch-live --provider=databento-live --interval=60000 --strategy=mgc-open-ema12$');
