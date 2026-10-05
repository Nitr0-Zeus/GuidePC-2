# Pacotes A + B (Quick wins e utilidade) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar os Pacotes A+B da spec — inventário de hardware, bateria, tema claro/escuro, sparklines, top processos, HOST configurável, export CSV, histórico de alertas, saúde do Grafana e thresholds unificados — preservando escritor único do banco e omissão honesta de métricas.

**Architecture:** Backend Express ganha 6 rotas novas (5 leitas + webhook que passa a gravar) e 3 serviços com cache em memória (`src/services/`); o coletor ganha o bloco de bateria; a página resumo (vanilla) ganha tema, sparklines SVG e 4 seções empilhadas; o Grafana ganha painéis de bateria provisionados. Toda escrita em banco continua passando exclusivamente por `src/db/writer.js`.

**Tech Stack:** Node ≥ 20 · Express 5 · systeminformation 5.33 · better-sqlite3 13 · vitest 5 · supertest 7 · ESLint 10 · Grafana 13 (Docker, provisionado) — **zero dependências novas**.

**Spec:** `docs/superpowers/specs/2026-10-05-pacotes-ab-design.md` (este plano argumenta da spec; o executor lê ambas).

## Global Constraints

- Idioma PT-BR em toda UI, mensagens de erro, docs e mensagens de commit.
- Escritor único: **só** `src/db/writer.js` grava no banco; nenhuma rota GET escreve.
- Métrica/dado indisponível é **omitido** (nunca 0 falso, nunca dado inventado).
- Zero dependências novas: `package.json` não muda. Frontend permanece vanilla (sem framework/lib de gráfico).
- `npm test` e `npm run lint` zerados **antes de cada commit**.
- Commits convencionais (`feat:`, `fix:`, `docs:`), um por task, ASCII (sem acentos nas mensagens).
- Shell é PowerShell 5.1: **não usar `&&` nem `rg`** (usar `;` e `Select-String`).
- Portas padrão: Express 3001, Grafana 3000 (`admin`/`guidepc2`).
- Shapes confirmados do `systeminformation` instalado: `si.battery()` → `{ hasBattery, percent, isCharging, ... }`; `si.processes()` → `{ all, running, list: [{ pid, name, cpu (%), mem (%), user, ... }] }`; `memLayout()[].size` e `diskLayout()[].size` em **bytes**; `graphics().controllers[].vram` em **MB**.

---

### Task 1: HOST configurável (A6)

**Files:**
- Modify: `src/config.js` (objeto `config` ganha `host`, `thresholdsPath`, `grafanaHealthUrl`)
- Modify: `src/server.js:33-35` (`app.listen`)
- Test: `test/config.test.js` (criar)

**Interfaces:**
- Produces: `config.host` (string, default `'0.0.0.0'`), `config.thresholdsPath` (string), `config.grafanaHealthUrl` (string) — consumidos pelas Tasks 2 e 8 e pelo boot.

- [ ] **Step 1: Escrever o teste falhando**

Criar `test/config.test.js`:

```js
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete process.env.HOST;
});

describe('config', () => {
  it('host tem default 0.0.0.0 quando a env HOST não existe', async () => {
    delete process.env.HOST;
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.host).toBe('0.0.0.0');
  });

  it('host é sobrescrito pela variável de ambiente HOST', async () => {
    vi.stubEnv('HOST', '127.0.0.1');
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.host).toBe('127.0.0.1');
  });

  it('expõe thresholdsPath e grafanaHealthUrl com defaults locais', async () => {
    const { config } = await import('../src/config.js');
    expect(config.thresholdsPath.replace(/\\/g, '/')).toMatch(/config\/thresholds\.json$/);
    expect(config.grafanaHealthUrl).toBe('http://localhost:3000/api/health');
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run test/config.test.js`
Expected: FAIL — `undefined` não é `'0.0.0.0'` (propriedade `host` não existe).

- [ ] **Step 3: Implementar**

`src/config.js` — trocar o objeto `config` (linhas 6-12) por:

```js
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
```

`src/server.js` — trocar linhas 32-35 por:

```js
const app = createApp({ queries });
const server = app.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`GuidePC 2 em http://${host}:${config.port}`);
});
```

- [ ] **Step 4: Rodar o teste e ver passar + gate**

Run: `npx vitest run test/config.test.js`
Expected: PASS (3 testes).

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte completa PASS, lint sem erros.

- [ ] **Step 5: Commit**

```powershell
git add src/config.js src/server.js test/config.test.js
git commit -m "feat: host configuravel via env HOST e paths de config nos servicos"
```

---

### Task 2: Thresholds unificados — backend (B4)

**Files:**
- Create: `config/thresholds.json`
- Create: `src/api/thresholds.js`
- Modify: `src/api/routes.js` (rota `GET /config/thresholds`; assinatura ganha `thresholdsPath`)
- Modify: `src/app.js:8-11` (repassa `thresholdsPath`)
- Modify: `src/server.js:32` (passa `thresholdsPath`)
- Test: `test/thresholds.test.js` (criar); `test/api.test.js` (`setup()` reescrito + 2 testes novos)

**Interfaces:**
- Consumes: `config.thresholdsPath` (Task 1).
- Produces: `readThresholds(filePath) → { cpu: {warn, crit}, mem: {warn, crit}, disk: {warn, crit} }`; rota `GET /api/config/thresholds` com **esse mesmo shape** (consumido pela Task 13). Defaults: cpu 70/90, mem 75/90, disk 70/85.

- [ ] **Step 1: Escrever os testes falhando**

Criar `test/thresholds.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readThresholds, DEFAULT_THRESHOLDS } from '../src/api/thresholds.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});
function tempFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guidepc2-th-'));
  dirs.push(dir);
  const file = path.join(dir, 'thresholds.json');
  fs.writeFileSync(file, content);
  return file;
}

describe('readThresholds', () => {
  it('devolve os defaults quando o arquivo não existe', () => {
    const out = readThresholds(path.join(os.tmpdir(), 'nao-existe-guidepc2.json'));
    expect(out).toEqual(DEFAULT_THRESHOLDS);
    expect(out.cpu).toEqual({ warn: 70, crit: 90 });
    expect(out.mem).toEqual({ warn: 75, crit: 90 });
    expect(out.disk).toEqual({ warn: 70, crit: 85 });
  });

  it('devolve os defaults quando o JSON é inválido', () => {
    expect(readThresholds(tempFile('{quebrado'))).toEqual(DEFAULT_THRESHOLDS);
  });

  it('faz merge por chave: arquivo parcial sobrepõe só o que trouxe', () => {
    const file = tempFile(JSON.stringify({ cpu: { warn: 55, crit: 95 }, mem: 'lixo' }));
    const out = readThresholds(file);
    expect(out.cpu).toEqual({ warn: 55, crit: 95 });
    expect(out.mem).toEqual({ warn: 75, crit: 90 });
    expect(out.disk).toEqual({ warn: 70, crit: 85 });
  });

  it('ignora valores não numéricos mantendo o default da chave', () => {
    const file = tempFile(JSON.stringify({ disk: { warn: 'setenta', crit: 80 } }));
    const out = readThresholds(file);
    expect(out.disk).toEqual({ warn: 70, crit: 80 });
  });
});
```

Em `test/api.test.js`, **substituir** o `setup()` (linhas 34-43) por:

```js
function setup(overrides = {}) {
  const db = openTemp();
  const now = Math.floor(Date.now() / 1000);
  createWriter(db).insertBatch([
    { ts: now - 60, metric: 'cpu.total', value: 33 },
    { ts: now - 5, metric: 'cpu.total', value: 77 },
    { ts: now - 5, metric: 'mem.used', value: 40 },
  ]);
  const app = createApp({
    queries: createQueries(db),
    thresholdsPath: path.join(os.tmpdir(), 'guidepc2-thresholds-inexistente.json'),
    ...overrides,
  });
  return { app, now, db };
}
```

Adicionar no `describe('API')` de `test/api.test.js`:

```js
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/thresholds.test.js test/api.test.js`
Expected: FAIL — `Cannot find module '../src/api/thresholds.js'` e rota 404 nos testes de API.

- [ ] **Step 3: Implementar**

Criar `config/thresholds.json`:

```json
{
  "cpu": { "warn": 70, "crit": 90 },
  "mem": { "warn": 75, "crit": 90 },
  "disk": { "warn": 70, "crit": 85 }
}
```

Criar `src/api/thresholds.js`:

```js
import fs from 'node:fs';

export const DEFAULT_THRESHOLDS = {
  cpu: { warn: 70, crit: 90 },
  mem: { warn: 75, crit: 90 },
  disk: { warn: 70, crit: 85 },
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function readThresholds(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return structuredClone(DEFAULT_THRESHOLDS);
  }
  const out = structuredClone(DEFAULT_THRESHOLDS);
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
      const entry = raw[key];
      if (!entry || typeof entry !== 'object') continue;
      if (isNum(entry.warn)) out[key].warn = entry.warn;
      if (isNum(entry.crit)) out[key].crit = entry.crit;
    }
  }
  return out;
}
```

`src/api/routes.js` — adicionar import e trocar a assinatura (linha 3), incluindo a rota nova logo após `const router = Router();`:

```js
import { Router } from 'express';
import { readThresholds } from './thresholds.js';

export function createApiRouter({ queries, thresholdsPath }) {
  const router = Router();

  router.get('/config/thresholds', (_req, res) => {
    res.json(readThresholds(thresholdsPath));
  });
```

`src/app.js` — trocar linhas 8-11 por:

```js
export function createApp({ queries, thresholdsPath }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ queries, thresholdsPath }));
```

`src/server.js` — linha 32:

```js
const app = createApp({ queries, thresholdsPath: config.thresholdsPath });
```

- [ ] **Step 4: Rodar e ver passar + gate**

Run: `npx vitest run test/thresholds.test.js test/api.test.js`
Expected: PASS (4 unit + 9 API, incluindo os 2 novos).

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte PASS, lint limpo.

- [ ] **Step 5: Commit**

```powershell
git add config/thresholds.json src/api/thresholds.js src/api/routes.js src/app.js src/server.js test/thresholds.test.js test/api.test.js
git commit -m "feat: thresholds unificados em config/thresholds.json servidos pela API"
```

### Task 3: Bateria no coletor (A2 backend)

**Files:**
- Modify: `src/collector/metrics.js` (bloco novo após o bloco `si.mem()`, antes de `si.fsSize()`)
- Test: `test/collector.test.js` (`makeSi` ganha `battery`; describe novo com 3 testes)

**Interfaces:**
- Produces: métricas `battery.pct` (%) e `battery.charging` (0/1) — **só** quando `hasBattery === true`. Consumidas por `/api/latest` (Task 12 renderiza) e pelos painéis do Grafana (Task 14).

- [ ] **Step 1: Escrever os testes falhando**

Em `test/collector.test.js`, adicionar em `makeSi()` (após a propriedade `networkConnections`):

```js
    battery: async () => ({ hasBattery: false, percent: 0, isCharging: false }),
