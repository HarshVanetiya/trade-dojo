import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { runBackfill } from './market/backfill.js';
import { createProvider, MarketData } from './market/marketData.js';
import { wireRuntime } from './runtime.js';
import { seedAdmin } from './services/auth.js';
import { loadSettings } from './services/settings.js';
import { hub } from './ws/hub.js';

async function main() {
  await migrate();
  await loadSettings();
  await seedAdmin();

  const md = new MarketData(createProvider());
  wireRuntime(md);

  const app = createApp();
  const server = http.createServer(app);
  hub.attach(server);

  const pushStatus = () => {
    for (const inst of md.instruments) hub.broadcast('market_status', { instrument: inst.code, ...md.marketStatus(inst.id) });
  };
  hub.onConnectHook = () => pushStatus();
  setInterval(pushStatus, 15_000).unref();

  await md.start();
  console.log(`[market] provider: ${md.provider.name}`);

  server.listen(config.PORT, config.HOST, () => {
    console.log(`[api] TradeDojo backend listening on http://${config.HOST}:${config.PORT}`);
  });

  if (config.BACKFILL_ON_START) {
    runBackfill(md).catch((err) => md.recordError(`Backfill failed: ${err.message}`));
  }

  const shutdown = async () => {
    console.log('[api] shutting down');
    hub.close();
    server.close();
    await md.stop().catch(() => {});
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
