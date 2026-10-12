import { neon } from '@neondatabase/serverless';
import {
  allocatePaperCandidates,
  createPaperAccounts,
  gradePaperPosition,
  normalizeNflScores,
  selectRiskPolicyVoids,
  settlePaperPosition,
  nflSeasonWeek,
} from './nfl-paper.mjs';
import { fetchNflPlayerResults } from './nfl-player-results.mjs';

const SCORE_ENDPOINT = 'https://parlay-api.com/v1/sports/americanfootball_nfl/scores?daysFrom=14';

export function nflPaperDatabaseConfigured() {
  return Boolean(process.env.NFL_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function database() {
  const url = process.env.NFL_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('NFL paper database not configured');
  return neon(url);
}

async function ensureSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS nfl_paper_positions (
      id TEXT PRIMARY KEY,
      account_key TEXT NOT NULL,
      setup_id TEXT,
      market TEXT NOT NULL,
      category TEXT,
      selection TEXT NOT NULL,
      matchup TEXT,
      event_id TEXT,
      player TEXT,
      home_team TEXT,
      away_team TEXT,
      season INTEGER,
      week INTEGER,
      side TEXT,
      line NUMERIC,
      legs JSONB NOT NULL DEFAULT '[]'::jsonb,
      book TEXT,
      book_title TEXT,
      odds INTEGER NOT NULL,
      probability NUMERIC,
      modeled_edge NUMERIC,
      confidence TEXT,
      entry_rule TEXT,
      invalidation TEXT,
      kickoff TIMESTAMPTZ,
      captured_at TIMESTAMPTZ NOT NULL,
      data_status TEXT,
      stake NUMERIC(12,2) NOT NULL,
      potential_profit NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      result TEXT,
      pnl NUMERIC(12,2),
      settlement_odds INTEGER,
      settled_at TIMESTAMPTZ,
      result_source TEXT,
      result_evidence JSONB
    )
  `;
  await sql`
    ALTER TABLE nfl_paper_positions
      ADD COLUMN IF NOT EXISTS player TEXT,
      ADD COLUMN IF NOT EXISTS home_team TEXT,
      ADD COLUMN IF NOT EXISTS away_team TEXT,
      ADD COLUMN IF NOT EXISTS season INTEGER,
      ADD COLUMN IF NOT EXISTS week INTEGER
  `;
  await sql`CREATE INDEX IF NOT EXISTS nfl_paper_positions_account_idx ON nfl_paper_positions (account_key, captured_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS nfl_paper_positions_status_idx ON nfl_paper_positions (status, kickoff)`;
}

function numberOrNull(value) {
  return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}

function normalizeRow(row) {
  return {
    id: row.id,
    accountKey: row.account_key,
    setupId: row.setup_id,
    market: row.market,
    category: row.category,
    selection: row.selection,
    matchup: row.matchup,
    eventId: row.event_id,
    player: row.player,
    home: row.home_team,
    away: row.away_team,
    season: numberOrNull(row.season),
    week: numberOrNull(row.week),
    side: row.side,
    line: numberOrNull(row.line),
    legs: Array.isArray(row.legs) ? row.legs : [],
    book: row.book,
    bookTitle: row.book_title,
    odds: Number(row.odds),
    probability: numberOrNull(row.probability),
    modeledEdge: numberOrNull(row.modeled_edge),
    confidence: row.confidence,
    entry: row.entry_rule,
    invalidation: row.invalidation,
    kickoff: row.kickoff,
    capturedAt: row.captured_at,
    dataStatus: row.data_status,
    stake: Number(row.stake),
    potentialProfit: Number(row.potential_profit),
    status: row.status,
    result: row.result,
    pnl: numberOrNull(row.pnl),
    settlementOdds: numberOrNull(row.settlement_odds),
    settledAt: row.settled_at,
    resultSource: row.result_source,
    resultEvidence: row.result_evidence,
  };
}

async function readPositions(sql) {
  const rows = await sql`SELECT * FROM nfl_paper_positions ORDER BY captured_at ASC, id ASC`;
  return rows.map(normalizeRow);
}

async function settlePositions(sql, positions, scores, playerResults, checkedAt) {
  const grades = positions.flatMap((position) => {
    if (!['open', 'awaiting_result'].includes(position.status)) return [];
    const grade = gradePaperPosition(position, scores, playerResults);
    if (!grade) return [];
    const settled = settlePaperPosition(position, grade.result, grade.settlementOdds);
    return [{
      id: position.id,
      status: grade.result,
      result: grade.result,
      pnl: Number(settled.pnl.toFixed(2)),
      settlement_odds: grade.settlementOdds,
      settled_at: checkedAt,
      result_source: grade.source || 'ParlayAPI scores',
      result_evidence: grade.evidence,
    }];
  });
  if (!grades.length) return 0;
  await sql`
    UPDATE nfl_paper_positions AS positions
    SET status = grades.status,
        result = grades.result,
        pnl = grades.pnl,
        settlement_odds = grades.settlement_odds,
        settled_at = grades.settled_at,
        result_source = grades.result_source,
        result_evidence = grades.result_evidence
    FROM jsonb_to_recordset(${JSON.stringify(grades)}::jsonb) AS grades(
      id TEXT, status TEXT, result TEXT, pnl NUMERIC, settlement_odds INTEGER,
      settled_at TIMESTAMPTZ, result_source TEXT, result_evidence JSONB
    )
    WHERE positions.id = grades.id AND positions.status IN ('open', 'awaiting_result')
  `;
  return grades.length;
}

async function enforceRiskPolicy(sql, positions, checkedAt) {
  const voidIds = selectRiskPolicyVoids(positions);
  if (!voidIds.length) return 0;
  const corrections = voidIds.map((id) => ({ id }));
  await sql`
    UPDATE nfl_paper_positions AS positions
    SET status = 'void',
        result = 'void',
        pnl = 0,
        settlement_odds = positions.odds,
        settled_at = ${checkedAt},
        result_source = 'NFL EDGE risk-policy correction',
        result_evidence = ${JSON.stringify({ reason: 'Position exceeded the $300 maximum open exposure for its isolated paper account' })}::jsonb
    FROM jsonb_to_recordset(${JSON.stringify(corrections)}::jsonb) AS corrections(id TEXT)
    WHERE positions.id = corrections.id AND positions.status IN ('open', 'awaiting_result')
  `;
  return voidIds.length;
}

async function insertPositions(sql, positions) {
  if (!positions.length) return 0;
  const rows = positions.map((position) => ({
    id: position.id,
    account_key: position.accountKey,
    setup_id: position.setupId,
    market: position.market,
    category: position.category,
    selection: position.selection,
    matchup: position.matchup,
    event_id: position.eventId,
    player: position.player,
    home_team: position.home,
    away_team: position.away,
    season: position.season,
    week: position.week,
    side: position.side,
    line: position.line,
    legs: position.legs,
    book: position.book,
    book_title: position.bookTitle,
    odds: position.odds,
    probability: position.probability,
    modeled_edge: position.modeledEdge,
    confidence: position.confidence,
    entry_rule: position.entry,
    invalidation: position.invalidation,
    kickoff: position.kickoff,
    captured_at: position.capturedAt,
    data_status: position.dataStatus,
    stake: position.stake,
    potential_profit: Number(position.potentialProfit.toFixed(2)),
    status: position.status,
  }));
  const inserted = await sql`
    INSERT INTO nfl_paper_positions (
      id, account_key, setup_id, market, category, selection, matchup, event_id, player, home_team, away_team, season, week, side, line, legs,
      book, book_title, odds, probability, modeled_edge, confidence, entry_rule, invalidation, kickoff,
      captured_at, data_status, stake, potential_profit, status
    )
    SELECT id, account_key, setup_id, market, category, selection, matchup, event_id, player, home_team, away_team, season, week, side, line, legs,
      book, book_title, odds, probability, modeled_edge, confidence, entry_rule, invalidation, kickoff,
      captured_at, data_status, stake, potential_profit, status
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS positions(
      id TEXT, account_key TEXT, setup_id TEXT, market TEXT, category TEXT, selection TEXT, matchup TEXT,
      event_id TEXT, player TEXT, home_team TEXT, away_team TEXT, season INTEGER, week INTEGER, side TEXT, line NUMERIC, legs JSONB, book TEXT, book_title TEXT, odds INTEGER,
      probability NUMERIC, modeled_edge NUMERIC, confidence TEXT, entry_rule TEXT, invalidation TEXT,
      kickoff TIMESTAMPTZ, captured_at TIMESTAMPTZ, data_status TEXT, stake NUMERIC,
      potential_profit NUMERIC, status TEXT
    )
    ON CONFLICT (id) DO UPDATE SET
      player = COALESCE(EXCLUDED.player, nfl_paper_positions.player),
      home_team = COALESCE(EXCLUDED.home_team, nfl_paper_positions.home_team),
      away_team = COALESCE(EXCLUDED.away_team, nfl_paper_positions.away_team),
      season = COALESCE(EXCLUDED.season, nfl_paper_positions.season),
      week = COALESCE(EXCLUDED.week, nfl_paper_positions.week),
      legs = CASE
        WHEN nfl_paper_positions.account_key = 'player_parlay'
          AND COALESCE(nfl_paper_positions.legs -> 0 ? 'player', false) = false
          AND jsonb_array_length(EXCLUDED.legs) > 0
        THEN EXCLUDED.legs
        ELSE nfl_paper_positions.legs
      END
    WHERE nfl_paper_positions.status IN ('open', 'awaiting_result')
      AND (
        (nfl_paper_positions.player IS NULL AND EXCLUDED.player IS NOT NULL)
        OR (nfl_paper_positions.home_team IS NULL AND EXCLUDED.home_team IS NOT NULL)
        OR (nfl_paper_positions.away_team IS NULL AND EXCLUDED.away_team IS NOT NULL)
        OR (nfl_paper_positions.season IS NULL AND EXCLUDED.season IS NOT NULL)
        OR (nfl_paper_positions.week IS NULL AND EXCLUDED.week IS NOT NULL)
        OR (
          nfl_paper_positions.account_key = 'player_parlay'
          AND COALESCE(nfl_paper_positions.legs -> 0 ? 'player', false) = false
          AND jsonb_array_length(EXCLUDED.legs) > 0
        )
      )
    RETURNING id, (xmax = 0) AS inserted
  `;
  return inserted.filter((row) => row.inserted === true || row.inserted === 't').length;
}

function positionWeek(position) {
  if (position.season !== null && position.season !== undefined
    && position.week !== null && position.week !== undefined
    && Number.isInteger(Number(position.season)) && Number.isInteger(Number(position.week))) {
    return { season: Number(position.season), week: Number(position.week), label: `${Number(position.season)} Week ${Number(position.week)}` };
  }
  return nflSeasonWeek(position.kickoff);
}

function dashboardFromPositions(positions) {
  const accounts = createPaperAccounts(positions);
  const weeklyMap = new Map();
  for (const position of positions) {
    if (!position.settledAt || !['win', 'loss', 'push', 'void'].includes(position.status)) continue;
    const assignment = positionWeek(position);
    if (!assignment) continue;
    const key = `${assignment.season}|${assignment.week}|${position.accountKey}`;
    if (!weeklyMap.has(key)) weeklyMap.set(key, { week: assignment.label, season: assignment.season, weekNumber: assignment.week, accountKey: position.accountKey, wins: 0, losses: 0, pushes: 0, voids: 0, pnl: 0 });
    const row = weeklyMap.get(key);
    if (position.status === 'win') row.wins += 1;
    else if (position.status === 'loss') row.losses += 1;
    else if (position.status === 'push') row.pushes += 1;
    else row.voids += 1;
    row.pnl += Number(position.pnl) || 0;
  }
  const positionsDescending = [...positions].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  const activeWeeks = [...new Set(positions
    .filter((position) => ['open', 'awaiting_result'].includes(position.status))
    .map((position) => positionWeek(position)?.label)
    .filter(Boolean))];
  return {
    configured: true,
    mode: 'paper_only',
    accounts,
    totalStartingBalance: accounts.reduce((sum, account) => sum + account.startingBalance, 0),
    totalEquity: accounts.reduce((sum, account) => sum + account.equity, 0),
    openPositions: positionsDescending.filter((position) => ['open', 'awaiting_result'].includes(position.status)).slice(0, 60),
    recentSettlements: positionsDescending.filter((position) => ['win', 'loss', 'push', 'void'].includes(position.status)).slice(0, 30),
    weekly: [...weeklyMap.values()].sort((a, b) => b.season - a.season || b.weekNumber - a.weekNumber || a.accountKey.localeCompare(b.accountKey)).slice(0, 48),
    activeWeeks,
    lastCapturedAt: positionsDescending[0]?.capturedAt || null,
    settlement: {
      games: 'automatic_from_parlayapi_scores',
      players: 'automatic_from_nflverse_weekly_stats',
    },
  };
}

export async function getNflPaperDashboard() {
  if (!nflPaperDatabaseConfigured()) {
    const accounts = createPaperAccounts();
    const startingBalance = accounts.reduce((sum, account) => sum + account.startingBalance, 0);
    return {
      configured: false,
      mode: 'paper_only',
      accounts,
      totalStartingBalance: startingBalance,
      totalEquity: startingBalance,
      openPositions: [],
      recentSettlements: [],
      weekly: [],
      activeWeeks: [],
      lastCapturedAt: null,
      settlement: { games: 'ready_after_database_connection', players: 'ready_after_database_connection' },
    };
  }
  const sql = database();
  await ensureSchema(sql);
  return dashboardFromPositions(await readPositions(sql));
}

export async function syncNflPaperLedger({ candidates = [], scores = [], playerResults = [], checkedAt = new Date().toISOString() } = {}) {
  if (!nflPaperDatabaseConfigured()) return { status: 'disabled', captured: 0, settled: 0 };
  const sql = database();
  await ensureSchema(sql);
  await sql`
    UPDATE nfl_paper_positions
    SET status = 'awaiting_result'
    WHERE status = 'open' AND kickoff <= ${checkedAt}
  `;
  let positions = await readPositions(sql);
  const riskPolicyVoids = await enforceRiskPolicy(sql, positions, checkedAt);
  if (riskPolicyVoids) positions = await readPositions(sql);
  const settled = await settlePositions(sql, positions, scores, playerResults, checkedAt);
  if (settled) positions = await readPositions(sql);
  const allocated = allocatePaperCandidates(candidates, positions);
  const captured = await insertPositions(sql, allocated);
  return { status: 'synced', captured, settled, riskPolicyVoids, candidates: candidates.length };
}

export { fetchNflPlayerResults };

export async function fetchNflScores({
  key = process.env.PARLAY_API_KEY,
  fetcher = fetch,
} = {}) {
  if (!key) return { ok: false, status: 'missing_parlay_api_key', scores: [] };
  try {
    const response = await fetcher(SCORE_ENDPOINT, {
      headers: { 'X-API-Key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ok: false, status: 'provider_error', httpStatus: response.status, scores: [] };
    const payload = await response.json();
    return { ok: true, status: 'checked', scores: normalizeNflScores(payload) };
  } catch (error) {
    return { ok: false, status: 'network_error', error: error instanceof Error ? error.message : 'Score request failed', scores: [] };
  }
}