```

Adicionar novo `describe` logo **após** o fechamento de `describe('collectMetrics')` (após a linha 108):

```js
describe('bateria', () => {
  it('grava battery.pct e battery.charging quando há bateria', async () => {
    const si = makeSi();
    si.battery = async () => ({ hasBattery: true, percent: 65.4, isCharging: true });
    const m = byName(await collectMetrics(si, {}, 1_000_000));
    expect(m['battery.pct']).toBe(65.4);
    expect(m['battery.charging']).toBe(1);
  });

  it('grava battery.charging = 0 quando descarregando', async () => {
    const si = makeSi();
    si.battery = async () => ({ hasBattery: true, percent: 42, isCharging: false });
    const m = byName(await collectMetrics(si, {}, 1_000_000));
    expect(m['battery.pct']).toBe(42);
    expect(m['battery.charging']).toBe(0);
  });

  it('omite as duas métricas em desktop (sem bateria) e quando a coleta falha', async () => {
    const semBateria = byName(await collectMetrics(makeSi(), {}, 1_000_000));
    expect(semBateria['battery.pct']).toBeUndefined();
    expect(semBateria['battery.charging']).toBeUndefined();

    const si = makeSi();
    si.battery = async () => {
      throw new Error('sem sensor');
    };
    const falhou = byName(await collectMetrics(si, {}, 1_000_000));
    expect(falhou['battery.pct']).toBeUndefined();
    expect(falhou['mem.used']).toBe(50);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/collector.test.js`
Expected: FAIL — nos 2 primeiros testes novos `m['battery.pct']` é `undefined` (métrica ainda não existe).

- [ ] **Step 3: Implementar**

Em `src/collector/metrics.js`, inserir este bloco **após** o bloco `si.mem()` (após a linha 44, `  } catch { /* omitido */ }` do mem) e **antes** do bloco `si.fsSize()`:

```js
  try {
    const battery = await si.battery();
    if (battery?.hasBattery) {
      if (typeof battery.percent === 'number' && Number.isFinite(battery.percent)) {
        push('battery.pct', round(battery.percent));
      }
      if (typeof battery.isCharging === 'boolean') {
        push('battery.charging', battery.isCharging ? 1 : 0);
      }
    }
  } catch {
    /* omitido */
  }
```

- [ ] **Step 4: Rodar e ver passar + gate**

Run: `npx vitest run test/collector.test.js`
Expected: PASS (10 testes: 7 existentes + 3 novos).

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte PASS, lint limpo.

- [ ] **Step 5: Commit**

```powershell
git add src/collector/metrics.js test/collector.test.js
git commit -m "feat: coletor de bateria battery.pct/battery.charging com omicao honesta em desktop"
```

---

### Task 4: Camada de dados de alertas (B2 — schema, writer, queries, purge)

**Files:**
- Modify: `src/db/index.js` (SCHEMA ganha tabela `alerts` + índice)
- Modify: `src/db/writer.js` (`insertAlerts`, `purgeAlertsOlderThan`)
- Modify: `src/db/queries.js` (`listAlerts`)
- Modify: `src/server.js:15-19` (`purgeNow` também limpa alertas)
- Test: `test/db.test.js` (3 testes novos no describe existente)

**Interfaces:**
- Produces (consumidos pela Task 5):
  - `writer.insertAlerts(rows)` — `rows: Array<{ ts: number, alertname: string, state: string, value: number | null }>`; transação.
  - `writer.purgeAlertsOlderThan(cutoffTs: number) → number` (contagem removida).
  - `queries.listAlerts(limit: number) → Array<{ ts, alertname, state, value }>` ordenado `ts DESC, id DESC`.

- [ ] **Step 1: Escrever os testes falhando**

Em `test/db.test.js`, adicionar ao final do `describe('database layer')` (antes da linha 116, o fechamento do describe):

```js
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/db.test.js`
Expected: FAIL — `no such table: alerts`.

- [ ] **Step 3: Implementar**

`src/db/index.js` — adicionar ao final da constante `SCHEMA` (após o último `CREATE INDEX`):

```sql
CREATE TABLE IF NOT EXISTS alerts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  alertname TEXT    NOT NULL,
  state     TEXT    NOT NULL,
  value     REAL
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
```

`src/db/writer.js` — trocar o arquivo inteiro por:

```js
export function createWriter(db) {
  const insert = db.prepare('INSERT INTO samples (ts, metric, value) VALUES (?, ?, ?)');
  const purge = db.prepare('DELETE FROM samples WHERE ts < ?');
  const insertAlert = db.prepare('INSERT INTO alerts (ts, alertname, state, value) VALUES (?, ?, ?, ?)');
  const purgeAlerts = db.prepare('DELETE FROM alerts WHERE ts < ?');

  return {
    insertBatch(rows) {
      const tx = db.transaction((batch) => {
        for (const row of batch) insert.run(row.ts, row.metric, row.value);
      });
      tx(rows);
    },
    purgeOlderThan(cutoffTs) {
      const info = purge.run(cutoffTs);
      if (info.changes > 0) db.pragma('incremental_vacuum');
      return info.changes;
    },
    insertAlerts(rows) {
      const tx = db.transaction((batch) => {
        for (const row of batch) insertAlert.run(row.ts, row.alertname, row.state, row.value ?? null);
      });
      tx(rows);
    },
    purgeAlertsOlderThan(cutoffTs) {
      const info = purgeAlerts.run(cutoffTs);
      if (info.changes > 0) db.pragma('incremental_vacuum');
      return info.changes;
    },
  };
}
```

`src/db/queries.js` — adicionar o statement junto dos demais (após o `countStmt`) e o método no retorno:

```js
  const listAlertsStmt = db.prepare(
    'SELECT ts, alertname, state, value FROM alerts ORDER BY ts DESC, id DESC LIMIT ?'
  );
```

```js
    listAlerts(limit = 20) {
      return listAlertsStmt.all(limit);
    },
```

`src/server.js` — trocar `purgeNow` (linhas 15-19) por:

```js
function purgeNow() {
  const cutoff = Math.floor(Date.now() / 1000) - config.retentionDays * 86_400;
  const removed = writer.purgeOlderThan(cutoff);
  const removedAlerts = writer.purgeAlertsOlderThan(cutoff);
  if (removed > 0) console.log(`[retenção] ${removed} amostras removidas`);
  if (removedAlerts > 0) console.log(`[retenção] ${removedAlerts} alertas removidos`);
}
```

- [ ] **Step 4: Rodar e ver passar + gate**

Run: `npx vitest run test/db.test.js`
Expected: PASS (9 testes: 6 existentes + 3 novos).

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte PASS, lint limpo.

- [ ] **Step 5: Commit**

```powershell
git add src/db/index.js src/db/writer.js src/db/queries.js src/server.js test/db.test.js
git commit -m "feat: camada de dados de alertas (tabela alerts, writer, listAlerts, purge)"
```

---

### Task 5: Webhook grava alertas + GET /api/alerts (B2 API)

**Files:**
- Create: `src/api/parseAlerts.js`
- Modify: `src/api/routes.js` (webhook passa a gravar; rota nova `GET /alerts`; assinatura ganha `writer`)
- Modify: `src/app.js` (repassa `writer`)
- Modify: `src/server.js` (passa `writer` no `createApp`)
- Test: `test/parseAlerts.test.js` (criar); `test/api.test.js` (`setup()` ganha `writer`; 1 teste substituído; 2 novos)

**Interfaces:**
- Consumes: `writer.insertAlerts`, `queries.listAlerts` (Task 4).
- Produces: `parseAlerts(body, nowMs?) → rows | null`; `POST /api/alerts/webhook` → 200 `{ ok: true, saved: n }` grava, ou 400 `{ error }` sem gravar; `GET /api/alerts?limit=` → `{ alerts: [...] }` (limit default 20, min 1, max 200). Consumidos pela Task 12 (página).

- [ ] **Step 1: Escrever os testes falhando**

Criar `test/parseAlerts.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parseAlerts } from '../src/api/parseAlerts.js';

describe('parseAlerts', () => {
  it('converte payload do Grafana em linhas com ts em epoch seconds', () => {
    const rows = parseAlerts({
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'GuidePC 2: CPU acima de 90%' },
          startsAt: '2026-10-05T12:00:00.000Z',
          values: { A: 95.5, B: 1 },
        },
      ],
    });
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({
      ts: Math.floor(Date.parse('2026-10-05T12:00:00.000Z') / 1000),
      alertname: 'GuidePC 2: CPU acima de 90%',
      state: 'firing',
      value: 95.5,
    });
  });

  it('usa status resolved, value direto e fallback de alertname', () => {
    const rows = parseAlerts({
      commonLabels: { alertname: 'Genérico' },
      alerts: [{ status: 'resolved', value: 42 }],
    });
    expect(rows[0].state).toBe('resolved');
    expect(rows[0].value).toBe(42);
    expect(rows[0].alertname).toBe('Genérico');
  });

  it('usa nowMs quando startsAt é inválido e null quando não há valor', () => {
    const rows = parseAlerts({ alerts: [{ status: 'firing', startsAt: 'lixo' }] }, 1_000_000_000);
    expect(rows[0].ts).toBe(1_000_000);
    expect(rows[0].value).toBeNull();
    expect(rows[0].alertname).toBe('Alerta sem nome');
  });

  it('devolve null sem alertas utilizáveis', () => {
    expect(parseAlerts({ status: 'firing' })).toBeNull();
    expect(parseAlerts({ alerts: [] })).toBeNull();
    expect(parseAlerts(null)).toBeNull();
    expect(parseAlerts({ alerts: [null, 'lixo'] })).toBeNull();
  });
});
```

Em `test/api.test.js`:

1. **Substituir** o `setup()` da Task 2 por (ganha `writer`):

```js
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
```

2. **Substituir** o teste existente `'POST /api/alerts/webhook aceita payload do Grafana e retorna 200'` (linhas 92-99) por:

```js
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/parseAlerts.test.js test/api.test.js`
Expected: FAIL — módulo `parseAlerts` não existe; webhook atual responde `{ok:true}` sem gravar (teste novo espera `saved: 1`).

- [ ] **Step 3: Implementar**

Criar `src/api/parseAlerts.js`:

```js
function extractValue(alert) {
  if (alert.values && typeof alert.values === 'object') {
    for (const v of Object.values(alert.values)) {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  if (typeof alert.value === 'number' && Number.isFinite(alert.value)) return alert.value;
  return null;
}

export function parseAlerts(body, nowMs = Date.now()) {
  if (!body || !Array.isArray(body.alerts) || body.alerts.length === 0) return null;
  const nowSec = Math.floor(nowMs / 1000);
  const rows = [];
  for (const alert of body.alerts) {
    if (!alert || typeof alert !== 'object') continue;
    const alertname =
      alert.labels?.alertname ?? body?.commonLabels?.alertname ?? 'Alerta sem nome';
    const state = alert.status === 'resolved' ? 'resolved' : 'firing';
    const parsed = Date.parse(alert.startsAt);
    const ts = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : nowSec;
    rows.push({ ts, alertname: String(alertname), state, value: extractValue(alert) });
  }
  return rows.length > 0 ? rows : null;
}
```

`src/api/routes.js` — imports e assinatura (o import do `parseAlerts` entra junto do do `thresholds`):

```js
import { Router } from 'express';
import { readThresholds } from './thresholds.js';
import { parseAlerts } from './parseAlerts.js';

export function createApiRouter({ queries, writer, thresholdsPath }) {
  const router = Router();
```

**Substituir** o handler do webhook (linhas 29-32) por:

```js
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
```

`src/app.js`:

```js
export function createApp({ queries, writer, thresholdsPath }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ queries, writer, thresholdsPath }));
```

`src/server.js` — linha 32:

```js
const app = createApp({ queries, writer, thresholdsPath: config.thresholdsPath });
```

- [ ] **Step 4: Rodar e ver passar + gate**

Run: `npx vitest run test/parseAlerts.test.js test/api.test.js`
Expected: PASS (4 parseAlerts + 11 API).

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte PASS, lint limpo.

- [ ] **Step 5: Commit**

```powershell
git add src/api/parseAlerts.js src/api/routes.js src/app.js src/server.js test/parseAlerts.test.js test/api.test.js
git commit -m "feat: webhook do Grafana grava historico em alerts e GET /api/alerts lista"
```

### Task 6: Inventário de hardware — serviço + rota (A1)

**Files:**
- Create: `src/services/hardware.js`
- Modify: `src/api/routes.js` (rota `GET /hardware`; assinatura ganha `hardware`)
- Modify: `src/app.js` (repassa `hardware`)
- Modify: `src/server.js` (cria o serviço com `si` real e passa no `createApp`)
- Test: `test/services.test.js` (criar — describe `hardware`); `test/api.test.js` (1 teste de rota)

**Interfaces:**
- Produces: `createHardwareService({ si, ttlMs = 600_000 }) → { get(nowMs?) }` devolvendo:
  `{ system: {manufacturer, model, version} | null, cpu: {brand, manufacturer, cores, physicalCores, speedMax} | null, bios: {vendor, version, releaseDate} | null, baseboard: {manufacturer, model, memMax, memSlots} | null, memory: {total, modules: [{size, bank, type, clockSpeed, manufacturer}]} | null, disks: [{name, size, type, interfaceType}], graphics: [{vendor, model, vram}] }`.
  `GET /api/hardware` devolve esse shape (tamanho em **bytes**, `vram` em **MB** — consumido pela Task 12).

- [ ] **Step 1: Escrever os testes falhando**

Criar `test/services.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createHardwareService } from '../src/services/hardware.js';

