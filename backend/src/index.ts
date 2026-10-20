import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { seedAdmin } from './services/auth.js';
import { loadSettings } from './services/settings.js';

async function main() {
  await migrate();
  await loadSettings();
  await seedAdmin();

  const app = createApp();
  const server = http.createServer(app);
  server.listen(config.PORT, config.HOST, () => {
    console.log(`[api] TradeDojo backend listening on http://${config.HOST}:${config.PORT}`);
  });

  const shutdown = async () => {
    console.log('[api] shutting down');
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[api] failed to start:', err);
  process.exit(1);
});
