import { Router } from 'express';
import { readThresholds } from './thresholds.js';
import { parseAlerts } from './parseAlerts.js';

export function createApiRouter({ queries, writer, thresholdsPath, hardware }) {
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
