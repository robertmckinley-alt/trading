#!/usr/bin/env node
// Run inside the paper-trading container. No state migration or journal rewrite.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
function workers(script) {
  return fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)).flatMap(n=>{
    try {
      const cwd=fs.readlinkSync(`/proc/${n}/cwd`),args=fs.readFileSync(`/proc/${n}/cmdline`,'utf8').split('\0').filter(Boolean);
      return cwd===root && path.basename(args[0]||'')==='node' && path.resolve(cwd,args[1]||'')===path.join(root,script) && args.includes('--worker')?[Number(n)]:[];
    } catch {return [];}
  });
}
async function main() {
  process.chdir(root);
  const risk=require('../lib/portfolio-risk.cjs');
  const snapshot=risk.getPortfolioRiskSnapshot(root,require('../config.json'));
  if(snapshot.issues.length)throw Error(`Repair blocked by account-state errors: ${JSON.stringify(snapshot.issues)}`);
  for(const folder of ['profit-experiment','regime-experiment']) {
    const file=path.join(root,'runtime',folder,'state.json');
    if(fs.existsSync(file)) {
      const state=JSON.parse(fs.readFileSync(file));
      if(!state?.accounts || !Array.isArray(state.events))throw Error(`Invalid ${folder} state; refusing restart`);
    }
  }
  execFileSync(process.execPath,['scripts/restart-execution-watchers.cjs','--profit-preservation'],{cwd:root,stdio:'inherit'});
  for(const script of ['scripts/profit-paper.cjs','scripts/regime-paper.cjs']) {
    const old=workers(script);
    for(const pid of old)if(workers(script).includes(pid))process.kill(pid,'SIGTERM');
    for(let i=0;i<50&&workers(script).some(p=>old.includes(p));i++)await wait(100);
    if(workers(script).some(p=>old.includes(p)))throw Error(`${script} did not stop; no duplicate launched`);
    // ensure() retains disabled settings; only existing opt-ins are restarted.
    require(path.join(root,script)).ensure();
  }
  execFileSync(process.execPath,['scripts/restart-status-server.cjs'],{cwd:root,stdio:'inherit'});
  console.log('Audit fixes loaded. Journals and saved plans retained. Confirm fresh watcher and experiment heartbeats with the operations monitor.');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
