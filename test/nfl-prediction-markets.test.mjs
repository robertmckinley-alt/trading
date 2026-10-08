import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchNflPredictionMarketDiscovery, normalizePredictionMarketDiscovery } from '../lib/nfl-prediction-markets.mjs';

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
