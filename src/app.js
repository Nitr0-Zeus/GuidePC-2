import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApiRouter } from './api/routes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp({ queries }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ queries }));
  app.use(express.static(path.join(root, 'src', 'web', 'public')));
  return app;
}
