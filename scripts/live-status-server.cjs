#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const path = require('path');

const envPath = process.env.ENV_FILE || path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  try {
    require('dotenv').config({ path: envPath, override: false });
  } catch (error) {
    console.warn(`Could not load env file ${envPath}: ${error.message}`);
  }
}

const { getLocalStrategySnapshots } = require('../lib/live-status.cjs');
const { executeBacktest } = require('../lib/backtest-service.cjs');

const port = Number(process.env.LIVE_STATUS_PORT || 3210);
const host = process.env.LIVE_STATUS_HOST || '0.0.0.0';
const statusToken = process.env.LIVE_STATUS_TOKEN || '';
const backtestCachePath = process.env.BACKTEST_CACHE_PATH || path.join(__dirname, '..', 'runtime', 'backtest-results.json');
const backtestRefreshMs = Math.max(60 * 60 * 1000, Number(process.env.BACKTEST_REFRESH_MS || 24 * 60 * 60 * 1000));
let backtestRefreshPromise = null;

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4096) reject(new Error('Request is too large.'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON request.')); }
    });
    req.on('error', reject);
  });
}

function saveBacktestResult(result) {
  fs.mkdirSync(path.dirname(backtestCachePath), { recursive: true });
  const temporaryPath = `${backtestCachePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(result));
  fs.renameSync(temporaryPath, backtestCachePath);
}

function refreshBacktestCache() {
  if (!process.env.DATABENTO_API_KEY) return Promise.resolve(null);
  if (backtestRefreshPromise) return backtestRefreshPromise;
  backtestRefreshPromise = executeBacktest({ days: 60 })
    .then((result) => {
      saveBacktestResult(result);
      console.log(`[${new Date().toISOString()}] refreshed 60-day backtest cache`);
      return result;
    })
    .catch((error) => {
      console.error(`[${new Date().toISOString()}] backtest refresh failed: ${error.message}`);
      return null;
    })
    .finally(() => { backtestRefreshPromise = null; });
  return backtestRefreshPromise;
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/healthz') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
    return;
  }

  if (statusToken && req.headers.authorization !== `Bearer ${statusToken}`) {
    res.writeHead(401, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return;
  }

  if (pathname === '/api/backtest' && req.method === 'POST') {
    try {
      const body = await readRequestJson(req);
      const result = await executeBacktest({ days: body.days || 60 });
      saveBacktestResult(result);
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: error.message });
    }
    return;
  }

  if (pathname === '/api/backtest-results' && req.method === 'GET') {
    try {
      if (!fs.existsSync(backtestCachePath)) {
        void refreshBacktestCache();
        sendJson(res, 202, { ok: false, pending: true, error: 'The first 60-day backtest is still being prepared.' });
        return;
      }
      sendJson(res, 200, { ok: true, result: JSON.parse(fs.readFileSync(backtestCachePath, 'utf8')) });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: error.message });
    }
    return;
  }

  if (pathname !== '/api/live-status') {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  try {
    const payload = getLocalStrategySnapshots();
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
});

server.listen(port, host, () => {
  console.log(`Live status server listening on http://${host}:${port}/api/live-status`);
  void refreshBacktestCache();
  setInterval(() => { void refreshBacktestCache(); }, backtestRefreshMs).unref();
});
