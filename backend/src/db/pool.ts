import fs from 'node:fs';
import pg from 'pg';
import { config } from '../config.js';

// BIGINT (int8) columns hold paise. Values stay far below 2^53, so plain numbers are exact.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
// NUMERIC is only used for non-money ratios.
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

function sslConfig(): pg.PoolConfig['ssl'] {
  if (!config.DB_CA_CERT_PATH) return undefined;
  return { rejectUnauthorized: true, ca: fs.readFileSync(config.DB_CA_CERT_PATH, 'utf8') };
}

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: sslConfig(),
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

export type Db = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<T | null> {
  const res = await db.query<T>(text, params);
  return res.rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
