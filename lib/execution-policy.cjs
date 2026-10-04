const {timestampForWallClock}=require('./dmc-market-open.cjs');
const {session}=require('./orb-session.cjs');
const VERSION='execution-repair-v1';
const ORDER_LIFETIME_MS=180000;
const clock=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
function tradingDate(at){return clock.format(new Date(at));}
function deadlines(setup,fallbackAt){
 const available=Date.parse(setup.signalAvailableAt||'');
 const detected=Date.parse(setup.detectedAt||fallbackAt||'');
 const at=Number.isFinite(available)?available:detected+60000;
 if(!Number.isFinite(at))throw new Error('Execution policy requires signal availability');
 setup.signalAvailableAt=new Date(at).toISOString();
 const date=tradingDate(at),cash=session(date);
 if(!cash.known||!cash.open)throw new Error(`No reviewed cash session for ${date}`);
 const minute=cash.closeMinute-1;
 const close=Date.parse(timestampForWallClock(date,`${Math.floor(minute/60)}:${String(minute%60).padStart(2,'0')}`));
 // Preserve any earlier explicit exit; no order can outlive its session.
 setup.flattenAt=new Date(Math.min(close,Date.parse(setup.flattenAt||'')||Infinity)).toISOString();
 setup.orderExpiresAt=new Date(Math.min(at+ORDER_LIFETIME_MS,Date.parse(setup.orderExpiresAt||'')||Infinity,Date.parse(setup.flattenAt))).toISOString();
 setup.executionPolicyVersion=VERSION;
 return setup;
}
function lookbackBars(config){return Math.max(1,Math.trunc(Number(config.live?.lookbackBars||2880)));}
module.exports={VERSION,ORDER_LIFETIME_MS,tradingDate,deadlines,lookbackBars};
