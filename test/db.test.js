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
});
