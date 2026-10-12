import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePublicFade} from '../lib/nfl-public-fade.mjs';
const now=Date.now();
const valid={eventId:'example',market:'spread',side:'home',ticketPct:82,moneyPct:60,ticketCount:500,observedAt:new Date(now-10*60000).toISOString(),kickoff:new Date(now+2*3600000).toISOString(),opposingOdds:-110,oddsObservedAt:new Date(now-9*60000).toISOString(),opposingLine:3.5,publicLine:-3.5,source:'licensed_snapshot'};
test('eligible only with independent valid data',()=>{
 const x=evaluatePublicFade(valid,{asOf:now});
 assert.equal(x.status,'watchlist');assert.equal(x.eligible,false);assert.equal(x.candidateSide,'away');
 assert.equal(x.divergence,22);assert.equal(x.classification,'research_only_not_a_pick');
});
test('rejects future or late snapshots',()=>{
 assert.equal(evaluatePublicFade({...valid,observedAt:new Date(now+3*3600000).toISOString()},{asOf:now}).eligible,false);
 assert.equal(evaluatePublicFade({...valid,oddsObservedAt:new Date(now+3*3600000).toISOString()},{asOf:now}).eligible,false);
});
test('rejects small sample, weak divergence, and mismatched lines',()=>{
 for(const change of [{ticketCount:12},{moneyPct:78},{opposingLine:4.5},{ticketPct:79}])assert.equal(evaluatePublicFade({...valid,...change},{asOf:now}).eligible,false);
});
test('requires opposing side price, not the public side price',()=>{
 assert.equal(evaluatePublicFade({...valid,opposingOdds:null},{asOf:now}).eligible,false);
});

test('verified movement qualifies a complete signal',()=>{
 const x=evaluatePublicFade({...valid,marketMovement:{direction:'toward_candidate',from:-3,to:-2.5}},{asOf:now});
 assert.equal(x.status,'qualified');assert.equal(x.eligible,true);
});
