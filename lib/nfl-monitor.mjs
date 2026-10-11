import { fetchNflGameMarkets } from './nfl-game-markets.mjs';
import {
  fetchNflPredictionMarketDiscovery,
  fetchNflSportPredictionMarkets,
} from './nfl-prediction-markets.mjs';
import { buildNflPlayerSetups } from './nfl-player-setups.mjs';

const BASE = 'https://api.parlay-api.com/v1/sports/americanfootball_nfl';
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

function snapshotPayload(record) {
  const value = record?.payload ?? record;
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function playerFailureDetails(result) {
  return (Array.isArray(result?.completeness?.failedMarkets) ? result.completeness.failedMarkets : [])
    .map((failure) => ({
      market: failure.market || null,
      status: failure.status || 'provider_error',
      httpStatus: Number.isFinite(failure.httpStatus) ? failure.httpStatus : null,
      detail: failure.detail || null,
      retryAfterSeconds: Number.isFinite(failure.retryAfterSeconds) ? failure.retryAfterSeconds : null,
    }));
}

export function applyNflPlayerSnapshotFallback(result, snapshotRecord, {
  now = Date.now(),
  maxAgeSeconds = 3600,
} = {}) {
  const live = result && typeof result === 'object' ? result : {};
  const failures = playerFailureDetails(live);
  const playerWarnings = (Array.isArray(live.warnings) ? live.warnings : [])
    .filter((warning) => /^Player props\b|^No supported full-game NFL player props returned/.test(String(warning)));
  const hasLiveLines = Number(live.linesCount) > 0;
  if (hasLiveLines && !failures.length) {
    return {
      ...live,
      playerData: {
        status: 'current',
        source: 'live',
        checkedAt: live.checkedAt || null,
        snapshotAgeSeconds: 0,
        linesCount: Number(live.linesCount),
        failures,
        warnings: playerWarnings,
      },
    };
  }

  const payload = snapshotPayload(snapshotRecord);
  const snapshotCheckedAt = payload?.checkedAt || snapshotRecord?.checked_at || null;
  const checkedAtMs = Date.parse(snapshotCheckedAt || '');
  const snapshotAgeSeconds = Number.isFinite(checkedAtMs) ? Math.max(0, Math.floor((now - checkedAtMs) / 1000)) : null;
  const savedLines = Array.isArray(payload?.lines) ? payload.lines : [];
  const adjustedLines = savedLines.map((line) => ({
    ...line,
    ageSeconds: Number.isFinite(line?.ageSeconds) && Number.isFinite(snapshotAgeSeconds)
      ? line.ageSeconds + snapshotAgeSeconds
      : null,
  }));
  const freshLines = adjustedLines.filter((line) => Number.isFinite(line.ageSeconds)
    && line.ageSeconds >= 0
    && line.ageSeconds <= maxAgeSeconds);
  const savedUnknownAgeLines = adjustedLines.filter((line) => !Number.isFinite(line.ageSeconds)).length;
  const savedStaleLines = adjustedLines.length - freshLines.length - savedUnknownAgeLines;
  const failureReason = failures.length
    ? failures.map((failure) => `${failure.market || 'player props'}: ${failure.status}${failure.httpStatus ? ` HTTP ${failure.httpStatus}` : ''}`).join('; ')
    : playerWarnings[0] || 'The live player-prop request returned no usable rows';
  const liveSnapshotLines = Array.isArray(live.snapshot?.lines)
    ? live.snapshot.lines
    : Array.isArray(live.lines) ? live.lines : [];
  const currentLiveLines = liveSnapshotLines.filter((line) => Number.isFinite(line.ageSeconds)
    && line.ageSeconds >= 0
    && line.ageSeconds <= maxAgeSeconds);
  const failedMarkets = new Set(failures.map((failure) => failure.market).filter(Boolean));
  const savedCandidates = hasLiveLines && failedMarkets.size
    ? freshLines.filter((line) => failedMarkets.has(line.market))
    : freshLines;
  const lineIdentity = (line) => [
    line.eventId,
    line.market,
    line.player,
    line.point,
    line.period,
    line.bookmaker,
    line.side,
  ].join('|');
  const merged = new Map(currentLiveLines.map((line) => [lineIdentity(line), line]));
  let savedLinesUsed = 0;
  for (const line of savedCandidates) {
    const key = lineIdentity(line);
    if (merged.has(key)) continue;
    merged.set(key, line);
    savedLinesUsed += 1;
  }
  const usableLines = [...merged.values()];

  if (hasLiveLines && !savedLinesUsed) {
    return {
      ...live,
      playerData: {
        status: 'partial_live',
        source: 'live',
        checkedAt: live.checkedAt || null,
        snapshotCheckedAt,
        snapshotAgeSeconds,
        linesCount: Number(live.linesCount),
        failures,
        warnings: playerWarnings,
        reason: failureReason,
      },
    };
  }

  if (!usableLines.length) {
    return {
      ...live,
      playerData: {
        status: 'unavailable',
        source: 'none',
        checkedAt: live.checkedAt || null,
        snapshotCheckedAt,
        snapshotAgeSeconds,
        linesCount: 0,
        failures,
        warnings: playerWarnings,
        reason: failureReason,
      },
    };
  }

  const playerSetups = buildNflPlayerSetups(usableLines, { now, maxAgeSeconds });
  const staleLines = Number(live.staleLines || 0) + savedStaleLines;
  const unknownAgeLines = Number(live.unknownAgeLines || 0) + savedUnknownAgeLines;
  const fallbackWarning = hasLiveLines
    ? `Player props live pull was partial; restored ${savedLinesUsed} freshness-adjusted prices from the saved ${snapshotCheckedAt} snapshot`
    : `Player props live pull failed; using ${savedLinesUsed} freshness-adjusted prices from the saved ${snapshotCheckedAt} snapshot`;
  return {
    ...live,
    linesCount: usableLines.length,
    staleLines,
    unknownAgeLines,
    coverage: summarizeCoverage(usableLines),
    playerSetups,
    lines: usableLines.slice(0, 100),
    warnings: [...new Set([...(live.warnings || []), fallbackWarning])],
    playerData: {
      status: hasLiveLines ? 'partial_snapshot_fallback' : 'snapshot_fallback',
      source: hasLiveLines ? 'live_plus_saved_snapshot' : 'saved_snapshot',
      checkedAt: hasLiveLines ? live.checkedAt || snapshotCheckedAt : snapshotCheckedAt,
      liveCheckedAt: live.checkedAt || null,
      snapshotCheckedAt,
      snapshotAgeSeconds,
      linesCount: usableLines.length,
      savedLinesUsed,
      staleLines,
      failures,
      warnings: playerWarnings,
      reason: failureReason,
    },
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
  const costComplete = sourceCredits.every((item) => item.cost !== null
    && item.cost !== undefined
    && Number.isFinite(Number(item.cost)));
  return {
    ...propsCredits,
    cost: costComplete && costs.length ? String(costs.reduce((total, value) => total + value, 0)) : null,
    costComplete,
    remaining: remaining.length ? String(Math.min(...remaining)) : propsCredits.remaining,
    components: {
      props: propsCredits.cost,
      gameMarkets: sources[0]?.creditUsage?.cost || null,
      predictionMarkets: sources[1]?.creditUsage?.cost || null,
    },
  };
}

function propRows(payload) {
  return Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.props) ? payload.props : null;
}

function retryablePropFailure(failure) {
  if (!failure) return false;
  if (failure.status !== 'provider_error') return true;
  return [429, 502, 503, 504].includes(failure.httpStatus);
}

export function retryDelayForPropFailure(failure, minimumDelayMs = 0) {
  const requestedDelayMs = Math.max(0, Number(failure?.retryAfterSeconds) || 0) * 1000;
  return Math.max(Math.max(0, Number(minimumDelayMs) || 0), Math.min(requestedDelayMs, 15_000));
}

async function fetchPropMarket({ market, key, fetcher, attempts, retryDelayMs }) {
  const url = BASE + '/props?' + new URLSearchParams({
    markets: market,
    limit: '10000',
    offset: '0',
    maxAgeSec: '3600',
    includeSids: 'true',
    dfsOdds: 'effective',
  });
  const responses = [];
  let failure = null;
  let attempt = 0;
  for (attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(url, {
        headers: { 'X-API-Key': key },
        cache: 'no-store',
        signal: AbortSignal.timeout(attempt === 1 ? 25000 : 15000),
      });
      responses.push(response);
      if (!response.ok) {
        failure = {
          market,
          status: 'provider_error',
          httpStatus: response.status,
          retryAfterSeconds: integerHeader(response, 'retry-after'),
          detail: 'HTTP ' + response.status,
        };
      } else {
        let payload;
        try {
          payload = await response.json();
        } catch {
          failure = { market, status: 'invalid_json', detail: 'Provider returned invalid JSON' };
        }
        if (payload !== undefined) {
          const rows = propRows(payload);
          if (rows) return { market, response, rows, responses, attempts: attempt };
          failure = { market, status: 'invalid_payload', detail: 'Unexpected response shape' };
        }
      }
    } catch (error) {
      failure = {
        market,
        status: 'network_error',
        detail: error instanceof Error ? error.message : 'Provider connection failed',
      };
    }
    if (attempt < attempts && retryablePropFailure(failure)) {
      const delay = retryDelayForPropFailure(failure, retryDelayMs);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    break;
  }
  return { market, failure, responses, attempts: attempt };
}

export async function fetchNflMonitor({
  key = process.env.PARLAY_API_KEY,
  fetcher = fetch,
  includeGameMarkets = true,
  includePredictionMarkets = process.env.NFL_PREDICTION_MARKETS_ENABLED === 'true',
  predictionMarketQuery = process.env.NFL_PREDICTION_MARKET_QUERY || '',
  propAttempts = 1,
  propRetryDelayMs = 250,
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

  const attempts = Math.max(1, Math.min(2, Number(propAttempts) || 1));
  const propResults = await Promise.all(REQUESTED_MARKETS.map((market) => fetchPropMarket({
    market,
    key,
    fetcher,
    attempts,
    retryDelayMs: Math.max(0, Number(propRetryDelayMs) || 0),
  })));
  const initialFailures = propResults.flatMap((result) => result.failure ? [result.failure] : []);
  const failedMarketNames = initialFailures.map((failure) => failure.market).filter(Boolean);
  const recoveryResult = failedMarketNames.length > 1
    ? await fetchPropMarket({
      market: failedMarketNames.join(','),
      key,
      fetcher,
      attempts: 1,
      retryDelayMs: Math.max(0, Number(propRetryDelayMs) || 0),
    })
    : null;
  const recoveryRows = recoveryResult?.rows || [];
  const recoveredMarkets = [...new Set(recoveryRows
    .map((row) => MARKET_ALIASES.get(String(row?.market_key || '').toLowerCase()))
    .filter((market) => failedMarketNames.includes(market)))];
  const recoveredMarketSet = new Set(recoveredMarkets);
  const failedMarkets = initialFailures.filter((failure) => !recoveredMarketSet.has(failure.market));
  const parsedRows = [
    ...propResults.flatMap((result) => result.rows ? [{ market: result.market, rows: result.rows }] : []),
    ...(recoveryRows.length ? [{ market: 'combined_recovery', rows: recoveryRows }] : []),
  ];
  const results = [
    ...propResults.flatMap((result) => result.rows ? [{ market: result.market, response: result.response }] : []),
    ...(recoveryRows.length ? [{ market: 'combined_recovery', response: recoveryResult.response }] : []),
  ];
  const attemptResponses = [
    ...propResults.flatMap((result) => result.responses.map((response) => ({ market: result.market, response }))),
    ...(recoveryResult?.responses || []).map((response) => ({ market: 'combined_recovery', response })),
  ];
  const retriedMarkets = propResults.filter((result) => result.attempts > 1).map((result) => result.market);

  const rows = parsedRows.flatMap((result) => result.rows);
  const lines = normalizeParlayProps(rows);
  const board = {
    ...aggregateCompleteness(results),
    requestCount: REQUESTED_MARKETS.length,
    successfulRequests: results.length,
    failedMarkets,
    retriedMarkets,
    recoveryAttempted: Boolean(recoveryResult),
    recoveredMarkets,
  };
  const successfulMarkets = new Set([
    ...propResults.filter((result) => result.rows).map((result) => result.market),
    ...recoveredMarkets,
  ]);
  board.boardExhausted = board.boardExhausted
    && failedMarkets.length === 0
    && REQUESTED_MARKETS.every((market) => successfulMarkets.has(market));
  const propsCredits = aggregateCreditUsage(attemptResponses);
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
