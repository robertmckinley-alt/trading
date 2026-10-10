import { americanToDecimal, americanToImplied, probabilityToAmerican } from './nfl-setups.mjs';

const MARKET_LABELS = {
  player_anytime_td: 'anytime touchdowns',
  player_pass_tds: 'passing touchdowns',
  player_pass_yds: 'passing yards',
  player_rush_yds: 'rushing yards',
  player_reception_yds: 'receiving yards',
  player_receptions: 'receptions',
};

const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function deviation(values) {
  const center = average(values);
  if (center === null || values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
}

function decimalToAmerican(decimal) {
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

function injuryBlocksPlay(injury) {
  if (!injury?.status) return false;
  return !/^(active|healthy|probable)$/i.test(String(injury.status).trim());
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replaceAll(/\s+/g, ' ');
}

function groupCurrentProps(lines, { now, maxAgeSeconds, minMinutesBeforeKickoff }) {
  const groups = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const kickoff = Date.parse(line.kickoff || '');
    if (line.sourceType !== 'sportsbook'
      || !line.eventId
      || !line.player
      || !Number.isFinite(line.point)
      || !Number.isFinite(line.odds)
      || !Number.isFinite(line.ageSeconds)
      || line.ageSeconds > maxAgeSeconds
      || line.ageSeconds < 0
      || !Number.isFinite(kickoff)
      || kickoff <= now + minMinutesBeforeKickoff * 60_000) continue;
    const key = [line.eventId, line.market, normalizeName(line.player), line.point, line.period].join('|');
    if (!groups.has(key)) groups.set(key, {
      eventId: line.eventId,
      market: line.market,
      player: line.player,
      point: line.point,
      period: line.period,
      kickoff: line.kickoff,
      matchup: line.away && line.home ? `${line.away} @ ${line.home}` : 'Matchup unavailable',
      injuryBlocked: false,
      books: new Map(),
    });
    const group = groups.get(key);
    group.injuryBlocked ||= injuryBlocksPlay(line.injury);
    if (!group.books.has(line.bookmaker)) group.books.set(line.bookmaker, {
      key: line.bookmaker,
      title: line.bookmakerTitle || line.bookmaker,
      Over: null,
      Under: null,
    });
    group.books.get(line.bookmaker)[line.side] = line;
  }
  return [...groups.values()];
}

function pairedBooks(group) {
  return [...group.books.values()].flatMap((book) => {
    if (!book.Over || !book.Under) return [];
    const overRaw = americanToImplied(book.Over.odds);
    const underRaw = americanToImplied(book.Under.odds);
    const overround = Number.isFinite(overRaw) && Number.isFinite(underRaw) ? overRaw + underRaw : null;
    if (!overround) return [];
    return [{
      ...book,
      fairOver: overRaw / overround,
      fairUnder: underRaw / overround,
    }];
  });
}

function candidateFor(group, book, side, peers) {
  const probabilities = peers
    .filter((peer) => peer.key !== book.key)
    .map((peer) => side === 'Over' ? peer.fairOver : peer.fairUnder)
    .filter(Number.isFinite);
  const probability = average(probabilities);
  const odds = book[side].odds;
  const decimal = americanToDecimal(odds);
  return {
    group,
    book,
    side,
    odds,
    probability,
    sourceBooks: probabilities.length,
    dispersion: deviation(probabilities),
    expectedReturn: Number.isFinite(probability) && decimal ? probability * decimal - 1 : null,
  };
}

function publishCandidate(candidate) {
  const { group, book, side, odds, probability, sourceBooks, dispersion, expectedReturn } = candidate;
  const decimal = americanToDecimal(odds);
  const marketLabel = MARKET_LABELS[group.market] || group.market;
  return {
    id: `${group.eventId}|${group.market}|${normalizeName(group.player)}|${group.point}|${side}|${book.key}`,
    eventId: group.eventId,
    market: group.market,
    category: 'Player prop value',
    player: group.player,
    side,
    point: group.point,
    selection: `${group.player} ${side} ${group.point} ${marketLabel}`,
    matchup: group.matchup,
    kickoff: group.kickoff,
    odds,
    book: book.key,
    bookTitle: book.title,
    probability,
    impliedProbability: americanToImplied(odds),
    expectedReturn,
    fairOdds: probabilityToAmerican(probability),
    confidence: sourceBooks >= 5 && dispersion <= 0.04 && expectedReturn >= 0.03 ? 'High' : 'Moderate',
    decision: 'PLAY',
    entry: `${group.player} ${side} ${group.point} ${marketLabel} at ${odds > 0 ? '+' : ''}${odds} or better`,
    invalidation: 'Pass if the exact player, event, market, side or line changes; the quote is stale; injury status changes; or kickoff starts.',
    maxLoss: '1 unit before user-specific sizing',
    targetProfit: decimal - 1,
    riskReward: decimal - 1,
    sourceBooks,
    dispersion,
    identityStatus: 'canonical_event_exact_player_name',
    basis: 'Exact event, player name, market and line matched across sportsbooks; price tested against leave-one-book-out de-vigged consensus.',
  };
}

function combinations(items, size, start = 0, prefix = [], output = []) {
  if (prefix.length === size) {
    output.push(prefix);
    return output;
  }
  for (let index = start; index <= items.length - (size - prefix.length); index += 1) {
    combinations(items, size, index + 1, [...prefix, items[index]], output);
  }
  return output;
}

function buildPlayerParlays(candidates, minParlayExpectedReturn) {
  const byBook = new Map();
  for (const candidate of candidates) {
    if (!byBook.has(candidate.book.key)) byBook.set(candidate.book.key, []);
    byBook.get(candidate.book.key).push(candidate);
  }
  const parlays = [];
  for (const [bookKey, bookCandidates] of byBook) {
    for (const size of [2, 3]) {
      for (const legs of combinations(bookCandidates, size)) {
        if (new Set(legs.map((leg) => leg.group.eventId)).size !== legs.length) continue;
        if (new Set(legs.map((leg) => `${normalizeName(leg.group.player)}|${leg.group.market}|${leg.group.point}`)).size !== legs.length) continue;
        const jointProbability = legs.reduce((value, leg) => value * leg.probability, 1);
        const combinedDecimal = legs.reduce((value, leg) => value * americanToDecimal(leg.odds), 1);
        const expectedReturn = jointProbability * combinedDecimal - 1;
        parlays.push({
          id: `${bookKey}|player|${legs.map((leg) => leg.group.eventId + ':' + normalizeName(leg.group.player)).sort().join('|')}`,
          category: `${size}-leg player prop parlay`,
          market: 'player_parlay',
          book: bookKey,
          bookTitle: legs[0].book.title,
          legs: legs.map((leg) => ({
            eventId: leg.group.eventId,
            selection: `${leg.group.player} ${leg.side} ${leg.group.point} ${MARKET_LABELS[leg.group.market] || leg.group.market}`,
            matchup: leg.group.matchup,
            kickoff: leg.group.kickoff,
            odds: leg.odds,
            probability: leg.probability,
            book: bookKey,
          })),
          jointProbability,
          fairOdds: probabilityToAmerican(jointProbability),
          offeredOdds: decimalToAmerican(combinedDecimal),
          expectedReturn,
          riskReward: combinedDecimal - 1,
          targetProfit: combinedDecimal - 1,
          maxLoss: '1 unit before user-specific sizing',
          confidence: legs.every((leg) => leg.sourceBooks >= 5 && leg.dispersion <= 0.04) ? 'High' : 'Moderate',
          decision: expectedReturn >= minParlayExpectedReturn ? 'PLAY' : 'PASS',
          entry: `${legs.map((leg) => `${leg.group.player} ${leg.side} ${leg.group.point} ${MARKET_LABELS[leg.group.market] || leg.group.market}`).join(' + ')} at ${decimalToAmerican(combinedDecimal) > 0 ? '+' : ''}${decimalToAmerican(combinedDecimal)} or better`,
          invalidation: 'Pass if the actual betslip price is worse than the listed entry, any exact prop line or player status changes, any quote becomes stale, or one of the games starts.',
          basis: 'Cross-game player props at one sportsbook. The payout is estimated and must be verified in the betslip. Same-game legs are excluded because their correlation is not quantified.',
        });
      }
    }
  }
  const unique = new Map();
  for (const parlay of parlays) {
    const key = parlay.legs.map((leg) => leg.eventId + ':' + leg.selection).sort().join('|');
    const current = unique.get(key);
    if (!current || parlay.expectedReturn > current.expectedReturn) unique.set(key, parlay);
  }
  return [...unique.values()]
    .sort((a, b) => (b.decision === 'PLAY') - (a.decision === 'PLAY') || b.expectedReturn - a.expectedReturn)
    .slice(0, 4);
}

export function buildNflPlayerSetups(lines, {
  now = Date.now(),
  maxAgeSeconds = 3600,
  minMinutesBeforeKickoff = 5,
  minConsensusBooks = 3,
  minExpectedReturn = 0.02,
  minParlayExpectedReturn = 0.02,
} = {}) {
  const groups = groupCurrentProps(lines, { now, maxAgeSeconds, minMinutesBeforeKickoff });
  const candidates = [];
  for (const group of groups) {
    if (group.injuryBlocked) continue;
    const peers = pairedBooks(group);
    for (const book of peers) {
      for (const side of ['Over', 'Under']) {
        const candidate = candidateFor(group, book, side, peers);
        if (candidate.sourceBooks >= minConsensusBooks
          && candidate.dispersion <= 0.06
          && candidate.expectedReturn >= minExpectedReturn
          && candidate.odds >= -140
          && candidate.odds <= 300) candidates.push(candidate);
      }
    }
  }
  const bestByProp = new Map();
  for (const candidate of candidates) {
    const key = [candidate.group.eventId, candidate.group.market, normalizeName(candidate.group.player), candidate.group.point].join('|');
    const current = bestByProp.get(key);
    if (!current || candidate.expectedReturn > current.expectedReturn) bestByProp.set(key, candidate);
  }
  const plays = [...bestByProp.values()]
    .sort((a, b) => b.expectedReturn - a.expectedReturn || b.probability - a.probability)
    .slice(0, 10)
    .map(publishCandidate);
  const parlays = buildPlayerParlays(candidates, minParlayExpectedReturn);
  return {
    model: 'NFL EDGE Player Consensus v1',
    plays,
    parlays,
    actionablePlays: plays.length + parlays.filter((parlay) => parlay.decision === 'PLAY').length,
    matchedGroups: groups.length,
    methodology: 'Exact player/event/market/line sportsbook matching with leave-one-book-out de-vigged pricing.',
    limitations: [
      'Player identity uses canonical event plus exact provider display name rather than a universal athlete ID.',
      'Any non-active injury tag blocks the player setup.',
      'Same-game player parlays are excluded because correlation is not quantified.',
    ],
  };
}
