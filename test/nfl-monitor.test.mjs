import test from 'node:test';
import assert from 'node:assert/strict';
import {
 applyNflPlayerSnapshotFallback,
 fetchNflMonitor,
 normalizeParlayProps,
 retryDelayForPropFailure,
} from '../lib/nfl-monitor.mjs';
const headers = { get: () => null };
const marketFetcher = (data, headerForMarket = () => headers) => async (url) => {
 const market = new URL(String(url)).searchParams.get('markets');
 return {
  ok:true,
  json:async()=>({data:data.filter((row)=>row.market_key===market)}),
  headers:headerForMarket(market),
 };
};
test('missing key fails closed without contacting provider',async()=>{
 const result=await fetchNflMonitor({key:'',includeGameMarkets:false,fetcher:()=>{throw Error('must not fetch')}});
 assert.equal(result.status,'missing_parlay_api_key');
 assert.equal(result.ok,false);
});
test('provider errors fail closed',async()=>{
 const result=await fetchNflMonitor({key:'test',includeGameMarkets:false,fetcher:async()=>({ok:false,status:429})});
 assert.equal(result.httpStatus,429);
 assert.equal(result.ok,false);
});
test('identical player lines compare across sportsbooks only',async()=>{
 const data=[
  {market_key:'player_pass_yds',event_id:'game1',bookmaker:'bookA',player:'Quarterback',line:250.5,over_price:-110,under_price:-110,period:'FULL',last_update:new Date().toISOString()},
  {market_key:'player_pass_yds',event_id:'game1',bookmaker:'bookB',player:'Quarterback',line:250.5,over_price:115,under_price:-115,period:'FULL',last_update:new Date().toISOString()},
  {market_key:'player_pass_yds',event_id:'game1',bookmaker:'bookC',player:'Quarterback',line:260.5,over_price:200,under_price:-250,period:'FULL',last_update:new Date().toISOString()},
 ];
 const result=await fetchNflMonitor({key:'test',includeGameMarkets:false,fetcher:marketFetcher(data)});
 assert.equal(result.linesCount,6);
 assert.equal(result.discrepancies.length,1);
 assert.equal(result.discrepancies[0].point,250.5);
 assert.equal(result.discrepancies[0].identityStatus,'display_name_only');
 assert.equal(result.discrepancies[0].actionable,false);
});
test('unexpected provider payload does not count as successful monitoring',async()=>{
 const result=await fetchNflMonitor({key:'test',includeGameMarkets:false,fetcher:async()=>({ok:true,json:async()=>({unexpected:true}),headers})});
 assert.equal(result.status,'invalid_payload');
 assert.equal(result.ok,false);
});
test('normalizes current aliases, timestamps, source types, injuries and selection ids',()=>{
 const now=Date.parse('2026-10-08T03:00:00Z');
 const lines=normalizeParlayProps([
  {market_key:'player_passing_yards',canonical_event_id:'canonical-1',bookmaker:'fanduel',player:'Quarterback Jr.',line:250.5,over_price:-110,under_price:-105,last_update:now-20_000,age_seconds:20,over_sid:'selection-1',injury:{status:'Questionable',description:'Limited',date:'2026-10-07T20:00:00Z'}},
  {market_key:'player_rush_yds',canonical_event_id:'canonical-1',bookmaker:'underdog',player:'Running Back',line:60.5,over_price:-137,under_price:-137,age_seconds:30,odds_type:'standard'},
  {market_key:'player_receptions',canonical_event_id:'canonical-1',bookmaker:'kalshi',player:'Receiver',line:4.5,over_price:120,under_price:-140,age_seconds:40},
 ],{now});
 assert.equal(lines.length,6);
 assert.equal(lines[0].market,'player_pass_yds');
 assert.equal(lines[0].eventId,'canonical-1');
 assert.equal(lines[0].updatedAt,'2026-10-08T02:59:40.000Z');
 assert.equal(lines[0].selectionId,'selection-1');
 assert.equal(lines[0].injury.status,'Questionable');
 assert.equal(lines[2].sourceType,'dfs');
 assert.equal(lines[4].sourceType,'prediction_market');
});
test('preserves completeness and current credit headers',async()=>{
 const values=new Map([
  ['x-result-page-size','1'],['x-result-row-count','1'],['x-result-limit','10000'],['x-result-offset','0'],
  ['x-result-has-more','false'],['x-result-truncated','true'],['x-result-truncated-hint','source cap'],
  ['x-result-degraded','bookA'],['x-requests-remaining','99997'],['x-requests-last','3'],['x-request-id','request-1'],
 ]);
 const data=[{market_key:'player_pass_yds',canonical_event_id:'game1',bookmaker:'fanduel',player:'Quarterback',line:250.5,over_price:-110,under_price:-110,age_seconds:10}];
 const cleanHeaders={get:(name)=>({
  'x-result-page-size':'0','x-result-row-count':'0','x-result-limit':'10000','x-result-offset':'0',
  'x-result-has-more':'false','x-result-truncated':'false',
 }[name]||null)};
 const result=await fetchNflMonitor({key:'test',includeGameMarkets:false,fetcher:marketFetcher(data,(market)=>market==='player_pass_yds'?{get:(name)=>values.get(name)||null}:cleanHeaders)});
 assert.equal(result.status,'checked_incomplete');
 assert.equal(result.completeness.truncated,true);
 assert.deepEqual(result.completeness.truncatedMarkets,['player_pass_yds']);
 assert.deepEqual(result.completeness.degradedBooks,['bookA']);
 assert.equal(result.remainingCredits,'99997');
 assert.equal(result.requestCost,null);
 assert.equal(result.snapshot.lines.length,2);
});
test('DFS rows cannot create sportsbook price-gap diagnostics',async()=>{
 const data=[
  {market_key:'player_receptions',canonical_event_id:'game1',bookmaker:'prizepicks',player:'Receiver',line:5.5,over_price:-137,under_price:-137,age_seconds:10},
  {market_key:'player_receptions',canonical_event_id:'game1',bookmaker:'underdog',player:'Receiver',line:5.5,over_price:120,under_price:-150,age_seconds:10},
 ];
 const result=await fetchNflMonitor({key:'test',includeGameMarkets:false,fetcher:marketFetcher(data)});
 assert.equal(result.discrepancies.length,0);
 assert.equal(result.coverage.bySourceType.dfs,4);
});

