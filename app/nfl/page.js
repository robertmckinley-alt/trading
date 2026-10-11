import Link from 'next/link';
import { unstable_cache } from 'next/cache';
import { applyNflPlayerSnapshotFallback, fetchNflMonitor } from '../../lib/nfl-monitor.mjs';
import { buildNflSetups } from '../../lib/nfl-setups.mjs';
import { latestNflPlayerSnapshot } from '../../lib/nfl-storage.js';
import styles from './nfl.module.css';

export const metadata = {
  title: 'NFL Edge | Full Market Suite',
  description: 'NFL moneylines, game winners, spreads, totals, player props and prediction-market research',
};

export const dynamic = 'force-dynamic';

const getPublicBoard = unstable_cache(async () => {
  let result = await fetchNflMonitor({
    includeGameMarkets: true,
    includePredictionMarkets: process.env.NFL_PREDICTION_MARKETS_ENABLED === 'true',
    propAttempts: 2,
    propRetryDelayMs: 500,
  });
  let savedSnapshot = null;
  if (!result.linesCount && (process.env.NFL_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL)) {
    try {
      savedSnapshot = await latestNflPlayerSnapshot();
    } catch (error) {
      result = {
        ...result,
        warnings: [...(result.warnings || []), `Saved player-prop snapshot unavailable: ${error instanceof Error ? error.message : 'database read failed'}`],
      };
    }
  }
  result = applyNflPlayerSnapshotFallback(result, savedSnapshot, { now: Date.parse(result.checkedAt) });
  const setups = buildNflSetups(result.gameMarkets?.games || [], {
    now: Date.parse(result.checkedAt),
  });
  return {
    ok: result.ok,
    configured: result.configured,
    status: result.status,
    checkedAt: result.checkedAt,
    provider: result.provider,
    warnings: result.warnings || [],
    linesCount: result.linesCount || 0,
    staleLines: result.staleLines || 0,
    unknownAgeLines: result.unknownAgeLines || 0,
    coverage: result.coverage || { bookmakers: [], byMarket: {}, bySourceType: {} },
    playerData: result.playerData || { status: 'unavailable', source: 'none', failures: [], warnings: [] },
    setups,
    playerSetups: result.playerSetups || { plays: [], parlays: [], actionablePlays: 0, matchedGroups: 0 },
    gameMarkets: result.gameMarkets ? {
      ...result.gameMarkets,
      games: (result.gameMarkets.games || []).map(({ books, ...game }) => game),
    } : null,
    predictionMarkets: result.predictionMarkets ? {
      ...result.predictionMarkets,
      markets: (result.predictionMarkets.markets || []).slice(0, 24),
    } : null,
    remainingCredits: result.remainingCredits || null,
    requestCost: result.requestCost || null,
  };
}, ['nfl-public-board-v8'], { revalidate: 900, tags: ['nfl-public-board'] });

const marketNames = {
  player_pass_yds: 'Passing yards',
  player_rush_yds: 'Rushing yards',
  player_reception_yds: 'Receiving yards',
  player_receptions: 'Receptions',
  player_anytime_td: 'Anytime TD',
  player_pass_tds: 'Passing TDs',
};

function formatAmerican(value) {
  if (!Number.isFinite(value)) return '—';
  return value > 0 ? `+${value}` : String(value);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
}

function formatLine(value) {
  if (!Number.isFinite(value)) return '—';
  return value > 0 ? `+${value}` : String(value);
}

