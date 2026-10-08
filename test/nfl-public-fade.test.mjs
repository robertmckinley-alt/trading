import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePublicFade} from '../lib/nfl-public-fade.mjs';
const now=Date.now();
const valid={eventId:'example',market:'spread',side:'home',ticketPct:82,moneyPct:60,observedAt:new Date(now-10*60000).toISOString(),kickoff:new Date(now+2*3600000).toISOString(),odds:-110,source:'licensed_snapshot'};
test('flags valid research signal without implying EV',()=>{
 const x=evaluatePublicFade(valid);
 assert.equal(x.eligible,true);assert.equal(x.candidateSide,'away');
 assert.equal(x.divergence,22);assert.equal(x.classification,'research_only_not_a_pick');
});
test('rejects post-kickoff or future leakage',()=>{
 assert.equal(evaluatePublicFade({...valid,observedAt:new Date(now+3*3600000).toISOString()}).eligible,false);
});
test('rejects under-threshold ticket share',()=>{
 assert.equal(evaluatePublicFade({...valid,ticketPct:79}).eligible,false);
});
