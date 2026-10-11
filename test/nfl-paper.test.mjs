import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NFL_STRATEGIES,
  allocatePaperCandidates,
  collectPaperCandidates,
  createPaperAccounts,
  expectedValue,
  gradePaperPosition,
  normalizeNflScores,
  removeTwoWayVig,
  settlePaperPosition,
  summarizePaperAccount,
} from '../lib/nfl-paper.mjs';

test('six isolated accounts start with 10k each and a 9k floor', () => {
  const accounts = createPaperAccounts();
  assert.equal(accounts.length, 6);
  assert.equal(new Set(accounts.map((account) => account.key)).size, NFL_STRATEGIES.length);
  assert.equal(accounts.reduce((sum, account) => sum + account.equity, 0), 60_000);
  assert.ok(accounts.every((account) => account.drawdownFloor === 9_000));
});

test('vig removal and expected value use normalized probabilities', () => {
  const probability = removeTwoWayVig(-110, -110);
  assert.ok(Math.abs(probability.over - 0.5) < 1e-10);
  assert.ok(Math.abs(probability.over + probability.under - 1) < 1e-10);
  assert.ok(Math.abs(expectedValue(0.55, 100) - 0.1) < 1e-10);
});

test('settlement, ROI and drawdown use settled positions only', () => {
  const positions = [
    settlePaperPosition({ stake: 100, odds: 100, settledAt: '2026-10-01' }, 'win'),
    settlePaperPosition({ stake: 100, odds: -110, settledAt: '2026-10-02' }, 'loss'),
    settlePaperPosition({ stake: 100, odds: 100, settledAt: '2026-10-03' }, 'push'),
  ];
  const account = summarizePaperAccount(positions, 'moneyline');
  assert.equal(account.equity, 10_000);
  assert.equal(account.wins, 1);
  assert.equal(account.losses, 1);
  assert.equal(account.pushes, 1);
  assert.equal(account.maxDrawdown, 100);
});

test('allocation caps simultaneous risk at 3 percent per account', () => {
  const candidates = Array.from({ length: 5 }, (_, index) => ({
    id: `moneyline|event-${index}`,
    accountKey: 'moneyline',
    odds: 100,
    modeledEdge: 0.05 - index / 100,
  }));
  const allocated = allocatePaperCandidates(candidates);
  assert.equal(allocated.length, 3);
  assert.equal(allocated.reduce((sum, position) => sum + position.stake, 0), 300);
});

test('10 percent drawdown floor pauses new positions', () => {
  const losses = Array.from({ length: 10 }, (_, index) => ({
    id: `loss-${index}`,
    accountKey: 'moneyline',
    stake: 100,
    odds: -110,
    status: 'loss',
    result: 'loss',
    pnl: -100,
    settledAt: `2026-10-${String(index + 1).padStart(2, '0')}`,
  }));
  const account = summarizePaperAccount(losses, 'moneyline');
  assert.equal(account.equity, 9_000);
  assert.equal(account.state, 'PAUSED');
  assert.equal(allocatePaperCandidates([{ id: 'next', accountKey: 'moneyline', odds: 100 }], losses).length, 0);
});

test('only future PLAY cards become paper candidates and duplicate parlay views collapse', () => {
  const setup = {
    id: 'event-a|moneyline-value|home', eventId: 'event-a', market: 'moneyline', selection: 'Home', matchup: 'Away @ Home',
    kickoff: '2026-10-12T20:00:00Z', odds: -110, expectedReturn: 0.04, decision: 'PLAY',
  };
  const parlay = {
    id: 'book|winner|2|a|b', market: 'winner_parlay', offeredOdds: 150, expectedReturn: 0.03, decision: 'PLAY',
    legs: [
      { eventId: 'a', selection: 'A', kickoff: '2026-10-12T20:00:00Z', odds: -150 },
      { eventId: 'b', selection: 'B', kickoff: '2026-10-13T20:00:00Z', odds: -160 },
    ],
  };
  const candidates = collectPaperCandidates({
    checkedAt: '2026-10-11T20:00:00Z',
    setups: { moneylines: [setup], winners: [{ ...setup, id: 'prediction', decision: 'PREDICTION' }], parlays: [parlay], likelihoodParlays: [parlay] },
  });
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((item) => item.accountKey).sort(), ['moneyline', 'winner_parlay']);
});

test('completed scores grade moneyline, spread, total and winner parlay', () => {
  const scores = normalizeNflScores([{
    id: 'event-a', completed: true, home_team: 'Home', away_team: 'Away',
    scores: [{ name: 'Home', score: '27' }, { name: 'Away', score: '20' }],
  }, {
    id: 'event-b', completed: true, home_team: 'Second Home', away_team: 'Second Away',
    scores: [{ name: 'Second Home', score: '14' }, { name: 'Second Away', score: '17' }],
  }]);
  assert.equal(gradePaperPosition({ accountKey: 'moneyline', eventId: 'event-a', market: 'moneyline', selection: 'Home', odds: -110 }, scores).result, 'win');
  assert.equal(gradePaperPosition({ accountKey: 'spread', eventId: 'event-a', market: 'spread', selection: 'Away', line: 7, odds: -110 }, scores).result, 'push');
  assert.equal(gradePaperPosition({ accountKey: 'total', eventId: 'event-a', market: 'total', side: 'over', line: 44.5, odds: -110 }, scores).result, 'win');
  assert.equal(gradePaperPosition({ accountKey: 'winner_parlay', odds: 220, legs: [
    { eventId: 'event-a', selection: 'Home', market: 'moneyline', odds: -150 },
    { eventId: 'event-b', selection: 'Second Away', market: 'moneyline', odds: 120 },
  ] }, scores).result, 'win');
});

test('player positions are not auto-graded without a verified stat source', () => {
  assert.equal(gradePaperPosition({ accountKey: 'player_prop' }, []), null);
  assert.equal(gradePaperPosition({ accountKey: 'player_parlay' }, []), null);
});