function formatReturn(value) {
  return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%` : '—';
}

function formatAge(value) {
  if (!Number.isFinite(value)) return 'Unknown age';
  if (value < 60) return `${Math.round(value)} sec old`;
  if (value >= 3600) return `${(value / 3600).toFixed(1)} hr old`;
  return `${Math.round(value / 60)} min old`;
}

function formatDate(value, includeDate = true) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unavailable';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: includeDate ? 'short' : undefined,
    month: includeDate ? 'short' : undefined,
    day: includeDate ? 'numeric' : undefined,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function DataPill({ label, value, tone = 'neutral' }) {
  return <div className={`${styles.dataPill} ${styles[tone] || ''}`}><span>{label}</span><strong>{value}</strong></div>;
}

function Moneyline({ team, quote }) {
  return (
    <div className={styles.moneylineRow}>
      <span>{team}</span>
      <strong>{formatAmerican(quote?.odds)}</strong>
      <small>{quote?.bookmakerTitle || 'No price'}</small>
    </div>
  );
}

function SetupCard({ setup }) {
  return (
    <article className={styles.setupCard}>
      <header>
        <div><span>{setup.category}</span><strong className={setup.decision === 'PASS' ? styles.passBadge : setup.decision === 'PLAY' ? styles.playBadge : styles.predictionBadge}>{setup.decision}</strong></div>
        <b className={setup.confidence === 'High' ? styles.highConfidence : styles.moderateConfidence}>{setup.confidence}</b>
      </header>
      <h3>{setup.selection}</h3>
      <p className={styles.matchup}>{setup.matchup} · {formatDate(setup.kickoff)}</p>
      <div className={styles.setupMetrics}>
        {Number.isFinite(setup.probability) && <div><span>Win probability</span><strong>{formatPercent(setup.probability)}</strong></div>}
        {Number.isFinite(setup.odds) && <div><span>Entry price</span><strong>{formatAmerican(setup.odds)}</strong></div>}
        {Number.isFinite(setup.expectedReturn) && <div><span>Modeled edge</span><strong className={setup.expectedReturn >= 0 ? styles.positiveText : styles.warningText}>{formatReturn(setup.expectedReturn)}</strong></div>}
        {Number.isFinite(setup.lineAdvantage) && <div><span>Line advantage</span><strong className={styles.positiveText}>{setup.lineAdvantage.toFixed(1)} pts</strong></div>}
      </div>
      <dl className={styles.setupDetails}>
        <div><dt>Entry</dt><dd>{setup.entry}</dd></div>
        <div><dt>Book</dt><dd>{setup.bookTitle || setup.book}</dd></div>
        <div><dt>Risk / reward</dt><dd>Risk 1u to win {Number.isFinite(setup.targetProfit) ? `${setup.targetProfit.toFixed(2)}u` : '—'}</dd></div>
        <div><dt>Invalidation</dt><dd>{setup.invalidation}</dd></div>
      </dl>
      <footer>{setup.basis}</footer>
    </article>
  );
}

function PredictionCard({ setup }) {
  const probabilityWidth = Number.isFinite(setup.probability)
    ? `${Math.max(0, Math.min(100, setup.probability * 100)).toFixed(1)}%`
    : '0%';
  return (
    <article className={`${styles.setupCard} ${styles.predictionCard}`}>
      <header>
        <div><span>{setup.category}</span><strong className={setup.decision === 'PASS' ? styles.passBadge : setup.decision === 'PLAY' ? styles.playBadge : styles.predictionBadge}>{setup.decision}</strong></div>
        <b className={setup.dataStatus === 'current' ? styles.highConfidence : styles.caution}>{setup.dataStatusLabel}</b>
      </header>
      <h3>{setup.selection}</h3>
      <p className={styles.matchup}>{setup.matchup} · {formatDate(setup.kickoff)}</p>
      <div className={styles.probabilityLadder} aria-label={`${formatPercent(setup.probability)} market-implied win probability`}>
        <div><span>0%</span><strong>{formatPercent(setup.probability)}</strong><span>100%</span></div>
        <i><b style={{ width: probabilityWidth }} /></i>
      </div>
      <div className={styles.setupMetrics}>
        <div><span>Win probability</span><strong>{formatPercent(setup.probability)}</strong></div>
        <div><span>Best price</span><strong>{formatAmerican(setup.odds)}</strong></div>
        <div><span>Books compared</span><strong>{setup.sourceBooks}</strong></div>
        <div><span>Modeled edge</span><strong className={Number.isFinite(setup.expectedReturn) && setup.expectedReturn >= 0 ? styles.positiveText : styles.warningText}>{formatReturn(setup.expectedReturn)}</strong></div>
      </div>
      <dl className={styles.setupDetails}>
        <div><dt>Entry rule</dt><dd>{setup.entry}</dd></div>
        <div><dt>Best book</dt><dd>{setup.bookTitle || setup.book}</dd></div>
        <div><dt>Quote age</dt><dd>{formatAge(setup.quoteAgeSeconds)}</dd></div>
        <div><dt>Invalidation</dt><dd>{setup.invalidation}</dd></div>
      </dl>
      <footer>{setup.basis}</footer>
    </article>
  );
}

function ParlayCard({ parlay }) {
  return (
    <article className={`${styles.setupCard} ${styles.parlayCard}`}>
      <header>
        <div><span>{parlay.category}</span><strong className={parlay.decision === 'PASS' ? styles.passBadge : parlay.decision === 'PLAY' ? styles.playBadge : styles.predictionBadge}>{parlay.decision}</strong></div>
        <b className={parlay.decision === 'PLAY' ? styles.highConfidence : styles.caution}>{parlay.bookTitle || parlay.book}</b>
      </header>
      <ol>{parlay.legs.map((leg) => <li key={`${leg.eventId}-${leg.selection}`}><strong>{leg.selection}{parlay.market === 'player_parlay' ? '' : ' ML'}</strong><span>{formatAmerican(leg.odds)} · {formatPercent(leg.probability)}{Number.isFinite(leg.expectedReturn) ? ` · ${formatReturn(leg.expectedReturn)} leg` : ''}</span></li>)}</ol>
      <div className={styles.setupMetrics}>
        <div><span>Estimated price</span><strong>{formatAmerican(parlay.offeredOdds)}</strong></div>
        <div><span>Estimated hit rate</span><strong>{formatPercent(parlay.jointProbability)}</strong></div>
        <div><span>Modeled edge</span><strong className={Number.isFinite(parlay.expectedReturn) && parlay.expectedReturn >= 0 ? styles.positiveText : styles.warningText}>{formatReturn(parlay.expectedReturn)}</strong></div>
        <div><span>Risk / reward</span><strong>1u → {parlay.targetProfit.toFixed(2)}u</strong></div>
      </div>
      <p className={styles.invalidation}><strong>Entry:</strong> {parlay.entry}</p>
      {parlay.dataStatusLabel && <p className={styles.invalidation}><strong>Data:</strong> {parlay.dataStatusLabel}</p>}
      <p className={styles.invalidation}><strong>Invalidation:</strong> {parlay.invalidation}</p>
      <footer>{parlay.basis}</footer>
    </article>
  );
}

function SetupEmpty({ children }) {
  return <div className={styles.setupEmpty}><strong>PASS</strong><p>{children}</p></div>;
}

function GameCard({ game, winner }) {
  const isFresh = game.freshness?.staleQuotes === 0 && game.freshness?.unknownAgeQuotes === 0;
  return (
    <article className={styles.gameCard}>
      <header className={styles.gameHeader}>
        <div>
          <p>{formatDate(game.kickoff)}</p>
          <h3>{game.away} <span>@</span> {game.home}</h3>
        </div>
        <span className={`${styles.freshness} ${isFresh ? styles.fresh : styles.caution}`}>
          {isFresh ? 'Quotes current' : 'Freshness gap'}
        </span>
      </header>

      <div className={styles.winnerCallout}>
        <span>{winner ? 'NFL EDGE consensus call' : 'Straight-up market leader'}</span>
        <strong>{winner?.selection || game.marketLeader || 'No consensus'}</strong>
        <b>{formatPercent(winner?.probability ?? game.marketLeaderProbability)} win probability</b>
        <p>{winner ? `${winner.confidence} confidence · ${winner.sourceBooks} comparison books` : 'Insufficient current books for a published model call.'}</p>
      </div>

      <div className={styles.gameGrid}>
        <section>
          <h4>Best moneyline</h4>
          <Moneyline team={game.away} quote={game.bestMoneyline?.away} />
          <Moneyline team={game.home} quote={game.bestMoneyline?.home} />
        </section>
        <section>
          <h4>Consensus lines</h4>
          <div className={styles.consensusRow}><span>{game.home} spread</span><strong>{formatLine(game.consensus?.homeSpread)}</strong></div>
          <div className={styles.consensusRow}><span>Game total</span><strong>{game.consensus?.total ?? '—'}</strong></div>
          <div className={styles.consensusRow}><span>Books compared</span><strong>{game.bookmakers}</strong></div>
        </section>
      </div>

      <footer className={styles.gameFooter}>
        <span>Decision: <strong>{winner?.decision || 'PASS'}</strong></span>
        <p>{winner?.entry || game.reason}</p>
      </footer>
    </article>
  );
}

function EmptyBoard({ configured, status }) {
  return (
    <div className={styles.emptyBoard}>
      <strong>NO TRADE</strong>
      <h3>Current game lines are unavailable.</h3>
      <p>{configured === false
        ? 'ParlayAPI is not configured in this environment.'
        : `The provider board did not return a complete current slate (${status || 'unknown status'}).`}</p>
      <p>Reconsider only after current moneyline, spread and total quotes return with timestamps inside the 60-minute freshness limit.</p>
    </div>
  );
}

export default async function NFLPage() {
  let board;
  try {
    board = await getPublicBoard();
  } catch (error) {
    board = {
      ok: false,
      configured: true,
      status: 'page_data_error',
      checkedAt: new Date().toISOString(),
      warnings: [error instanceof Error ? error.message : 'NFL data request failed'],
      linesCount: 0,
      playerData: { status: 'unavailable', source: 'none', failures: [], warnings: [], reason: 'NFL data request failed' },
      coverage: { bookmakers: [], byMarket: {}, bySourceType: {} },
      gameMarkets: null,
      predictionMarkets: null,
      setups: null,
    };
  }

  const allGames = board.gameMarkets?.games || [];
  const checkedAtMillis = Date.parse(board.checkedAt || '');
  const now = Number.isFinite(checkedAtMillis) ? checkedAtMillis : 0;
  const upcomingGames = allGames
    .filter((game) => game.state === 'pregame' && Number.isFinite(Date.parse(game.kickoff)) && Date.parse(game.kickoff) > now)
    .sort((a, b) => Date.parse(a.kickoff || 0) - Date.parse(b.kickoff || 0));
  const games = upcomingGames.slice(0, 20);
  const gameStatus = board.gameMarkets?.status || 'unavailable';
  const dataCurrent = Boolean(
    board.gameMarkets?.ok
    && board.gameMarkets?.staleQuotes === 0
    && board.gameMarkets?.unknownAgeQuotes === 0
  );
  const dataStatusLabel = dataCurrent
    ? 'Current API snapshot'
    : board.gameMarkets?.ok ? 'Partial — current cards only' : 'Unavailable';
  const predictionCount = board.predictionMarkets?.marketsCount || board.predictionMarkets?.markets?.length || 0;
  const sourceCount = board.gameMarkets?.bookmakers?.length || 0;
  const propMarkets = Object.entries(board.coverage?.byMarket || {});
  const liveSetup = (setup) => Number.isFinite(Date.parse(setup.kickoff || '')) ? Date.parse(setup.kickoff) > now : true;
  const setups = board.setups || { winners: [], moneylines: [], spreads: [], totals: [], parlays: [], likelihoodParlays: [], actionableSetups: 0, publishedSetups: 0 };
  const winners = (setups.winners || []).filter(liveSetup);
  const winnerMap = new Map(winners.map((winner) => [winner.eventId, winner]));
  const valuePlays = [...(setups.moneylines || []), ...(setups.spreads || []), ...(setups.totals || [])].filter(liveSetup);
  const valueParlays = (setups.parlays || []).filter((parlay) => parlay.legs?.every(liveSetup));
  const likelihoodParlays = (setups.likelihoodParlays || []).filter((parlay) => parlay.legs?.every(liveSetup));
  const winnerParlaysBySize = [2, 3, 4].map((size) => ({
    size,
    parlays: likelihoodParlays.filter((parlay) => (parlay.legCount || parlay.legs?.length) === size),
  }));
  const playerPlays = (board.playerSetups?.plays || []).filter(liveSetup);
  const playerParlays = (board.playerSetups?.parlays || []).filter((parlay) => parlay.legs?.every(liveSetup));
  const playerParlaysBySize = [2, 3, 4].map((size) => ({
    size,
    parlays: playerParlays.filter((parlay) => (parlay.legCount || parlay.legs?.length) === size),
  })).filter((group) => group.parlays.length);
  const publishedItems = [...winners, ...valuePlays, ...likelihoodParlays, ...valueParlays, ...playerPlays, ...playerParlays];
  const publishedById = new Map(publishedItems.map((setup) => [setup.id, setup]));
  const actionableCount = [...publishedById.values()].filter((setup) => setup.decision === 'PLAY').length;
  const playerData = board.playerData || {};
  const playerFailure = playerData.reason || playerData.failures?.map((failure) => (
    `${failure.market || 'player props'}: ${failure.status}${failure.httpStatus ? ` HTTP ${failure.httpStatus}` : ''}`
  )).join('; ');
  const playerDataStatus = board.linesCount > 0
    ? playerData.source === 'saved_snapshot'
      ? `${Number(board.linesCount).toLocaleString('en-US')} freshness-adjusted prices from saved snapshot (${formatAge(playerData.snapshotAgeSeconds)}) · live pull failed: ${playerFailure}`
      : `${Number(board.linesCount).toLocaleString('en-US')} exact-line prices loaded live`
    : `Player-prop feed unavailable — ${playerFailure || 'no usable current rows'}${playerData.snapshotCheckedAt ? ` · latest saved snapshot ${formatAge(playerData.snapshotAgeSeconds)}` : ''}`;

  return (
    <main id="main-content" className={styles.page}>
      <nav className={styles.nav} aria-label="NFL Edge navigation">
        <Link href="/">← Trading dashboard</Link>
        <div><span>Research mode</span><strong>Paper only</strong></div>
      </nav>

      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>NFL EDGE / CONSENSUS MODEL V1</p>
          <h1>Best setups.<br /><em>Clear calls.</em></h1>
          <p className={styles.lede}>Ranked winner projections, moneyline value, ATS and total line edges, plus same-book parlay constructions. Every call includes its price, probability, risk and invalidation.</p>
        </div>
        <aside className={styles.analysisTicket}>
          <div><span>Analysis time</span><strong>{formatDate(board.checkedAt, false)}</strong></div>
          <div><span>Data status</span><strong>{dataStatusLabel}</strong></div>
          <div><span>Market session</span><strong>NFL pregame</strong></div>
          <div><span>Current price</span><strong>Listed by game</strong></div>
        </aside>
      </header>

      <section className={styles.scoreRail} aria-label="Coverage summary">
        <DataPill label="Upcoming games" value={String(games.length)} tone={games.length ? 'positive' : 'warning'} />
        <DataPill label="Sportsbook sources" value={String(sourceCount)} />
        <DataPill label="Winner predictions" value={String(winners.length)} tone={winners.length ? 'positive' : 'warning'} />
        <DataPill label="Winner parlays" value={String(likelihoodParlays.length)} tone={likelihoodParlays.length ? 'positive' : 'warning'} />
        <DataPill label="Player parlays" value={String(playerParlays.length)} tone={playerParlays.length ? 'positive' : 'warning'} />
        <DataPill label="Actionable plays" value={String(actionableCount)} tone={actionableCount ? 'positive' : 'warning'} />
      </section>

      <section className={styles.suiteStrip} aria-label="NFL Edge suite coverage">
        {[
          ['SU', 'Game winners', 'Ranked consensus probability'],
          ['ATS', 'Spreads', 'Winner side + line advantage'],
          ['O/U', 'Totals', 'Half-point-or-better market edge'],
          ['PROP', 'Player props', 'Six full-game markets'],
          ['PM', 'Prediction markets', 'Kalshi + Polymarket discovery'],
        ].map(([code, name, detail]) => (
          <div key={code}><b>{code}</b><span>{name}</span><small>{detail}</small></div>
        ))}
      </section>

      <nav className={styles.sectionNav} aria-label="NFL Edge sections">
        <a href="#predicted-winners"><span>Predicted winners</span><strong>{winners.length}</strong></a>
        <a href="#winner-parlays"><span>Winner parlays</span><strong>{likelihoodParlays.length}</strong></a>
        <a href="#value-bets"><span>Value bets</span><strong>{valuePlays.length + valueParlays.length}</strong></a>
        <a href="#player-props"><span>Player props</span><strong>{playerPlays.length}</strong></a>
        <a href="#player-parlays"><span>Player parlays</span><strong>{playerParlays.length}</strong></a>
        <a href="#full-slate"><span>Full slate</span><strong>{games.length}</strong></a>
      </nav>

      <section className={styles.section} id="predicted-winners">
        <div className={styles.sectionHeading}>
          <div><p className={styles.sectionKicker}>PREDICTED WINNERS</p><h2>Who the market expects to win</h2></div>
          <p>Ranked by de-vigged sportsbook probability. PLAY adds a current positive price edge. PREDICTION names the likely winner without recommending a bet. PASS marks a delayed market lean.</p>
        </div>
        {winners.length ? <div className={styles.setupGrid}>{winners.map((setup) => <PredictionCard key={setup.id} setup={setup} />)}</div> : <SetupEmpty>No game has at least two sportsbook moneylines from which to calculate a market-implied winner.</SetupEmpty>}
      </section>

      <section className={styles.section} id="winner-parlays">
        <div className={styles.sectionHeading}>
          <div><p className={styles.sectionKicker}>MOST LIKELY PARLAYS</p><h2>Winner combinations ranked by hit rate</h2></div>
          <p>Each ticket uses one sportsbook and different games. Likelihood and value are separate: PREDICTION can be probable without being a good price, while PASS uses delayed data for structure only.</p>
        </div>
        {likelihoodParlays.length ? <div className={styles.parlayGroups}>
          {winnerParlaysBySize.map(({ size, parlays: sizeParlays }) => (
            <div className={styles.parlayGroup} key={size}>
              <div className={styles.parlayGroupHeading}>
                <h3>{size}-leg predicted-winner parlays</h3>
                <span>{sizeParlays.length ? `${sizeParlays.filter((parlay) => parlay.decision === 'PLAY').length} PLAY · ${sizeParlays.length} ranked` : 'Insufficient shared-book games'}</span>
              </div>
              {sizeParlays.length
                ? <div className={styles.setupGrid}>{sizeParlays.map((parlay) => <ParlayCard key={parlay.id} parlay={parlay} />)}</div>
                : <SetupEmpty>Reconsider when at least {size} predicted winners have prices at the same sportsbook.</SetupEmpty>}
            </div>
          ))}
        </div> : <SetupEmpty>No same-book winner combination can be built from the current provider snapshot.</SetupEmpty>}
      </section>

      <section className={styles.section} id="value-bets">
        <div className={styles.sectionHeading}>
          <div><p className={styles.sectionKicker}>PRICE + LINE EDGE</p><h2>Best bet setups</h2></div>
          <p>These are the setups that beat the cross-book benchmark now. They disappear when the quote gets stale, the price moves, or the line advantage closes.</p>
        </div>
        {valuePlays.length ? <div className={styles.setupGrid}>{valuePlays.slice(0, 8).map((setup) => <SetupCard key={setup.id} setup={setup} />)}</div> : <SetupEmpty>No moneyline, spread or total currently clears the minimum price and line-shopping gates.</SetupEmpty>}
        <div className={styles.subsectionHeading}>
          <div><p className={styles.sectionKicker}>VALUE PARLAYS</p><h3>Positive-edge winner combinations</h3></div>
          <p>Only fresh same-book tickets that clear the modeled-value gate appear here.</p>
        </div>
        {valueParlays.length ? <div className={styles.setupGrid}>{valueParlays.map((parlay) => <ParlayCard key={parlay.id} parlay={parlay} />)}</div> : <SetupEmpty>No winner parlay currently has both fresh prices and positive modeled value.</SetupEmpty>}
      </section>

      <section className={styles.section} id="player-props">
        <div className={styles.sectionHeading}>
          <div><p className={styles.sectionKicker}>PLAYER EDGE</p><h2>Best player props</h2></div>
          <p>Exact player, event, market, side and line matches only. A PLAY requires at least three other books, current prices, positive modeled value and no unresolved injury tag.</p>
        </div>
        <div className={`${styles.feedStatus} ${board.linesCount > 0 ? styles.feedCurrent : styles.feedPaused}`}><strong>Player data</strong><span>{playerDataStatus}</span></div>
        {playerPlays.length ? <div className={styles.setupGrid}>{playerPlays.slice(0, 8).map((setup) => <SetupCard key={setup.id} setup={setup} />)}</div> : <SetupEmpty>No player prop currently clears the exact-match, freshness, injury and price-edge gates.</SetupEmpty>}
      </section>

      <section className={styles.section} id="player-parlays">
        <div className={styles.sectionHeading}>
          <div><p className={styles.sectionKicker}>PLAYER PARLAYS</p><h2>Best cross-game player combinations</h2></div>
          <p>Up to eight ranked tickets per size. Two-, three- and four-player combinations use one sportsbook and different games. PLAY requires at least 2% modeled value. Same-game combinations stay excluded until correlation can be measured.</p>
        </div>
        {playerParlays.length ? <div className={styles.parlayGroups}>
          {playerParlaysBySize.map(({ size, parlays: sizeParlays }) => (
            <div className={styles.parlayGroup} key={size}>
              <div className={styles.parlayGroupHeading}>
                <h3>{size}-player parlays</h3>
                <span>{sizeParlays.filter((parlay) => parlay.decision === 'PLAY').length} PLAY · {sizeParlays.length} ranked</span>
              </div>
              <div className={styles.setupGrid}>{sizeParlays.map((parlay) => <ParlayCard key={parlay.id} parlay={parlay} />)}</div>
            </div>
          ))}
        </div> : <SetupEmpty>No cross-game player parlay currently has positive exact-line value at one sportsbook. Reconsider when at least four fresh books price matching players and lines across two or more games.</SetupEmpty>}
      </section>

      <section className={styles.section} id="full-slate">
        <div className={styles.sectionHeading}>
          <div><p className={styles.sectionKicker}>FULL SLATE</p><h2>Game-by-game board</h2></div>
          <p>Every game shows the model call, current best moneylines, consensus spread and total, or PASS when the required evidence is missing.</p>
        </div>
        {games.length ? <div className={styles.gameList}>{games.map((game) => <GameCard key={game.eventId || `${game.away}-${game.home}`} game={game} winner={winnerMap.get(game.eventId)} />)}</div> : <EmptyBoard configured={board.configured} status={gameStatus} />}
      </section>

      <section className={styles.secondaryGrid}>
        <article className={styles.panel}>
          <p className={styles.sectionKicker}>PLAYER PROPS</p>
          <h2>Full-game prop coverage</h2>
          <p className={styles.panelIntro}>The full provider board is coverage only. PLAY cards require an exact event, player, market and line match plus current prices and injury gates.</p>
          <div className={styles.coverageList}>
            {propMarkets.length ? propMarkets.map(([market, count]) => (
              <div key={market}><span>{marketNames[market] || market}</span><strong>{Number(count).toLocaleString('en-US')}</strong></div>
            )) : <p>No current prop coverage.</p>}
          </div>
        </article>

        <article className={styles.panel}>
          <p className={styles.sectionKicker}>PREDICTION MARKETS</p>
          <h2>Contract discovery</h2>
          <p className={styles.panelIntro}>Game contracts stay source-native. NFL EDGE does not blend them with sportsbook odds until settlement rules, spread, depth and tradability are verified.</p>
          <div className={styles.contractSummary}>
            <strong>{predictionCount}</strong><span>current contracts found</span>
            <p>Sources: {board.predictionMarkets?.sources?.join(' + ') || 'No current source response'}</p>
          </div>
        </article>

        <article className={`${styles.panel} ${styles.guardrailPanel}`}>
          <p className={styles.sectionKicker}>DECISION GATE</p>
          <h2>How calls are gated</h2>
          <ul>
            <li>Fresh quotes and at least four comparison books are required.</li>
            <li>PLAY requires a measurable price or line advantage; otherwise it stays PREDICTION or PASS.</li>
            <li>Quarterback, injury and late-news changes invalidate the setup until confirmed.</li>
            <li>Risk defaults to a one-unit maximum loss. Position size is withheld until bankroll and maximum risk are supplied.</li>
          </ul>
        </article>
      </section>

      <section className={styles.statusBar}>
        <div><span>Provider</span><strong>{board.provider || 'ParlayAPI not available'}</strong></div>
        <div><span>Quote status</span><strong>{gameStatus.replaceAll('_', ' ')}</strong></div>
        <div><span>Prop freshness</span><strong>{board.staleLines || 0} stale / {board.unknownAgeLines || 0} unknown</strong></div>
        <div><span>Credits used</span><strong>{board.requestCost || '—'} this refresh</strong></div>
      </section>

      <footer className={styles.footer}>
        <p><strong>LineMate remains manual-only.</strong> NFL EDGE does not log in, scrape, call undocumented endpoints or automate extraction from LineMate.</p>
        <p>Paper/research mode. The model is market-derived, not a proprietary injury-adjusted forecast. Verify the exact event, line, book, timestamp and rules before any decision.</p>
      </footer>
    </main>
  );
}
