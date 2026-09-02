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

const port = Number(process.env.LIVE_STATUS_PORT || 3210);
const host = process.env.LIVE_STATUS_HOST || '0.0.0.0';
const statusToken = process.env.LIVE_STATUS_TOKEN || '';

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
    return;
  }

  if (req.url !== '/api/live-status') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
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
