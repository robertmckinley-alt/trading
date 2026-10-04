const {timingSafeEqual,createHash}=require('node:crypto');
function settings(env=process.env){
 const token=String(env.LIVE_STATUS_TOKEN||'').trim();if(!token)throw new Error('LIVE_STATUS_TOKEN is required; bridge was not started');
 const host=env.LIVE_STATUS_HOST||'127.0.0.1';if(!['127.0.0.1','::1','localhost'].includes(host))throw new Error('LIVE_STATUS_HOST must be loopback; use a reverse proxy in the same network namespace');
 return {token,host};
}
function authorized(header,token){
 if(!token||typeof header!=='string')return false;
 const digest=s=>createHash('sha256').update(s).digest();
 return timingSafeEqual(digest(header),digest(`Bearer ${token}`));
}
module.exports={settings,authorized};
