const ENDPOINT = 'https://parlay-api.com/v1/sports/americanfootball_nfl/odds';
const SUPPORTED_MARKETS = new Set(['h2h', 'spreads', 'totals']);

const number = (value) => value === null || value === undefined || value === ''
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;

const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString()
  : null;

const textHeader = (response, name) => response.headers?.get?.(name) || null;

const integerHeader = (response, name) => {
  const value = textHeader(response, name);
  return value === null ? null : Number.parseInt(value, 10);
};

export function americanToImpliedProbability(odds) {
  const value = number(odds);
  if (value === null || value === 0 || Math.abs(value) < 100) return null;
  return value > 0 ? 100 / (value + 100) : -value / (-value + 100);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((total, value) => total + value, 0) / usable.length : null;
}

function ageSeconds(value, now) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / 1000)) : null;
}

function findOutcome(outcomes, name) {
  const target = String(name || '').trim().toLowerCase();
  return outcomes.find((outcome) => String(outcome?.name || '').trim().toLowerCase() === target) || null;
}

function normalizeMarket(market, fallbackUpdatedAt, now) {
  if (!market || !SUPPORTED_MARKETS.has(market.key) || !Array.isArray(market.outcomes)) return null;
  const updatedAt = timestamp(market.last_update) || fallbackUpdatedAt;
  return {
    key: market.key,
    updatedAt,
    ageSeconds: ageSeconds(updatedAt, now),
    outcomes: market.outcomes.flatMap((outcome) => {
      const price = number(outcome?.price);
      if (!outcome?.name || price === null || price === 0 || Math.abs(price) < 100) return [];
      return [{ name: String(outcome.name).trim(), price, point: number(outcome.point) }];
    }),
  };
}

function bestPrice(quotes) {
  return quotes.length
    ? quotes.reduce((best, quote) => quote.odds > best.odds ? quote : best)
    : null;
}

function normalizeBookmaker(bookmaker, home, away, now) {
  if (!bookmaker || !Array.isArray(bookmaker.markets)) return null;
  const bookmakerUpdatedAt = timestamp(bookmaker.last_update);
  const markets = bookmaker.markets
    .map((market) => normalizeMarket(market, bookmakerUpdatedAt, now))
    .filter(Boolean);
  if (!markets.length) return null;

  const market = (key) => markets.find((item) => item.key === key) || null;
  const h2h = market('h2h');
  const spread = market('spreads');
  const total = market('totals');
  const homeMoneyline = h2h ? findOutcome(h2h.outcomes, home) : null;
  const awayMoneyline = h2h ? findOutcome(h2h.outcomes, away) : null;
  const rawHome = americanToImpliedProbability(homeMoneyline?.price);
  const rawAway = americanToImpliedProbability(awayMoneyline?.price);
  const overround = rawHome !== null && rawAway !== null ? rawHome + rawAway : null;

  return {
    key: String(bookmaker.key || '').toLowerCase(),
    title: bookmaker.title || bookmaker.key || 'Unknown book',
    updatedAt: bookmakerUpdatedAt,
    moneyline: {
      available: Boolean(homeMoneyline || awayMoneyline),
      home: homeMoneyline?.price ?? null,
      away: awayMoneyline?.price ?? null,
      fairHomeProbability: overround ? rawHome / overround : null,
      fairAwayProbability: overround ? rawAway / overround : null,
      overround,
      updatedAt: h2h?.updatedAt || null,
      ageSeconds: h2h?.ageSeconds ?? null,
    },
    spread: {
      available: Boolean(spread),
      homePoint: spread ? findOutcome(spread.outcomes, home)?.point ?? null : null,
      homePrice: spread ? findOutcome(spread.outcomes, home)?.price ?? null : null,
      awayPoint: spread ? findOutcome(spread.outcomes, away)?.point ?? null : null,
      awayPrice: spread ? findOutcome(spread.outcomes, away)?.price ?? null : null,
      updatedAt: spread?.updatedAt || null,
      ageSeconds: spread?.ageSeconds ?? null,
    },
    total: {
      available: Boolean(total),
      point: total ? findOutcome(total.outcomes, 'Over')?.point ?? findOutcome(total.outcomes, 'Under')?.point ?? null : null,
      overPrice: total ? findOutcome(total.outcomes, 'Over')?.price ?? null : null,
      underPrice: total ? findOutcome(total.outcomes, 'Under')?.price ?? null : null,
      updatedAt: total?.updatedAt || null,
      ageSeconds: total?.ageSeconds ?? null,
    },
  };
}