function fakeSi() {
  const calls = { system: 0, cpu: 0, bios: 0, baseboard: 0, mem: 0, memLayout: 0, diskLayout: 0, graphics: 0 };
  return {
    calls,
    system: async () => { calls.system++; return { manufacturer: 'Fab', model: 'Mod', version: 'v1' }; },
    cpu: async () => { calls.cpu++; return { brand: 'Ryzen 5', manufacturer: 'AMD', cores: 6, physicalCores: 6, speedMax: 4.2 }; },
    bios: async () => { calls.bios++; return { vendor: 'AMI', version: 'F1', releaseDate: '01/01/2024' }; },
    baseboard: async () => { calls.baseboard++; return { manufacturer: 'Gigabyte', model: 'B550', memMax: 137438953472, memSlots: 4 }; },
    mem: async () => { calls.mem++; return { total: 17179869184 }; },
    memLayout: async () => {
      calls.memLayout++;
      return [
        { size: 8589934592, bank: 'BANK 0', type: 'DDR4', clockSpeed: 3200, manufacturer: 'Kingston' },
        { size: 0, bank: 'BANK 1', type: 'Empty', clockSpeed: 0 },
      ];
    },
    diskLayout: async () => {
      calls.diskLayout++;
      return [{ name: 'SSD 1TB', size: 1000204886016, type: 'SSD', interfaceType: 'NVMe' }];
    },
    graphics: async () => {
      calls.graphics++;
      return { controllers: [{ vendor: 'NVIDIA', model: 'RTX 3060', vram: 12288 }] };
    },
  };
}

