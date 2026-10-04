const test=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const path=require('node:path');
test('10: bridge exits before listening when LIVE_STATUS_TOKEN is absent',async()=>{
 const child=spawn(process.execPath,['scripts/live-status-server.cjs'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,LIVE_STATUS_TOKEN:'',LIVE_STATUS_PORT:'0',ENV_FILE:'/nonexistent',DATABENTO_API_KEY:''},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',c=>stderr+=c);let timer;
 try{const outcome=await Promise.race([new Promise(r=>child.once('exit',code=>r(code))),new Promise(r=>timer=setTimeout(()=>r('still-listening'),1500))]);assert.equal(outcome,1);assert.match(stderr,/LIVE_STATUS_TOKEN/);}finally{clearTimeout(timer);child.kill();}
});
test('10: bridge validates authorization in constant time and permits loopback only',()=>{
 const auth=require('../lib/bridge-security.cjs');assert.throws(()=>auth.settings({}),/LIVE_STATUS_TOKEN/);
 assert.equal(auth.settings({LIVE_STATUS_TOKEN:'fixture'}).host,'127.0.0.1');assert.throws(()=>auth.settings({LIVE_STATUS_TOKEN:'fixture',LIVE_STATUS_HOST:'0.0.0.0'}),/loopback/);
 assert.equal(auth.authorized('Bearer fixture','fixture'),true);assert.equal(auth.authorized('Bearer wrong','fixture'),false);assert.equal(auth.authorized(undefined,'fixture'),false);
});
