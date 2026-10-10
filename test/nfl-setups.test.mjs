import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNflSetups } from '../lib/nfl-setups.mjs';

const now = Date.parse('2026-10-10T17:00:00Z');

function book(key, {
  homeOdds = -160,
  awayOdds = 140,
  homePoint = -4,
  totalPoint = 45,
  ageSeconds = 60,
} = {}) {
  const implied = (odds) => odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
  const homeRaw = implied(homeOdds);
  const awayRaw = implied(awayOdds);
  const overround = homeRaw + awayRaw;
  return {
    key,
    title: `Book ${key.toUpperCase()}`,
    moneyline: {
      available: true,
      home: homeOdds,
      away: awayOdds,
      fairHomeProbability: homeRaw / overround,
      fairAwayProbability: awayRaw / overround,
      ageSeconds,
    },
    spread: {
      available: true,
      homePoint,
      homePrice: -110,
      awayPoint: -homePoint,
      awayPrice: -110,
      ageSeconds,
    },
    total: {
      available: true,
      point: totalPoint,
      overPrice: -110,
      underPrice: -110,
      ageSeconds,
    },
  };
}

function game(id, home, away, kickoff = '2026-10-11T20:00:00Z') {
  return {
    eventId: id,
    home,
    away,
    kickoff,
    state: 'pregame',
    books: [
      book('a', { homeOdds: -110, awayOdds: -110, homePoint: -3, totalPoint: 44 }),
      book('b'),
      book('c'),
      book('d'),
      book('e'),
      book('f'),
    ],
  };
}

test('publishes winner, price, ATS, total and same-book parlay setups', () => {
  const result = buildNflSetups([
    game('game-1', 'Home One', 'Away One'),
    game('game-2', 'Home Two', 'Away Two', '2026-10-12T00:00:00Z'),
  ], { now });

  assert.equal(result.winners.length, 2);
  assert.equal(result.winners[0].selection.startsWith('Home'), true);
  assert.equal(result.winners[0].decision, 'PLAY');
  assert.equal(result.moneylines.length, 2);
  assert.equal(result.moneylines[0].book, 'a');
  assert.equal(result.spreads.length, 2);
  assert.equal(result.spreads[0].line, -3);
  assert.equal(result.spreads[0].lineAdvantage, 1);
  assert.equal(result.totals.length, 2);
  assert.equal(result.totals[0].selection, 'Over 44');
  assert.equal(result.parlays.some((parlay) => parlay.decision === 'PLAY' && parlay.book === 'a'), true);
  assert.equal(result.actionableSetups > 0, true);
});

test('fails closed for started games and stale quotes', () => {
  const started = game('started', 'Home', 'Away', '2026-10-10T16:00:00Z');
  const stale = game('stale', 'Home', 'Away');
  stale.books = stale.books.map((entry) => ({
    ...entry,
    moneyline: { ...entry.moneyline, ageSeconds: 7200 },
    spread: { ...entry.spread, ageSeconds: 7200 },
    total: { ...entry.total, ageSeconds: 7200 },
  }));
  const result = buildNflSetups([started, stale], { now });
  assert.equal(result.publishedSetups, 0);
  assert.equal(result.actionableSetups, 0);
});

test('parlays use one sportsbook and distinct games', () => {
  const result = buildNflSetups([
    game('game-1', 'Home One', 'Away One'),
    game('game-2', 'Home Two', 'Away Two'),
    game('game-3', 'Home Three', 'Away Three'),
  ], { now });
  for (const parlay of result.parlays) {
    assert.equal(new Set(parlay.legs.map((leg) => leg.eventId)).size, parlay.legs.length);
    assert.equal(parlay.legs.every((leg) => leg.book === parlay.book), true);
  }
});
