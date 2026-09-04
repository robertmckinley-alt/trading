#!/usr/bin/env node
const { parentPort, workerData } = require('worker_threads');
const { executeBacktest } = require('../lib/backtest-service.cjs');
const { saveBacktestResult } = require('../lib/backtest-worker.cjs');

async function main() {
  try {
    const result = await executeBacktest({ days: workerData.days });
    saveBacktestResult(workerData.cachePath, result);
    parentPort.postMessage({ ok: true });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.message });
  }
}

void main();
