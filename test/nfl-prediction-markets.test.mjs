import test from 'node:test';
import assert from 'node:assert/strict';
import {
 fetchNflPredictionMarketDiscovery,
 fetchNflSportPredictionMarkets,
 normalizeNflPredictionMarkets,
 normalizePredictionMarketDiscovery,
} from '../lib/nfl-prediction-markets.mjs';

test('normalizes source-native NFL game contracts without converting them into picks',()=>{
 const markets=normalizeNflPredictionMarkets([{event_id:'game-1',sport_key:'americanfootball_nfl',commence_time:'2026-10-11T20:25:00Z',home_team:'Seattle Seahawks',away_team:'Los Angeles Rams',source:'kalshi',selection:'Seattle Seahawks',yes_price:0.58,no_price:0.44,yes_implied_prob:0.58,no_implied_prob:0.44,volume_24h_usd:24000}]);
 assert.equal(markets.length,1);
 assert.equal(markets[0].selection,'Seattle Seahawks');
 assert.equal(markets[0].yesPrice,0.58);
 assert.equal(markets[0].actionable,false);
});

test('uses the dedicated NFL prediction-market endpoint for game contracts',async()=>{
 let requestedUrl='';
 const result=await fetchNflSportPredictionMarkets({key:'test',fetcher:async(url)=>{
  requestedUrl=String(url);
  return {ok:true,headers:{get:(name)=>({'x-requests-last':'1','x-requests-remaining':'99999'}[name]||null)},json:async()=>({data:[{event_id:'game-1',source:'polymarket',selection:'Rams',yes_price:0.49,no_price:0.53}]})};
 }});
 assert.match(requestedUrl,/prediction-markets\/americanfootball_nfl/);
 assert.equal(new URL(requestedUrl).searchParams.get('sources'),'kalshi,polymarket');
 assert.equal(result.ok,true);
 assert.equal(result.marketsCount,1);
 assert.equal(result.creditUsage.cost,'1');
});

test('normalizes source-native prediction-market discovery without creating a signal',()=>{
 const markets=normalizePredictionMarketDiscovery({markets:[{
  source:'kalshi',market_id:'KX-NFL',event_title:'NFL team wins',outcome:'Yes',volume:25000,match_confidence:0.92,
  prices:{yes_bid:0.61,yes_ask:0.63,no_bid:0.37,no_ask:0.39},rules_url:'https://example.test/rules',
 }]});
 assert.equal(markets.length,1);
 assert.equal(markets[0].prices.yesAsk,0.63);
 assert.equal(markets[0].discoveryOnly,true);
 assert.equal(markets[0].actionable,false);
});

test('prediction-market discovery keeps provider clusters as unverified leads',async()=>{
 let requestedUrl='';
 const result=await fetchNflPredictionMarketDiscovery({key:'test',query:'NFL',fetcher:async(url)=>{
  requestedUrl=String(url);
  return {ok:true,json:async()=>({source_summary:{kalshi:{count:1}},markets:[{source:'kalshi',event_title:'NFL market',outcome:'Yes',prices:{yes_bid:0.5,yes_ask:0.52}}],clusters:[{cluster_key:'nfl market',note:'Candidate text match only'}]})};
 }});
 assert.match(requestedUrl,/prediction-markets\/search/);
 assert.equal(result.ok,true);
 assert.equal(result.markets[0].actionable,false);
 assert.equal(result.clusters.length,1);
});
