const fs = require('fs');
const path = require('path');
const { runAllBacktests } = require('./backtest-engine.cjs');
const { fetchDatabentoHistoricalCandles, historicalWindow, historicalYearWindow } = require('./historical-data.cjs');
const { normalizeConfig } = require('./trader-core.cjs');

function loadConfig() {
  return normalizeConfig(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')));
}

function remoteBacktestUrls(env = process.env) {
  const direct = String(env.BACKTEST_SOURCE_URL || '').trim();
  const live = [env.LIVE_STATUS_SOURCE_URL, env.LIVE_STATUS_SOURCE_URLS]
    .filter(Boolean)
    .flatMap((value) => String(value).split(/[\s,]+/))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/\/api\/live-status\/?(?:\?.*)?$/, '/api/backtest'));
  return [...new Set([direct, ...live].filter(Boolean))];
}

function remoteBacktestResultUrls(env = process.env) {
  return remoteBacktestUrls(env).map((value) => value.replace(/\/api\/backtest$/, '/api/backtest-results'));
}

function backtestConfigured(env = process.env) {
  return Boolean(env.DATABENTO_API_KEY || remoteBacktestUrls(env).length);
}

async function fetchRemoteBacktest(url, request, env = process.env, fetchImpl = fetch) {
  const token = env.LIVE_STATUS_TOKEN || env.BACKTEST_SOURCE_TOKEN;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(request),
    cache: 'no-store',
    signal: AbortSignal.timeout(290_000)
  });
  if (!response.ok) throw new Error(`Remote backtest service responded ${response.status}.`);
  const data = await response.json();
  if (!data?.ok || !data?.result) throw new Error(data?.error || 'Remote backtest service returned an invalid result.');
  return data.result;
}

async function getCachedBacktest(options = {}) {
  const env = options.env || process.env;
  const urls = remoteBacktestResultUrls(env);
  if (!urls.length) return null;
  const token = env.LIVE_STATUS_TOKEN || env.BACKTEST_SOURCE_TOKEN;
  try {
    return await Promise.any(urls.map(async (url) => {
      const response = await (options.fetchImpl || fetch)(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) throw new Error(`Remote backtest results responded ${response.status}.`);
      const data = await response.json();
      if (!data?.ok || !data?.result) throw new Error('No cached backtest result is ready.');
      return data.result;
    }));
  } catch {
    return null;
  }
}

async function executeBacktest(options = {}) {
  const env = options.env || process.env;
  const window = options.year
    ? historicalYearWindow(options.year, options.now || new Date())
    : historicalWindow(options.days || 60, options.now || new Date());
  const request = options.year ? { year: window.year } : { days: window.days };
  if (!env.DATABENTO_API_KEY) {
    const urls = remoteBacktestUrls(env);
    if (!urls.length) throw new Error('Backtesting needs DATABENTO_API_KEY on Vercel or the VPS backtest bridge enabled.');
    return Promise.any(urls.map((url) => fetchRemoteBacktest(url, request, env, options.fetchImpl || fetch)));
  }
  const historical = await fetchDatabentoHistoricalCandles({ window, env, fetchImpl: options.fetchImpl });
  const result = runAllBacktests(historical.candles, loadConfig());
  return {
    ...result,
    source: historical.source,
    symbol: historical.symbol,
    window: historical.window
  };
}

module.exports = { backtestConfigured, executeBacktest, getCachedBacktest, remoteBacktestResultUrls, remoteBacktestUrls };
