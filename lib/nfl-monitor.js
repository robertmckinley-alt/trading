const MARKETS = ['player_pass_yds','player_rush_yds','player_reception_yds','player_receptions','player_anytime_td'];
const BASE = 'https://api.the-odds-api.com/v4';
export async function fetchNflMonitor({key=process.env.ODDS_API_KEY,fetcher=fetch}={}) {
 const checkedAt=new Date().toISOString();
 if(!key) return {ok:false,configured:false,checkedAt,status:'missing_odds_api_key',games:0,lines:[],warnings:['ODDS_API_KEY is not configured; no live lines were checked']};
 const response=await fetcher(BASE+'/sports/americanfootball_nfl/odds?'+new URLSearchParams({apiKey:key,regions:'us',markets:MARKETS.join(','),oddsFormat:'american'}),{cache:'no-store',signal:AbortSignal.timeout(20000)});
 if(!response.ok) return {ok:false,configured:true,checkedAt,status:'provider_error',httpStatus:response.status,lines:[],warnings:['Odds provider returned HTTP '+response.status]};
 const games=await response.json();
 if(!Array.isArray(games)) return {ok:false,configured:true,checkedAt,status:'invalid_payload',lines:[],warnings:['Unexpected provider response']};
 const lines=[];
 for(const game of games) for(const book of game.bookmakers||[]) for(const market of book.markets||[]) for(const outcome of market.outcomes||[]) {
  if(!Number.isFinite(Number(outcome.price)))continue;
  lines.push({eventId:game.id,home:game.home_team,away:game.away_team,kickoff:game.commence_time,book:book.key,updatedAt:market.last_update||book.last_update,market:market.key,player:outcome.description||'',side:outcome.name,point:outcome.point??null,odds:Number(outcome.price)});
 }
 const now=Date.now(),warnings=[];
 const stale=lines.filter(x=>!x.updatedAt||now-Date.parse(x.updatedAt)>2*3600000);
 if(stale.length) warnings.push(stale.length+' lines are older than two hours or lack timestamps');
 if(!lines.length)warnings.push('No player prop lines returned (offseason, unsupported markets, or plan limits)');
 const grouped=new Map();
 for(const line of lines){const k=[line.eventId,line.market,line.player,line.side,line.point].join('|');if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(line);}
 const differences=[];
 for(const group of grouped.values()){if(group.length<2)continue;const prices=group.map(x=>x.odds);const lo=Math.min(...prices),hi=Math.max(...prices);if(hi-lo>=20)differences.push({market:group[0].market,player:group[0].player,side:group[0].side,point:group[0].point,minOdds:lo,maxOdds:hi,books:group.length});}
 return {ok:true,configured:true,checkedAt,status:'checked',games:games.length,linesCount:lines.length,staleLines:stale.length,discrepancies:differences.slice(0,30),lines:lines.slice(0,100),warnings,remainingRequests:response.headers.get('x-requests-remaining')};
}
