const numeric = (value) => value === null || value === undefined || value === ''
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;

export function americanToDecimal(odds) {
  const value = numeric(odds);
  if (value === null || value === 0 || Math.abs(value) < 100) return null;
  return value > 0 ? 1 + value / 100 : 1 + 100 / -value;
}

export function americanToImplied(odds) {
  const decimal = americanToDecimal(odds);
  return decimal ? 1 / decimal : null;
}

export function probabilityToAmerican(probability) {
  const value = numeric(probability);
  if (value === null || value <= 0 || value >= 1) return null;
  return Math.round(value >= 0.5 ? -100 * value / (1 - value) : 100 * (1 - value) / value);
}

function decimalToAmerican(decimal) {
  const value = numeric(decimal);
  if (value === null || value <= 1) return null;
  return Math.round(value >= 2 ? (value - 1) * 100 : -100 / (value - 1));
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function median(values) {
  const usable = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!usable.length) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

function deviation(values) {
  const center = average(values);
  if (center === null || values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
}

function isFresh(market, maxAgeSeconds) {
  return market?.available
    && Number.isFinite(market.ageSeconds)
    && market.ageSeconds >= 0
    && market.ageSeconds <= maxAgeSeconds;
}

function eventIsEligible(game, now, minMinutesBeforeKickoff) {
  const kickoff = Date.parse(game?.kickoff || '');
  return game?.eventId
    && Number.isFinite(kickoff)
    && kickoff > now + minMinutesBeforeKickoff * 60_000;
}

function marketFairProbability(book, market, side) {
  if (market === 'moneyline') {
    return side === 'home'
      ? book.moneyline?.fairHomeProbability
      : book.moneyline?.fairAwayProbability;
  }
  const quote = book[market];
  const first = market === 'spread'
    ? americanToImplied(quote?.homePrice)
    : americanToImplied(quote?.overPrice);
  const second = market === 'spread'
    ? americanToImplied(quote?.awayPrice)
    : americanToImplied(quote?.underPrice);
  const overround = Number.isFinite(first) && Number.isFinite(second) ? first + second : null;
  if (!overround) return null;
  const firstSide = market === 'spread' ? 'home' : 'over';
  return side === firstSide ? first / overround : second / overround;
}

function moneylineConsensus(game, side, { excludeBook = null, maxAgeSeconds = 3600 } = {}) {
  const probabilities = (game.books || []).flatMap((book) => {
    if (book.key === excludeBook || !isFresh(book.moneyline, maxAgeSeconds)) return [];
    const probability = marketFairProbability(book, 'moneyline', side);
    return Number.isFinite(probability) ? [probability] : [];
  });
  return {
    probability: average(probabilities),
    books: probabilities.length,
    dispersion: deviation(probabilities),
  };
}

function moneylineSnapshotConsensus(game, side, { excludeBook = null } = {}) {
  const probabilities = (game.books || []).flatMap((book) => {
    if (book.key === excludeBook || !book.moneyline?.available) return [];
    const probability = marketFairProbability(book, 'moneyline', side);
    return Number.isFinite(probability) ? [probability] : [];
  });
  return {
    probability: average(probabilities),
    books: probabilities.length,
    dispersion: deviation(probabilities),
  };
}

function moneylineQuote(book, side) {
  return side === 'home' ? book.moneyline?.home : book.moneyline?.away;
}

function teamForSide(game, side) {
  return side === 'home' ? game.home : game.away;
}

function opponentForSide(game, side) {
  return side === 'home' ? game.away : game.home;
}

function confidenceForWinner(probability, books, dispersion) {
  if (probability >= 0.68 && books >= 6 && dispersion <= 0.035) return 'High';
  if (probability >= 0.56 && books >= 4 && dispersion <= 0.055) return 'Moderate';
  return 'Low';
}

function expectedReturn(probability, odds) {
  const decimal = americanToDecimal(odds);
  return decimal && Number.isFinite(probability) ? probability * decimal - 1 : null;
}

function bestMoneylineQuote(game, side, maxAgeSeconds) {
  return (game.books || []).flatMap((book) => {
    const odds = moneylineQuote(book, side);
    return isFresh(book.moneyline, maxAgeSeconds) && Number.isFinite(odds)
      ? [{ book: book.key, bookTitle: book.title, odds, ageSeconds: book.moneyline.ageSeconds }]
      : [];
  }).reduce((best, quote) => !best || quote.odds > best.odds ? quote : best, null);
}

function bestSnapshotMoneylineQuote(game, side) {
  return (game.books || []).flatMap((book) => {
    const odds = moneylineQuote(book, side);
    return book.moneyline?.available && Number.isFinite(odds)
      ? [{ book: book.key, bookTitle: book.title, odds, ageSeconds: book.moneyline.ageSeconds }]
      : [];
  }).reduce((best, quote) => !best || quote.odds > best.odds ? quote : best, null);
}

function buildWinner(game, options) {
  const { maxAgeSeconds, minConsensusBooks, minPredictionBooks, minExpectedReturn } = options;
  const freshHome = moneylineConsensus(game, 'home', { maxAgeSeconds });
  const freshAway = moneylineConsensus(game, 'away', { maxAgeSeconds });
  const hasCurrentConsensus = freshHome.books >= minPredictionBooks && freshAway.books >= minPredictionBooks;
  const home = hasCurrentConsensus ? freshHome : moneylineSnapshotConsensus(game, 'home');
  const away = hasCurrentConsensus ? freshAway : moneylineSnapshotConsensus(game, 'away');
  if (home.books < minPredictionBooks || away.books < minPredictionBooks) return null;
  const side = home.probability >= away.probability ? 'home' : 'away';
  const fullConsensus = side === 'home' ? home : away;
  if (fullConsensus.probability <= 0.5) return null;
  const quote = hasCurrentConsensus
    ? bestMoneylineQuote(game, side, maxAgeSeconds)
    : bestSnapshotMoneylineQuote(game, side);
  if (!quote) return null;
  const independentConsensus = hasCurrentConsensus
    ? moneylineConsensus(game, side, { excludeBook: quote.book, maxAgeSeconds })
    : moneylineSnapshotConsensus(game, side, { excludeBook: quote.book });
  const edgeProbability = hasCurrentConsensus && independentConsensus.books
    ? independentConsensus.probability
    : null;
  const edge = hasCurrentConsensus ? expectedReturn(edgeProbability, quote.odds) : null;
  const confidence = hasCurrentConsensus
    ? confidenceForWinner(fullConsensus.probability, fullConsensus.books, fullConsensus.dispersion)
    : 'Low';
  const clearsPlayGate = hasCurrentConsensus
    && fullConsensus.books >= minConsensusBooks
    && independentConsensus.books >= Math.max(1, minConsensusBooks - 1)
    && Number.isFinite(edge)
    && edge >= minExpectedReturn
    && confidence !== 'Low';
  const selection = teamForSide(game, side);
  const decimal = americanToDecimal(quote.odds);
  return {
    id: `${game.eventId}|winner|${side}`,
    eventId: game.eventId,
    market: 'moneyline',
    category: hasCurrentConsensus ? 'Predicted winner' : 'Delayed winner lean',
    side,
    selection,
    opponent: opponentForSide(game, side),
    matchup: `${game.away} @ ${game.home}`,
    kickoff: game.kickoff,
    odds: quote.odds,
    book: quote.book,
    bookTitle: quote.bookTitle,
    probability: fullConsensus.probability,
    impliedProbability: americanToImplied(quote.odds),
    expectedReturn: edge,
    fairOdds: probabilityToAmerican(fullConsensus.probability),
    confidence,
    decision: clearsPlayGate ? 'PLAY' : hasCurrentConsensus ? 'PREDICTION' : 'PASS',
    dataStatus: hasCurrentConsensus ? 'current' : 'delayed_or_incomplete',
    dataStatusLabel: hasCurrentConsensus ? 'Current market consensus' : 'Delayed snapshot — no bet',
    quoteAgeSeconds: quote.ageSeconds,
    entry: hasCurrentConsensus
      ? `${selection} moneyline ${quote.odds > 0 ? '+' : ''}${quote.odds} or better`
      : 'No entry — wait for at least two current moneyline sources.',
    invalidation: hasCurrentConsensus
      ? 'Pass if the quote is older than 60 minutes, kickoff has started, the starting quarterback changes, or the available price gets worse.'
      : 'This lean is not actionable. Reconsider only after current, timestamped moneylines return from at least two books.',
    maxLoss: '1 unit before user-specific sizing',
    targetProfit: decimal ? decimal - 1 : null,
    riskReward: decimal ? decimal - 1 : null,
    sourceBooks: fullConsensus.books,
    independentBooks: independentConsensus.books,
    dispersion: fullConsensus.dispersion,
    basis: hasCurrentConsensus
      ? 'De-vigged sportsbook consensus; value is tested against a leave-one-book-out benchmark.'
      : 'Market-implied leader from the latest provider snapshot; freshness requirements are not met.',
  };
}

function buildMoneylineValue(game, options) {
  const { maxAgeSeconds, minConsensusBooks, minExpectedReturn } = options;
  const candidates = [];
  for (const book of game.books || []) {
    if (!isFresh(book.moneyline, maxAgeSeconds)) continue;
    for (const side of ['home', 'away']) {
      const odds = moneylineQuote(book, side);
      if (!Number.isFinite(odds) || odds < -400 || odds > 350) continue;
      const consensus = moneylineConsensus(game, side, { excludeBook: book.key, maxAgeSeconds });
      if (consensus.books < minConsensusBooks || consensus.dispersion > 0.06) continue;
      const edge = expectedReturn(consensus.probability, odds);
      if (!Number.isFinite(edge) || edge < minExpectedReturn) continue;
      candidates.push({ book, side, odds, consensus, edge });
    }
  }
  const best = candidates.sort((a, b) => b.edge - a.edge || b.consensus.probability - a.consensus.probability)[0];
  if (!best) return null;
  const decimal = americanToDecimal(best.odds);
  return {
    id: `${game.eventId}|moneyline-value|${best.side}`,
    eventId: game.eventId,
    market: 'moneyline',
    category: 'Moneyline value',
    side: best.side,
    selection: teamForSide(game, best.side),
    opponent: opponentForSide(game, best.side),
    matchup: `${game.away} @ ${game.home}`,
    kickoff: game.kickoff,
    odds: best.odds,
    book: best.book.key,
    bookTitle: best.book.title,
    probability: best.consensus.probability,
    impliedProbability: americanToImplied(best.odds),
    expectedReturn: best.edge,
    fairOdds: probabilityToAmerican(best.consensus.probability),
    confidence: best.consensus.books >= 6 && best.consensus.dispersion <= 0.035 ? 'High' : 'Moderate',
    decision: 'PLAY',
    entry: `${teamForSide(game, best.side)} moneyline ${best.odds > 0 ? '+' : ''}${best.odds} or better`,
    invalidation: 'Pass if the price moves below the listed entry, the quote is stale, kickoff starts, or material quarterback/injury news changes the market.',
    maxLoss: '1 unit before user-specific sizing',
    targetProfit: decimal - 1,
    riskReward: decimal - 1,
    sourceBooks: best.consensus.books,
    dispersion: best.consensus.dispersion,
    basis: 'Executable price versus other-book de-vigged consensus',
  };
}

function bestPointQuote(game, market, side, maxAgeSeconds) {
  const quotes = (game.books || []).flatMap((book) => {
    const quote = book[market];
    if (!isFresh(quote, maxAgeSeconds)) return [];
    const point = market === 'spread'
      ? side === 'home' ? quote.homePoint : quote.awayPoint
      : quote.point;
    const odds = market === 'spread'
      ? side === 'home' ? quote.homePrice : quote.awayPrice
      : side === 'over' ? quote.overPrice : quote.underPrice;
    return Number.isFinite(point) && Number.isFinite(odds)
      ? [{ book: book.key, bookTitle: book.title, point, odds, ageSeconds: quote.ageSeconds }]
      : [];
  });
  if (!quotes.length) return null;
  return quotes.reduce((best, quote) => {
    if (!best) return quote;
    if (market === 'total') {
      const quoteBetter = side === 'over' ? quote.point < best.point : quote.point > best.point;
      if (quoteBetter || (quote.point === best.point && quote.odds > best.odds)) return quote;
      return best;
    }
    return quote.point > best.point || (quote.point === best.point && quote.odds > best.odds) ? quote : best;
  }, null);
}

function buildSpread(game, winner, options) {
  if (!winner) return null;
  const { maxAgeSeconds, minConsensusBooks } = options;
  const side = winner.side;
  const points = (game.books || []).flatMap((book) => {
    if (!isFresh(book.spread, maxAgeSeconds)) return [];
    const point = side === 'home' ? book.spread.homePoint : book.spread.awayPoint;
    return Number.isFinite(point) ? [point] : [];
  });
  const consensusPoint = median(points);
  const quote = bestPointQuote(game, 'spread', side, maxAgeSeconds);
  if (points.length < minConsensusBooks || !quote || !Number.isFinite(consensusPoint)) return null;
  const lineAdvantage = quote.point - consensusPoint;
  if (lineAdvantage < 0.5 || quote.odds < -125) return null;
  const decimal = americanToDecimal(quote.odds);
  return {
    id: `${game.eventId}|spread|${side}`,
    eventId: game.eventId,
    market: 'spread',
    category: 'ATS line edge',
    side,
    selection: teamForSide(game, side),
    matchup: `${game.away} @ ${game.home}`,
    kickoff: game.kickoff,
    line: quote.point,
    consensusLine: consensusPoint,
    lineAdvantage,
    odds: quote.odds,
    book: quote.book,
    bookTitle: quote.bookTitle,
    confidence: lineAdvantage >= 1 && points.length >= 6 ? 'High' : 'Moderate',
    decision: 'PLAY',
    entry: `${teamForSide(game, side)} ${quote.point > 0 ? '+' : ''}${quote.point} at ${quote.odds > 0 ? '+' : ''}${quote.odds} or better`,
    invalidation: 'Pass if the line loses its half-point advantage to consensus, the price falls below -125, the quote is stale, or kickoff starts.',
    maxLoss: '1 unit before user-specific sizing',
    targetProfit: decimal - 1,
    riskReward: decimal - 1,
    sourceBooks: points.length,
    basis: 'Consensus winner side at a better spread than the cross-book median',
  };
}

function buildTotal(game, options) {
  const { maxAgeSeconds, minConsensusBooks } = options;
  const points = (game.books || []).flatMap((book) => isFresh(book.total, maxAgeSeconds) && Number.isFinite(book.total.point)
    ? [book.total.point]
    : []);
  const consensusPoint = median(points);
  if (points.length < minConsensusBooks || !Number.isFinite(consensusPoint)) return null;
  const candidates = ['over', 'under'].flatMap((side) => {
    const quote = bestPointQuote(game, 'total', side, maxAgeSeconds);
    if (!quote || quote.odds < -125) return [];
    const lineAdvantage = side === 'over' ? consensusPoint - quote.point : quote.point - consensusPoint;
    return lineAdvantage >= 0.5 ? [{ side, quote, lineAdvantage }] : [];
  });
  const best = candidates.sort((a, b) => b.lineAdvantage - a.lineAdvantage || b.quote.odds - a.quote.odds)[0];
  if (!best) return null;
  const decimal = americanToDecimal(best.quote.odds);
  const selection = `${best.side === 'over' ? 'Over' : 'Under'} ${best.quote.point}`;
  return {
    id: `${game.eventId}|total|${best.side}`,
    eventId: game.eventId,
    market: 'total',
    category: 'Total line edge',
    side: best.side,
    selection,
    matchup: `${game.away} @ ${game.home}`,
    kickoff: game.kickoff,
    line: best.quote.point,
    consensusLine: consensusPoint,
    lineAdvantage: best.lineAdvantage,
    odds: best.quote.odds,
    book: best.quote.book,
    bookTitle: best.quote.bookTitle,
    confidence: best.lineAdvantage >= 1 && points.length >= 6 ? 'High' : 'Moderate',
    decision: 'PLAY',
    entry: `${selection} at ${best.quote.odds > 0 ? '+' : ''}${best.quote.odds} or better`,
    invalidation: 'Pass if the line loses its half-point advantage to consensus, the price falls below -125, the quote is stale, or kickoff starts.',
    maxLoss: '1 unit before user-specific sizing',
    targetProfit: decimal - 1,
    riskReward: decimal - 1,
    sourceBooks: points.length,
    basis: 'Executable total is at least a half-point better than the cross-book median',
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

function decisionRank(decision) {
  return decision === 'PLAY' ? 2 : decision === 'PREDICTION' ? 1 : 0;
}

function buildParlays(games, winners, options) {
  const {
    maxAgeSeconds,
    minConsensusBooks,
    minPredictionBooks,
    minParlayExpectedReturn,
    maxParlaysPerSize,
  } = options;
  const gameMap = new Map(games.map((game) => [game.eventId, game]));
  const eligible = winners
    .filter((winner) => winner.probability >= 0.52)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 12);
  const bookKeys = [...new Set(eligible.flatMap((winner) => gameMap.get(winner.eventId)?.books?.map((book) => book.key) || []))];
  const candidates = [];

  for (const bookKey of bookKeys) {
    const legs = eligible.flatMap((winner) => {
      const game = gameMap.get(winner.eventId);
      const book = game?.books?.find((entry) => entry.key === bookKey);
      const odds = book ? moneylineQuote(book, winner.side) : null;
      if (!book?.moneyline?.available || !Number.isFinite(odds)) return [];

      const quoteIsFresh = isFresh(book.moneyline, maxAgeSeconds);
      const consensus = quoteIsFresh
        ? moneylineConsensus(game, winner.side, { excludeBook: bookKey, maxAgeSeconds })
        : moneylineSnapshotConsensus(game, winner.side, { excludeBook: bookKey });
      const probability = Number.isFinite(consensus.probability)
        ? consensus.probability
        : winner.probability;
      if (!Number.isFinite(probability) || probability < 0.5) return [];
      const current = quoteIsFresh
        && winner.dataStatus === 'current'
        && consensus.books >= Math.max(1, minPredictionBooks - 1);
      const valueQualified = current
        && consensus.books >= Math.max(1, minConsensusBooks - 1)
        && consensus.dispersion <= 0.06;
      return [{
        eventId: winner.eventId,
        selection: winner.selection,
        matchup: winner.matchup,
        kickoff: winner.kickoff,
        odds,
        probability,
        expectedReturn: current ? expectedReturn(probability, odds) : null,
        sourceBooks: consensus.books,
        current,
        valueQualified,
        quoteAgeSeconds: book.moneyline.ageSeconds,
        book: bookKey,
        bookTitle: book.title,
      }];
    });

    for (const size of [2, 3, 4]) {
      for (const combo of combinations(legs, size)) {
        const decimals = combo.map((leg) => americanToDecimal(leg.odds));
        if (decimals.some((decimal) => !decimal)) continue;
        const jointProbability = combo.reduce((value, leg) => value * leg.probability, 1);
        const combinedDecimal = decimals.reduce((value, decimal) => value * decimal, 1);
        const allCurrent = combo.every((leg) => leg.current);
        const edge = allCurrent ? jointProbability * combinedDecimal - 1 : null;
        const fullyCompared = combo.every((leg) => leg.valueQualified);
        const decision = allCurrent && fullyCompared && edge >= minParlayExpectedReturn
          ? 'PLAY'
          : allCurrent ? 'PREDICTION' : 'PASS';
        const offeredOdds = decimalToAmerican(combinedDecimal);
        candidates.push({
          id: `${bookKey}|winner|${size}|${combo.map((leg) => leg.eventId).sort().join('|')}`,
          category: `${size}-leg winner parlay`,
          market: 'winner_parlay',
          legCount: size,
          book: bookKey,
          bookTitle: combo[0].bookTitle,
          legs: combo,
          jointProbability,
          fairOdds: probabilityToAmerican(jointProbability),
          offeredOdds,
          expectedReturn: edge,
          riskReward: combinedDecimal - 1,
          targetProfit: combinedDecimal - 1,
          maxLoss: '1 unit before user-specific sizing',
          confidence: allCurrent && combo.every((leg) => leg.probability >= 0.65) ? 'High' : allCurrent ? 'Moderate' : 'Low',
          decision,
          dataStatus: allCurrent ? 'current' : 'delayed_or_incomplete',
          dataStatusLabel: allCurrent ? 'Current same-book prices' : 'Delayed snapshot — no bet',
          entry: allCurrent
            ? `${combo.map((leg) => leg.selection).join(' + ')} at ${offeredOdds > 0 ? '+' : ''}${offeredOdds} or better`
            : 'No entry — refresh all legs before considering this combination.',
          invalidation: allCurrent
            ? 'Pass if any leg price worsens, a quarterback/injury status changes, any quote becomes stale, or one of the games starts.'
            : 'This combination is not actionable. Reconsider only when every leg has a current same-book price.',
          basis: allCurrent
            ? 'Distinct-game winner predictions at one sportsbook, ranked by combined hit probability. Combined price must be verified in the betslip.'
            : 'Distinct-game market leaders at one sportsbook from a delayed or incomplete snapshot; shown for structure only.',
        });
      }
    }
  }

  const bestByLegs = new Map();
  for (const candidate of candidates) {
    const key = candidate.legs.map((leg) => leg.eventId).sort().join('|');
    const current = bestByLegs.get(key);
    const candidateEdge = Number.isFinite(candidate.expectedReturn) ? candidate.expectedReturn : -Infinity;
    const currentEdge = Number.isFinite(current?.expectedReturn) ? current.expectedReturn : -Infinity;
    if (!current
      || decisionRank(candidate.decision) > decisionRank(current.decision)
      || (decisionRank(candidate.decision) === decisionRank(current.decision) && candidateEdge > currentEdge)
      || (decisionRank(candidate.decision) === decisionRank(current.decision)
        && candidateEdge === currentEdge
        && candidate.targetProfit > current.targetProfit)) {
      bestByLegs.set(key, candidate);
    }
  }

  const ranked = [...bestByLegs.values()];
  const likelihoodParlays = [2, 3, 4].flatMap((size) => ranked
    .filter((parlay) => parlay.legCount === size)
    .sort((a, b) => b.jointProbability - a.jointProbability
      || decisionRank(b.decision) - decisionRank(a.decision)
      || (Number.isFinite(b.expectedReturn) ? b.expectedReturn : -Infinity)
        - (Number.isFinite(a.expectedReturn) ? a.expectedReturn : -Infinity))
    .slice(0, maxParlaysPerSize));
  const valueParlays = [2, 3, 4].flatMap((size) => ranked
    .filter((parlay) => parlay.legCount === size && parlay.decision === 'PLAY')
    .sort((a, b) => b.expectedReturn - a.expectedReturn || b.jointProbability - a.jointProbability)
    .slice(0, 3)).slice(0, 8);

  return {
    likelihoodParlays,
    valueParlays,
    stats: {
      combinationsEvaluated: candidates.length,
      published: likelihoodParlays.length,
      actionable: likelihoodParlays.filter((parlay) => parlay.decision === 'PLAY').length,
      bySize: Object.fromEntries([2, 3, 4].map((size) => {
        const sizeParlays = likelihoodParlays.filter((parlay) => parlay.legCount === size);
        return [size, {
          published: sizeParlays.length,
          actionable: sizeParlays.filter((parlay) => parlay.decision === 'PLAY').length,
        }];
      })),
    },
  };
}

export function buildNflSetups(games, {
  now = Date.now(),
  maxAgeSeconds = 3600,
  minMinutesBeforeKickoff = 5,
  minConsensusBooks = 4,
  minPredictionBooks = 2,
  minExpectedReturn = 0.015,
  minParlayExpectedReturn = 0.015,
  maxParlaysPerSize = 4,
} = {}) {
  const options = {
    now,
    maxAgeSeconds,
    minMinutesBeforeKickoff,
    minConsensusBooks,
    minPredictionBooks,
    minExpectedReturn,
    minParlayExpectedReturn,
    maxParlaysPerSize,
  };
  const eligibleGames = (Array.isArray(games) ? games : [])
    .filter((game) => eventIsEligible(game, now, minMinutesBeforeKickoff));
  const winners = eligibleGames
    .map((game) => buildWinner(game, options))
    .filter(Boolean)
    .sort((a, b) => b.probability - a.probability
      || decisionRank(b.decision) - decisionRank(a.decision))
    .slice(0, 20);
  const winnerMap = new Map(winners
    .filter((winner) => winner.dataStatus === 'current')
    .map((winner) => [winner.eventId, winner]));
  const moneylines = eligibleGames
    .map((game) => buildMoneylineValue(game, options))
    .filter(Boolean)
    .sort((a, b) => b.expectedReturn - a.expectedReturn)
    .slice(0, 6);
  const spreads = eligibleGames
    .map((game) => buildSpread(game, winnerMap.get(game.eventId), options))
    .filter(Boolean)
    .sort((a, b) => b.lineAdvantage - a.lineAdvantage || b.sourceBooks - a.sourceBooks)
    .slice(0, 6);
  const totals = eligibleGames
    .map((game) => buildTotal(game, options))
    .filter(Boolean)
    .sort((a, b) => b.lineAdvantage - a.lineAdvantage || b.sourceBooks - a.sourceBooks)
    .slice(0, 6);
  const { likelihoodParlays, valueParlays: parlays, stats: parlayStats } = buildParlays(eligibleGames, winners, options);
  const published = [...winners, ...moneylines, ...spreads, ...totals, ...likelihoodParlays];
  const actionable = published.filter((setup) => setup.decision === 'PLAY');
  return {
    generatedAt: new Date(now).toISOString(),
    model: 'NFL EDGE Consensus Model v1',
    dataStatus: eligibleGames.length ? 'current_market_model' : 'no_eligible_games',
    eligibleGames: eligibleGames.length,
    publishedSetups: published.length,
    actionableSetups: actionable.length,
    winners,
    moneylines,
    spreads,
    totals,
    parlays,
    likelihoodParlays,
    parlayStats,
    methodology: 'De-vigged cross-book consensus, leave-one-book-out price tests, and line-shopping advantages. It is not an injury-adjusted proprietary forecast.',
    limitations: [
      'Starting-quarterback and injury changes are not independently verified.',
      'Parlay probabilities assume distinct games are independent and the combined price is only an estimate.',
      'Delayed winner leans and delayed parlay structures are labeled PASS and have no entry.',
      'Position size is withheld until the user supplies bankroll and maximum risk.',
    ],
  };
}
