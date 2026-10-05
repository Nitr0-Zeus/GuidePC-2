import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createWriter } from '../src/db/writer.js';
import { createQueries } from '../src/db/queries.js';
import { createApp } from '../src/app.js';

const dirs = [];
const openDbs = [];
function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guidepc2-api-'));
  dirs.push(dir);
  return path.join(dir, 'metrics.db');
}
function openTemp() {
  const db = openDatabase(tempDbPath());
  openDbs.push(db);
  return db;
}
afterEach(() => {
  while (openDbs.length) {
    try {
      openDbs.pop().close();
    } catch {
      /* já fechado */
    }
  }
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function setup() {
  const db = openTemp();
  const now = Math.floor(Date.now() / 1000);
  createWriter(db).insertBatch([
    { ts: now - 60, metric: 'cpu.total', value: 33 },
    { ts: now - 5, metric: 'cpu.total', value: 77 },
    { ts: now - 5, metric: 'mem.used', value: 40 },
  ]);
  return { app: createApp({ queries: createQueries(db) }), now, db };
}

describe('API', () => {
  it('GET /api/health retorna status e métricas do coletor', async () => {
    const { app, now } = setup();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.uptime).toBeTypeOf('number');
    expect(res.body.lastCollectionAt).toBe(now - 5);
    expect(res.body.metricsCount).toBe(2);
  });

  it('GET /api/latest devolve o último valor de cada métrica', async () => {
    const { app, now } = setup();
    const res = await request(app).get('/api/latest');
    expect(res.status).toBe(200);
    expect(res.body.ts).toBe(now - 5);
    expect(res.body.values['cpu.total']).toBe(77);
    expect(res.body.values['mem.used']).toBe(40);
  });

  it('GET /api/metrics/:metric respeita from/to', async () => {
    const { app, now } = setup();
    const res = await request(app).get(
      `/api/metrics/cpu.total?from=${now - 120}&to=${now}`
    );
    expect(res.status).toBe(200);
    expect(res.body.metric).toBe('cpu.total');
    expect(res.body.points.length).toBe(2);
    expect(res.body.points[0].ts).toBe(now - 60);
  });

  it('GET /api/metrics/:metric com período inválido retorna 400', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/metrics/cpu.total?from=100&to=100');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTypeOf('string');
  });

  it('GET /api/metrics/:metric desconhecida retorna points vazio', async () => {
    const { app, now } = setup();
    const res = await request(app).get(
      `/api/metrics/nao.existe?from=${now - 120}&to=${now}`
    );
    expect(res.status).toBe(200);
    expect(res.body.points).toEqual([]);
  });

  it('POST /api/alerts/webhook aceita payload do Grafana e retorna 200', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/alerts/webhook')
      .send({ alertName: 'GuidePC 2: CPU acima de 90%', status: 'firing' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
