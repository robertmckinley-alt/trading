const ENDPOINT = 'https://parlay-api.com/v1/prediction-markets/search';
const NFL_ENDPOINT = 'https://parlay-api.com/v1/prediction-markets/americanfootball_nfl';
const ALLOWED_SOURCES = new Set(['kalshi', 'polymarket', 'novig']);

const number = (value) => value === null || value === undefined || value === ''
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;

function price(value) {
  const parsed = number(value);
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
}

const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString()
  : null;

const textHeader = (response, name) => response.headers?.get?.(name) || null;

export function normalizeNflPredictionMarkets(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.markets) ? payload.markets : null;
  if (!rows) return null;
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const source = String(row.source || '').toLowerCase();
    if (!ALLOWED_SOURCES.has(source)) return [];
    const yesPrice = price(row.yes_price ?? row.yesPrice);
    const noPrice = price(row.no_price ?? row.noPrice);
    return [{
      eventId: row.canonical_event_id || row.event_id || null,
      marketId: row.market_id || row.id || row.ticker || null,
      sportKey: row.sport_key || 'americanfootball_nfl',
      kickoff: timestamp(row.commence_time),
      home: String(row.home_team || '').trim(),
      away: String(row.away_team || '').trim(),
      source,
      selection: String(row.selection || row.outcome || '').trim(),
      yesPrice,
      noPrice,
      yesImpliedProbability: number(row.yes_implied_prob ?? row.yes_implied_probability) ?? yesPrice,
      noImpliedProbability: number(row.no_implied_prob ?? row.no_implied_probability) ?? noPrice,
      volume24hUsd: number(row.volume_24h_usd ?? row.volume_24h ?? row.volume),
      observedAt: timestamp(row.last_update || row.last_observed || row.updated_at),
      discoveryOnly: true,
      actionable: false,
      reason: 'Source-native contract price requires settlement-rule, spread, depth and tradability verification',
    }];
  });
}

export async function fetchNflSportPredictionMarkets({
  key = process.env.PARLAY_API_KEY,
  fetcher = fetch,
} = {}) {
  const checkedAt = new Date().toISOString();
  if (!key) {
    return {
      ok: false,
      checkedAt,
      status: 'missing_parlay_api_key',
      discoveryOnly: true,
      markets: [],
      warnings: ['PARLAY_API_KEY is not configured'],
    };
  }
  const url = NFL_ENDPOINT + '?' + new URLSearchParams({ sources: 'kalshi,polymarket' });
  let response;
  try {
    response = await fetcher(url, {
      headers: { 'X-API-Key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      status: 'network_error',
      discoveryOnly: true,
      markets: [],
      warnings: [error instanceof Error ? error.message : 'NFL prediction-market request failed'],
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      checkedAt,
      status: 'provider_error',
      httpStatus: response.status,
      discoveryOnly: true,
      markets: [],
      warnings: ['ParlayAPI NFL prediction-market endpoint returned HTTP ' + response.status],
    };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      checkedAt,
      status: 'invalid_json',
      discoveryOnly: true,
      markets: [],
      warnings: ['NFL prediction-market endpoint returned invalid JSON'],
    };
  }
  const markets = normalizeNflPredictionMarkets(payload);
  if (!markets) {
    return {
      ok: false,
      checkedAt,
      status: 'invalid_payload',
      discoveryOnly: true,
      markets: [],
      warnings: ['Unexpected NFL prediction-market response shape'],
    };
  }
  const warnings = [
    'Discovery only: source-native contracts are not blended with sportsbook odds or treated as executable picks',
  ];
  if (!markets.length) warnings.push('No current NFL game contracts were returned');
  return {
    ok: true,
    checkedAt,
    status: 'checked',
    provider: 'ParlayAPI',
    discoveryOnly: true,
    marketsCount: markets.length,
    sources: [...new Set(markets.map((market) => market.source))].sort(),
    creditUsage: {
      remaining: textHeader(response, 'x-requests-remaining') || textHeader(response, 'x-credits-remaining'),
      cost: textHeader(response, 'x-requests-last') || textHeader(response, 'x-credits-cost'),
      requestId: textHeader(response, 'x-request-id'),
    },
    markets,
    warnings,
  };
}

export function normalizePredictionMarketDiscovery(payload) {
  const rows = Array.isArray(payload?.markets) ? payload.markets : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const source = String(row.source || '').toLowerCase();
    if (!ALLOWED_SOURCES.has(source)) return [];
    const prices = row.prices && typeof row.prices === 'object' ? row.prices : {};
    return [{
      source,
      nativeId: row.market_id || row.id || row.ticker || null,
      eventTitle: String(row.event_title || row.title || '').trim(),
      outcome: String(row.outcome || row.subtitle || '').trim(),
      volume: number(row.volume ?? row.volume_24h ?? row.liquidity),
      matchConfidence: number(row.match_confidence ?? row.confidence),
      prices: {
        yesBid: price(prices.yes_bid),
        yesAsk: price(prices.yes_ask),
        noBid: price(prices.no_bid),
        noAsk: price(prices.no_ask),
      },
      rulesUrl: row.rules_url || row.url || null,
      discoveryOnly: true,
      actionable: false,
      reason: 'Text matching does not prove equivalent settlement rules or executable liquidity',
    }];
  });
}

export async function fetchNflPredictionMarketDiscovery({
  key = process.env.PARLAY_API_KEY,
  fetcher = fetch,
  query = 'NFL',
  minVolume = 1000,
  minConfidence = 0.7,
} = {}) {
  const checkedAt = new Date().toISOString();
  const q = String(query || '').trim();
  if (!q) {
    return {
      ok: false,
      checkedAt,
      status: 'missing_query',
      discoveryOnly: true,
      markets: [],
      warnings: ['Prediction-market discovery requires a specific search query'],
    };
  }
  const url = ENDPOINT + '?' + new URLSearchParams({
    q,
    sources: 'kalshi,polymarket,novig',
    min_volume: String(minVolume),
    min_confidence: String(minConfidence),
    sort: 'balanced',
  });
  const headers = key ? { 'X-API-Key': key } : {};
  let response;
  try {
    response = await fetcher(url, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      status: 'network_error',
      discoveryOnly: true,
      markets: [],
      warnings: [error instanceof Error ? error.message : 'Prediction-market discovery failed'],
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      checkedAt,
      status: 'provider_error',
      httpStatus: response.status,
      discoveryOnly: true,
      markets: [],
      warnings: ['ParlayAPI prediction-market search returned HTTP ' + response.status],
    };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      checkedAt,
      status: 'invalid_json',
      discoveryOnly: true,
      markets: [],
      warnings: ['Prediction-market search returned invalid JSON'],
    };
  }
  const markets = normalizePredictionMarketDiscovery(payload);
  const warnings = [
    'Discovery only: keep source-native prices separate and verify settlement rules, spread, depth and tradability before analysis',
  ];
  if (!markets.length) warnings.push('No qualifying NFL prediction markets were returned');
  return {
    ok: true,
    checkedAt,
    status: 'checked',
    provider: 'ParlayAPI',
    beta: true,
    discoveryOnly: true,
    query: q,
    sourceSummary: payload?.source_summary || {},
    clusters: Array.isArray(payload?.clusters) ? payload.clusters.slice(0, 100) : [],
    markets: markets.slice(0, 100),
    warnings,
  };
}
