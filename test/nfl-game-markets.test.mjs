import test from 'node:test';
import assert from 'node:assert/strict';
import {
  americanToImpliedProbability,
  fetchNflGameMarkets,
  normalizeNflGameMarkets,
} from '../lib/nfl-game-markets.mjs';

const fixture = [{
  id: 'game-1',
  canonical_event_id: 'canonical-1',
  commence_time: '2026-10-11T20:25:00Z',
  home_team: 'Seattle Seahawks',
  away_team: 'Los Angeles Rams',
  bookmakers: [
    {
      key: 'book-a',
      title: 'Book A',
      last_update: '2026-10-08T04:59:40Z',
      markets: [
        { key: 'h2h', last_update: '2026-10-08T04:59:45Z', outcomes: [{ name: 'Seattle Seahawks', price: -120 }, { name: 'Los Angeles Rams', price: 110 }] },
        { key: 'spreads', last_update: '2026-10-08T04:59:45Z', outcomes: [{ name: 'Seattle Seahawks', price: -110, point: -2.5 }, { name: 'Los Angeles Rams', price: -110, point: 2.5 }] },
        { key: 'totals', last_update: '2026-10-08T04:59:45Z', outcomes: [{ name: 'Over', price: -105, point: 46.5 }, { name: 'Under', price: -115, point: 46.5 }] },
      ],
    },
    {
      key: 'book-b',
      title: 'Book B',
      last_update: '2026-10-08T04:59:50Z',
      markets: [
        { key: 'h2h', outcomes: [{ name: 'Seattle Seahawks', price: -115 }, { name: 'Los Angeles Rams', price: 105 }] },
        { key: 'spreads', outcomes: [{ name: 'Seattle Seahawks', price: -105, point: -3 }, { name: 'Los Angeles Rams', price: -115, point: 3 }] },
        { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 47.5 }, { name: 'Under', price: -110, point: 47.5 }] },
      ],
    },
  ],
}];

test('converts American odds to implied probability', () => {
  assert.equal(americanToImpliedProbability(100), 0.5);
  assert.equal(americanToImpliedProbability(-200), 2 / 3);
  assert.equal(americanToImpliedProbability(99), null);
});

test('normalizes moneylines, removes two-way vig and summarizes spreads and totals', () => {
  const games = normalizeNflGameMarkets(fixture, { now: Date.parse('2026-10-08T05:00:00Z') });
  assert.equal(games.length, 1);
  const game = games[0];
  assert.equal(game.eventId, 'canonical-1');
  assert.equal(game.marketLeader, 'Seattle Seahawks');
  assert.ok(game.marketLeaderProbability > 0.52 && game.marketLeaderProbability < 0.55);
  assert.deepEqual(game.bestMoneyline.home, { bookmaker: 'book-b', bookmakerTitle: 'Book B', odds: -115 });
  assert.deepEqual(game.bestMoneyline.away, { bookmaker: 'book-a', bookmakerTitle: 'Book A', odds: 110 });
  assert.equal(game.consensus.homeSpread, -2.75);
  assert.equal(game.consensus.total, 47);
  assert.equal(game.freshness.staleQuotes, 0);
  assert.equal(game.decision, 'NO TRADE');
});

test('flags stale quotes and rejects malformed payloads', () => {
  const games = normalizeNflGameMarkets(fixture, { now: Date.parse('2026-10-08T07:00:00Z') });
  assert.equal(games[0].freshness.staleQuotes, 6);
  assert.equal(normalizeNflGameMarkets({ unexpected: true }), null);
});

test('fetches the official NFL moneyline, spread and total endpoint', async () => {
  let requestedUrl = '';
  const result = await fetchNflGameMarkets({
    key: 'test',
    now: Date.parse('2026-10-08T05:00:00Z'),
    fetcher: async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        headers: { get: (name) => ({
          'x-data-as-of': '2026-10-08T04:59:50Z',
          'x-markets-served': 'h2h,spreads,totals',
          'x-requests-last': '3',
          'x-requests-remaining': '99997',
        }[name] || null) },
        json: async () => fixture,
      };
    },
  });
  const url = new URL(requestedUrl);
  assert.match(url.pathname, /americanfootball_nfl\/odds$/);
  assert.equal(url.searchParams.get('markets'), 'h2h,spreads,totals');
  assert.equal(result.ok, true);
  assert.equal(result.gamesCount, 1);
  assert.equal(result.creditUsage.cost, '3');
});

test('game-market provider errors fail closed', async () => {
  const result = await fetchNflGameMarkets({ key: 'test', fetcher: async () => ({ ok: false, status: 429 }) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'provider_error');
  assert.equal(result.games.length, 0);
});
