#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { alignReleasedSeries, benchmarkSeries, scoreForecasts } = require('../lib/research-context.cjs');
function main() {
  const [mode, inputPath, outputName] = process.argv.slice(2);
  if (!['macro', 'benchmark', 'forecasts'].includes(mode) || !inputPath || !/^[a-zA-Z0-9_-]+\.json$/.test(outputName || '')) throw new Error('Usage: node scripts/research-context.cjs macro|benchmark|forecasts input.json output-name.json');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const report = mode === 'macro' ? alignReleasedSeries(input.decisionTimes, input.observations)
    : mode === 'benchmark' ? benchmarkSeries(input.points, input.options) : scoreForecasts(input.rows);
  const root = path.join(__dirname, '..', 'runtime', 'research-context');
  for (const directory of [path.dirname(root), root]) {
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Research output directories must not be symlinks');
  }
  fs.mkdirSync(root, { recursive: true });
  const destination = path.join(root, outputName);
  fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(`Research-only report: ${destination}`);
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
