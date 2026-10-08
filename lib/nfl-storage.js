import { neon } from '@neondatabase/serverless';
const table='nfl_edge_snapshots';
function database() {
 const url=process.env.NFL_DATABASE_URL||process.env.DATABASE_URL||process.env.POSTGRES_URL;
 if(!url)throw new Error('NFL snapshot database not configured');
 return neon(url);
}
export async function saveNflSnapshot(payload) {
 const sql=database();
 await sql`CREATE TABLE IF NOT EXISTS nfl_edge_snapshots (id BIGSERIAL PRIMARY KEY, checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), payload JSONB NOT NULL)`;
 const rows=await sql`INSERT INTO nfl_edge_snapshots (payload) VALUES (${JSON.stringify(payload)}::jsonb) RETURNING id,checked_at`;
 return rows[0];
}
export async function latestNflSnapshot() {
 const sql=database();
 const rows=await sql`SELECT id,checked_at,payload FROM nfl_edge_snapshots ORDER BY id DESC LIMIT 1`;
 return rows[0]||null;
}
