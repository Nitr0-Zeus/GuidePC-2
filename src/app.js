import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApiRouter } from './api/routes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp({ queries, writer, thresholdsPath, hardware, processes, grafanaHealth }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ queries, writer, thresholdsPath, hardware, processes, grafanaHealth }));
  app.use(express.static(path.join(root, 'src', 'web', 'public')));
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'JSON inválido no corpo da requisição' });
    }
    console.error('[api]', err);
    return res.status(500).json({ error: 'Erro interno' });
  });
  return app;
}
