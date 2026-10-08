import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLinemateExport,wilsonInterval} from '../lib/nfl-linemate.mjs';
test('normalizes authorized trend rows',()=>{
 const rows=normalizeLinemateExport([{player:'Example Player',market:'receiving_yards',line:49.5,games:10,hits:7}]);
 assert.equal(rows[0].hitRate,0.7);
 assert.equal(rows[0].source,'user_authorized_export');
});
test('rejects impossible trend counts',()=>{
 assert.throws(()=>normalizeLinemateExport([{player:'P',market:'yards',line:10,games:3,hits:4}]));
});
test('small samples produce appropriately wide confidence intervals',()=>{
 const a=wilsonInterval(7,10),b=wilsonInterval(70,100);
 assert.ok(a.high-a.low>b.high-b.low);
});
