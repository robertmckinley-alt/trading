import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchNflMonitor, normalizeParlayProps } from '../lib/nfl-monitor.mjs';
const headers = { get: () => null };
test('missing key fails closed without contacting provider',async()=>{
 const result=await fetchNflMonitor({key:'',fetcher:()=>{throw Error('must not fetch')}});
 assert.equal(result.status,'missing_parlay_api_key');
 assert.equal(result.ok,false);
});
test('provider errors fail closed',async()=>{
 const result=await fetchNflMonitor({key:'test',fetcher:async()=>({ok:false,status:429})});
 assert.equal(result.httpStatus,429);
 assert.equal(result.ok,false);
});
test('identical player lines compare across sportsbooks only',async()=>{
 const data=[
  {market_key:'player_pass_yds',event_id:'game1',bookmaker:'bookA',player:'Quarterback',line:250.5,over_price:-110,under_price:-110,period:'FULL',last_update:new Date().toISOString()},
  {market_key:'player_pass_yds',event_id:'game1',bookmaker:'bookB',player:'Quarterback',line:250.5,over_price:115,under_price:-115,period:'FULL',last_update:new Date().toISOString()},
  {market_key:'player_pass_yds',event_id:'game1',bookmaker:'bookC',player:'Quarterback',line:260.5,over_price:200,under_price:-250,period:'FULL',last_update:new Date().toISOString()},
 ];
 const result=await fetchNflMonitor({key:'test',fetcher:async()=>({ok:true,json:async()=>({data}),headers})});
 assert.equal(result.linesCount,6);
 assert.equal(result.discrepancies.length,1);
 assert.equal(result.discrepancies[0].point,250.5);
 assert.equal(result.discrepancies[0].identityStatus,'display_name_only');
 assert.equal(result.discrepancies[0].actionable,false);
});
test('unexpected provider payload does not count as successful monitoring',async()=>{
 const result=await fetchNflMonitor({key:'test',fetcher:async()=>({ok:true,json:async()=>({unexpected:true}),headers})});
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
 const result=await fetchNflMonitor({key:'test',fetcher:async()=>({ok:true,json:async()=>data,headers:{get:(name)=>values.get(name)||null}})});
 assert.equal(result.status,'checked_incomplete');
 assert.equal(result.completeness.truncated,true);
 assert.deepEqual(result.completeness.degradedBooks,['bookA']);
 assert.equal(result.remainingCredits,'99997');
 assert.equal(result.requestCost,'3');
 assert.equal(result.snapshot.lines.length,2);
});
test('DFS rows cannot create sportsbook price-gap diagnostics',async()=>{
 const data=[
  {market_key:'player_receptions',canonical_event_id:'game1',bookmaker:'prizepicks',player:'Receiver',line:5.5,over_price:-137,under_price:-137,age_seconds:10},
  {market_key:'player_receptions',canonical_event_id:'game1',bookmaker:'underdog',player:'Receiver',line:5.5,over_price:120,under_price:-150,age_seconds:10},
 ];
 const result=await fetchNflMonitor({key:'test',fetcher:async()=>({ok:true,json:async()=>data,headers})});
 assert.equal(result.discrepancies.length,0);
 assert.equal(result.coverage.bySourceType.dfs,4);
});
