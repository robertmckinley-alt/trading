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
      sendJson(res, 200, { ok: true, result });
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
});
