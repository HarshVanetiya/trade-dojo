import pg from 'pg';

/**
 * Tests run against a real PostgreSQL:
 *  - TEST_DATABASE_URL (default postgres://dojo:dojo@localhost:5432/tradedojo_test), or
 *  - USE_EMBEDDED_PG=1 to start a throwaway server via the `embedded-postgres` package
 *    (cannot run as root).
 * The public schema is dropped and recreated, then migrations run.
 */
export default async function setup() {
  let stop: (() => Promise<void>) | undefined;
  if (process.env.USE_EMBEDDED_PG === '1') {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const dir = `${process.cwd()}/.test-pg`;
    const pgServer = new EmbeddedPostgres({ databaseDir: dir, user: 'dojo', password: 'dojo', port: 54329, persistent: false });
    await pgServer.initialise();
    await pgServer.start();
    await pgServer.createDatabase('tradedojo_test');
    process.env.TEST_DATABASE_URL_RESOLVED = 'postgres://dojo:dojo@localhost:54329/tradedojo_test';
    stop = () => pgServer.stop();
  }
  const url = process.env.TEST_DATABASE_URL_RESOLVED || process.env.TEST_DATABASE_URL || 'postgres://dojo:dojo@localhost:5432/tradedojo_test';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();

  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET = 'test-secret-123456';
  const { migrate } = await import('../src/db/migrate.js');
  const { pool } = await import('../src/db/pool.js');
  await migrate(() => {});
  await pool.end();
  return async () => {
    if (stop) await stop();
  };
}