function normalizeEvent(event, now) {
  if (!event || typeof event !== 'object') return null;
  const home = String(event.home_team || '').trim();
  const away = String(event.away_team || '').trim();
  if (!home || !away) return null;
  const kickoff = timestamp(event.commence_time);
  const books = (Array.isArray(event.bookmakers) ? event.bookmakers : [])
    .map((bookmaker) => normalizeBookmaker(bookmaker, home, away, now))
    .filter(Boolean);
  const homeMoneylines = books.flatMap((book) => Number.isFinite(book.moneyline.home)
    ? [{ bookmaker: book.key, bookmakerTitle: book.title, odds: book.moneyline.home }]
    : []);
  const awayMoneylines = books.flatMap((book) => Number.isFinite(book.moneyline.away)
    ? [{ bookmaker: book.key, bookmakerTitle: book.title, odds: book.moneyline.away }]
    : []);
  const fairHomeProbability = average(books.map((book) => book.moneyline.fairHomeProbability));
  const fairAwayProbability = average(books.map((book) => book.moneyline.fairAwayProbability));
  const marketLeader = fairHomeProbability === null || fairAwayProbability === null
    ? null
    : fairHomeProbability === fairAwayProbability
      ? 'Even market'
      : fairHomeProbability > fairAwayProbability ? home : away;
  const offeredQuotes = books.flatMap((book) => [book.moneyline, book.spread, book.total])
    .filter((quote) => quote.available);
  const quoteAges = offeredQuotes.map((quote) => quote.ageSeconds).filter(Number.isFinite);
  const staleQuotes = quoteAges.filter((value) => value > 3600).length;
  const unknownAgeQuotes = offeredQuotes.length - quoteAges.length;

  return {
    eventId: event.canonical_event_id || event.id || null,
    providerEventId: event.id || null,
    home,
    away,
    kickoff,
    state: kickoff && Date.parse(kickoff) > now ? 'pregame' : 'started_or_past',
    bookmakers: books.length,
    bookmakerKeys: books.map((book) => book.key).filter(Boolean).sort(),
    marketLeader,
    marketLeaderProbability: marketLeader === home
      ? fairHomeProbability
      : marketLeader === away ? fairAwayProbability : null,
    fairHomeProbability,
    fairAwayProbability,
    bestMoneyline: {
      home: bestPrice(homeMoneylines),
      away: bestPrice(awayMoneylines),
    },
    consensus: {
      homeSpread: median(books.map((book) => book.spread.homePoint)),
      total: median(books.map((book) => book.total.point)),
    },
    freshness: {
      staleQuotes,
      unknownAgeQuotes,
      freshestAgeSeconds: quoteAges.length ? Math.min(...quoteAges) : null,
      oldestAgeSeconds: quoteAges.length ? Math.max(...quoteAges) : null,
    },
    decision: 'NO TRADE',
    bias: marketLeader ? (marketLeader === home ? 'Home market lean' : marketLeader === away ? 'Away market lean' : 'Neutral') : 'Neutral',
    reason: 'Market consensus is a price signal, not an independently validated win-probability edge',
    books,
  };
}

export function normalizeNflGameMarkets(payload, { now = Date.now() } = {}) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.events) ? payload.events : null;
  if (!rows) return null;
  return rows.map((event) => normalizeEvent(event, now)).filter(Boolean);
}

export async function fetchNflGameMarkets({
  key = process.env.PARLAY_API_KEY,
  fetcher = fetch,
  now = Date.now(),
} = {}) {
  const checkedAt = new Date(now).toISOString();
  if (!key) {
    return {
      ok: false,
      checkedAt,
      status: 'missing_parlay_api_key',
      games: [],
      warnings: ['PARLAY_API_KEY is not configured'],
    };
  }
  const url = ENDPOINT + '?' + new URLSearchParams({
    regions: 'us',
    markets: 'h2h,spreads,totals',
    oddsFormat: 'american',
    dateFormat: 'iso',
  });
  let response;
  try {
    response = await fetcher(url, {
      headers: { 'X-API-Key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      status: 'network_error',
      games: [],
      warnings: [error instanceof Error ? error.message : 'Game-market provider connection failed'],
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      checkedAt,
      status: 'provider_error',
      httpStatus: response.status,
      retryAfterSeconds: integerHeader(response, 'retry-after'),
      games: [],
      warnings: ['ParlayAPI game-market endpoint returned HTTP ' + response.status],
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
      games: [],
      warnings: ['Game-market endpoint returned invalid JSON'],
    };
  }
  const games = normalizeNflGameMarkets(payload, { now });
  if (!games) {
    return {
      ok: false,
      checkedAt,
      status: 'invalid_payload',
      games: [],
      warnings: ['Unexpected ParlayAPI game-market response shape'],
    };
  }
  const warnings = [];
  const staleQuotes = games.reduce((total, game) => total + game.freshness.staleQuotes, 0);
  const unknownAgeQuotes = games.reduce((total, game) => total + game.freshness.unknownAgeQuotes, 0);
  if (!games.length) warnings.push('No NFL game markets were returned');
  if (staleQuotes) warnings.push(staleQuotes + ' game-market quotes exceed the 60-minute freshness bound');
  if (unknownAgeQuotes) warnings.push(unknownAgeQuotes + ' game-market quotes have unknown age');
  return {
    ok: true,
    checkedAt,
    status: staleQuotes || unknownAgeQuotes ? 'checked_incomplete' : 'checked',
    provider: 'ParlayAPI',
    markets: ['h2h', 'spreads', 'totals'],
    gamesCount: games.length,
    bookmakers: [...new Set(games.flatMap((game) => game.bookmakerKeys))].sort(),
    staleQuotes,
    unknownAgeQuotes,
    dataAsOf: textHeader(response, 'x-data-as-of'),
    marketsServed: textHeader(response, 'x-markets-served'),
    marketsUnservable: textHeader(response, 'x-markets-unservable'),
    marketsServedElsewhere: textHeader(response, 'x-markets-served-elsewhere'),
    creditUsage: {
      remaining: textHeader(response, 'x-requests-remaining') || textHeader(response, 'x-credits-remaining'),
      used: textHeader(response, 'x-requests-used'),
      cost: textHeader(response, 'x-requests-last') || textHeader(response, 'x-credits-cost'),
      requestId: textHeader(response, 'x-request-id'),
    },
    games,
    warnings,
  };
}
