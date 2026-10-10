import { fetchNflGameMarkets } from './nfl-game-markets.mjs';
import {
  fetchNflPredictionMarketDiscovery,
  fetchNflSportPredictionMarkets,
} from './nfl-prediction-markets.mjs';
import { buildNflPlayerSetups } from './nfl-player-setups.mjs';

const BASE = 'https://parlay-api.com/v1/sports/americanfootball_nfl';
const REQUESTED_MARKETS = [
  'player_pass_yds',
  'player_rush_yds',
  'player_reception_yds',
  'player_receptions',
  'player_anytime_td',
  'player_pass_tds',
];
const MARKET_ALIASES = new Map([
  ['player_pass_yds', 'player_pass_yds'],
  ['player_pass_yards', 'player_pass_yds'],
  ['player_passing_yards', 'player_pass_yds'],
  ['player_rush_yds', 'player_rush_yds'],
  ['player_rush_yards', 'player_rush_yds'],
  ['player_rushing_yards', 'player_rush_yds'],
  ['player_reception_yds', 'player_reception_yds'],
  ['player_receiving_yards', 'player_reception_yds'],
  ['player_receptions', 'player_receptions'],
  ['player_anytime_td', 'player_anytime_td'],
  ['player_anytime_touchdown_scorer', 'player_anytime_td'],
  ['anytime_td', 'player_anytime_td'],
  ['anytime_touchdown_scorer', 'player_anytime_td'],
  ['player_pass_tds', 'player_pass_tds'],
  ['player_passing_touchdowns', 'player_pass_tds'],
]);
const DFS_BOOKS = new Set(['prizepicks', 'underdog', 'betr', 'sleeper', 'pick6', 'parlayplay']);
const PREDICTION_MARKETS = new Set(['kalshi', 'polymarket', 'robinhood']);
const EXCHANGES = new Set(['novig']);

const number = (value) => value === null || value === undefined || value === ''
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;

const integerHeader = (response, name) => {
  const value = response.headers?.get?.(name);
  return value === null || value === undefined || value === '' ? null : Number.parseInt(value, 10);
};

const textHeader = (response, name) => response.headers?.get?.(name) || null;

const booleanHeader = (response, name) => textHeader(response, name)?.toLowerCase() === 'true';

function sourceType(bookmaker) {
  const key = String(bookmaker || '').toLowerCase();
  if (DFS_BOOKS.has(key)) return 'dfs';
  if (PREDICTION_MARKETS.has(key)) return 'prediction_market';
  if (EXCHANGES.has(key)) return 'exchange';
  return 'sportsbook';
}

function normalizedPeriod(value) {
  if (value === null || value === undefined || value === '') return 'FULL';
  const period = String(value).toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
  return ['FULL', 'FULL_GAME', 'GAME'].includes(period) ? 'FULL' : period;
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function observedAgeSeconds(item, updatedAt, now) {
  const explicit = number(item.age_seconds);
  if (explicit !== null && explicit >= 0) return explicit;
  if (!updatedAt) return null;
  return Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 1000));
}

function normalizeInjury(injury) {
  if (!injury || typeof injury !== 'object') return null;
  const status = String(injury.status || '').trim();
  const description = String(injury.description || injury.detail || '').trim();
  if (!status && !description) return null;
  return {
    status: status || null,
    description: description || null,
    reportedAt: timestamp(injury.date),
    team: injury.team || null,
    teamAbbr: injury.team_abbr || null,
  };
}

