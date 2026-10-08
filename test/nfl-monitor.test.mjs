import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchNflMonitor } from '../lib/nfl-monitor.mjs';
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
  {market_key:'player_pass_yds',event_id:'game1',bookmaker:'bookB',player:'Quarterback',line:250.5,over_price:115,under_price:-140,period:'FULL',last_update:new Date().toISOString()},
  {market_key:'player_pass_yds',event_id:'game1',bookmaker:'bookC',player:'Quarterback',line:260.5,over_price:200,under_price:-250,period:'FULL',last_update:new Date().toISOString()},
 ];
 const result=await fetchNflMonitor({key:'test',fetcher:async()=>({ok:true,json:async()=>({data}),headers})});
 assert.equal(result.linesCount,6);
 assert.equal(result.discrepancies.length,1);
 assert.equal(result.discrepancies[0].point,250.5);
});
test('unexpected provider payload does not count as successful monitoring',async()=>{
 const result=await fetchNflMonitor({key:'test',fetcher:async()=>({ok:true,json:async()=>({unexpected:true}),headers})});
 assert.equal(result.status,'invalid_payload');
 assert.equal(result.ok,false);
});
