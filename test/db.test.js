import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createWriter } from '../src/db/writer.js';
import { createQueries } from '../src/db/queries.js';

const dirs = [];
const openDbs = [];
function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guidepc2-'));
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

describe('database layer', () => {
  it('cria schema com os índices exigidos', () => {
    const db = openTemp();
    const idx = db.prepare("PRAGMA index_list('samples')").all().map((r) => r.name);
    expect(idx).toContain('idx_samples_ts');
    expect(idx).toContain('idx_samples_metric_ts');
    const cols = db.prepare("PRAGMA table_info('samples')").all().map((r) => r.name);
    expect(cols).toEqual(['id', 'ts', 'metric', 'value']);
    db.close();
  });

  it('insertBatch grava e latest devolve o último valor por métrica', () => {
    const db = openTemp();
    const writer = createWriter(db);
    writer.insertBatch([
      { ts: 100, metric: 'cpu.total', value: 10 },
      { ts: 105, metric: 'cpu.total', value: 20 },
      { ts: 105, metric: 'mem.used', value: 50 },
    ]);
    const queries = createQueries(db);
    const latest = queries.latest(110);
    expect(latest.ts).toBe(105);
    expect(latest.values['cpu.total']).toBe(20);
    expect(latest.values['mem.used']).toBe(50);
    db.close();
  });

  it('latest respeita a janela de tempo', () => {
    const db = openTemp();
    createWriter(db).insertBatch([
      { ts: 100, metric: 'cpu.total', value: 10 },
      { ts: 5000, metric: 'cpu.total', value: 30 },
    ]);
    const queries = createQueries(db);
    const latest = queries.latest(5100, 200);
    expect(latest.values['cpu.total']).toBe(30);
    const stale = queries.latest(9000, 100);
    expect(stale.values['cpu.total']).toBeUndefined();
    db.close();
  });

  it('range devolve apenas pontos do período em ordem', () => {
    const db = openTemp();
    createWriter(db).insertBatch([
      { ts: 100, metric: 'cpu.total', value: 1 },
      { ts: 200, metric: 'cpu.total', value: 2 },
      { ts: 300, metric: 'cpu.total', value: 3 },
      { ts: 250, metric: 'mem.used', value: 99 },
    ]);
    const { points } = createQueries(db).range('cpu.total', 150, 300);
    expect(points).toEqual([
      { ts: 200, value: 2 },
      { ts: 300, value: 3 },
    ]);
    db.close();
  });

  it('purgeOlderThan remove só o que é anterior ao corte e devolve a contagem', () => {
    const db = openTemp();
    const writer = createWriter(db);
    writer.insertBatch([
      { ts: 100, metric: 'cpu.total', value: 1 },
      { ts: 200, metric: 'cpu.total', value: 2 },
      { ts: 300, metric: 'cpu.total', value: 3 },
    ]);
    expect(writer.purgeOlderThan(200)).toBe(1);
    expect(createQueries(db).range('cpu.total', 0, 1000).points.length).toBe(2);
    expect(writer.purgeOlderThan(1000)).toBe(2);
    db.close();
  });

  it('maxTs e countRecent alimentam o /api/health', () => {
    const db = openTemp();
    expect(createQueries(db).maxTs()).toBeNull();
    createWriter(db).insertBatch([
      { ts: 100, metric: 'cpu.total', value: 1 },
      { ts: 105, metric: 'cpu.total', value: 2 },
      { ts: 105, metric: 'mem.used', value: 3 },
    ]);
    const q = createQueries(db);
    expect(q.maxTs()).toBe(105);
    expect(q.countRecent(120, 110)).toBe(2);
    db.close();
  });

  it('cria a tabela alerts com índice por ts', () => {
    const db = openTemp();
    const cols = db.prepare("PRAGMA table_info('alerts')").all().map((r) => r.name);
    expect(cols).toEqual(['id', 'ts', 'alertname', 'state', 'value']);
    const idx = db.prepare("PRAGMA index_list('alerts')").all().map((r) => r.name);
    expect(idx).toContain('idx_alerts_ts');
    db.close();
  });

  it('insertAlerts grava e listAlerts devolve por ts DESC com limite', () => {
    const db = openTemp();
    const writer = createWriter(db);
    writer.insertAlerts([
      { ts: 100, alertname: 'CPU alta', state: 'firing', value: 95.5 },
      { ts: 300, alertname: 'Mem alta', state: 'resolved', value: null },
      { ts: 200, alertname: 'Disco cheio', state: 'firing', value: 88 },
    ]);
    const list = createQueries(db).listAlerts(2);
    expect(list.length).toBe(2);
    expect(list[0].alertname).toBe('Mem alta');
    expect(list[1].alertname).toBe('Disco cheio');
    expect(list[1].value).toBe(88);
    expect(list[0].value).toBeNull();
    db.close();
  });

  it('purgeAlertsOlderThan remove alertas antes do corte e conta', () => {
    const db = openTemp();
    const writer = createWriter(db);
    writer.insertAlerts([
      { ts: 100, alertname: 'a', state: 'firing', value: 1 },
      { ts: 200, alertname: 'b', state: 'firing', value: 2 },
      { ts: 300, alertname: 'c', state: 'firing', value: 3 },
    ]);
    expect(writer.purgeAlertsOlderThan(200)).toBe(1);
    expect(createQueries(db).listAlerts(50).length).toBe(2);
    expect(writer.purgeAlertsOlderThan(1000)).toBe(2);
    db.close();
  });
});
