import si from 'systeminformation';
import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { createWriter } from './db/writer.js';
import { createQueries } from './db/queries.js';
import { createCollector } from './collector/index.js';
import { createApp } from './app.js';

const db = openDatabase(config.dbPath);
const writer = createWriter(db);
const queries = createQueries(db);

const DAY_MS = 86_400_000;

function purgeNow() {
  const cutoff = Math.floor(Date.now() / 1000) - config.retentionDays * 86_400;
  const removed = writer.purgeOlderThan(cutoff);
  if (removed > 0) console.log(`[retenção] ${removed} amostras removidas`);
}

purgeNow();
const purgeTimer = setInterval(purgeNow, DAY_MS);

const collector = createCollector({
  si,
  writer,
  intervalMs: config.intervalMs,
  onError: (error) => console.error('[coletor]', error.message),
});
collector.start();

const app = createApp({ queries });
const server = app.listen(config.port, () => {
  console.log(`GuidePC 2 em http://localhost:${config.port}`);
});

function shutdown() {
  collector.stop();
  clearInterval(purgeTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