test('requests each prop market separately and aggregates request credits',async()=>{
 const requested=[];
 const result=await fetchNflMonitor({key:'test',includeGameMarkets:false,fetcher:async(url)=>{
  const parsed=new URL(String(url));
  assert.equal(parsed.hostname,'api.parlay-api.com');
  requested.push(parsed.searchParams.get('markets'));
  return {ok:true,json:async()=>({data:[]}),headers:{get:(name)=>({
   'x-result-page-size':'0','x-result-row-count':'0','x-result-limit':'10000','x-result-offset':'0',
   'x-result-has-more':'false','x-result-truncated':'false','x-requests-remaining':'99982','x-requests-last':'3',
  }[name]||null)}};
 }});
 assert.equal(requested.length,6);
 assert.equal(new Set(requested).size,6);
 assert.equal(result.completeness.requestMode,'per_market');
 assert.equal(result.completeness.boardExhausted,true);
 assert.equal(result.requestCost,'18');
 assert.equal(result.remainingCredits,'99982');
});

test('adds moneyline, spread and total coverage to the full monitor',async()=>{
 const now=new Date().toISOString();
 const result=await fetchNflMonitor({key:'test',fetcher:async(url)=>{
  const parsed=new URL(String(url));
  const responseHeaders={get:(name)=>({
   'x-result-page-size':'0','x-result-row-count':'0','x-result-limit':'10000','x-result-offset':'0',
   'x-result-has-more':'false','x-result-truncated':'false','x-requests-remaining':'99979','x-requests-last':'3',
  }[name]||null)};
  if(parsed.pathname.endsWith('/odds')) return {ok:true,headers:responseHeaders,json:async()=>[{
   id:'game-1',commence_time:'2026-10-11T20:25:00Z',home_team:'Home Team',away_team:'Away Team',bookmakers:[{
    key:'book-a',title:'Book A',last_update:now,markets:[
     {key:'h2h',last_update:now,outcomes:[{name:'Home Team',price:-120},{name:'Away Team',price:110}]},
     {key:'spreads',last_update:now,outcomes:[{name:'Home Team',price:-110,point:-2.5},{name:'Away Team',price:-110,point:2.5}]},
     {key:'totals',last_update:now,outcomes:[{name:'Over',price:-110,point:44.5},{name:'Under',price:-110,point:44.5}]},
    ],
   }],
  }]};
  return {ok:true,headers:responseHeaders,json:async()=>({data:[]})};
 }});
 assert.equal(result.gameMarkets.ok,true);
 assert.equal(result.gameMarkets.gamesCount,1);
 assert.equal(result.gameMarkets.games[0].marketLeader,'Home Team');
 assert.equal(result.requestCost,'21');
 assert.equal(result.status,'checked');
});

