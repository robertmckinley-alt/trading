import { gunzipSync } from 'node:zlib';

export const NFLVERSE_PLAYER_STATS_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv.gz`;

const numeric = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function normalizeNflPlayerName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replaceAll(/\s+/g, ' ');
}

function csvFields(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  fields.push(value);
  return fields;
}

function normalizedResult(row) {
  const season = Number(row.season);
  const week = Number(row.week);
  const player = String(row.player_display_name || row.player || '').trim();
  if (row.season_type !== 'REG' || !Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > 18 || !player) return null;
  return {
    source: 'nflverse weekly player stats',
    playerId: String(row.player_id || '').trim() || null,
    player,
    normalizedPlayer: normalizeNflPlayerName(player),
    position: String(row.position || '').trim() || null,
    season,
    week,
    gameId: String(row.game_id || '').trim() || null,
    team: String(row.team || '').trim() || null,
    opponent: String(row.opponent_team || '').trim() || null,
    stats: {
      passingYards: numeric(row.passing_yards),
      passingTds: numeric(row.passing_tds),
      rushingYards: numeric(row.rushing_yards),
      rushingTds: numeric(row.rushing_tds),
      receptions: numeric(row.receptions),
      receivingYards: numeric(row.receiving_yards),
      receivingTds: numeric(row.receiving_tds),
      specialTeamsTds: numeric(row.special_teams_tds),
      defensiveTds: numeric(row.def_tds),
      fumbleRecoveryTds: numeric(row.fumble_recovery_tds),
    },
  };
}

export function normalizeNflPlayerResults(rows = []) {
  return rows.flatMap((row) => {
    const result = row && typeof row === 'object' ? normalizedResult(row) : null;
    return result ? [result] : [];
  });
}

export function parseNflversePlayerStatsCsv(csv) {
  const lines = String(csv || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = csvFields(lines[0]);
  return normalizeNflPlayerResults(lines.slice(1).map((line) => {
    const fields = csvFields(line);
    return Object.fromEntries(header.map((name, index) => [name, fields[index] ?? '']));
  }));
}

export function playerStatForMarket(result, market) {
  if (!result?.stats) return null;
  if (market === 'player_pass_yds') return result.stats.passingYards;
  if (market === 'player_pass_tds') return result.stats.passingTds;
  if (market === 'player_rush_yds') return result.stats.rushingYards;
  if (market === 'player_reception_yds') return result.stats.receivingYards;
  if (market === 'player_receptions') return result.stats.receptions;
  if (market === 'player_anytime_td') {
    return result.stats.rushingTds
      + result.stats.receivingTds
      + result.stats.specialTeamsTds
      + result.stats.defensiveTds
      + result.stats.fumbleRecoveryTds;
  }
  return null;
}

export function nflSeasonForDate(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.getUTCMonth() < 3 ? date.getUTCFullYear() - 1 : date.getUTCFullYear();
}

export async function fetchNflPlayerResults({
  season = nflSeasonForDate(),
  fetcher = fetch,
} = {}) {
  if (!Number.isInteger(Number(season))) return { ok: false, status: 'invalid_season', results: [] };
  try {
    const response = await fetcher(NFLVERSE_PLAYER_STATS_URL(Number(season)), {
      cache: 'no-store',
      headers: { Accept: 'application/gzip, application/octet-stream' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { ok: false, status: 'provider_error', httpStatus: response.status, results: [] };
    const compressed = Buffer.from(await response.arrayBuffer());
    const results = parseNflversePlayerStatsCsv(gunzipSync(compressed).toString('utf8'));
    return {
      ok: true,
      status: 'checked',
      season: Number(season),
      results,
      sourceUpdatedAt: response.headers?.get?.('last-modified') || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'network_error',
      error: error instanceof Error ? error.message : 'Player-result request failed',
      results: [],
    };
  }
}
