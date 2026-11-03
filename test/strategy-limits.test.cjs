const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const base=require('../config.json'),{SLUG,applyStrategyLimits}=require('../lib/strategy-limits.cjs');
const {riskGuardBot}=require('../lib/adaptive-bots.cjs');
const live=require('../lib/live-trader.cjs');
test('only the exact 9AM baseline account receives doubled financial and daily-entry limits',()=>{
  const original=structuredClone(base),next=applyStrategyLimits(base,SLUG);
  assert.equal(next.maxRiskPerTradeUsd,1000);assert.equal(next.adaptiveRiskFloorUsd,500);
  assert.equal(next.maxDailyLossUsd,1500);assert.equal(next.live.maxTradesPerDay,2);
  assert.deepEqual(base,original);assert.deepEqual(applyStrategyLimits(next,SLUG),next);
  for(const slug of ['hourly-sweep-ifvg-bos','nq-dmc-market-open','live-9am-sweep-min-stop','live-9am-sweep-x-test'])assert.equal(applyStrategyLimits(base,slug),base);
  assert.equal(next.startingBalanceUsd,50000);assert.equal(next.maxAccountDrawdownPercent,base.maxAccountDrawdownPercent);
  assert.equal(next.maxPortfolioOpenRiskUsd,base.maxPortfolioOpenRiskUsd);
  assert.deepEqual(next.maxStrategyFamilyOpenRiskUsd,base.maxStrategyFamilyOpenRiskUsd);
});
test('same adaptive multiplier doubles $325 admission to $650 without defeating loss or floor guards',()=>{
  const cfg=applyStrategyLimits(base,SLUG),market={riskMultiplier:.75},performance={riskMultiplier:1,dailyPnlUsd:0};
  const learning={adjustment:{riskMultiplier:.65}},state={balanceUsd:55460.5};
  assert.equal(riskGuardBot(base,state,market,performance,learning).adjustedRiskUsd,325);
  assert.equal(riskGuardBot(cfg,state,market,performance,learning).adjustedRiskUsd,650);
  assert.equal(riskGuardBot(cfg,state,market,{...performance,dailyPnlUsd:-1499},learning).allowed,true);
  assert.equal(riskGuardBot(cfg,state,market,{...performance,dailyPnlUsd:-1500},learning).allowed,false);
  assert.equal(riskGuardBot(cfg,{balanceUsd:45000},market,performance,learning).allowed,false);
});
test('9AM dispatcher admits a second daily evaluation but blocks a third',()=>{
  const cfg={...applyStrategyLimits(base,SLUG),strategySlug:SLUG};
  const candles=Array.from({length:841},(_,i)=>({timestamp:new Date(Date.parse('2026-10-23T00:00:00Z')+i*60000).toISOString(),open:100,high:101,low:99,close:100,volume:100}));
  const trade={date:'2026-10-23'};
  assert.doesNotMatch(live.detectSignalFromCandles(candles,cfg,{trades:[trade],live:{}}).reason,/Daily trade cap/);
  assert.match(live.detectSignalFromCandles(candles,cfg,{trades:[trade,trade],live:{}}).reason,/Daily trade cap/);
});
test('watcher applies account limits before strategy configuration and state hydration',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../paper-trader.cjs'),'utf8');
  const at=source.indexOf("applyStrategyLimits(loadConfig(), strategySlug)");
  assert.ok(at>0);assert.ok(at<source.indexOf('const config = {',at));assert.ok(at<source.indexOf('const state = loadState(config, statePath)',at));
});