export function normalizeParlayProps(rows, { now = Date.now() } = {}) {
  const lines = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const returnedMarket = String(item.market_key || '').toLowerCase();
    const market = MARKET_ALIASES.get(returnedMarket);
    if (!market) continue;
    const period = normalizedPeriod(item.period);
    if (period !== 'FULL') continue;
    const point = number(item.line);
    const player = String(item.player || item.player_name || '').trim();
    const bookmaker = String(item.bookmaker || '').toLowerCase().trim();
    if (!player || !bookmaker || point === null) continue;
    const updatedAt = timestamp(item.last_observed) || timestamp(item.last_update);
    const ageSeconds = observedAgeSeconds(item, updatedAt, now);
    const base = {
      eventId: item.canonical_event_id || item.event_id || null,
      providerEventId: item.event_id || null,
      home: item.home_team || '',
      away: item.away_team || '',
      kickoff: timestamp(item.commence_time),
      bookmaker,
      bookmakerTitle: item.bookmaker_title || bookmaker,
      sourceType: sourceType(bookmaker),
      updatedAt,
      ageSeconds,
      market,
      returnedMarket,
      player,
      point,
      period,
      oddsType: item.odds_type || null,
      projectionType: item.projection_type || null,
      injury: normalizeInjury(item.injury),
      identityStatus: 'display_name_only',
    };
    for (const [side, priceKey, selectionKey] of [
      ['Over', 'over_price', 'over_sid'],
      ['Under', 'under_price', 'under_sid'],
    ]) {
      const odds = number(item[priceKey]);
      if (odds === null || odds === 0 || odds === -10000 || Math.abs(odds) < 100) continue;
      lines.push({ ...base, side, odds, selectionId: item[selectionKey] || null });
    }
  }
  return lines;
}

function summarizeCoverage(lines) {
  const countBy = (key) => Object.fromEntries(
    [...lines.reduce((map, line) => map.set(line[key], (map.get(line[key]) || 0) + 1), new Map())]
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
  return {
    bookmakers: [...new Set(lines.map((line) => line.bookmaker))].sort(),
    bySourceType: countBy('sourceType'),
    byMarket: countBy('market'),
    injuryTaggedLines: lines.filter((line) => line.injury).length,
  };
}

function provisionalComparisons(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (line.sourceType !== 'sportsbook' || !line.eventId) continue;
    const key = [line.eventId, line.market, line.player, line.side, line.point, line.period].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }
  const comparisons = [];
  for (const group of groups.values()) {
    const books = new Set(group.map((line) => line.bookmaker));
    if (books.size < 2) continue;
    const prices = group.map((line) => line.odds);
    const minOdds = Math.min(...prices);
    const maxOdds = Math.max(...prices);
    if (maxOdds - minOdds < 20) continue;
    comparisons.push({
      eventId: group[0].eventId,
      market: group[0].market,
      returnedMarket: group[0].returnedMarket,
      player: group[0].player,
      side: group[0].side,
      point: group[0].point,
      minOdds,
      maxOdds,
      books: books.size,
      identityStatus: 'display_name_only',
      actionable: false,
      reason: 'Cross-book athlete identity is not verified',
    });
  }
  return comparisons
    .sort((a, b) => (b.maxOdds - b.minOdds) - (a.maxOdds - a.minOdds))
    .slice(0, 30);
}

function completeness(response) {
  const degraded = textHeader(response, 'x-result-degraded');
  const hasMore = booleanHeader(response, 'x-result-has-more');
  const truncated = booleanHeader(response, 'x-result-truncated');
  return {
    pageSize: integerHeader(response, 'x-result-page-size'),
    rowCount: integerHeader(response, 'x-result-row-count'),
    limit: integerHeader(response, 'x-result-limit'),
    offset: integerHeader(response, 'x-result-offset'),
    hasMore,
    nextOffset: integerHeader(response, 'x-next-offset'),
    truncated,
    truncatedHint: textHeader(response, 'x-result-truncated-hint'),
    degradedBooks: degraded ? degraded.split(',').map((value) => value.trim()).filter(Boolean) : [],
    boardExhausted: !hasMore && !truncated && !degraded,
  };
}

function creditUsage(response) {
  return {
    remaining: textHeader(response, 'x-requests-remaining') || textHeader(response, 'x-credits-remaining'),
    used: textHeader(response, 'x-requests-used'),
    cost: textHeader(response, 'x-requests-last') || textHeader(response, 'x-credits-cost'),
    requestId: textHeader(response, 'x-request-id'),
  };
}