describe('hardware service', () => {
  it('monta o inventário completo e filtra slots vazios de memória', async () => {
    const service = createHardwareService({ si: fakeSi() });
    const hw = await service.get(0);
    expect(hw.cpu.brand).toBe('Ryzen 5');
    expect(hw.system.model).toBe('Mod');
    expect(hw.bios.vendor).toBe('AMI');
    expect(hw.baseboard.memSlots).toBe(4);
    expect(hw.memory.total).toBe(17179869184);
    expect(hw.memory.modules.length).toBe(1);
    expect(hw.memory.modules[0].type).toBe('DDR4');
    expect(hw.disks[0].size).toBe(1000204886016);
    expect(hw.graphics[0].vram).toBe(12288);
  });

  it('cacheia por ttlMs: só recarrega após expirar', async () => {
    const si = fakeSi();
    const service = createHardwareService({ si, ttlMs: 600_000 });
    await service.get(0);
    await service.get(599_999);
    expect(si.calls.cpu).toBe(1);
    await service.get(600_001);
    expect(si.calls.cpu).toBe(2);
  });

  it('falha em uma consulta vira null sem derrubar as demais', async () => {
    const si = fakeSi();
    si.cpu = async () => {
      throw new Error('boom');
    };
    const hw = await createHardwareService({ si }).get(0);
    expect(hw.cpu).toBeNull();
    expect(hw.system.model).toBe('Mod');
    expect(hw.memory.total).toBe(17179869184);
    expect(hw.disks.length).toBe(1);
  });
});
```

Em `test/api.test.js`, adicionar no `describe('API')`:

```js
  it('GET /api/hardware devolve o inventário do serviço', async () => {
    const fixture = { cpu: { brand: 'Ryzen 5' }, system: { model: 'Mod' }, disks: [], graphics: [] };
    const { app } = setup({ hardware: { get: async () => fixture } });
    const res = await request(app).get('/api/hardware');
    expect(res.status).toBe(200);
    expect(res.body.cpu.brand).toBe('Ryzen 5');
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/services.test.js test/api.test.js`
Expected: FAIL — `Cannot find module '../src/services/hardware.js'` e rota `/api/hardware` 404.

- [ ] **Step 3: Implementar**

Criar `src/services/hardware.js`:

```js
const safe = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

export function createHardwareService({ si, ttlMs = 600_000 }) {
  let cache = null;
  let cachedAt = 0;

  async function load() {
    const [system, cpu, bios, baseboard, mem, memLayout, diskLayout, graphics] = await Promise.all([
      safe(() => si.system()),
      safe(() => si.cpu()),
      safe(() => si.bios()),
      safe(() => si.baseboard()),
      safe(() => si.mem()),
      safe(() => si.memLayout()),
      safe(() => si.diskLayout()),
      safe(() => si.graphics()),
    ]);
    return {
      system: system
        ? { manufacturer: system.manufacturer, model: system.model, version: system.version }
        : null,
      cpu: cpu
        ? {
            brand: cpu.brand,
            manufacturer: cpu.manufacturer,
            cores: cpu.cores,
            physicalCores: cpu.physicalCores,
            speedMax: cpu.speedMax,
          }
        : null,
      bios: bios ? { vendor: bios.vendor, version: bios.version, releaseDate: bios.releaseDate } : null,
      baseboard: baseboard
        ? {
            manufacturer: baseboard.manufacturer,
            model: baseboard.model,
            memMax: baseboard.memMax,
            memSlots: baseboard.memSlots,
          }
        : null,
      memory: mem
        ? {
            total: mem.total,
            modules: (memLayout ?? [])
              .filter((m) => m && m.size > 0)
              .map((m) => ({
                size: m.size,
                bank: m.bank,
                type: m.type,
                clockSpeed: m.clockSpeed,
                manufacturer: m.manufacturer ?? null,
              })),
          }
        : null,
      disks: (diskLayout ?? []).map((d) => ({
        name: d.name,
        size: d.size,
        type: d.type,
        interfaceType: d.interfaceType,
      })),
      graphics: (graphics?.controllers ?? []).map((g) => ({
        vendor: g.vendor,
        model: g.model,
        vram: g.vram,
      })),
    };
  }

  return {
    async get(nowMs = Date.now()) {
      if (cache && nowMs - cachedAt < ttlMs) return cache;
      cache = await load();
      cachedAt = nowMs;
      return cache;
    },
  };
}
```

`src/api/routes.js` — assinatura + rota (logo após a rota `/config/thresholds`):

```js
export function createApiRouter({ queries, writer, thresholdsPath, hardware }) {
```

```js
  router.get('/hardware', async (_req, res, next) => {
    try {
      res.json(await hardware.get());
    } catch (error) {
      next(error);
    }
  });
```

`src/app.js` — repassa `hardware`:

```js
export function createApp({ queries, writer, thresholdsPath, hardware }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ queries, writer, thresholdsPath, hardware }));
```

`src/server.js` — import e criação do serviço (import no topo junto dos demais):

```js
import { createHardwareService } from './services/hardware.js';
```

```js
const app = createApp({
  queries,
  writer,
  thresholdsPath: config.thresholdsPath,
  hardware: createHardwareService({ si }),
});
```

- [ ] **Step 4: Rodar e ver passar + gate**

Run: `npx vitest run test/services.test.js test/api.test.js`
Expected: PASS (3 hardware + 12 API).

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte PASS, lint limpo.

- [ ] **Step 5: Commit**

```powershell
git add src/services/hardware.js src/api/routes.js src/app.js src/server.js test/services.test.js test/api.test.js
git commit -m "feat: inventario de hardware via GET /api/hardware com cache de 10min"
```

---

### Task 7: Top processos — serviço + rota (A5)

**Files:**
- Create: `src/services/processes.js`
- Modify: `src/api/routes.js` (rota `GET /processes`; assinatura ganha `processes`)
- Modify: `src/app.js` e `src/server.js` (repassa/cria o serviço)
- Test: `test/services.test.js` (describe `processes`); `test/api.test.js` (1 teste de rota)

**Interfaces:**
- Produces: `createProcessesService({ si, ttlMs = 10_000, topN = 10 }) → { get(nowMs?) }` devolvendo
  `{ all, running, cpuTop: [{pid, name, cpu, mem, user}], memTop: [mesmo shape] }` (ordenados desc por `cpu` e `mem` — **%**). `GET /api/processes` devolve esse shape (consumido pela Task 12).

- [ ] **Step 1: Escrever os testes falhando**

Adicionar em `test/services.test.js` (novo describe, import novo no topo):

```js
import { createProcessesService } from '../src/services/processes.js';
```

```js
describe('processes service', () => {
  function fakeSi() {
    let chamadas = 0;
    const list = Array.from({ length: 15 }, (_, i) => ({
      pid: 100 + i,
      name: `proc-${i}`,
      cpu: (i % 7) * 10,
      mem: ((i * 13) % 9) * 5,
      user: 'user',
    }));
    return {
      get chamadas() {
        return chamadas;
      },
      processes: async () => {
        chamadas++;
        return { all: 15, running: 3, list };
      },
    };
  }

  it('devolve top 10 por CPU e top 10 por memória, ordenados desc', async () => {
    const service = createProcessesService({ si: fakeSi() });
    const out = await service.get(0);
    expect(out.all).toBe(15);
    expect(out.cpuTop.length).toBe(10);
    expect(out.memTop.length).toBe(10);
    expect(out.cpuTop[0].cpu).toBe(60);
    for (let i = 1; i < out.cpuTop.length; i++) {
      expect(out.cpuTop[i - 1].cpu).toBeGreaterThanOrEqual(out.cpuTop[i].cpu);
    }
    for (let i = 1; i < out.memTop.length; i++) {
      expect(out.memTop[i - 1].mem).toBeGreaterThanOrEqual(out.memTop[i].mem);
    }
    expect(out.cpuTop[0].name).toBeTypeOf('string');
  });

  it('cacheia por 10s: chamadas repetidas no intervalo não refazem a coleta', async () => {
    const si = fakeSi();
    const service = createProcessesService({ si, ttlMs: 10_000 });
    await service.get(0);
    await service.get(9_999);
    expect(si.chamadas).toBe(1);
    await service.get(10_001);
    expect(si.chamadas).toBe(2);
  });
});
```

Em `test/api.test.js`:

```js
  it('GET /api/processes devolve cpuTop e memTop do serviço', async () => {
    const fixture = { all: 1, running: 1, cpuTop: [{ pid: 1, name: 'x', cpu: 50, mem: 10, user: 'u' }], memTop: [] };
    const { app } = setup({ processes: { get: async () => fixture } });
    const res = await request(app).get('/api/processes');
    expect(res.status).toBe(200);
    expect(res.body.cpuTop[0].cpu).toBe(50);
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/services.test.js test/api.test.js`
Expected: FAIL — `Cannot find module '../src/services/processes.js'` e rota 404.

- [ ] **Step 3: Implementar**

Criar `src/services/processes.js`:

```js
export function createProcessesService({ si, ttlMs = 10_000, topN = 10 }) {
  let cache = null;
  let cachedAt = 0;

  return {
    async get(nowMs = Date.now()) {
      if (cache && nowMs - cachedAt < ttlMs) return cache;
      const data = await si.processes();
      const list = (data.list ?? []).map((p) => ({
        pid: p.pid,
        name: p.name || p.command || `PID ${p.pid}`,
        cpu: Number.isFinite(p.cpu) ? p.cpu : 0,
        mem: Number.isFinite(p.mem) ? p.mem : 0,
        user: p.user ?? '',
      }));
      cache = {
        all: data.all ?? list.length,
        running: data.running ?? 0,
        cpuTop: [...list].sort((a, b) => b.cpu - a.cpu).slice(0, topN),
        memTop: [...list].sort((a, b) => b.mem - a.mem).slice(0, topN),
      };
      cachedAt = nowMs;
      return cache;
    },
  };
}
```

`src/api/routes.js` — assinatura ganha `processes` e a rota (após `/hardware`):

```js
export function createApiRouter({ queries, writer, thresholdsPath, hardware, processes }) {
```

```js
  router.get('/processes', async (_req, res, next) => {
    try {
      res.json(await processes.get());
    } catch (error) {
      next(error);
    }
  });
```

`src/app.js` — repassa `processes` em `createApp` e `createApiRouter`.

`src/server.js` — import e uso:

```js
import { createProcessesService } from './services/processes.js';
```

```js
const app = createApp({
  queries,
  writer,
  thresholdsPath: config.thresholdsPath,
  hardware: createHardwareService({ si }),
  processes: createProcessesService({ si }),
});
```

- [ ] **Step 4: Rodar e ver passar + gate**

Run: `npx vitest run test/services.test.js test/api.test.js`
Expected: PASS (5 services + 13 API).

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte PASS, lint limpo.

- [ ] **Step 5: Commit**

```powershell
git add src/services/processes.js src/api/routes.js src/app.js src/server.js test/services.test.js test/api.test.js
git commit -m "feat: top 10 processos por CPU e memoria via GET /api/processes com cache 10s"
```

---

### Task 8: Saúde do Grafana — serviço + rota (B3)

**Files:**
- Create: `src/services/grafanaHealth.js`
- Modify: `src/api/routes.js` (rota `GET /health/grafana`; assinatura ganha `grafanaHealth`)
- Modify: `src/app.js` e `src/server.js`
- Test: `test/services.test.js` (describe `grafanaHealth`); `test/api.test.js` (1 teste de rota)

**Interfaces:**
- Consumes: `config.grafanaHealthUrl` (Task 1).
- Produces: `createGrafanaHealth({ url, fetchFn?, ttlMs = 15_000, timeoutMs = 2000 }) → { get(nowMs?) }` devolvendo `{ online: boolean }`. `GET /api/health/grafana` devolve esse shape (consumido pela Task 13).

- [ ] **Step 1: Escrever os testes falhando**

Adicionar em `test/services.test.js` (import no topo: `import { createGrafanaHealth } from '../src/services/grafanaHealth.js';`):

```js
describe('grafanaHealth service', () => {
  it('online quando o endpoint responde ok', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }));
    const service = createGrafanaHealth({ url: 'http://x/api/health', fetchFn });
    expect(await service.get(0)).toEqual({ online: true });
    expect(fetchFn).toHaveBeenCalledWith('http://x/api/health', expect.anything());
  });

  it('offline quando responde não-ok ou rejeita (container morto)', async () => {
    const rejeita = createGrafanaHealth({ url: 'http://x', fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
    expect(await rejeita.get(0)).toEqual({ online: false });
    const naoOk = createGrafanaHealth({ url: 'http://x', fetchFn: async () => ({ ok: false }) });
    expect(await naoOk.get(0)).toEqual({ online: false });
  });

  it('cacheia por 15s', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }));
    const service = createGrafanaHealth({ url: 'http://x', fetchFn, ttlMs: 15_000 });
    await service.get(0);
    await service.get(14_999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await service.get(15_001);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
```

Em `test/api.test.js`:

```js
  it('GET /api/health/grafana devolve online do serviço', async () => {
    const { app } = setup({ grafanaHealth: { get: async () => ({ online: true }) } });
    const res = await request(app).get('/api/health/grafana');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ online: true });
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/services.test.js test/api.test.js`
Expected: FAIL — módulo não existe e rota 404.

- [ ] **Step 3: Implementar**

Criar `src/services/grafanaHealth.js`:

```js
export function createGrafanaHealth({
  url,
  fetchFn = globalThis.fetch,
  ttlMs = 15_000,
  timeoutMs = 2000,
}) {
  let cache = null;
  let cachedAt = 0;

  return {
    async get(nowMs = Date.now()) {
      if (cache && nowMs - cachedAt < ttlMs) return cache;
      let online = false;
      try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
        online = res.ok === true;
      } catch {
        online = false;
      }
      cache = { online };
      cachedAt = nowMs;
      return cache;
    },
  };
}
```

`src/api/routes.js` — assinatura ganha `grafanaHealth`; rota (registrada **antes** de `/health` para evitar ambiguidade de leitura; caminhos são distintos, `/health` e `/health/grafana`):

```js
  router.get('/health/grafana', async (_req, res, next) => {
    try {
      res.json(await grafanaHealth.get());
    } catch (error) {
      next(error);
    }
  });
```

`src/app.js` — repassa `grafanaHealth` em `createApp` e `createApiRouter`.

`src/server.js` — import e uso:

```js
import { createGrafanaHealth } from './services/grafanaHealth.js';
```

```js
const app = createApp({
  queries,
  writer,
  thresholdsPath: config.thresholdsPath,
  hardware: createHardwareService({ si }),
  processes: createProcessesService({ si }),
  grafanaHealth: createGrafanaHealth({ url: config.grafanaHealthUrl }),
});
```

- [ ] **Step 4: Rodar e ver passar + gate**

Run: `npx vitest run test/services.test.js test/api.test.js`
Expected: PASS (8 services + 14 API).

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte PASS, lint limpo.

- [ ] **Step 5: Commit**

```powershell
git add src/services/grafanaHealth.js src/api/routes.js src/app.js src/server.js test/services.test.js test/api.test.js
git commit -m "feat: saude do Grafana via GET /api/health/grafana com cache 15s"
```

---

### Task 9: Export CSV (B1)

**Files:**
- Modify: `src/db/queries.js` (`iterateRange` — leitura em streaming)
- Modify: `src/api/routes.js` (rota `GET /export.csv` + helper `csvCell` + import de `once`)
- Test: `test/db.test.js` (1 teste); `test/api.test.js` (2 testes)

**Interfaces:**
- Consumes: `queries.iterateRange(fromSec, toSec)` (novo — iterator de better-sqlite3 sobre `ts, metric, value` no período, `ORDER BY ts ASC`).
- Produces: `GET /api/export.csv?from=&to=` → `200 text/csv` (`Content-Disposition: attachment`, header `ts,metric,value`) ou `400` em período inválido (consumido pela Task 13).

- [ ] **Step 1: Escrever os testes falhando**

Em `test/db.test.js`, no describe existente:

```js
  it('iterateRange percorre todo o período em ordem cronológica', () => {
    const db = openTemp();
    createWriter(db).insertBatch([
      { ts: 100, metric: 'cpu.total', value: 1 },
      { ts: 200, metric: 'cpu.total', value: 2 },
      { ts: 300, metric: 'mem.used', value: 3 },
      { ts: 400, metric: 'mem.used', value: 4 },
    ]);
    const rows = [...createQueries(db).iterateRange(150, 300)];
    expect(rows).toEqual([
      { ts: 200, metric: 'cpu.total', value: 2 },
      { ts: 300, metric: 'mem.used', value: 3 },
    ]);
    db.close();
  });
```

Em `test/api.test.js`:

```js
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/db.test.js test/api.test.js`
Expected: FAIL — `iterateRange is not a function` e rota `/export.csv` 404 (o 404 vem do middleware estático → status 404 sem `error` string).

- [ ] **Step 3: Implementar**

`src/db/queries.js` — statement novo (junto dos demais) e método no retorno:

```js
  const exportStmt = db.prepare(
    'SELECT ts, metric, value FROM samples WHERE ts >= ? AND ts <= ? ORDER BY ts ASC'
  );
```

```js
    iterateRange(fromSec, toSec) {
      return exportStmt.iterate(fromSec, toSec);
    },
```

`src/api/routes.js` — import no topo:

```js
import { once } from 'node:events';
```

helper após os imports (fora da factory):

```js
const csvCell = (v) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
```

rota (após `/metrics/:metric`):

```js
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
```

- [ ] **Step 4: Rodar e ver passar + gate**

Run: `npx vitest run test/db.test.js test/api.test.js`
Expected: PASS (10 db + 16 API).

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte PASS, lint limpo.

- [ ] **Step 5: Commit**

```powershell
git add src/db/queries.js src/api/routes.js test/db.test.js test/api.test.js
git commit -m "feat: export CSV em formato longo via GET /api/export.csv com streaming"
```

### Task 10: Tema claro/escuro (A3)

**Files:**
- Modify: `src/web/public/index.html` (CSS: paletas; HTML: botão toggle; script: anti-flash + toggle)

**Interfaces:**
- Produces: `document.documentElement.dataset.theme` (`'light' | 'dark'`), `localStorage['guidepc2-theme']`, botão `#theme-toggle`. Demais tasks frontend assumem o sistema de variáveis com as duas paletas.

Sem teste unitário (padrão do repo: frontend é verificado por gate + QA visual na Task 16).

- [ ] **Step 1: Separar as paletas no CSS**

Em `src/web/public/index.html`, **substituir** o bloco `:root { ... }` inteiro (linhas 9-24, o tema dark atual) por:

```css
    :root {
      color-scheme: light;
      --bg: #f4f6f9;
      --panel: #ffffff;
      --line: #dfe4ec;
      --text: #17202b;
      --muted: #4a5462;
      --faint: #5b6673;
      --ok: #12734a;
      --warn: #8a5a00;
      --crit: #c92a2a;
      --accent: #14548c;
      --accent-hover: #0f426f;
      --meter-track: #e6eaf0;
      --flash: rgba(20, 84, 140, 0.10);
      --verdict-crit: #b3261e;
      --verdict-warn: #7a5200;
      --sb-thumb: #c3cad6;
      --sb-thumb-hover: #a7b1c0;
      --selection: rgba(20, 84, 140, 0.25);
      --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
    }

    [data-theme='dark'] {
      color-scheme: dark;
      --bg: #0e1116;
      --panel: #141a22;
      --line: #232b36;
      --text: #e9eef5;
      --muted: #96a1b0;
      --faint: #848f9d;
      --ok: #5ecb8b;
      --warn: #e8b84a;
      --crit: #ef6b6b;
      --accent: #9cc7f0;
      --accent-hover: #c3ddfa;
      --meter-track: #222a35;
      --flash: rgba(156, 199, 240, 0.14);
      --verdict-crit: #ffb4b4;
      --verdict-warn: #f5d993;
      --sb-thumb: #2c3542;
      --sb-thumb-hover: #3a4553;
      --selection: rgba(156, 199, 240, 0.28);
      --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
    }
```

- [ ] **Step 2: Trocar as cores hardcoded por variáveis**

No mesmo arquivo, substituir:

- `::-webkit-scrollbar-thumb { background: #2c3542; ... }` → `background: var(--sb-thumb);`
- `::-webkit-scrollbar-thumb:hover { background: #3a4553; }` → `background: var(--sb-thumb-hover);`
- `::selection { background: rgba(156, 199, 240, 0.28); ... }` → `background: var(--selection);`
- `a:hover { color: #c3ddfa; }` → `color: var(--accent-hover);`
- `.verdict.is-crit h2 { color: #ffb4b4; }` → `color: var(--verdict-crit);`
- `.verdict.is-warn h2 { color: #f5d993; }` → `color: var(--verdict-warn);`

- [ ] **Step 3: Script anti-flash no `<head>`**

Inserir logo **antes** da tag `<style>` (linha 8):

```html
  <script>
    (function () {
      var t = null;
      try { t = localStorage.getItem('guidepc2-theme'); } catch (e) { t = null; }
      if (t !== 'light' && t !== 'dark') {
        t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      document.documentElement.dataset.theme = t;
    })();
  </script>
```

- [ ] **Step 4: Botão toggle no HTML + CSS**

No `<header class="topbar">`, envolver o freshness e adicionar o botão (substituir as linhas 318-321):

```html
      <div class="topbar-right">
        <div class="freshness" id="freshness" role="status">
          <span class="dot" aria-hidden="true"></span>
          <span id="freshness-text">Conectando ao coletor…</span>
        </div>
        <button id="theme-toggle" class="theme-toggle" type="button" aria-pressed="false" aria-label="Alternar entre tema claro e escuro">
          <svg class="icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"></circle>
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>
          </svg>
          <svg class="icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>
          </svg>
        </button>
      </div>
```

CSS (adicionar após o bloco `.freshness.is-error .dot`):

```css
    .topbar-right {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .theme-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      padding: 0;
      background: var(--panel);
      color: var(--muted);
      border: 1px solid var(--line);
      border-radius: 9px;
      cursor: pointer;
      transition: color 0.2s var(--ease-out), border-color 0.2s var(--ease-out);
    }
    .theme-toggle:hover { color: var(--accent); border-color: var(--accent); }
    .theme-toggle .icon-moon { display: none; }
    [data-theme='dark'] .theme-toggle .icon-sun { display: none; }
    [data-theme='dark'] .theme-toggle .icon-moon { display: block; }
```

- [ ] **Step 5: JS do toggle**

No `<script>` do final, adicionar (logo após a linha com `const el = (id) => ...`):

```js
    const themeToggle = el('theme-toggle');
    function syncThemeButton() {
      const dark = document.documentElement.dataset.theme === 'dark';
      themeToggle.setAttribute('aria-pressed', String(dark));
      themeToggle.setAttribute(
        'aria-label',
        dark ? 'Tema escuro ativo. Clique para o tema claro' : 'Tema claro ativo. Clique para o tema escuro'
      );
    }
    themeToggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('guidepc2-theme', next);
      } catch (e) {
        /* armazenamento indisponível — tema vale só nesta aba */
      }
      syncThemeButton();
    });
    syncThemeButton();
```

- [ ] **Step 6: Gate**

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte PASS, lint limpo. (Visual: QA na Task 16 — checar light/dark sem flash e contraste AA.)

- [ ] **Step 7: Commit**

```powershell
git add src/web/public/index.html
git commit -m "feat: tema claro/escuro com toggle, localStorage e prefers-color-scheme"
```

---

### Task 11: Sparklines nos vitais (A4)

**Files:**
- Modify: `src/web/public/index.html` (CSS `.spark`; template do `vitalCard`; JS de carregamento)

**Interfaces:**
- Consumes: `GET /api/metrics/:metric?from=&to=` (existente), `state.lastItems` (novo, populado pelo `refresh`).
- Produces: `state.sparks: { [metricKey]: string }` (atributo `d` do path SVG), timers `sparkTimer`.

- [ ] **Step 1: CSS do sparkline**

Adicionar após o bloco `.meter .fill.is-crit`:

```css
    .vital .spark {
      display: block;
      width: 100%;
      height: 28px;
      margin-top: 12px;
    }
    .vital .spark path {
      fill: none;
      stroke: var(--accent);
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
    }
```

- [ ] **Step 2: Estado + helper de path**

No `<script>`, trocar a linha do `state` por:

```js
    const state = {
      lastFetch: null,
      timer: null,
      ageTimer: null,
      sparkTimer: null,
      errored: false,
      sparks: {},
      lastItems: [],
    };
    const SPARK_MS = 60000;
    const SPARK_WINDOW_SEC = 3600;
```

Adicionar as funções (antes de `renderVitals`):

```js
    function sparkPath(points) {
      if (!points || points.length < 2) return null;
      const w = 100;
      const h = 28;
      let min = Infinity;
      let max = -Infinity;
      for (const p of points) {
        if (p.value < min) min = p.value;
        if (p.value > max) max = p.value;
      }
      if (max === min) max = min + 1;
      const step = Math.max(1, Math.ceil(points.length / 120));
      const sampled = points.filter((_, i) => i % step === 0 || i === points.length - 1);
      return sampled
        .map((p, i) => {
          const x = (i / (sampled.length - 1)) * w;
          const y = h - ((p.value - min) / (max - min)) * h;
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
    }

    async function refreshSparks() {
      const now = Math.floor(Date.now() / 1000);
      const keys = state.lastItems.map((i) => i.key);
      await Promise.all(
        keys.map(async (key) => {
          try {
            const res = await fetch(
              `/api/metrics/${encodeURIComponent(key)}?from=${now - SPARK_WINDOW_SEC}&to=${now + 1}`,
              { cache: 'no-store' }
            );
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const d = sparkPath(data.points);
            if (!d) return;
            state.sparks[key] = d;
            for (const card of document.querySelectorAll('.vital')) {
              if (card.dataset.key === key) {
                const svg = card.querySelector('.spark');
                if (svg) {
                  svg.querySelector('path').setAttribute('d', d);
                  svg.hidden = false;
                }
              }
            }
          } catch {
            /* mantém o último path conhecido */
          }
        })
      );
    }
```

- [ ] **Step 3: Template do vitalCard**

No retorno de `vitalCard`, **adicionar** o svg após o `</div>` do `.meter` (antes do fechamento do template):

```js
      const spark = state.sparks[item.key];
      return `
        <article class="vital${changed ? ' is-flash' : ''}" data-key="${item.key}">
          <p class="label">${t.label}${item.labelSuffix ?? ''}</p>
          <p class="reading">${fmt(item.value)}<span class="unit">${unit}</span></p>
          <p class="note">${note}</p>
          <div class="meter" role="presentation">
            <span class="fill${item.level === 'warn' ? ' is-warn' : item.level === 'crit' ? ' is-crit' : ''}" style="width:${meterPct}%"></span>
          </div>
          <svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"${spark ? '' : ' hidden'}><path d="${spark ?? ''}"></path></svg>
        </article>`;
```

(A função `vitalCard` hoje monta `return \`...\`` direto — reestruturar para `const spark = ...; return \`...\`` com a linha do spark incluída.)

- [ ] **Step 4: Popular lastItems + timers de boot**

Em `refresh()`, após `renderSide(values);` adicionar:

```js
        state.lastItems = items;
```

No boot (junto dos `setInterval` existentes), trocar o bloco final por:

```js
    refresh().then(() => refreshSparks());
    state.timer = setInterval(refresh, POLL_MS);
    state.ageTimer = setInterval(renderFreshness, 1000);
    state.sparkTimer = setInterval(refreshSparks, SPARK_MS);
```

- [ ] **Step 5: Gate**

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte PASS, lint limpo. (Visual: QA na Task 16 — sparklines visíveis nos 4 vitais, sem histórico → oculto.)

- [ ] **Step 6: Commit**

```powershell
git add src/web/public/index.html
git commit -m "feat: sparklines SVG de 1h nos vitais via /api/metrics com refresh 60s"
```

### Task 12: Seções novas — hardware, bateria, processos, alertas (A1/A2/A5/B2 UI)

**Files:**
- Modify: `src/web/public/index.html` (CSS das seções; HTML após `.details`; JS de carga)

**Interfaces:**
- Consumes: `GET /api/hardware` (Task 6), `GET /api/processes` (Task 7), `GET /api/alerts?limit=10` (Task 5), `/api/latest` com `battery.pct`/`battery.charging` (Task 3).
- Produces: painéis `#hardware-panel`, `#battery-panel`, `#processes-panel`, `#alerts-panel` (começam `hidden`, aparecem após o primeiro fetch).

- [ ] **Step 1: CSS das seções**

Adicionar após o bloco `.datarow .detail`:

```css
    .info-panel {
      padding: 26px 22px;
      border-bottom: 1px solid var(--line);
    }
    .info-panel h3 {
      margin: 0 0 4px;
      font-size: 0.95rem;
      font-weight: 650;
    }
    .info-panel .sub {
      margin: 0 0 16px;
      color: var(--faint);
      font-size: 0.8rem;
    }
    .info-panel .empty {
      margin: 0;
      color: var(--muted);
      font-size: 0.85rem;
    }
    .hw-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 14px 24px;
    }
    .hw-item .k {
      color: var(--faint);
      font-size: 0.75rem;
      margin-bottom: 2px;
    }
    .hw-item .v {
      color: var(--text);
      font-size: 0.88rem;
      word-break: break-word;
    }
    .battery-row { max-width: 420px; }
    .battery-row .reading {
      margin: 0 0 8px;
      font-size: clamp(1.6rem, 3vw, 2rem);
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .proc-columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      min-width: 0;
    }
    .proc-col h4 {
      margin: 0 0 12px;
      font-size: 0.85rem;
      font-weight: 650;
      color: var(--muted);
    }
    .alert-badge {
      font-size: 0.72rem;
      font-weight: 650;
      padding: 2px 8px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .alert-badge.is-firing { background: rgba(239, 107, 107, 0.16); color: var(--crit); }
    .alert-badge.is-resolved { background: rgba(94, 203, 139, 0.16); color: var(--ok); }
    @media (max-width: 860px) {
      .proc-columns { grid-template-columns: 1fr; }
    }
```

- [ ] **Step 2: HTML das seções**

Inserir **apois** o fechamento de `<section class="details">` (linha 342) e **antes** do `<footer>`:

```html
    <section class="info-panel" id="hardware-panel" hidden>
      <h3>Meu computador</h3>
      <p class="sub">Equipamento identificado — atualiza a cada 10 minutos</p>
      <div class="hw-grid" id="hw-grid"></div>
    </section>

    <section class="info-panel" id="battery-panel" hidden>
      <h3>Bateria</h3>
      <p class="sub" id="battery-sub">Situação da bateria agora</p>
      <div class="battery-row">
        <p class="reading" id="battery-reading">—</p>
        <div class="meter" role="presentation">
          <span class="fill" id="battery-fill"></span>
        </div>
      </div>
    </section>

    <section class="info-panel" id="processes-panel" hidden>
      <h3>O que está usando seu PC</h3>
      <p class="sub">Processos que mais consomem agora — atualiza a cada 10 segundos</p>
      <div class="proc-columns">
        <div class="proc-col">
          <h4>Processador</h4>
          <div class="rows" id="proc-cpu"></div>
        </div>
        <div class="proc-col">
          <h4>Memória</h4>
          <div class="rows" id="proc-mem"></div>
        </div>
      </div>
    </section>

    <section class="info-panel" id="alerts-panel" hidden>
      <h3>Histórico de alertas</h3>
      <p class="sub">Últimos alertas do sistema — até 7 dias de histórico</p>
      <div class="rows" id="alerts-rows"></div>
    </section>
```

- [ ] **Step 3: JS — helpers e hardware**

No `<script>`, adicionar após `renderSide` (antes de `renderFreshness`):

```js
    function escapeHtml(s) {
      return String(s).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
      );
    }

    function fmtBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;
      const gb = bytes / 1024 ** 3;
      if (gb >= 1024) return fmt(gb / 1024) + ' TB';
      if (gb >= 0.1) return fmt(gb) + ' GB';
      return fmt(bytes / 1024 ** 2) + ' MB';
    }

    const PROC_MS = 10000;
    const ALERTS_MS = 30000;
    const HW_MS = 600000;

    function hwItem(label, value) {
      if (value === null || value === undefined || value === '') return '';
      return `<div class="hw-item"><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(value)}</div></div>`;
    }

    async function refreshHardware() {
      try {
        const res = await fetch('/api/hardware', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const hw = await res.json();
        const items = [];
        if (hw.system) {
          items.push(hwItem('Fabricante', hw.system.manufacturer));
          items.push(hwItem('Modelo', hw.system.model));
          items.push(hwItem('Versão', hw.system.version));
        }
        if (hw.cpu) {
          items.push(hwItem('Processador', hw.cpu.brand));
          items.push(hwItem('Núcleos', `${hw.cpu.physicalCores} físicos / ${hw.cpu.cores} lógicos`));
          items.push(hwItem('Frequência máxima', hw.cpu.speedMax ? `${hw.cpu.speedMax} GHz` : null));
        }
        if (hw.memory) {
          items.push(hwItem('Memória total', fmtBytes(hw.memory.total)));
          hw.memory.modules.forEach((m, i) => {
            const detalhes = [fmtBytes(m.size), m.type, m.clockSpeed ? `${m.clockSpeed} MHz` : null]
              .filter(Boolean)
              .join(' · ');
            items.push(hwItem(`Módulo ${m.bank || i + 1}`, detalhes));
          });
        }
        if (hw.bios) {
          items.push(hwItem('BIOS', [hw.bios.vendor, hw.bios.version].filter(Boolean).join(' ')));
          items.push(hwItem('BIOS lançada em', hw.bios.releaseDate));
        }
        if (hw.baseboard) {
          items.push(hwItem('Placa-mãe', [hw.baseboard.manufacturer, hw.baseboard.model].filter(Boolean).join(' ')));
        }
        hw.disks.forEach((d) => {
          const detalhes = [fmtBytes(d.size), d.type, d.interfaceType].filter(Boolean).join(' · ');
          items.push(hwItem(d.name || 'Disco', detalhes));
        });
        hw.graphics.forEach((g) => {
          const nome = [g.vendor, g.model].filter(Boolean).join(' ');
          items.push(hwItem('Placa de vídeo', nome + (g.vram ? ` · ${g.vram} MB` : '')));
        });
        const html = items.filter(Boolean).join('');
        el('hw-grid').innerHTML =
          html || '<div class="hw-item"><div class="v">Não consegui identificar as peças deste computador.</div></div>';
        el('hardware-panel').hidden = false;
      } catch {
        el('hw-grid').innerHTML =
          '<div class="hw-item"><div class="v">Não consegui ler o inventário do hardware agora.</div></div>';
        el('hardware-panel').hidden = false;
      }
    }
```

- [ ] **Step 4: JS — bateria (dentro do refresh) e processos/alertas**

Adicionar `renderBattery` (chamar dentro de `refresh()`, logo após `renderSide(values);` — junto do `state.lastItems`):

```js
    function renderBattery(values) {
      const panel = el('battery-panel');
      const pct = values['battery.pct'];
      if (typeof pct !== 'number') {
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
      const charging = values['battery.charging'] === 1;
      el('battery-reading').textContent = `${fmt(pct)}%`;
      el('battery-sub').textContent = charging
        ? 'Carregando agora — ligada na tomada'
        : 'Sem carregador — rodando na bateria';
      const fill = el('battery-fill');
      fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      fill.className = 'fill' + (pct <= 15 ? ' is-crit' : pct <= 30 ? ' is-warn' : '');
    }
```

Adicionar após `refreshHardware`:

```js
    function procRow(p, kind) {
      const value = kind === 'cpu' ? p.cpu : p.mem;
      const lvl = value >= 90 ? ' is-crit' : value >= 70 ? ' is-warn' : '';
      return `
        <div class="datarow">
          <div class="row"><span class="name">${escapeHtml(p.name)}</span><span>${fmt(value)}%</span></div>
          <div class="meter"><span class="fill${lvl}" style="width:${Math.min(100, Math.max(0, value))}%"></span></div>
          <div class="row"><span class="detail">PID ${p.pid}</span><span class="detail">${escapeHtml(p.user || '—')}</span></div>
        </div>`;
    }

    async function refreshProcesses() {
      try {
        const res = await fetch('/api/processes', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        el('proc-cpu').innerHTML =
          data.cpuTop.map((p) => procRow(p, 'cpu')).join('') ||
          '<p class="empty">Nenhum processo para mostrar.</p>';
        el('proc-mem').innerHTML =
          data.memTop.map((p) => procRow(p, 'mem')).join('') ||
          '<p class="empty">Nenhum processo para mostrar.</p>';
        el('processes-panel').hidden = false;
      } catch {
        el('proc-cpu').innerHTML = '<p class="empty">Não consegui listar os processos agora.</p>';
        el('processes-panel').hidden = false;
      }
    }

    const alertDateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

    async function refreshAlerts() {
      try {
        const res = await fetch('/api/alerts?limit=10', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const rows = (data.alerts ?? []).map((a) => {
          const firing = a.state === 'firing';
          return `
            <div class="datarow">
              <div class="row">
                <span class="name">${escapeHtml(a.alertname)}</span>
                <span class="alert-badge ${firing ? 'is-firing' : 'is-resolved'}">${firing ? 'Disparado' : 'Resolvido'}</span>
              </div>
              <div class="row">
                <span class="detail">${alertDateFmt.format(new Date(a.ts * 1000))}</span>
                <span class="detail">${typeof a.value === 'number' ? fmt(a.value) : ''}</span>
              </div>
            </div>`;
        });
        el('alerts-rows').innerHTML =
          rows.join('') ||
          '<p class="empty">Nenhum alerta nos últimos 7 dias. Tudo tranquilo por aqui.</p>';
        el('alerts-panel').hidden = false;
      } catch {
        el('alerts-rows').innerHTML = '<p class="empty">Não consegui carregar o histórico de alertas agora.</p>';
        el('alerts-panel').hidden = false;
      }
    }
```

- [ ] **Step 5: Boot — timers**

No boot do script (junto dos `setInterval` existentes), adicionar:

```js
    refreshProcesses();
    refreshAlerts();
    refreshHardware();
    state.procTimer = setInterval(refreshProcesses, PROC_MS);
    state.alertsTimer = setInterval(refreshAlerts, ALERTS_MS);
    state.hwTimer = setInterval(refreshHardware, HW_MS);
```

(e adicionar `procTimer: null, alertsTimer: null, hwTimer: null` ao objeto `state` da Task 11).

- [ ] **Step 6: Gate**

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte PASS, lint limpo. (Visual: QA na Task 16 — 4 painéis, bateria some em desktop, processos ordenados, alerta vazio mostra mensagem amigável.)

- [ ] **Step 7: Commit**

```powershell
git add src/web/public/index.html
git commit -m "feat: secoes de hardware, bateria, processos e historico de alertas na pagina"
```

---

### Task 13: Rodapé — chip do Grafana, CSV e thresholds via API (B3/B1/B4 UI)

**Files:**
- Modify: `src/web/public/index.html` (footer HTML; CSS do chip; JS: `loadThresholds`, `refreshGrafanaChip`, `refreshCsvLink`)

**Interfaces:**
- Consumes: `GET /api/config/thresholds` (Task 2 — shape `{ cpu: {warn, crit}, mem: {...}, disk: {...} }`), `GET /api/health/grafana` (Task 8 — `{ online }`), `GET /api/export.csv` (Task 9).
- Produces: `THRESHOLDS` passa a ser alimentado pela API (fallback = defaults embutidos já existentes); chip `#grafana-chip`; link `#csv-link` com janela de 7 dias.

- [ ] **Step 1: HTML do footer**

Substituir o `<footer class="footer">` (linhas 344-350) por:

```html
    <footer class="footer">
      <div class="footer-status">
        <span>Coleta a cada 5 segundos · histórico de 7 dias</span>
        <span class="grafana-chip" id="grafana-chip" role="status">Verificando gráficos…</span>
      </div>
      <nav class="links">
        <a href="http://localhost:3000/d/guidepc2-cpu" target="_blank" rel="noopener">Gráficos detalhados (Grafana)</a>
        <a href="/api/latest">Ver dados crus (API)</a>
        <a href="/api/export.csv" id="csv-link" download>Baixar dados (CSV)</a>
      </nav>
    </footer>
```

CSS (adicionar junto do bloco `.footer .links`):

```css
    .footer-status {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
    }
    .grafana-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.78rem;
      padding: 3px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--muted);
      white-space: nowrap;
    }
    .grafana-chip::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
    }
    .grafana-chip.is-online { color: var(--ok); }
    .grafana-chip.is-offline { color: var(--warn); }
```

- [ ] **Step 2: JS — thresholds via API**

Adicionar (antes do `refresh()` de boot):

```js
    async function loadThresholds() {
      try {
        const res = await fetch('/api/config/thresholds', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const t = await res.json();
        const apply = (key, entry) => {
          if (entry && Number.isFinite(entry.warn) && Number.isFinite(entry.crit)) {
            THRESHOLDS[key].warn = entry.warn;
            THRESHOLDS[key].crit = entry.crit;
          }
        };
        apply('cpu.total', t.cpu);
        apply('mem.used', t.mem);
        apply('disk.usage', t.disk);
      } catch {
        /* mantém os defaults embutidos */
      }
    }
```

- [ ] **Step 3: JS — chip do Grafana + CSV**

Adicionar:

```js
    const GRAFANA_MS = 30000;

    function refreshCsvLink() {
      const now = Math.floor(Date.now() / 1000);
      el('csv-link').href = `/api/export.csv?from=${now - 7 * 86400}&to=${now + 1}`;
    }

    async function refreshGrafanaChip() {
      const chip = el('grafana-chip');
      try {
        const res = await fetch('/api/health/grafana', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (data.online) {
          chip.textContent = 'Gráficos: online';
          chip.className = 'grafana-chip is-online';
        } else {
          chip.textContent = 'Gráficos offline — rode "docker compose up -d"';
          chip.className = 'grafana-chip is-offline';
        }
      } catch {
        chip.textContent = 'Gráficos: sem resposta';
        chip.className = 'grafana-chip is-offline';
      }
      refreshCsvLink();
    }
```

- [ ] **Step 4: Boot — thresholds antes do primeiro refresh**

Trocar o bloco de boot final por:

```js
    loadThresholds().finally(() => {
      refresh().then(() => refreshSparks());
    });
    state.timer = setInterval(refresh, POLL_MS);
    state.ageTimer = setInterval(renderFreshness, 1000);
    state.sparkTimer = setInterval(refreshSparks, SPARK_MS);
    state.grafanaTimer = setInterval(refreshGrafanaChip, GRAFANA_MS);
    refreshGrafanaChip();
    refreshProcesses();
    refreshAlerts();
    refreshHardware();
    state.procTimer = setInterval(refreshProcesses, PROC_MS);
    state.alertsTimer = setInterval(refreshAlerts, ALERTS_MS);
    state.hwTimer = setInterval(refreshHardware, HW_MS);
```

(Adicionar `grafanaTimer: null` ao objeto `state`. Se a Task 12 já adicionou os outros timers, consolidar neste único bloco de boot.)

- [ ] **Step 5: Gate**

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte PASS, lint limpo. (Visual: QA na Task 16.)

- [ ] **Step 6: Commit**

```powershell
git add src/web/public/index.html
git commit -m "feat: chip de saude do Grafana, download CSV de 7 dias e thresholds via API"
```

### Task 14: Painéis de bateria no Grafana (A2)

**Files:**
- Modify: `grafana/provisioning/dashboards/memory.json` (3 painéis novos via script Node — preserva UTF-8)

**Interfaces:**
- Consumes: métricas `battery.pct` e `battery.charging` (Task 3), data source `guidepc2-metrics` (existente).

- [ ] **Step 1: Script de patch dos painéis**

Criar `tmp-patch-memory.mjs` (descartável, removido no fim):

```js
import fs from 'node:fs';

const path = 'grafana/provisioning/dashboards/memory.json';
const dashboard = JSON.parse(fs.readFileSync(path, 'utf8'));
const datasource = { type: 'frser-sqlite-datasource', uid: 'guidepc2-metrics' };
const target = (metric) => ({
  refId: 'A',
  queryType: 'table',
  datasource,
  rawQueryText: `SELECT ts, value FROM samples WHERE metric = '${metric}' AND ts >= $__from / 1000 AND ts < $__to / 1000 ORDER BY ts ASC`,
  queryText: `SELECT ts, value FROM samples WHERE metric = '${metric}' AND ts >= $__from / 1000 AND ts < $__to / 1000 ORDER BY ts ASC`,
  timeColumns: ['ts'],
});

const paineis = [
  {
    id: 8,
    type: 'stat',
    title: 'Bateria',
    datasource,
    gridPos: { h: 6, w: 6, x: 0, y: 24 },
    targets: [target('battery.pct')],
    fieldConfig: {
      defaults: {
        unit: 'percent',
        min: 0,
        max: 100,
        mappings: [],
        thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: 15 }] },
        noValue: 'Não disponível',
      },
      overrides: [],
    },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      colorMode: 'value',
      graphMode: 'area',
      textMode: 'auto',
    },
  },
  {
    id: 9,
    type: 'stat',
    title: 'Carregando',
    datasource,
    gridPos: { h: 6, w: 6, x: 6, y: 24 },
    targets: [target('battery.charging')],
    fieldConfig: {
      defaults: {
        unit: 'short',
        mappings: [
          {
            type: 'value',
            options: {
              '0': { text: 'Usando bateria', color: 'blue', index: 0 },
              '1': { text: 'Carregando', color: 'green', index: 1 },
            },
          },
        ],
        noValue: 'Não disponível',
      },
      overrides: [],
    },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      colorMode: 'none',
      graphMode: 'none',
      textMode: 'value',
    },
  },
  {
    id: 10,
    type: 'timeseries',
    title: 'Bateria (%)',
    datasource,
    gridPos: { h: 6, w: 12, x: 12, y: 24 },
    targets: [target('battery.pct')],
    fieldConfig: {
      defaults: {
        unit: 'percent',
        min: 0,
        max: 100,
        mappings: [],
        custom: { drawStyle: 'line', lineWidth: 1, fillOpacity: 10, showPoints: 'auto', spanNulls: true },
      },
      overrides: [],
    },
    options: {
      legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
      tooltip: { mode: 'multi', sort: 'desc' },
    },
  },
];

const jaTem = dashboard.panels.some((p) => p.title === 'Bateria');
if (!jaTem) dashboard.panels.push(...paineis);
dashboard.version = (dashboard.version ?? 1) + 1;
fs.writeFileSync(path, JSON.stringify(dashboard, null, 2), 'utf8');
console.log(`painéis: ${dashboard.panels.length}`);
```

- [ ] **Step 2: Rodar o script e validar**

Run: `node tmp-patch-memory.mjs`
Expected: `painéis: 10`

Run: `node --input-type=module -e 'import fs from "node:fs"; const d = JSON.parse(fs.readFileSync("grafana/provisioning/dashboards/memory.json", "utf8")); if (d.panels.length !== 10) throw new Error("painéis errados"); if (!d.panels.some((p) => p.title === "Bateria")) throw new Error("sem painel Bateria"); console.log("json ok");'`
Expected: `json ok`

Run: `Remove-Item tmp-patch-memory.mjs`

- [ ] **Step 3: Recarregar o Grafana (se estiver rodando)**

Run: `docker compose ps`
Se o container `grafana` estiver ativo: `docker compose restart grafana` e conferir em `http://localhost:3000/d/guidepc2-memory` que os painéis "Bateria" e "Carregando" aparecem (em desktop mostram **"Não disponível"** — é o esperado).
Se o Docker não estiver rodando, seguir (o provisionamento aplica no próximo `docker compose up -d`).

- [ ] **Step 4: Commit**

```powershell
git add grafana/provisioning/dashboards/memory.json
git commit -m "feat: paineis de bateria (pct, carregando, serie) no dashboard Memoria"
```

---

### Task 15: Documentação (README, PRODUCT.md, specs)

**Files:**
- Modify: `README.md` (§4 métricas, §7 config, §9 API, §11 manual, §10 limitações)
- Modify: `PRODUCT.md` (capacidades)
- Modify: `docs/superpowers/specs/2026-10-05-guidepc2-design.md` (contrato do webhook + API somente leitura)
- Modify: `docs/superpowers/specs/2026-10-05-pacotes-ab-design.md` (status → implementado)

**Interfaces:**
- Consome tudo das Tasks 1-14; nenhuma mudança de código.

- [ ] **Step 1: README — Referência da API (§9)**

Na tabela de rotas, **atualizar** a linha do webhook e **adicionar**:

| Método | Rota | Retorno |
|---|---|---|
| `POST` | `/api/alerts/webhook` | receiver do Grafana: valida `payload.alerts[]` e **grava** cada alerta em `alerts` via writer → `{ ok, saved }`; payload sem `alerts[]`/JSON inválido → `400` (não grava) |
| `GET` | `/api/alerts?limit=` | `{ alerts: [{ ts, alertname, state, value }] }` — ts DESC, `limit` default 20, min 1, max 200 |
| `GET` | `/api/hardware` | inventário (system/cpu/bios/baseboard/memória+módulos/discos/GPU); cache 10 min; falha parcial vira `null` |
| `GET` | `/api/processes` | `{ all, running, cpuTop[10], memTop[10] }` (% de CPU/memória por processo); cache 10 s |
| `GET` | `/api/health/grafana` | `{ online: boolean }` — proxy do `/api/health` do Grafana (timeout 2 s, cache 15 s) |
| `GET` | `/api/export.csv?from=&to=` | CSV longo `ts,metric,value` (streaming, anexo); padrão última hora; período inválido → `400` |
| `GET` | `/api/config/thresholds` | `{ cpu/mem/disk: { warn, crit } }` — merge de `config/thresholds.json` sobre os defaults (70/90, 75/90, 70/85) |

- [ ] **Step 2: README — Métricas (§4) e Configuração (§7)**

§4 — adicionar linhas na tabela:

| Dashboard | Métrica | Unidade | Origem | Windows |
|---|---|---|---|---|
| Memória | `battery.pct` | % | `si.battery()` | ⚠️ só notebooks |
| Memória | `battery.charging` | 0/1 | `si.battery()` | ⚠️ só notebooks |

§7 — adicionar na tabela de env vars:

| Variável | Default | O que faz |
|---|---|---|
| `HOST` | `0.0.0.0` | Interface do Express. Use `HOST=127.0.0.1` quando **não** usar Docker — o webhook do Grafana (dentro do container) precisa alcançar o host via `host.docker.internal`, e não alcança `127.0.0.1` do host. |
| `THRESHOLDS_PATH` | `config/thresholds.json` | Arquivo de thresholds da **página**. Editar o arquivo não reinicia o servidor (lido por request). |
| `GRAFANA_HEALTH_URL` | `http://localhost:3000/api/health` | Endpoint checado por `/api/health/grafana`. |

§7 — **nova subseção "Espelho de thresholds"** (logo após a tabela de env vars):

> **Espelho manual de thresholds.** A **página** lê `config/thresholds.json`; os **alertas do Grafana** vivem em `grafana/provisioning/alerting/alerts.yml` (provisionado, sem hot-reload — mudar exige editar o YAML e reiniciar o Grafana). São propósitos diferentes: página = aviso visual leigo; Grafana = alerta formal.
>
> | O quê | Página (`config/thresholds.json`) | Alerta Grafana (`alerts.yml`) |
> |---|---|---|
> | CPU | warn 70 / crit 90 | dispara > 90 por 2 min |
> | Memória | warn 75 / crit 90 | dispara > 90 por 5 min |
> | Disco | warn 70 / crit 85 | dispara > 85 por 5 min |
>
> Ao mudar um lado, atualize o outro manualmente.

- [ ] **Step 3: README — Manual do Operador (§11)**

Em §11.2 (ler a página resumo), adicionar as linhas novas na tabela de elementos:

| Elemento | O que significa |
|---|---|
| **Tema claro/escuro** (ícone no topo) | Alterna o visual; a preferência fica salva no navegador. Na primeira visita segue o tema do Windows. |
| **Meu computador** | Peças identificadas (processador, memória, discos, BIOS, placa de vídeo). Atualiza a cada 10 minutos. |
| **Bateria** (só notebooks) | `%` e se está carregando; barra fica âmbar < 30% e vermelha ≤ 15%. |
| **O que está usando seu PC** | Top 10 processos por CPU e por memória, a cada 10 segundos — é por aqui que se acha o "pesadelo" que deixa o PC lento. |
| **Histórico de alertas** | Últimos alertas disparados (7 dias); "Disparado" = ativo, "Resolvido" = encerrado. |
| **Gráficos: online/offline** (rodapé) | Saúde do Grafana. Offline → `docker compose up -d`. |
| **Baixar dados (CSV)** (rodapé) | Gera um CSV com as métricas dos últimos 7 dias (formato `ts,metric,value`). |

Em §11.8 (Segurança), adicionar: "Para uso sem Docker, rode `HOST=127.0.0.1 npm start` — as portas ficam só na sua máquina; com Docker (webhook do Grafana), mantenha o default."

- [ ] **Step 4: README — limitações (§10)**

Adicionar como item 6: "Os thresholds da página (`config/thresholds.json`) e os alertas do Grafana (`alerts.yml`) não são a mesma fonte — veja o espelho na §7."

- [ ] **Step 5: PRODUCT.md**

Em "Capabilities and Constraints", adicionar bullets:

- Seções da página: inventário de hardware, bateria (notebooks), top 10 processos, histórico de alertas (7 dias), chip de saúde do Grafana, export CSV.
- Tema claro/escuro com preferência persistida.
- `GET /api/config/thresholds` como fonte dos limiares da página.

- [ ] **Step 6: Specs**

Em `docs/superpowers/specs/2026-10-05-guidepc2-design.md`:
- Linha 54 ("A API REST é somente leitura"): trocar por "A API REST só escreve pelo webhook de alertas (que grava na tabela `alerts` via `writer.js`); nenhuma rota GET escreve."
- Linha 101 (rota do webhook): trocar "apenas loga o payload e retorna 200 (não escreve no banco)" por "valida `payload.alerts[]`, **grava** em `alerts` via writer e retorna `{ ok, saved }` (JSON inválido ou sem alertas → 400)".

Em `docs/superpowers/specs/2026-10-05-pacotes-ab-design.md`:
- `Status: aprovado pelo usuário (design em chat; escopo A+B)` → `Status: implementado (Pacotes A+B) — ver plano docs/superpowers/plans/2026-10-05-pacotes-ab.md`.

- [ ] **Step 7: Gate + Commit**

Run: `npm test; if ($?) { npm run lint }`
Expected: PASS (docs não afetam, mas é o gate do repo).

```powershell
git add README.md PRODUCT.md docs/superpowers/specs/2026-10-05-guidepc2-design.md docs/superpowers/specs/2026-10-05-pacotes-ab-design.md
git commit -m "docs: rotas, envs, espelho de thresholds, manual das secoes novas e status da spec"
```

---

### Task 16: QA visual + gates finais

**Files:**
- Modify: `src/web/public/index.html` (apenas se o QA apontar problemas)
- Nenhum arquivo novo.

**Interfaces:**
- Consome: servidor rodando com as Tasks 1-15 aplicadas.

- [ ] **Step 1: Subir o servidor em background**

```powershell
$log = Start-Process -FilePath node -ArgumentList 'src/server.js' -WorkingDirectory (Get-Location) -RedirectStandardOutput server-qa.log -RedirectStandardError server-qa.err -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
Invoke-RestMethod http://localhost:3001/api/health
```

Expected: JSON `{ status: 'ok', ... }`. Se `EADDRINUSE`, matar o processo antigo (`Get-NetTCPConnection -LocalPort 3001 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ }`) e repetir.

- [ ] **Step 2: QA visual com subagente `visual-qa`**

Dispatch do subagente `visual-qa` com: URL `http://localhost:3001`, e instruções de checar:
1. **Tema light** (default): tipografia, contraste AA dos textos principais, veredito e barras legíveis, sem overflow horizontal.
2. **Tema dark**: clicar no `#theme-toggle` e repetir a checagem; confirmar que não há flash estranho ao recarregar (tema persistido).
3. **Desktop (~1280px)** e **~500px**: grid dos vitais, seções novas (hardware/processos/alertas), footer.
4. Estados: painéis de hardware/processos/alertas renderizando dados reais; chip do Grafana coerente (offline se Docker parado = esperado); bateria **ausente** (desktop) — a seção não deve aparecer.
5. Sparklines nos 4 vitais.

- [ ] **Step 3: Corrigir achados**

Para cada achado crítico/médio do relatório: corrigir no `index.html`, revalidar. Achados cosméticos leves podem ser registrados sem corrigir.

- [ ] **Step 4: Gates finais**

Run: `npm test; if ($?) { npm run lint }`
Expected: suíte completa PASS (21 originais + novos) e lint zero erros.

- [ ] **Step 5: Parar o servidor e commitar correções (se houver)**

```powershell
Stop-Process -Id $log.Id
Remove-Item server-qa.log, server-qa.err -ErrorAction SilentlyContinue
git add -A
git commit -m "fix: correcoes apontadas pelo QA visual (tema, secoes, footer)"
```

(Se o QA não apontar nada, pular o commit e registrar "sem achados".)

---

## Self-Review do Plano

- **Spec coverage (11 critérios):** 1 → Task 6; 2 → Tasks 3+12+14; 3 → Task 10; 4 → Task 11; 5 → Task 7+12; 6 → Task 9; 7 → Tasks 4+5+12; 8 → Tasks 8+13; 9 → Tasks 2+13; 10 → Task 1; 11 → Tasks 15-16. ✓
- **Placeholders:** nenhum TBD/TODO; todo step tem código ou comando. ✓
- **Type consistency:** `readThresholds` / `parseAlerts` / `insertAlerts` / `listAlerts` / `iterateRange` / `createHardwareService.get` / `createProcessesService.get` / `createGrafanaHealth.get` com os mesmos nomes e shapes nas tasks de teste, implementação e frontend. ✓
- **Limitações da spec:** espelho de thresholds documentado (Task 15); `battery.charging` 0/1 (Tasks 3+14); CSV longo (Task 9). ✓

