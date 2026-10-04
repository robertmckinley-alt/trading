const {session}=require('./orb-session.cjs');
const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function parts(at){const p=Object.fromEntries(fmt.formatToParts(new Date(at)).map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};}
function cashCoverage(date,candles){
 const cash=session(date);if(!cash.open)return {complete:false,expected:0,actual:0,reason:cash.reason};
 const minutes=candles.map(c=>parts(c.timestamp)).filter(p=>p.date===date&&p.minute>=570&&p.minute<cash.closeMinute).map(p=>p.minute);
 const expected=cash.closeMinute-570,actual=new Set(minutes).size;
 return {complete:actual===expected&&minutes.length===expected,expected,actual,reason:actual===expected?'complete':'incomplete cash session'};
}
// UTC cache files contain overnight minutes too. Accept only an exact reviewed
// regular-session minute set. Holiday schedules are not guessed: those days are
// fetched again, while cash backtests use the reviewed cash calendar below.
function cacheDayComplete(dayStart,candles){
 const expected=new Set();
 for(let at=dayStart;at<dayStart+86400000;at+=60000){
  const p=parts(at),day=new Date(p.date+'T12:00Z').getUTCDay(),cash=session(p.date);
  if(!cash.known)return false;
  if(day>0&&day<6&&(!cash.open||cash.closeMinute!==960))return false;
  const closed=day===6||(day===0&&p.minute<1080)||(day===5&&p.minute>=1020)||(p.minute>=1020&&p.minute<1080)||(p.minute>=975&&p.minute<990);
  if(!closed)expected.add(at);
 }
 const actual=new Set(candles.map(c=>Date.parse(c.timestamp)));
 return actual.size===candles.length&&actual.size===expected.size&&[...actual].every(t=>expected.has(t));
}
module.exports={cashCoverage,cacheDayComplete,parts};
