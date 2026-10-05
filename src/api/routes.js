import { Router } from 'express';
import { readThresholds } from './thresholds.js';

export function createApiRouter({ queries, thresholdsPath }) {
  const router = Router();

  router.get('/config/thresholds', (_req, res) => {
    res.json(readThresholds(thresholdsPath));
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
    console.log('[alerta Grafana]', JSON.stringify(req.body));
    res.status(200).json({ ok: true });
  });

  return router;
}
