import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 3001),
  intervalMs: Number(process.env.METRICS_INTERVAL_MS ?? 5000),
  retentionDays: Number(process.env.RETENTION_DAYS ?? 7),
  dbPath: process.env.DB_PATH ?? path.join(root, 'data', 'metrics.db'),
  thresholdsPath: process.env.THRESHOLDS_PATH ?? path.join(root, 'config', 'thresholds.json'),
  grafanaHealthUrl: process.env.GRAFANA_HEALTH_URL ?? 'http://localhost:3000/api/health',
};
