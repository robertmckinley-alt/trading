const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
process.chdir(path.resolve(__dirname, '..'));
require('dotenv').config({path:'.env.local', quiet:true});
async function main() {
  fs.mkdirSync('runtime', {recursive:true});
  const h = require('../lib/historical-data.cjs');
  console.log('STARTED', new Date().toISOString());
  const data = await h.fetchDatabentoHistoricalCandles({
    symbol:'MGC.v.0', dataset:'GLBX.MDP3',
    window:h.historicalSinceYearWindow(2025), cacheDir:'runtime/gold-history-cache',
    onProgress:p => console.log(JSON.stringify(p))
  });
  const file = 'runtime/gold-history.json';
  fs.writeFileSync(file+'.tmp', JSON.stringify(data));
  fs.renameSync(file+'.tmp', file);
  console.log('SIMULATING', data.candles.length, 'gold candles');
  const run = spawnSync(process.execPath, ['scripts/backtest-gold.cjs', file], {stdio:'inherit'});
  if (run.status !== 0) throw new Error('Gold simulation failed');
  console.log('COMPLETED', new Date().toISOString());
}
main().catch(e => {console.error('FAILED:', e.message); process.exitCode=1;});
