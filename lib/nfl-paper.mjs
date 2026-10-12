// Paper-only accounting. This module never submits an order or sportsbook bet.
import { normalizeNflPlayerName, playerStatForMarket } from './nfl-player-results.mjs';

export const INITIAL_BANKROLL = 10_000;
export const MAX_DRAWDOWN = 1_000;
export const MAX_OPEN_EXPOSURE = 300;

export const NFL_PAPER_ACCOUNTS = Object.freeze([
  { key: 'moneyline', label: 'Moneylines', riskPerPlay: 100 },
  { key: 'spread', label: 'Spreads', riskPerPlay: 100 },
  { key: 'total', label: 'Totals', riskPerPlay: 100 },
  { key: 'player_prop', label: 'Player props', riskPerPlay: 100 },
  { key: 'winner_parlay', label: 'Winner parlays', riskPerPlay: 50 },
  { key: 'player_parlay', label: 'Player parlays', riskPerPlay: 50 },
  { key: 'public_fade', label: 'Public Fade', riskPerPlay: 100 },
].map((account) => Object.freeze({
  ...account,
  startingBalance: INITIAL_BANKROLL,
  drawdownFloor: INITIAL_BANKROLL - MAX_DRAWDOWN,
  maxDrawdown: MAX_DRAWDOWN,
  maxOpenExposure: MAX_OPEN_EXPOSURE,
})));

export const NFL_STRATEGIES = Object.freeze(NFL_PAPER_ACCOUNTS.map((account) => account.key));

const NFL_REGULAR_SEASON_STARTS = new Map([
  [2026, Date.parse('2026-09-10T00:00:00Z')],
]);

export function nflSeasonWeek(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const season = date.getUTCMonth() < 3 ? date.getUTCFullYear() - 1 : date.getUTCFullYear();
  const start = NFL_REGULAR_SEASON_STARTS.get(season);
  if (!Number.isFinite(start)) return null;
  const week = Math.floor((date.getTime() - start) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return week >= 1 && week <= 18 ? { season, week, label: `${season} Week ${week}` } : null;
}

export function americanToProbability(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value) || value === 0 || Math.abs(value) < 100) throw new Error('Invalid American odds');
  return value > 0 ? 100 / (value + 100) : -value / (-value + 100);
}

export function decimalOdds(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value) || value === 0 || Math.abs(value) < 100) throw new Error('Invalid American odds');
  return value > 0 ? 1 + value / 100 : 1 + 100 / (-value);
}

export function removeTwoWayVig(over, under) {
  const first = americanToProbability(over);
  const second = americanToProbability(under);
  return { over: first / (first + second), under: second / (first + second), overround: first + second };
}

export function expectedValue(probability, odds) {
  const value = Number(probability);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Probability must be 0..1');
  return value * (decimalOdds(odds) - 1) - (1 - value);
}

export function settlePaperPosition(position, result, settlementOdds = position.odds) {
  if (!['win', 'loss', 'push', 'void'].includes(result)) throw new Error('Invalid result');
  const stake = Number(position.stake);
  if (!Number.isFinite(stake) || stake <= 0) throw new Error('Invalid stake');
  const pnl = result === 'win'
    ? stake * (decimalOdds(settlementOdds) - 1)
    : result === 'loss' ? -stake : 0;
  return { ...position, result, status: result, pnl, settlementOdds };
}

function accountConfig(key) {
  return NFL_PAPER_ACCOUNTS.find((account) => account.key === key) || null;
}

function paperPositionRank(first, second) {
  const captured = Date.parse(first.capturedAt || first.captured_at || 0) - Date.parse(second.capturedAt || second.captured_at || 0);
  if (captured) return captured;
  const firstEdge = Number.isFinite(Number(first.modeledEdge ?? first.modeled_edge)) ? Number(first.modeledEdge ?? first.modeled_edge) : -Infinity;
  const secondEdge = Number.isFinite(Number(second.modeledEdge ?? second.modeled_edge)) ? Number(second.modeledEdge ?? second.modeled_edge) : -Infinity;
  if (firstEdge !== secondEdge) return secondEdge - firstEdge;
  const probability = Number(second.probability || 0) - Number(first.probability || 0);
  if (probability) return probability;
  return String(first.id || '').localeCompare(String(second.id || ''));
}

