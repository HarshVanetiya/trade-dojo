// npm run backfill -- [--daily-days=730] [--minute-days=90]
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { backfillProgress, runBackfill } from '../market/backfill.js';
import { createProvider, MarketData } from '../market/marketData.js';
import { loadSettings } from '../services/settings.js';

const arg = (name: string, def: number) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : def;
};

async function main() {
  await migrate();
  await loadSettings();
  const provider = createProvider();
  const md = new MarketData(provider);
  await md.reloadInstruments();
  await md.hours.loadHolidays();
  // Contracts only; no live feed needed for a backfill.
  await md.syncContracts();
  await md.ensureActiveContracts();
  const timer = setInterval(() => {
    console.log(`[backfill] ${backfillProgress.chunksDone}/${backfillProgress.chunksTotal} chunks, ${backfillProgress.candlesSaved} candles - ${backfillProgress.current ?? ''}`);
  }, 5000);
  await runBackfill(md, { dailyDays: arg('daily-days', 730), minuteDays: arg('minute-days', 90) });
  clearInterval(timer);
  console.log(`[backfill] done: ${backfillProgress.candlesSaved} candles saved, ${backfillProgress.errors.length} errors`);
  for (const e of backfillProgress.errors) console.log(`  - ${e}`);
  await provider.stop();
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
