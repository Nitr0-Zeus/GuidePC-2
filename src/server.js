import si from 'systeminformation';
import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { createWriter } from './db/writer.js';
import { createQueries } from './db/queries.js';
import { createCollector } from './collector/index.js';
import { createHardwareService } from './services/hardware.js';
import { createProcessesService } from './services/processes.js';
import { createGrafanaHealth } from './services/grafanaHealth.js';
import { createApp } from './app.js';

const db = openDatabase(config.dbPath);
const writer = createWriter(db);
const queries = createQueries(db);

const DAY_MS = 86_400_000;

function purgeNow() {
  const cutoff = Math.floor(Date.now() / 1000) - config.retentionDays * 86_400;
  const removed = writer.purgeOlderThan(cutoff);
  const removedAlerts = writer.purgeAlertsOlderThan(cutoff);
  if (removed > 0) console.log(`[retenção] ${removed} amostras removidas`);
  if (removedAlerts > 0) console.log(`[retenção] ${removedAlerts} alertas removidos`);
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

const app = createApp({
  queries,
  writer,
  thresholdsPath: config.thresholdsPath,
  hardware: createHardwareService({ si }),
  processes: createProcessesService({ si }),
  grafanaHealth: createGrafanaHealth({ url: config.grafanaHealthUrl }),
});
const server = app.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`GuidePC 2 em http://${host}:${config.port}`);
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