function aggregateCompleteness(results) {
  const perMarket = Object.fromEntries(
    results.map(({ market, response }) => [market, completeness(response)]),
  );
  const boards = Object.entries(perMarket);
  const truncatedMarkets = boards.filter(([, board]) => board.truncated).map(([market]) => market);
  const nextOffsets = Object.fromEntries(
    boards.filter(([, board]) => board.nextOffset !== null).map(([market, board]) => [market, board.nextOffset]),
  );
  const degradedBooks = [...new Set(boards.flatMap(([, board]) => board.degradedBooks))].sort();
  const sum = (field) => {
    const values = boards.map(([, board]) => board[field]).filter((value) => value !== null);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return {
    requestMode: 'per_market',
    requestCount: results.length,
    pageSize: sum('pageSize'),
    rowCount: sum('rowCount'),
    limitPerRequest: 10000,
    offset: 0,
    hasMore: boards.some(([, board]) => board.hasMore),
    nextOffsets,
    truncated: truncatedMarkets.length > 0,
    truncatedMarkets,
    truncatedHint: boards
      .filter(([, board]) => board.truncatedHint)
      .map(([market, board]) => market + ': ' + board.truncatedHint)
      .join(' | ') || null,
    degradedBooks,
    boardExhausted: boards.every(([, board]) => board.boardExhausted),
    perMarket,
  };
}

function aggregateCreditUsage(results) {
  const usage = results.map(({ response }) => creditUsage(response));
  const numeric = (field) => usage
    .map((item) => item[field])
    .filter((value) => value !== null && Number.isFinite(Number(value)))
    .map(Number);
  const remaining = numeric('remaining');
  const used = numeric('used');
  const costs = numeric('cost');
  const requestIds = usage.map((item) => item.requestId).filter(Boolean);
  return {
    remaining: remaining.length ? String(Math.min(...remaining)) : null,
    used: used.length ? String(Math.max(...used)) : null,
    cost: costs.length === results.length ? String(costs.reduce((total, value) => total + value, 0)) : null,
    requestId: requestIds.at(-1) || null,
    requestIds,
  };
}

function combinedCreditUsage(propsCredits, ...sources) {
  const sourceCredits = [propsCredits, ...sources.map((source) => source?.creditUsage)].filter(Boolean);
  const numeric = (field) => sourceCredits
    .map((item) => item[field])
    .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(Number);
  const costs = numeric('cost');
  const remaining = numeric('remaining');
  return {
    ...propsCredits,
    cost: costs.length ? String(costs.reduce((total, value) => total + value, 0)) : null,
    remaining: remaining.length ? String(Math.min(...remaining)) : propsCredits.remaining,
    components: {
      props: propsCredits.cost,
      gameMarkets: sources[0]?.creditUsage?.cost || null,
      predictionMarkets: sources[1]?.creditUsage?.cost || null,
    },
  };
}

export async function fetchNflMonitor({
  key = process.env.PARLAY_API_KEY,
  fetcher = fetch,
  includeGameMarkets = true,
  includePredictionMarkets = process.env.NFL_PREDICTION_MARKETS_ENABLED === 'true',
  predictionMarketQuery = process.env.NFL_PREDICTION_MARKET_QUERY || '',
} = {}) {
  const checkedAt = new Date().toISOString();
  if (!key) {
    return {
      ok: false,
      configured: false,
      checkedAt,
      status: 'missing_parlay_api_key',
      lines: [],
      warnings: ['PARLAY_API_KEY is not configured'],
    };
  }

  const gameMarketsPromise = includeGameMarkets
    ? fetchNflGameMarkets({ key, fetcher })
    : Promise.resolve({
      ok: false,
      status: 'disabled',
      games: [],
      warnings: ['Game-market monitoring is disabled'],
    });
  const predictionMarketsPromise = includePredictionMarkets
    ? fetchNflSportPredictionMarkets({ key, fetcher })
    : Promise.resolve({
      ok: false,
      status: 'disabled',
      discoveryOnly: true,
      markets: [],
      warnings: ['Set NFL_PREDICTION_MARKETS_ENABLED=true to enable official NFL game-contract discovery'],
    });
  const predictionDiscoveryPromise = includePredictionMarkets && String(predictionMarketQuery).trim()
    ? fetchNflPredictionMarketDiscovery({ key, fetcher, query: predictionMarketQuery })
    : Promise.resolve({
      ok: false,
      status: 'disabled',
      discoveryOnly: true,
      markets: [],
      warnings: ['Set NFL_PREDICTION_MARKET_QUERY to a specific topic to enable special-market search'],
    });

  const settledRequests = await Promise.allSettled(REQUESTED_MARKETS.map(async (market) => {
      const url = BASE + '/props?' + new URLSearchParams({
        markets: market,
        limit: '10000',
        offset: '0',
        maxAgeSec: '3600',
        includeSids: 'true',
        dfsOdds: 'effective',
      });
      const response = await fetcher(url, {
        headers: { 'X-API-Key': key },
        cache: 'no-store',
        signal: AbortSignal.timeout(25000),
      });
      return { market, response };
    }));
  const requestFailures = settledRequests.flatMap((request, index) => request.status === 'rejected'
    ? [{ market: REQUESTED_MARKETS[index], status: 'network_error', detail: request.reason instanceof Error ? request.reason.message : 'Provider connection failed' }]
    : []);
  const responses = settledRequests.flatMap((request) => request.status === 'fulfilled' ? [request.value] : []);
  const providerFailures = responses.flatMap(({ market, response }) => response.ok ? [] : [{
    market,
    status: 'provider_error',
    httpStatus: response.status,
    retryAfterSeconds: integerHeader(response, 'retry-after'),
    detail: 'HTTP ' + response.status,
  }]);
  const successfulResponses = responses.filter(({ response }) => response.ok);
  const settledPayloads = await Promise.allSettled(successfulResponses.map(async ({ market, response }) => ({
    market,
    payload: await response.json(),
  })));
  const payloadFailures = settledPayloads.flatMap((payload, index) => payload.status === 'rejected'
    ? [{ market: successfulResponses[index].market, status: 'invalid_json', detail: 'Provider returned invalid JSON' }]
    : []);
  const parsedRows = settledPayloads.flatMap((payload) => {
    if (payload.status !== 'fulfilled') return [];
    const { market, payload: body } = payload.value;
    const rows = Array.isArray(body)
      ? body
      : Array.isArray(body?.data) ? body.data : Array.isArray(body?.props) ? body.props : null;
    return rows ? [{ market, rows }] : [];
  });
  const invalidPayloads = settledPayloads.flatMap((payload) => {
    if (payload.status !== 'fulfilled') return [];
    const { market, payload: body } = payload.value;
    const valid = Array.isArray(body) || Array.isArray(body?.data) || Array.isArray(body?.props);
    return valid ? [] : [{ market, status: 'invalid_payload', detail: 'Unexpected response shape' }];
  });
  const failedMarkets = [...requestFailures, ...providerFailures, ...payloadFailures, ...invalidPayloads];
  const successfulMarkets = new Set(parsedRows.map(({ market }) => market));
  const results = successfulResponses.filter(({ market }) => successfulMarkets.has(market));

  const rows = parsedRows.flatMap((result) => result.rows);
  const lines = normalizeParlayProps(rows);
  const board = {
    ...aggregateCompleteness(results),
    requestCount: REQUESTED_MARKETS.length,
    successfulRequests: results.length,
    failedMarkets,
  };
  board.boardExhausted = board.boardExhausted && failedMarkets.length === 0 && results.length === REQUESTED_MARKETS.length;
  const propsCredits = aggregateCreditUsage(results);
  const warnings = [];
  for (const failure of failedMarkets) warnings.push(`Player props ${failure.market}: ${failure.status} (${failure.detail})`);
  const stale = lines.filter((line) => line.ageSeconds !== null && line.ageSeconds > 3600);
  const unknownAge = lines.filter((line) => line.ageSeconds === null);
  if (stale.length) warnings.push(stale.length + ' line records exceed the 60-minute freshness bound');
  if (unknownAge.length) warnings.push(unknownAge.length + ' line records have unknown observation age');
  if (!lines.length) warnings.push('No supported full-game NFL player props returned');
  if (board.hasMore) warnings.push('Partial board: pagination remains at offset ' + board.nextOffset);
  if (board.truncated) warnings.push('Incomplete board: ' + (board.truncatedHint || 'provider reported truncation'));
  if (board.degradedBooks.length) warnings.push('Degraded provider sources: ' + board.degradedBooks.join(', '));

  const comparisons = provisionalComparisons(lines);
  if (comparisons.length) {
    warnings.push('Cross-book price gaps are non-actionable until athlete identity is independently verified');
  }

  const [gameMarkets, predictionMarkets, predictionMarketDiscovery] = await Promise.all([
    gameMarketsPromise,
    predictionMarketsPromise,
    predictionDiscoveryPromise,
  ]);
  if (includeGameMarkets && !gameMarkets.ok) warnings.push('Game markets: ' + gameMarkets.status);
  if (includePredictionMarkets && !predictionMarkets.ok) warnings.push('NFL prediction markets: ' + predictionMarkets.status);
  if (String(predictionMarketQuery).trim() && !predictionMarketDiscovery.ok) {
    warnings.push('Special prediction-market discovery: ' + predictionMarketDiscovery.status);
  }
  const gamesByEventId = new Map((gameMarkets.games || []).flatMap((game) => [
    game.eventId ? [game.eventId, game] : null,
    game.providerEventId ? [game.providerEventId, game] : null,
  ].filter(Boolean)));
  const playerSetupLines = lines.map((line) => {
    const game = gamesByEventId.get(line.eventId) || gamesByEventId.get(line.providerEventId);
    if (!game) return line;
    return {
      ...line,
      eventId: line.eventId || game.eventId,
      home: line.home || game.home,
      away: line.away || game.away,
      kickoff: line.kickoff || game.kickoff,
    };
  });
  const playerSetups = buildNflPlayerSetups(playerSetupLines, { now: Date.parse(checkedAt) });
  const credits = combinedCreditUsage(propsCredits, gameMarkets, predictionMarkets);

  const coverage = summarizeCoverage(lines);
  const fullSuiteChecked = board.boardExhausted
    && (!includeGameMarkets || (gameMarkets.ok && gameMarkets.status === 'checked'))
    && (!includePredictionMarkets || predictionMarkets.ok);
  const operational = includeGameMarkets ? gameMarkets.ok : results.length > 0;
  const primaryFailure = failedMarkets[0] || null;
  return {
    ok: operational,
    configured: true,
    checkedAt,
    status: operational ? (fullSuiteChecked ? 'checked' : 'checked_incomplete') : (primaryFailure?.status || 'provider_unavailable'),
    market: primaryFailure?.market || null,
    httpStatus: primaryFailure?.httpStatus || null,
    retryAfterSeconds: primaryFailure?.retryAfterSeconds || null,
    provider: 'ParlayAPI',
    games: gameMarkets.ok ? gameMarkets.gamesCount : new Set(lines.map((line) => line.eventId).filter(Boolean)).size,
    linesCount: lines.length,
    staleLines: stale.length,
    unknownAgeLines: unknownAge.length,
    coverage,
    completeness: board,
    creditUsage: credits,
    remainingCredits: credits.remaining,
    requestCost: credits.cost,
    discrepancies: comparisons,
    provisionalComparisons: comparisons,
    playerSetups,
    gameMarkets,
    predictionMarkets,
    predictionMarketDiscovery,
    lines: lines.slice(0, 100),
    warnings,
    snapshot: {
      schemaVersion: 4,
      checkedAt,
      provider: 'ParlayAPI',
      completeness: board,
      coverage,
      lines,
      playerSetups,
      gameMarkets,
      predictionMarkets,
      predictionMarketDiscovery,
    },
  };
}
