import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createWriter } from '../src/db/writer.js';
import { createQueries } from '../src/db/queries.js';
import { createApp } from '../src/app.js';

const dirs = [];
const openDbs = [];
const servers = [];
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
  while (servers.length) {
    const server = servers.pop();
    server.close();
    server.closeAllConnections?.();
  }
  while (openDbs.length) {
    try {
      openDbs.pop().close();
    } catch {
      /* já fechado */
    }
  }
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function pendente() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function seedAmostras(db, now, qtd) {
  const lote = [];
  for (let i = 0; i < qtd; i += 1) {
    lote.push({ ts: now - qtd + i, metric: 'cpu.total', value: i });
  }
  createWriter(db).insertBatch(lote);
  return qtd + 4;
}

function setup(overrides = {}) {
  const db = openTemp();
  const now = Math.floor(Date.now() / 1000);
  const writer = createWriter(db);
  writer.insertBatch([
    { ts: now - 60, metric: 'cpu.total', value: 33 },
    { ts: now - 5, metric: 'cpu.total', value: 77 },
    { ts: now - 5, metric: 'mem.used', value: 40 },
  ]);
  const app = createApp({
    queries: createQueries(db),
    writer,
    thresholdsPath: path.join(os.tmpdir(), 'guidepc2-thresholds-inexistente.json'),
    ...overrides,
  });
  return { app, now, db };
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

  it('GET /api/export.csv devolve CSV com header e Content-Disposition', async () => {
    const { app, now } = setup();
    const res = await request(app).get(`/api/export.csv?from=${now - 120}&to=${now}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text.startsWith('ts,metric,value')).toBe(true);
    expect(res.text).toContain('cpu.total');
    expect(res.text).toContain('mem.used');
  });

  it('GET /api/export.csv com período inválido retorna 400', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/export.csv?from=100&to=100');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTypeOf('string');
  });

  it('GET /api/export.csv concorrentes completam sem disputar a mesma declaração', async () => {
    const { app, now, db } = setup();
    const linhas = seedAmostras(db, now, 60000);
    const url = `/api/export.csv?from=${now - 70000}&to=${now}`;
    const server = app.listen(0);
    servers.push(server);
    await once(server, 'listening');
    const { port } = server.address();

    const headersA = pendente();
    const fimA = pendente();
    const reqA = http.request({ port, path: url }, (res) => {
      res.pause();
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
      });
      res.on('end', () => fimA.resolve(bytes));
      res.on('error', (erro) => fimA.reject(erro));
      headersA.resolve(res);
    });
    reqA.on('error', (erro) => {
      headersA.reject(erro);
      fimA.reject(erro);
    });
    reqA.end();

    const resA = await headersA.promise;
    const b = await request(server).get(url);
    expect(b.status).toBe(200);
    expect(b.text.startsWith('ts,metric,value')).toBe(true);
    expect(b.text.trim().split('\n').length).toBe(linhas);

    resA.resume();
    const bytesA = await fimA.promise;
    expect(bytesA).toBe(Buffer.byteLength(b.text));
    reqA.destroy();
  });

  it('GET /api/export.csv cancelada no meio mantém o endpoint saudável', async () => {
    const { app, now, db } = setup();
    const linhas = seedAmostras(db, now, 60000);
    const url = `/api/export.csv?from=${now - 70000}&to=${now}`;
    const server = app.listen(0);
    servers.push(server);
    await once(server, 'listening');
    const { port } = server.address();

    const headersA = pendente();
    const reqA = http.request({ port, path: url }, (res) => {
      res.pause();
      headersA.resolve(res);
    });
    reqA.on('error', () => {});
    reqA.end();
    await headersA.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));

    reqA.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const depois = await request(server).get(url);
    expect(depois.status).toBe(200);
    expect(depois.text.startsWith('ts,metric,value')).toBe(true);
    expect(depois.text.trim().split('\n').length).toBe(linhas);
  });

  it('POST /api/alerts/webhook grava os alertas do payload', async () => {
    const { app, db } = setup();
    const res = await request(app)
      .post('/api/alerts/webhook')
      .send({
        status: 'firing',
        alerts: [
          {
            status: 'firing',
            labels: { alertname: 'GuidePC 2: CPU acima de 90%' },
            startsAt: '2026-10-05T12:00:00.000Z',
            values: { A: 95.5 },
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, saved: 1 });
    const rows = db.prepare('SELECT * FROM alerts').all();
    expect(rows.length).toBe(1);
    expect(rows[0].alertname).toBe('GuidePC 2: CPU acima de 90%');
    expect(rows[0].state).toBe('firing');
    expect(rows[0].value).toBe(95.5);
  });

  it('POST /api/alerts/webhook sem alerts[] retorna 400 e não grava', async () => {
    const { app, db } = setup();
    const res = await request(app)
      .post('/api/alerts/webhook')
      .send({ status: 'firing', alertName: 'formato antigo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTypeOf('string');
    expect(db.prepare('SELECT COUNT(*) AS c FROM alerts').get().c).toBe(0);
  });

  it('GET /api/alerts lista por ts DESC respeitando limit', async () => {
    const { app, db } = setup();
    createWriter(db).insertAlerts([
      { ts: 100, alertname: 'antigo', state: 'resolved', value: null },
      { ts: 300, alertname: 'novo', state: 'firing', value: 91 },
      { ts: 200, alertname: 'meio', state: 'firing', value: null },
    ]);
    const res = await request(app).get('/api/alerts?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.alerts.map((a) => a.alertname)).toEqual(['novo', 'meio']);
    const padrao = await request(app).get('/api/alerts');
    expect(padrao.body.alerts.length).toBe(3);
  });

  it('POST /api/alerts/webhook com JSON inválido retorna 400 sem stack', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/alerts/webhook')
      .set('Content-Type', 'application/json')
      .send('{invalido');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTypeOf('string');
  });

  it('GET /api/config/thresholds devolve defaults quando o arquivo não existe', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/config/thresholds');
    expect(res.status).toBe(200);
    expect(res.body.cpu).toEqual({ warn: 70, crit: 90 });
    expect(res.body.mem).toEqual({ warn: 75, crit: 90 });
    expect(res.body.disk).toEqual({ warn: 70, crit: 85 });
  });

  it('GET /api/config/thresholds sobrepõe defaults pelo arquivo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guidepc2-th-api-'));
    dirs.push(dir);
    const file = path.join(dir, 'thresholds.json');
    fs.writeFileSync(file, JSON.stringify({ cpu: { warn: 50, crit: 85 } }));
    const { app } = setup({ thresholdsPath: file });
    const res = await request(app).get('/api/config/thresholds');
    expect(res.status).toBe(200);
    expect(res.body.cpu).toEqual({ warn: 50, crit: 85 });
    expect(res.body.disk).toEqual({ warn: 70, crit: 85 });
  });

  it('GET /api/hardware devolve o inventário do serviço', async () => {
    const fixture = { cpu: { brand: 'Ryzen 5' }, system: { model: 'Mod' }, disks: [], graphics: [] };
    const { app } = setup({ hardware: { get: async () => fixture } });
    const res = await request(app).get('/api/hardware');
    expect(res.status).toBe(200);
    expect(res.body.cpu.brand).toBe('Ryzen 5');
  });

  it('GET /api/processes devolve cpuTop e memTop do serviço', async () => {
    const fixture = { all: 1, running: 1, cpuTop: [{ pid: 1, name: 'x', cpu: 50, mem: 10, user: 'u' }], memTop: [] };
    const { app } = setup({ processes: { get: async () => fixture } });
    const res = await request(app).get('/api/processes');
    expect(res.status).toBe(200);
    expect(res.body.cpuTop[0].cpu).toBe(50);
  });

  it('GET /api/health/grafana devolve online do serviço', async () => {
    const { app } = setup({ grafanaHealth: { get: async () => ({ online: true }) } });
    const res = await request(app).get('/api/health/grafana');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ online: true });
  });
});