export function selectRiskPolicyVoids(positions = []) {
  const voidIds = [];
  for (const account of NFL_PAPER_ACCOUNTS) {
    let openExposure = 0;
    const open = positions
      .filter((position) => (position.accountKey || position.account_key) === account.key
        && ['open', 'awaiting_result'].includes(position.status))
      .sort(paperPositionRank);
    for (const position of open) {
      const stake = Number(position.stake);
      if (!Number.isFinite(stake) || stake <= 0 || openExposure + stake > account.maxOpenExposure) {
        voidIds.push(position.id);
        continue;
      }
      openExposure += stake;
    }
  }
  return voidIds;
}

export function summarizePaperAccount(positions = [], accountOrStartingBalance = INITIAL_BANKROLL) {
  const config = typeof accountOrStartingBalance === 'string'
    ? accountConfig(accountOrStartingBalance)
    : typeof accountOrStartingBalance === 'object'
      ? accountOrStartingBalance
      : { startingBalance: Number(accountOrStartingBalance), maxDrawdown: MAX_DRAWDOWN, maxOpenExposure: MAX_OPEN_EXPOSURE, riskPerPlay: 100 };
  const startingBalance = Number(config?.startingBalance ?? INITIAL_BANKROLL);
  const ordered = [...positions].sort((a, b) => Date.parse(a.settledAt || a.settled_at || 0) - Date.parse(b.settledAt || b.settled_at || 0));
  let equity = startingBalance;
  let peak = startingBalance;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let voids = 0;
  let staked = 0;
  for (const position of ordered) {
    const result = position.result || position.status;
    if (!['win', 'loss', 'push', 'void'].includes(result)) continue;
    const pnl = Number.isFinite(Number(position.pnl))
      ? Number(position.pnl)
      : settlePaperPosition(position, result, position.settlementOdds || position.settlement_odds || position.odds).pnl;
    equity += pnl;
    staked += Number(position.stake) || 0;
    if (result === 'win') wins += 1;
    else if (result === 'loss') losses += 1;
    else if (result === 'push') pushes += 1;
    else voids += 1;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const openPositions = positions.filter((position) => ['open', 'awaiting_result'].includes(position.status));
  const openExposure = openPositions.reduce((sum, position) => sum + (Number(position.stake) || 0), 0);
  const drawdownFloor = startingBalance - Number(config?.maxDrawdown ?? MAX_DRAWDOWN);
  const currentDrawdown = peak - equity;
  const lossBuffer = Math.max(0, equity - drawdownFloor - openExposure);
  const exposureRoom = Math.max(0, Number(config?.maxOpenExposure ?? MAX_OPEN_EXPOSURE) - openExposure);
  const targetRisk = Number(config?.riskPerPlay ?? 100);
  const nextStake = Math.max(0, Math.min(targetRisk, lossBuffer, exposureRoom));
  const settled = wins + losses + pushes + voids;
  return {
    key: config?.key,
    label: config?.label,
    startingBalance,
    equity,
    pnl: equity - startingBalance,
    roi: staked ? (equity - startingBalance) / staked : 0,
    wins,
    losses,
    pushes,
    voids,
    settled,
    staked,
    openPositions: openPositions.length,
    openExposure,
    maxOpenExposure: Number(config?.maxOpenExposure ?? MAX_OPEN_EXPOSURE),
    peakEquity: peak,
    currentDrawdown,
    maxDrawdown,
    maxAllowedDrawdown: Number(config?.maxDrawdown ?? MAX_DRAWDOWN),
    drawdownFloor,
    nextStake,
    state: equity <= drawdownFloor || nextStake <= 0 ? 'PAUSED' : 'ACTIVE',
    evaluation: settled < 30 ? 'COLLECTING' : equity > startingBalance ? 'POSITIVE' : equity < startingBalance ? 'NEGATIVE' : 'FLAT',
  };
}

export function createPaperAccounts(positions = []) {
  return NFL_PAPER_ACCOUNTS.map((account) => ({
    ...account,
    ...summarizePaperAccount(positions.filter((position) => position.accountKey === account.key || position.account_key === account.key), account),
  }));
}

function kickoffIsFuture(setup, now) {
  const kickoffs = setup.legs?.map((leg) => leg.kickoff) || [setup.kickoff];
  return kickoffs.every((kickoff) => Number.isFinite(Date.parse(kickoff || '')) && Date.parse(kickoff) > now);
}

function selectionIdentity(setup, accountKey) {
  if (Array.isArray(setup.legs)) {
    return `${accountKey}|${setup.legs.map((leg) => `${leg.eventId}:${leg.selection}`).sort().join('|')}`;
  }
  if (accountKey === 'player_prop') {
    return `${accountKey}|${setup.eventId}|${setup.market}|${setup.player}|${setup.side}|${setup.point}`;
  }
  return `${accountKey}|${setup.eventId}|${setup.market}|${setup.selection}`;
}

function candidate(setup, accountKey, capturedAt) {
  const odds = Number(setup.odds ?? setup.offeredOdds);
  if (!Number.isFinite(odds) || Math.abs(odds) < 100) return null;
  const legs = Array.isArray(setup.legs) ? setup.legs.map((leg) => ({
    eventId: leg.eventId,
    player: leg.player || null,
    side: leg.side || null,
    line: Number.isFinite(Number(leg.line ?? leg.point)) ? Number(leg.line ?? leg.point) : null,
    home: leg.home || null,
    away: leg.away || null,
    selection: leg.selection,
    matchup: leg.matchup,
    kickoff: leg.kickoff,
    odds: leg.odds,
    probability: leg.probability,
    market: leg.market || 'moneyline',
  })) : [];
  const kickoff = setup.kickoff || legs.map((leg) => leg.kickoff).filter(Boolean).sort()[0] || null;
  const seasonWeek = nflSeasonWeek(kickoff);
  return {
    id: selectionIdentity(setup, accountKey),
    accountKey,
    setupId: setup.id,
    market: setup.market,
    category: setup.category,
    selection: setup.selection || legs.map((leg) => leg.selection).join(' + '),
    matchup: setup.matchup || legs.map((leg) => leg.matchup).join(' / '),
    eventId: setup.eventId || null,
    player: setup.player || null,
    home: setup.home || null,
    away: setup.away || null,
    side: setup.side || null,
    line: Number.isFinite(Number(setup.line ?? setup.point)) ? Number(setup.line ?? setup.point) : null,
    legs,
    book: setup.book || null,
    bookTitle: setup.bookTitle || setup.book || null,
    odds,
    probability: Number.isFinite(Number(setup.probability ?? setup.jointProbability)) ? Number(setup.probability ?? setup.jointProbability) : null,
    modeledEdge: Number.isFinite(Number(setup.expectedReturn)) ? Number(setup.expectedReturn) : null,
    confidence: setup.confidence || null,
    entry: setup.entry || null,
    invalidation: setup.invalidation || null,
    kickoff,
    season: seasonWeek?.season || null,
    week: seasonWeek?.week || null,
    capturedAt,
    dataStatus: setup.dataStatus || 'current',
  };
}

export function collectPaperCandidates({ setups = {}, playerSetups = {}, checkedAt = new Date().toISOString() } = {}) {
  const now = Date.parse(checkedAt);
  const groups = [
    ['moneyline', [...(setups.moneylines || []), ...(setups.winners || [])]],
    ['spread', setups.spreads || []],
    ['total', setups.totals || []],
    ['player_prop', playerSetups.plays || []],
    ['winner_parlay', [...(setups.parlays || []), ...(setups.likelihoodParlays || [])]],
    ['player_parlay', playerSetups.parlays || []],
  ];
  const unique = new Map();
  for (const [accountKey, items] of groups) {
    for (const setup of items) {
      if (setup?.decision !== 'PLAY' || !kickoffIsFuture(setup, now)) continue;
      const item = candidate(setup, accountKey, checkedAt);
      if (!item) continue;
      const current = unique.get(item.id);
      const itemEdge = Number.isFinite(item.modeledEdge) ? item.modeledEdge : -Infinity;
      const currentEdge = Number.isFinite(current?.modeledEdge) ? current.modeledEdge : -Infinity;
      if (!current || itemEdge > currentEdge || (itemEdge === currentEdge && item.odds > current.odds)) unique.set(item.id, item);
    }
  }
  return [...unique.values()].sort((a, b) => a.accountKey.localeCompare(b.accountKey)
    || (Number.isFinite(b.modeledEdge) ? b.modeledEdge : -Infinity) - (Number.isFinite(a.modeledEdge) ? a.modeledEdge : -Infinity)
    || (b.probability || 0) - (a.probability || 0));
}

export function allocatePaperCandidates(candidates, positions = []) {
  const accepted = [];
  const existing = new Set(positions.map((position) => position.id));
  const simulated = [...positions];
  for (const item of candidates) {
    if (existing.has(item.id)) continue;
    const config = accountConfig(item.accountKey);
    if (!config) continue;
    const summary = summarizePaperAccount(simulated.filter((position) => (position.accountKey || position.account_key) === item.accountKey), config);
    if (summary.state === 'PAUSED' || summary.nextStake <= 0) continue;
    const stake = summary.nextStake;
    const allocated = {
      ...item,
      stake,
      potentialProfit: stake * (decimalOdds(item.odds) - 1),
      status: 'open',
    };
    accepted.push(allocated);
    simulated.push(allocated);
    existing.add(item.id);
  }
  return accepted;
}

function scoreRows(payload) {
  return Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.scores) ? payload.scores : [];
}

