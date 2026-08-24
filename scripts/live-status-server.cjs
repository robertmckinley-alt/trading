#!/usr/bin/env node
const http = require('http');

const { getLocalStrategySnapshots } = require('../lib/live-status.cjs');

const port = Number(process.env.LIVE_STATUS_PORT || 3210);
const host = process.env.LIVE_STATUS_HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  if (req.url !== '/api/live-status') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
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
