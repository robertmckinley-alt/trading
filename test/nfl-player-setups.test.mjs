import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNflPlayerSetups } from '../lib/nfl-player-setups.mjs';

const now = Date.parse('2026-10-10T17:00:00Z');

function propLines(eventId, player, market, point, kickoff = '2026-10-11T20:00:00Z') {
  const rows = [];
  for (const key of ['a', 'b', 'c', 'd', 'e']) {
    const target = key === 'a';
    for (const [side, odds] of [['Over', target ? -110 : -160], ['Under', target ? -110 : 140]]) {
      rows.push({
        eventId,
        home: `Home ${eventId}`,
        away: `Away ${eventId}`,
        kickoff,
        bookmaker: key,
        bookmakerTitle: `Book ${key.toUpperCase()}`,
        sourceType: 'sportsbook',
        ageSeconds: 60,
        market,
        player,
        point,
        period: 'FULL',
        side,
        odds,
        identityStatus: 'display_name_only',
        injury: null,
      });
    }
  }
  return rows;
}

test('publishes exact-match player props and cross-game parlays', () => {
  const lines = [
    ...propLines('game-1', 'Receiver One', 'player_receptions', 5.5),
    ...propLines('game-2', 'Quarterback Two', 'player_pass_yds', 249.5, '2026-10-12T00:00:00Z'),
  ];
  const result = buildNflPlayerSetups(lines, { now });
  assert.equal(result.plays.length, 2);
  assert.equal(result.plays[0].side, 'Over');
  assert.equal(result.plays[0].book, 'a');
  assert.equal(result.plays[0].decision, 'PLAY');
  assert.match(result.plays[0].selection, /receptions/);
  assert.equal(result.parlays.every((parlay) => parlay.legs.every((leg) => /receptions|passing yards/.test(leg.selection))), true);
  assert.equal(result.parlays.some((parlay) => parlay.decision === 'PLAY' && parlay.book === 'a'), true);
  assert.equal(result.parlays.every((parlay) => new Set(parlay.legs.map((leg) => leg.eventId)).size === parlay.legs.length), true);
});

test('builds a balanced 2-, 3- and 4-player parlay board from positive legs below the standalone gate', () => {
  const lines = [
    ...propLines('game-1', 'Receiver One', 'player_receptions', 5.5),
    ...propLines('game-2', 'Quarterback Two', 'player_pass_yds', 249.5, '2026-10-12T00:00:00Z'),
    ...propLines('game-3', 'Runner Three', 'player_rush_yds', 69.5, '2026-10-12T17:00:00Z'),
    ...propLines('game-4', 'Receiver Four', 'player_reception_yds', 74.5, '2026-10-12T20:00:00Z'),
  ];
  const result = buildNflPlayerSetups(lines, {
    now,
    minExpectedReturn: 0.2,
    maxParlaysPerSize: 3,
  });
  assert.equal(result.plays.length, 0);
  assert.deepEqual(new Set(result.parlays.map((parlay) => parlay.legCount)), new Set([2, 3, 4]));
  assert.equal(result.parlays.length, 8);
  assert.equal(Object.values(result.parlayStats.bySize).every((size) => size.published <= 3), true);
  assert.equal(result.parlays.every((parlay) => parlay.legs.length === parlay.legCount), true);
  assert.equal(result.parlays.every((parlay) => parlay.legs.every((leg) => leg.expectedReturn >= 0)), true);
  assert.equal(result.parlayStats.published, result.parlays.length);
  assert.equal(result.parlayStats.actionable > 0, true);
});

test('rejects injury flags, stale quotes and same-game parlays', () => {
  const injured = propLines('game-1', 'Receiver One', 'player_receptions', 5.5)
    .map((line) => ({ ...line, injury: { status: 'Questionable' } }));
  const stale = propLines('game-2', 'Quarterback Two', 'player_pass_yds', 249.5)
    .map((line) => ({ ...line, ageSeconds: 7200 }));
  const sameGame = [
    ...propLines('game-3', 'Receiver Three', 'player_receptions', 4.5),
    ...propLines('game-3', 'Quarterback Three', 'player_pass_yds', 259.5),
  ];
  const result = buildNflPlayerSetups([...injured, ...stale, ...sameGame], { now });
  assert.equal(result.plays.length, 2);
  assert.equal(result.parlays.length, 0);
});
