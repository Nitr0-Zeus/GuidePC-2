import { Router } from 'express';
import { once } from 'node:events';
import { readThresholds } from './thresholds.js';
import { parseAlerts } from './parseAlerts.js';

const csvCell = (v) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function createApiRouter({ queries, writer, thresholdsPath, hardware, processes, grafanaHealth }) {
  const router = Router();

  router.get('/config/thresholds', (_req, res) => {
    res.json(readThresholds(thresholdsPath));
  });

  router.get('/hardware', async (_req, res, next) => {
    try {
      res.json(await hardware.get());
    } catch (error) {
      next(error);
    }
  });

  router.get('/processes', async (_req, res, next) => {
    try {
      res.json(await processes.get());
    } catch (error) {
      next(error);
    }
  });

  router.get('/health/grafana', async (_req, res, next) => {
    try {
      res.json(await grafanaHealth.get());
    } catch (error) {
      next(error);
    }
  });

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      lastCollectionAt: queries.maxTs(),
      metricsCount: queries.countRecent(120),
    });
  });

  router.get('/latest', (_req, res) => {
    res.json(queries.latest(Math.floor(Date.now() / 1000)));
  });

  router.get('/metrics/:metric', (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const from = req.query.from !== undefined ? Number(req.query.from) : now - 3600;
    const to = req.query.to !== undefined ? Number(req.query.to) : now + 1;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      return res.status(400).json({ error: 'Parâmetros from/to inválidos' });
    }
    return res.json(queries.range(req.params.metric, from, to));
  });

  router.get('/export.csv', async (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const from = req.query.from !== undefined ? Number(req.query.from) : now - 3600;
    const to = req.query.to !== undefined ? Number(req.query.to) : now + 1;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      return res.status(400).json({ error: 'Parâmetros from/to inválidos' });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="guidepc2-metricas.csv"');
    res.write('ts,metric,value\n');
    for (const row of queries.iterateRange(from, to)) {
      const line = `${row.ts},${csvCell(row.metric)},${row.value}\n`;
      if (!res.write(line)) await once(res, 'drain');
    }
    res.end();
    return undefined;
  });

  router.post('/alerts/webhook', (req, res) => {
    const rows = parseAlerts(req.body);
    if (!rows) {
      return res.status(400).json({ error: 'Payload sem alertas para gravar' });
    }
    console.log('[alerta Grafana]', JSON.stringify(req.body));
    writer.insertAlerts(rows);
    return res.status(200).json({ ok: true, saved: rows.length });
  });

  router.get('/alerts', (req, res) => {
    const parsed = parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 20;
    res.json({ alerts: queries.listAlerts(limit) });
  });

  return router;
}
