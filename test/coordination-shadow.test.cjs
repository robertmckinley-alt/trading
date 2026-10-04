const test = require('node:test');
const assert = require('node:assert/strict');
const { advance, report } = require('../lib/coordination-shadow.cjs');
const core = require('../lib/trader-core.cjs');
const at = minute => `2026-10-02T14:${String(minute).padStart(2, '0')}:00Z`;
const now = Date.parse(at(10));
const loss = (id, side='long', symbol='NQ', minute=8) => ({ id, side, symbol, realizedPnlUsd: -100, stop: 100, exitReason:'stop-loss', exitedAt:at(minute), createdAt:at(minute+1) });
const config = core.normalizeConfig({ startingBalanceUsd:50000,maxAccountDrawdownPercent:10,maxRiskPerTradeUsd:500,tickSize:.25, tickValueUsd:5, slippageTicks:1, commissionPerContractUsd:4.5 });
const target = (overrides={}) => ({slug:'target', config, heartbeat:{ok:true,at:at(10)}, trades:[], lifecycle:{status:'open',filledAt:at(5)}, plan:{setup:{symbol:'NQ',side:'long'},signalContext:{observedAt:at(4),poc:100}},candles:[{timestamp:at(9),close:99}],...overrides});
test('only same-market, same-side shared-level failures propose exits, without changing inputs',()=>{
 const accounts=[{slug:'source',trades:[loss('1')]},target()];const original=structuredClone(accounts);
 const s=advance(null,accounts,now);assert.equal(s.events.length,1);assert.equal(Date.parse(s.events[0].executeAfter),Date.parse(at(11)));assert.deepEqual(accounts,original);
 assert.equal(advance(s,accounts,now).events.length,1);
 for(const t of [loss('1','short'),loss('1','long','MGC')]) assert.equal(advance(null,[{slug:'source',trades:[t]},target()],now).events.length,0);
});
test('missing exit timestamps, future knowledge, stale feed and unbroken levels cannot trigger exits',()=>{
 for(const t of [{...loss('1'),exitedAt:null},{...loss('1'),createdAt:at(12)}])assert.equal(advance(null,[{slug:'source',trades:[t]},target()],now).events.length,0);
 for(const a of [target({heartbeat:{ok:false,at:at(10)}}),target({candles:[{timestamp:at(9),close:101}]})])assert.equal(advance(null,[{slug:'source',trades:[loss('1')]},a],now).events.length,0);
});
test('whipsaw pause observes new pending orders only; a blocked winner counts as cost',()=>{
 const sources=[{slug:'a',trades:[loss('1','long','NQ',6)]},{slug:'b',trades:[loss('2','short','NQ',8)]}];
 const s=advance(null,sources,now);assert.equal(s.pauses.length,1);
 const pending=target({heartbeat:{ok:true,at:at(11)},lifecycle:{status:'not-filled'},plan:{setup:{symbol:'NQ',side:'long'},signalContext:{observedAt:at(11)}}});
 const next=advance(s,[...sources,pending],Date.parse(at(11)));assert.equal(next.events[0].kind,'entry-pause');
 const done=advance(next,[{slug:'target',trades:[{signalContext:{observedAt:at(11)},realizedPnlUsd:80,exitedAt:at(14)}]}],Date.parse(at(15)));
 assert.equal(report(done).costUsd,80);assert.equal(report(done).netDeltaUsd,-80);
});
test('counterfactual exit uses a future minute open with costs and preserves earlier stops',()=>{
 const setup=core.normalizeSetup({symbol:'NQ',entry:101,stop:95,targets:[120],side:'long',execution:'next-bar-market',detectedAt:at(4),setup:{},thesis:'test'},config);
 const plan=core.buildTradePlan(setup,config,core.createEmptyState(config));plan.signalContext={observedAt:at(4),poc:100};
 const candles=Array.from({length:7},(_,i)=>({timestamp:at(i+5),open:101,high:102,low:99,close:99}));
 const s=advance(null,[{slug:'source',trades:[loss('1')]},target({plan,candles:candles.slice(0,5)})],now);
 assert.equal(s.events.length,1);
 const done=advance(s,[target({plan,candles,trades:[{signalContext:{observedAt:at(4)},realizedPnlUsd:-100,exitedAt:at(15)}]})],Date.parse(at(16)));
 assert.equal(done.events[0].shadowExitAt,at(11));assert.equal(done.events[0].shadowExitPrice,100.75);assert.ok(done.events[0].shadowPnlUsd<0);
 const broken=structuredClone(candles);broken[5]={timestamp:at(10),open:94,high:99,low:93,close:94};
 const stop=advance(s,[target({plan,candles:broken})],Date.parse(at(12)));assert.equal(stop.events[0].shadowExitAt,at(10));
 const gap=advance(s,[target({plan,candles:candles.filter((_,i)=>i!==2)})],Date.parse(at(12)));assert.equal(gap.events[0].status,'insufficient-data');
});
test('public recap preserves exit candle time separately from journal recording time',()=>{
 const { buildDailyRecaps } = require('../lib/live-status.cjs');
 const result=buildDailyRecaps([{date:'2026-10-02',realizedPnlUsd:-10,filledAt:at(1),exitedAt:at(2),createdAt:at(3)}]);
 assert.equal(result[0].tradesList[0].exitedAt,at(2));assert.equal(result[0].tradesList[0].recordedAt,at(3));
 const old=buildDailyRecaps([{date:'2026-10-02',realizedPnlUsd:1,createdAt:at(3)}]);assert.equal(old[0].tradesList[0].exitedAt,null);
});
