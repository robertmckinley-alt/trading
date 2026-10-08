import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLinemateExport,wilsonInterval} from '../lib/nfl-linemate.mjs';
test('normalizes authorized trend rows',()=>{
 const rows=normalizeLinemateExport(
  [{player:'Example Player',market:'receiving_yards',side:'Over',line:49.5,games:10,hits:7}],
  {collectionMethod:'manual_entry',permissionBasis:'personal_noncommercial',observedAt:'2026-10-07T20:00:00-07:00'},
 );
 assert.equal(rows[0].hitRate,0.7);
 assert.equal(rows[0].source,'linemate_manual_reference');
 assert.equal(rows[0].actionable,false);
});
test('rejects impossible trend counts',()=>{
 assert.throws(()=>normalizeLinemateExport(
  [{player:'P',market:'yards',side:'Over',line:10,games:3,hits:4}],
  {collectionMethod:'manual_entry',permissionBasis:'personal_noncommercial',observedAt:'2026-10-07T20:00:00Z'},
 ));
});
test('rejects automated imports and unreferenced provider exports',()=>{
 const row=[{player:'P',market:'yards',side:'Over',line:10,games:3,hits:2,observed_at:'2026-10-07T20:00:00Z'}];
 assert.throws(()=>normalizeLinemateExport(row,{collectionMethod:'automated_browser',permissionBasis:'personal_noncommercial'}));
 assert.throws(()=>normalizeLinemateExport(row,{collectionMethod:'provider_export',permissionBasis:'written_permission'}));
});
test('small samples produce appropriately wide confidence intervals',()=>{
 const a=wilsonInterval(7,10),b=wilsonInterval(70,100);
 assert.ok(a.high-a.low>b.high-b.low);
});