export function normalizeNflScores(payload) {
  return scoreRows(payload).flatMap((game) => {
    if (!game?.completed || !Array.isArray(game.scores)) return [];
    const home = String(game.home_team || '').trim();
    const away = String(game.away_team || '').trim();
    const homeScore = Number(game.scores.find((score) => String(score?.name || '').trim() === home)?.score);
    const awayScore = Number(game.scores.find((score) => String(score?.name || '').trim() === away)?.score);
    if (!home || !away || !Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return [];
    return [{
      eventId: game.canonical_event_id || game.id,
      providerEventId: game.id || null,
      home,
      away,
      homeScore,
      awayScore,
      completed: true,
      lastUpdate: game.last_update || null,
    }];
  });
}

function resultForGameLeg(leg, score) {
  if (!score) return null;
  const selectedHome = leg.selection === score.home;
  const selectedAway = leg.selection === score.away;
  if (leg.market === 'total') {
    const total = score.homeScore + score.awayScore;
    if (total === Number(leg.line)) return 'push';
    return leg.side === 'over' ? total > Number(leg.line) ? 'win' : 'loss' : total < Number(leg.line) ? 'win' : 'loss';
  }
  if (!selectedHome && !selectedAway) return null;
  const selectedScore = selectedHome ? score.homeScore : score.awayScore;
  const opponentScore = selectedHome ? score.awayScore : score.homeScore;
  if (leg.market === 'spread') {
    const adjusted = selectedScore + Number(leg.line);
    return adjusted === opponentScore ? 'push' : adjusted > opponentScore ? 'win' : 'loss';
  }
  return selectedScore === opponentScore ? 'push' : selectedScore > opponentScore ? 'win' : 'loss';
}

function playerResultIndex(results) {
  const index = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const key = `${result.season}|${result.week}|${normalizeNflPlayerName(result.player)}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(result);
  }
  return index;
}

function resultForPlayerLeg(leg, index) {
  const hasStoredWeek = leg.season !== null && leg.season !== undefined
    && leg.week !== null && leg.week !== undefined
    && Number.isInteger(Number(leg.season)) && Number.isInteger(Number(leg.week));
  const seasonWeek = hasStoredWeek
    ? { season: Number(leg.season), week: Number(leg.week) }
    : nflSeasonWeek(leg.kickoff);
  if (!seasonWeek || !leg.player || !leg.market || !Number.isFinite(Number(leg.line))) return null;
  const matches = index.get(`${seasonWeek.season}|${seasonWeek.week}|${normalizeNflPlayerName(leg.player)}`) || [];
  if (matches.length !== 1) return null;
  const actual = playerStatForMarket(matches[0], leg.market);
  if (!Number.isFinite(actual)) return null;
  const line = Number(leg.line);
  const side = String(leg.side || '').toLowerCase();
  const result = actual === line ? 'push' : side === 'over' ? actual > line ? 'win' : 'loss' : side === 'under' ? actual < line ? 'win' : 'loss' : null;
  if (!result) return null;
  return {
    result,
    actual,
    line,
    player: matches[0].player,
    playerId: matches[0].playerId,
    gameId: matches[0].gameId,
    market: leg.market,
    side: leg.side,
    season: seasonWeek.season,
    week: seasonWeek.week,
  };
}

export function gradePaperPosition(position, normalizedScores = [], playerResults = []) {
  const accountKey = position.accountKey || position.account_key;
  if (['player_prop', 'player_parlay'].includes(accountKey)) {
    const index = playerResultIndex(playerResults);
    const identityParts = String(position.id || '').split('|');
    const legs = accountKey === 'player_parlay'
      ? position.legs || []
      : [{
        player: position.player || (identityParts[0] === 'player_prop' ? identityParts[3] : null),
        market: position.market,
        side: position.side,
        line: position.line,
        kickoff: position.kickoff,
        season: position.season,
        week: position.week,
        odds: position.odds,
      }];
    const results = legs.map((leg) => ({ leg, evidence: resultForPlayerLeg(leg, index) }));
    if (!results.length || results.some((item) => !item.evidence)) return null;
    if (results.some((item) => item.evidence.result === 'loss')) return { result: 'loss', settlementOdds: position.odds, evidence: results, source: 'nflverse player stats (CC BY 4.0)' };
    const winners = results.filter((item) => item.evidence.result === 'win');
    if (!winners.length) return { result: 'push', settlementOdds: position.odds, evidence: results, source: 'nflverse player stats (CC BY 4.0)' };
    const settlementDecimal = winners.reduce((product, item) => product * decimalOdds(item.leg.odds), 1);
    const settlementOdds = settlementDecimal >= 2
      ? Math.round((settlementDecimal - 1) * 100)
      : Math.round(-100 / (settlementDecimal - 1));
    return { result: 'win', settlementOdds, evidence: results, source: 'nflverse player stats (CC BY 4.0)' };
  }
  if (!['moneyline', 'spread', 'total', 'winner_parlay'].includes(accountKey)) return null;
  const byEvent = new Map(normalizedScores.flatMap((score) => [
    score.eventId ? [score.eventId, score] : null,
    score.providerEventId ? [score.providerEventId, score] : null,
  ].filter(Boolean)));
  const legs = accountKey === 'winner_parlay'
    ? position.legs || []
    : [{
      eventId: position.eventId || position.event_id,
      selection: position.selection,
      market: position.market,
      side: position.side,
      line: position.line,
      odds: position.odds,
    }];
  const results = legs.map((leg) => ({ leg, result: resultForGameLeg(leg, byEvent.get(leg.eventId)) }));
  if (!results.length || results.some((item) => !item.result)) return null;
  if (results.some((item) => item.result === 'loss')) return { result: 'loss', settlementOdds: position.odds, evidence: results };
  const winners = results.filter((item) => item.result === 'win');
  if (!winners.length) return { result: 'push', settlementOdds: position.odds, evidence: results };
  const settlementDecimal = winners.reduce((product, item) => product * decimalOdds(item.leg.odds), 1);
  const settlementOdds = settlementDecimal >= 2
    ? Math.round((settlementDecimal - 1) * 100)
    : Math.round(-100 / (settlementDecimal - 1));
  return { result: 'win', settlementOdds, evidence: results };
}
