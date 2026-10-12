import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  fetchNflPlayerResults,
  normalizeNflPlayerName,
  parseNflversePlayerStatsCsv,
  playerStatForMarket,
} from '../lib/nfl-player-results.mjs';

const csv = [
  'player_id,player_display_name,position,season,week,season_type,game_id,team,opponent_team,passing_yards,passing_tds,rushing_yards,rushing_tds,receptions,receiving_yards,receiving_tds,special_teams_tds,def_tds,fumble_recovery_tds',
  '00-1234,"A.J. Example",QB,2026,6,REG,2026_06_AAA_BBB,AAA,BBB,287,3,24,1,0,0,0,0,0,0',
  '00-5678,Receiver Example,WR,2026,6,REG,2026_06_CCC_DDD,CCC,DDD,0,0,0,0,7,96,1,0,0,0',
].join('\n');

test('parses licensed weekly player results and preserves settlement fields', () => {
  const results = parseNflversePlayerStatsCsv(csv);
  assert.equal(results.length, 2);
  assert.equal(results[0].normalizedPlayer, 'a j example');
  assert.equal(playerStatForMarket(results[0], 'player_pass_yds'), 287);
  assert.equal(playerStatForMarket(results[0], 'player_pass_tds'), 3);
  assert.equal(playerStatForMarket(results[0], 'player_anytime_td'), 1);
  assert.equal(playerStatForMarket(results[1], 'player_receptions'), 7);
  assert.equal(playerStatForMarket(results[1], 'player_reception_yds'), 96);
  assert.equal(normalizeNflPlayerName(' A.J.  Example '), 'a j example');
});

test('fetches and decompresses the nflverse release without exposing credentials', async () => {
  const response = {
    ok: true,
    headers: { get: (name) => name === 'last-modified' ? 'Mon, 12 Oct 2026 04:35:10 GMT' : null },
    arrayBuffer: async () => gzipSync(Buffer.from(csv)),
  };
  const result = await fetchNflPlayerResults({ season: 2026, fetcher: async () => response });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.sourceUpdatedAt, 'Mon, 12 Oct 2026 04:35:10 GMT');
});
