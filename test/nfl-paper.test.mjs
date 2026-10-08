import test from 'node:test';
import assert from 'node:assert/strict';
import {NFL_STRATEGIES,createPaperAccounts,removeTwoWayVig,expectedValue,settlePaperPosition,summarizePaperAccount} from '../lib/nfl-paper.mjs';
test('seven isolated accounts start with 50k each',()=>{
 const accounts=createPaperAccounts();
 assert.equal(accounts.length,7);assert.equal(new Set(accounts.map(a=>a.strategy)).size,7);
 assert.equal(accounts.reduce((sum,a)=>sum+a.equity,0),350000);
});
test('vig removal normalizes implied probabilities',()=>{
 const p=removeTwoWayVig(-110,-110);
 assert.ok(Math.abs(p.over-0.5)<1e-10);
 assert.ok(Math.abs(p.over+p.under-1)<1e-10);
});
test('expected value is per dollar staked',()=>{
 assert.ok(Math.abs(expectedValue(0.55,100)-0.1)<1e-10);
});
test('settlement, ROI and drawdown use settled trades only',()=>{
 const p=[settlePaperPosition({stake:100,odds:100},'win'),settlePaperPosition({stake:100,odds:-110},'loss'),settlePaperPosition({stake:100,odds:100},'push')];
 const a=summarizePaperAccount(p);
 assert.equal(a.equity,50000);assert.equal(a.wins,1);assert.equal(a.losses,1);assert.equal(a.pushes,1);assert.equal(a.maxDrawdown,100);
});
