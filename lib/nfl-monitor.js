const BASE = 'https://parlay-api.com/v1/sports/americanfootball_nfl';
const MARKETS = ['player_pass_yds','player_rush_yds','player_rec_yds','player_receptions','player_anytime_td','player_pass_tds'];
const number = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function normalize(rows) {
  const lines = [];
  for (const item of rows) {
    if (!item || !MARKETS.includes(item.market_key)) continue;
    if (item.period && item.period !== 'FULL') continue;
    const point = number(item.line);
    const base = {eventId:item.event_id,home:item.home_team,away:item.away_team,kickoff:item.commence_time,book:item.bookmaker,updatedAt:item.last_update,market:item.market_key,player:item.player_name,point,period:item.period||'UNSPECIFIED'};
    for (const [side,key] of [['Over','over_price'],['Under','under_price']]) {
      const odds=number(item[key]);
      if(odds!==null && odds!==0 && odds!==-10000) lines.push({...base,side,odds});
    }
  }
  return lines;
}
export async function fetchNflMonitor({key=process.env.PARLAY_API_KEY,fetcher=fetch}={}) {
 const checkedAt=new Date().toISOString();
 if(!key) return {ok:false,configured:false,checkedAt,status:'missing_parlay_api_key',lines:[],warnings:['PARLAY_API_KEY is not configured']};
 const url=BASE+'/props?'+new URLSearchParams({markets:MARKETS.join(','),limit:'5000'});
 let response;
 try { response=await fetcher(url,{headers:{'X-API-Key':key},cache:'no-store',signal:AbortSignal.timeout(20000)}); }
 catch(e) {return {ok:false,configured:true,checkedAt,status:'network_error',lines:[],warnings:[e instanceof Error?e.message:'Provider connection failed']};}
 if(!response.ok) return {ok:false,configured:true,checkedAt,status:'provider_error',httpStatus:response.status,lines:[],warnings:['ParlayAPI returned HTTP '+response.status]};
 let payload;
 try {payload=await response.json();}catch{return {ok:false,configured:true,checkedAt,status:'invalid_json',lines:[],warnings:['Provider returned invalid JSON']};}
 const rows=Array.isArray(payload)?payload:Array.isArray(payload?.data)?payload.data:Array.isArray(payload?.props)?payload.props:null;
 if(!rows) return {ok:false,configured:true,checkedAt,status:'invalid_payload',lines:[],warnings:['Unexpected ParlayAPI props response shape']};
 const lines=normalize(rows);
 const now=Date.now(),warnings=[];
 const stale=lines.filter(x=>!validTime(x.updatedAt)||now-Date.parse(x.updatedAt)>2*3600000);
 if(stale.length)warnings.push(stale.length+' line records are stale (>2h) or undated');
 if(!lines.length)warnings.push('No supported full-game NFL player props returned');
 if(response.headers.get('x-result-has-more')==='true')warnings.push('Partial board: pagination required; x-next-offset='+response.headers.get('x-next-offset'));
 const groups=new Map();
 for(const line of lines){const k=[line.eventId,line.market,line.player,line.side,line.point,line.period].join('|');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(line);}
 const differences=[];
 for(const group of groups.values()){if(group.length<2)continue;const prices=group.map(x=>x.odds),lo=Math.min(...prices),hi=Math.max(...prices);if(hi-lo>=20)differences.push({market:group[0].market,player:group[0].player,side:group[0].side,point:group[0].point,minOdds:lo,maxOdds:hi,books:group.length});}
 return {ok:true,configured:true,checkedAt,status:'checked',provider:'ParlayAPI',games:new Set(lines.map(x=>x.eventId)).size,linesCount:lines.length,staleLines:stale.length,discrepancies:differences.slice(0,30),lines:lines.slice(0,100),warnings,remainingCredits:response.headers.get('x-credits-remaining')||null};
}