test('keeps current game markets operational when one prop market times out',async()=>{
 const now='2026-10-10T17:00:00Z';
 const result=await fetchNflMonitor({key:'test',fetcher:async(url)=>{
  const parsed=new URL(String(url));
  const headers={get:(name)=>({
   'x-result-page-size':'0','x-result-row-count':'0','x-result-limit':'10000','x-result-offset':'0',
   'x-result-has-more':'false','x-result-truncated':'false',
  }[name]||null)};
  if(parsed.pathname.endsWith('/odds'))return {ok:true,headers,json:async()=>[{
   id:'game-1',commence_time:'2026-10-11T20:00:00Z',home_team:'Home',away_team:'Away',bookmakers:[{
    key:'book-a',title:'Book A',last_update:now,markets:[
     {key:'h2h',last_update:now,outcomes:[{name:'Home',price:-120},{name:'Away',price:110}]},
     {key:'spreads',last_update:now,outcomes:[{name:'Home',price:-110,point:-2.5},{name:'Away',price:-110,point:2.5}]},
     {key:'totals',last_update:now,outcomes:[{name:'Over',price:-110,point:44.5},{name:'Under',price:-110,point:44.5}]},
    ],
   }],
  }]};
  if(parsed.searchParams.get('markets')==='player_pass_yds')throw Error('The operation was aborted due to timeout');
  return {ok:true,headers,json:async()=>({data:[]})};
 }});
 assert.equal(result.ok,true);
 assert.equal(result.status,'checked_incomplete');
 assert.equal(result.gameMarkets.ok,true);
 assert.equal(result.completeness.failedMarkets.length,1);
 assert.match(result.warnings.join(' '),/player_pass_yds: network_error/);
});

test('scheduled monitoring retries transient prop failures once',async()=>{
 const calls=new Map();
 const result=await fetchNflMonitor({
  key:'test',
  includeGameMarkets:false,
  propAttempts:2,
  propRetryDelayMs:0,
  fetcher:async(url)=>{
   const market=new URL(String(url)).searchParams.get('markets');
   calls.set(market,(calls.get(market)||0)+1);
   if(market==='player_pass_yds'&&calls.get(market)===1){
    return {ok:false,status:503,headers:{get:(name)=>name==='x-requests-last'?'3':null}};
   }
   return {ok:true,headers:{get:(name)=>({
    'x-result-page-size':'0','x-result-row-count':'0','x-result-limit':'10000','x-result-offset':'0',
    'x-result-has-more':'false','x-result-truncated':'false','x-requests-last':'3',
   }[name]||null)},json:async()=>({data:[]})};
  },
 });
 assert.equal(result.ok,true);
 assert.equal(result.status,'checked');
 assert.equal(calls.get('player_pass_yds'),2);
 assert.deepEqual(result.completeness.retriedMarkets,['player_pass_yds']);
 assert.equal(result.completeness.failedMarkets.length,0);
 assert.equal(result.requestCost,'21');
});

test('provider retry delay honors Retry-After instead of retrying too early',()=>{
 assert.equal(retryDelayForPropFailure({retryAfterSeconds:5},500),5000);
 assert.equal(retryDelayForPropFailure({retryAfterSeconds:null},750),750);
});

test('fresh saved player lines replace an empty live pull with adjusted ages',()=>{
 const now=Date.parse('2026-10-10T22:00:00Z');
 const snapshotCheckedAt='2026-10-10T21:50:00Z';
 const baseLine={
  eventId:'game-1',providerEventId:'game-1',home:'Home',away:'Away',kickoff:'2026-10-11T20:00:00Z',
  bookmaker:'fanduel',bookmakerTitle:'FanDuel',sourceType:'sportsbook',market:'player_pass_yds',player:'Quarterback',
  point:250.5,period:'FULL',side:'Over',odds:-110,ageSeconds:30,
 };
 const result=applyNflPlayerSnapshotFallback({
  checkedAt:'2026-10-10T22:00:00Z',linesCount:0,warnings:['No supported full-game NFL player props returned'],
  completeness:{failedMarkets:[{market:'player_pass_yds',status:'provider_error',httpStatus:503,detail:'HTTP 503'}]},
 },{
  checked_at:snapshotCheckedAt,
  payload:{checkedAt:snapshotCheckedAt,lines:[baseLine,{...baseLine,bookmaker:'draftkings',ageSeconds:4000}]},
 },{now});
 assert.equal(result.linesCount,1);
 assert.equal(result.staleLines,1);
 assert.equal(result.lines[0].ageSeconds,630);
 assert.equal(result.playerData.status,'snapshot_fallback');
 assert.equal(result.playerData.source,'saved_snapshot');
 assert.match(result.playerData.reason,/HTTP 503/);
});

test('stale saved player lines remain unavailable and never become plays',()=>{
 const now=Date.parse('2026-10-10T22:00:00Z');
 const result=applyNflPlayerSnapshotFallback({checkedAt:new Date(now).toISOString(),linesCount:0,warnings:[]},{
  checked_at:'2026-10-10T20:00:00Z',
  payload:{checkedAt:'2026-10-10T20:00:00Z',lines:[{ageSeconds:10}]},
 },{now});
 assert.equal(result.linesCount,0);
 assert.equal(result.playerData.status,'unavailable');
 assert.equal(result.playerData.source,'none');
});
