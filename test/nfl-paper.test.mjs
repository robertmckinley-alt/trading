import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NFL_STRATEGIES,
  allocatePaperCandidates,
  collectPaperCandidates,
  createPaperAccounts,
  expectedValue,
  gradePaperPosition,
  nflSeasonWeek,
  normalizeNflScores,
  removeTwoWayVig,
  selectRiskPolicyVoids,
  settlePaperPosition,
  summarizePaperAccount,
} from '../lib/nfl-paper.mjs';

test('seven isolated accounts start with 10k each and a 9k floor', () => {
  const accounts = createPaperAccounts();
  assert.equal(accounts.length, 7);
  assert.equal(new Set(accounts.map((account) => account.key)).size, NFL_STRATEGIES.length);
  assert.equal(accounts.reduce((sum, account) => sum + account.equity, 0), 70_000);
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

test('risk-policy reconciliation voids only positions above the $300 account cap', () => {
  const positions = Array.from({ length: 5 }, (_, index) => ({
    id: `spread-${index}`,
    accountKey: 'spread',
    status: 'open',
    stake: 100,
    capturedAt: '2026-10-11T20:00:00Z',
    probability: 0.6 - index / 100,
  }));
  assert.deepEqual(selectRiskPolicyVoids(positions), ['spread-3', 'spread-4']);
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
    settledAt: new Date(Date.UTC(2026,9,1+index)).toISOString(),
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

test('player candidates retain structured result identity for straight and parlay grading', () => {
  const playerLeg = {
    eventId: 'week-6-a', market: 'player_receptions', player: 'Receiver Example', side: 'Over', line: 5.5,
    selection: 'Receiver Example Over 5.5 receptions', matchup: 'Away @ Home', home: 'Home', away: 'Away',
    kickoff: '2026-10-18T17:00:00Z', odds: -105, probability: 0.55,
  };
  const candidates = collectPaperCandidates({
    checkedAt: '2026-10-11T20:00:00Z',
    playerSetups: {
      plays: [{ ...playerLeg, id: 'player-straight', point: 5.5, expectedReturn: 0.03, decision: 'PLAY' }],
      parlays: [{
        id: 'player-parlay', market: 'player_parlay', offeredOdds: 260, expectedReturn: 0.04, decision: 'PLAY',
        legs: [playerLeg, { ...playerLeg, eventId: 'week-6-b', player: 'Second Player', selection: 'Second Player Under 70.5 receiving yards', market: 'player_reception_yds', side: 'Under', line: 70.5, kickoff: '2026-10-18T20:00:00Z' }],
      }],
    },
  });
  const straight = candidates.find((item) => item.accountKey === 'player_prop');
  const parlay = candidates.find((item) => item.accountKey === 'player_parlay');
  assert.equal(straight.player, 'Receiver Example');
  assert.equal(straight.week, 6);
  assert.equal(parlay.legs[0].market, 'player_receptions');
  assert.equal(parlay.legs[0].player, 'Receiver Example');
  assert.equal(parlay.legs[1].line, 70.5);
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

test('Week 6 player props and cross-game player parlays grade from unique postgame rows', () => {
  const results = [{
    playerId: '00-1', player: 'A.J. Example', season: 2026, week: 6, gameId: '2026_06_AAA_BBB',
    stats: { passingYards: 287, passingTds: 3, rushingYards: 24, rushingTds: 1, receptions: 0, receivingYards: 0, receivingTds: 0, specialTeamsTds: 0, defensiveTds: 0, fumbleRecoveryTds: 0 },
  }, {
    playerId: '00-2', player: 'Receiver Example', season: 2026, week: 6, gameId: '2026_06_CCC_DDD',
    stats: { passingYards: 0, passingTds: 0, rushingYards: 0, rushingTds: 0, receptions: 7, receivingYards: 96, receivingTds: 1, specialTeamsTds: 0, defensiveTds: 0, fumbleRecoveryTds: 0 },
  }];
  const straight = gradePaperPosition({
    id: 'player_prop|week-6-a|player_pass_yds|A.J. Example|Over|275.5', accountKey: 'player_prop', market: 'player_pass_yds', side: 'Over', line: 275.5, season: null, week: null,
    kickoff: '2026-10-18T17:00:00Z', odds: -110,
  }, [], results);
  assert.equal(straight.result, 'win');
  assert.equal(straight.evidence[0].evidence.actual, 287);

  const parlay = gradePaperPosition({
    accountKey: 'player_parlay', odds: 260, legs: [
      { player: 'A.J. Example', market: 'player_pass_tds', side: 'Over', line: 2.5, kickoff: '2026-10-18T17:00:00Z', odds: 110 },
      { player: 'Receiver Example', market: 'player_receptions', side: 'Over', line: 6.5, kickoff: '2026-10-18T20:00:00Z', odds: -105 },
    ],
  }, [], results);
  assert.equal(parlay.result, 'win');
  assert.equal(parlay.evidence.length, 2);
  assert.deepEqual(nflSeasonWeek('2026-10-18T17:00:00Z'), { season: 2026, week: 6, label: '2026 Week 6' });
});

test('ambiguous player names remain awaiting result', () => {
  const duplicate = {
    player: 'Same Name', season: 2026, week: 6, stats: { receptions: 8 },
  };
  assert.equal(gradePaperPosition({
    accountKey: 'player_prop', player: 'Same Name', market: 'player_receptions', side: 'Over', line: 4.5,
    kickoff: '2026-10-18T17:00:00Z', odds: -110,
  }, [], [duplicate, { ...duplicate, playerId: 'second' }]), null);
});
