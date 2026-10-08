import Link from 'next/link';
import { unstable_cache } from 'next/cache';
import { fetchNflMonitor } from '../../lib/nfl-monitor.mjs';
import styles from './nfl.module.css';

export const metadata = {
  title: 'NFL Edge | Full Market Suite',
  description: 'NFL moneylines, game winners, spreads, totals, player props and prediction-market research',
};

export const dynamic = 'force-dynamic';

const getPublicBoard = unstable_cache(async () => {
  const result = await fetchNflMonitor({
    includeGameMarkets: true,
    includePredictionMarkets: process.env.NFL_PREDICTION_MARKETS_ENABLED === 'true',
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
}, ['nfl-public-board-v3'], { revalidate: 3600, tags: ['nfl-public-board'] });

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
  return <div className={`${styles.dataPill} ${styles[tone]}`}><span>{label}</span><strong>{value}</strong></div>;
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

function GameCard({ game }) {
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
        <span>Straight-up market leader</span>
        <strong>{game.marketLeader || 'No consensus'}</strong>
        <b>{formatPercent(game.marketLeaderProbability)} fair market probability</b>
        <p>Market-implied leader. This is not an independent NFL EDGE pick.</p>
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
        <span>Decision: <strong>NO TRADE</strong></span>
        <p>{game.reason}</p>
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
      coverage: { bookmakers: [], byMarket: {}, bySourceType: {} },
      gameMarkets: null,
      predictionMarkets: null,
    };
  }

  const allGames = board.gameMarkets?.games || [];
  const upcomingGames = allGames
    .filter((game) => game.state === 'pregame')
    .sort((a, b) => Date.parse(a.kickoff || 0) - Date.parse(b.kickoff || 0));
  const games = upcomingGames.slice(0, 20);
  const gameStatus = board.gameMarkets?.status || 'unavailable';
  const dataCurrent = board.ok && board.gameMarkets?.ok && gameStatus === 'checked';
  const predictionCount = board.predictionMarkets?.marketsCount || board.predictionMarkets?.markets?.length || 0;
  const sourceCount = board.gameMarkets?.bookmakers?.length || 0;
  const propMarkets = Object.entries(board.coverage?.byMarket || {});

  return (
    <main id="main-content" className={styles.page}>
      <nav className={styles.nav} aria-label="NFL Edge navigation">
        <Link href="/">← Trading dashboard</Link>
        <div><span>Research mode</span><strong>Paper only</strong></div>
      </nav>

      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>NFL EDGE / FULL MARKET SUITE</p>
          <h1>The whole board.<br /><em>One disciplined read.</em></h1>
          <p className={styles.lede}>Straight-up winners, moneylines, spreads, totals, player props and prediction markets. Current prices are shown. Unverified edge stays NO TRADE.</p>
        </div>
        <aside className={styles.analysisTicket}>
          <div><span>Analysis time</span><strong>{formatDate(board.checkedAt, false)}</strong></div>
          <div><span>Data status</span><strong>{dataCurrent ? 'Current API snapshot' : 'Incomplete / unavailable'}</strong></div>
          <div><span>Market session</span><strong>NFL pregame</strong></div>
          <div><span>Current price</span><strong>Listed by game</strong></div>
        </aside>
      </header>

      <section className={styles.scoreRail} aria-label="Coverage summary">
        <DataPill label="Upcoming games" value={String(games.length)} tone={games.length ? 'positive' : 'warning'} />
        <DataPill label="Sportsbook sources" value={String(sourceCount)} />
        <DataPill label="Player-prop prices" value={(board.linesCount || 0).toLocaleString('en-US')} />
        <DataPill label="Prediction contracts" value={String(predictionCount)} />
        <DataPill label="Actionable picks" value="0" tone="warning" />
      </section>

      <section className={styles.suiteStrip} aria-label="NFL Edge suite coverage">
        {[
          ['SU', 'Game winners', 'Market-implied leader + best moneyline'],
          ['ATS', 'Spreads', 'Cross-book consensus line'],
          ['O/U', 'Totals', 'Consensus game total'],
          ['PROP', 'Player props', 'Six full-game markets'],
          ['PM', 'Prediction markets', 'Kalshi + Polymarket discovery'],
        ].map(([code, name, detail]) => (
          <div key={code}><b>{code}</b><span>{name}</span><small>{detail}</small></div>
        ))}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeading}>
          <div><p className={styles.sectionKicker}>STRAIGHT-UP + CORE LINES</p><h2>Game winner board</h2></div>
          <p>The favorite is de-vigged across available books. It is a market consensus, not a guaranteed winner.</p>
        </div>
        {games.length ? <div className={styles.gameList}>{games.map((game) => <GameCard key={game.eventId || `${game.away}-${game.home}`} game={game} />)}</div> : <EmptyBoard configured={board.configured} status={gameStatus} />}
      </section>

      <section className={styles.secondaryGrid}>
        <article className={styles.panel}>
          <p className={styles.sectionKicker}>PLAYER PROPS</p>
          <h2>Full-game prop coverage</h2>
          <p className={styles.panelIntro}>ParlayAPI prices are grouped by market. Athlete matches remain non-actionable until identity and context are verified.</p>
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
          <h2>Why the board says NO TRADE</h2>
          <ul>
            <li>No independent win-probability model is validated.</li>
            <li>Live injury and news context still needs confirmation.</li>
            <li>No account size or maximum risk was supplied.</li>
            <li>Entry, stop, targets and minimum risk-to-reward are not defined.</li>
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
        <p>Research software only. Market prices can move. Verify the exact event, line, book, timestamp, liquidity and rules before any decision.</p>
      </footer>
    </main>
  );
}
