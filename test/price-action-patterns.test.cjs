const test = require('node:test');
const assert = require('node:assert/strict');
const { detect, SLUGS } = require('../lib/price-action-patterns.cjs');
function candles(rows, short = false) {
  return rows.flatMap(([open, high, low, close], i) => Array.from({length:5}, (_, j) => ({
    timestamp: new Date(Date.parse('2026-09-08T13:30:00Z') + (i*5+j)*60000).toISOString(),
    ...(short ? {open:200-open,high:200-low,low:200-high,close:200-close} : {open,high,low,close}), volume:100
  })));
}
const opening = [[95,100,90,96],[96,99,92,97],[97,99,94,98]];
const fixtures = [
  [[98,100,96,97],[96,98,94,95],[97,103,96,102],[98,100,93,94],[94,99,91,93],[94,105,93,104],[94,97,94,96]],
  [...opening,[99,104,98,103],[100,103,99.75,102]],
  [...opening,[95,99,91,96],[96,99,93,97],[97,99,95,98],[98,99,97,98],[99,104,98,103],[100,103,99.75,102]]
];
for (const [i, rows] of fixtures.entries()) {
  for (const short of [false,true]) test(`${SLUGS[i]} confirms ${short?'short':'long'} only after retest`, () => {
    const data=candles(rows,short), signal=detect(data,SLUGS[i],.25);
    assert.equal(signal.found,true);
    assert.equal(signal.side,short?'short':'long');
    const config = require('../lib/trader-core.cjs').normalizeConfig(require('../config.json'));
    const live = require('../lib/live-trader.cjs');
    const adapted = live.detectSignalFromCandles(data, {...config,strategySlug:SLUGS[i]}, {trades:[]});
    const plan = live.buildPlanFromSignal(adapted, config, require('../lib/trader-core.cjs').createEmptyState(config));
    assert.equal(plan.setup.setup.entryTimeframe,'M5');
    assert.equal(Math.abs(signal.targets[0]-signal.entry),2*Math.abs(signal.entry-signal.stop));
    assert.equal(detect(data.slice(0,-1),SLUGS[i],.25).found,false);
    assert.equal(detect(data.filter((_,n)=>n!==6),SLUGS[i],.25).found,false);
  });
}
test('breakout alone is not a retest; expired breakout cannot enter',()=>{
  assert.equal(detect(candles([...opening,[99,104,98,103]]),SLUGS[1],.25).found,false);
  const delayed=[...opening,[99,104,98,103],...Array(6).fill([103,105,102,104]),[100,103,99.75,102]];
  assert.equal(detect(candles(delayed),SLUGS[1],.25).found,false);
});
test('unconfirmed QM pivot and non-compressing range cannot qualify',()=>{
  assert.equal(detect(candles(fixtures[0].slice(0,5)),SLUGS[0],.25).found,false);
  const rows=fixtures[2].map(row=>[...row]); rows[5][2]=92;
  assert.equal(detect(candles(rows),SLUGS[2],.25).found,false);
});
test('qualification persists only passing patterns and attaches accounts once',()=>{
  const fs=require('node:fs'), path=require('node:path');
  const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'patterns-'));
  const config=require('../lib/trader-core.cjs').normalizeConfig(require('../config.json'));
  const trades=[...Array.from({length:50},(_,i)=>({date:'2025-02-03',id:`a${i}`})),...Array.from({length:20},(_,i)=>({date:'2026-02-03',id:`b${i}`}))].map(t=>({...t,status:'closed',contracts:1,realizedPnlUsd:100}));
  const report={generatedAt:'2026-09-10T00:00:00Z',provenance:{coverage:{complete:true},dataFingerprint:'fixture'},strategies:SLUGS.map((slug,i)=>({slug,name:slug,research:{trades:i===2?[]:trades}}))};
  try {
    const {qualify}=require('../lib/price-action-qualification.cjs');
    assert.equal(qualify(report,config,root).reviews[2].paperSelected,false);
    qualify(report,config,root);
    const saved=JSON.parse(fs.readFileSync(path.join(root,'runtime/price-action/paper-candidates.json')));
    assert.equal(saved.length,2);
    const {createState,attachCandidates}=require('../lib/orb-forward.cjs'), state=createState(config);
    attachCandidates(state,saved,saved[0].implementationHash);
    attachCandidates(state,saved,saved[0].implementationHash);
    assert.equal(state.accounts.length,11);
    assert.ok(state.accounts.every(a=>a.trades.length===0 && a.netPnlUsd===0));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
