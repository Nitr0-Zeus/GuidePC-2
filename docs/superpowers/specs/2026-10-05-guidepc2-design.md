# GuidePC 2 — Dashboard de Monitoramento de Sistema

Data: 2026-10-05
Status: aprovado pelo usuário

## Objetivo

Aplicação de coleta de métricas de sistema em tempo real (Node.js + Express +
systeminformation + SQLite) que alimenta dashboards interativos no Grafana para
apoiar decisões operacionais, com uma página resumo leve servida pelo próprio
Express.

## Escopo da primeira versão

- **4 dashboards** no Grafana com **~12 métricas** (escolha do usuário):
  CPU, Memória, Disco, Rede.
- Coleta a cada **5s**, retenção de **7 dias** com limpeza automática diária.
- **Grafana via Docker** (Docker Desktop já presente na máquina), app Node
  rodando direto no Windows local.
- **Página resumo leve** no Express (valores atuais via `/api/latest`, polling
  de 5s) além dos dashboards do Grafana.
- **Alertas no Grafana** (unified alerting provisionado) com thresholds:
  CPU > 90%, Memória > 90%, Disco > 85%.

## Fora de escopo (YAGNI)

- App web próprio com histórico em tempo real (WebSocket).
- Infraestrutura para múltiplos hosts / agentes remotos.
- Autenticação customizada (Grafana usa login padrão).
- Notificações por e-mail/Slack (contact point fica configurável, não
  configurado).

## Arquitetura

```
[coletor every 5s] → systeminformation → db/writer.js (único escritor, WAL)
                                              ↓
                                     data/metrics.db
                                       ↙          ↘
                    Express (API read-only +     Grafana (Docker)
                    página resumo)               volume do .db montado :ro
                                                 data source SQLite (provisionado)
                                                 4 dashboards + alertas (provisionados)
```

### Regra central (explícita, definida pelo usuário)

**O processo Node é o único responsável por escrever em `metrics.db`.**
Nenhum outro componente grava no arquivo:

- Todo `INSERT`/`DELETE` passa exclusivamente por `src/db/writer.js`.
- O volume do Grafana é montado **somente leitura** (`:ro` no docker-compose);
  o data source SQLite do Grafana abre o arquivo em modo read-only.
- A API REST só escreve pelo webhook de alertas (que grava na tabela `alerts`
  via `writer.js`); nenhuma rota GET escreve.

## Camada de dados

Biblioteca: **better-sqlite3** (síncrono, binários pré-compilados no Windows).

```sql
CREATE TABLE IF NOT EXISTS samples (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,          -- epoch seconds (exigência do plugin SQLite do Grafana)
  metric TEXT    NOT NULL,          -- ex.: 'cpu.total', 'net.rx.eth0'
  value  REAL    NOT NULL
);
```

- Formato normalizado (uma linha por amostra/métrica).
- `idx_samples_metric_ts` atende as consultas dos painéis (métrica + período).
- `idx_samples_ts` atende filtros de tempo puro e a limpeza de retenção.
- PRAGMAs no startup: `journal_mode=WAL`, `busy_timeout=5000`,
  `synchronous=NORMAL`.

### Retenção

Job diário: `DELETE FROM samples WHERE ts < ?` (7 dias) +
`PRAGMA incremental_vacuum`.

## Métricas (12+)

| Dashboard | Métricas | Origem (systeminformation) |
|---|---|---|
| CPU | `cpu.total` (%), `cpu.core.N` (% por núcleo), `cpu.load.1/5/15`, `cpu.temp` | `currentLoad`, `os.loadavg()` (omitido no Windows), `cpuTemperature` |
| Memória | `mem.used` (%), `mem.available` (GB), `mem.swap` (%), `mem.cached` (GB) | `mem` |
| Disco | `disk.usage.<vol>` (%), `disk.free.<vol>` (GB), `disk.read`/`disk.write` (MB/s) | `fsSize`; `fsStats` (só Linux/macOS — omitido no Windows) |
| Rede | `net.rx.<iface>` / `net.tx.<iface>` (KB/s, delta entre amostras), `net.conns.established`, `net.errors` | `networkStats`, `networkConnections` |

- Métricas indisponíveis no host (ex.: temperatura em VM) são **omitidas**
  silenciosamente; os painéis toleram série vazia.
- Coletor falha em um ciclo não derruba o scheduler (try/catch por coleta,
  log de erro, próxima execução segue).

## API (leitura; única escrita pelo webhook de alertas)

| Rota | Resposta |
|---|---|
| `GET /api/health` | `{ status, uptime, lastCollectionAt, metricsCount }` |
| `GET /api/latest` | `{ ts, values: { "cpu.total": 12.3, ... } }` |
| `GET /api/metrics/:metric?from=&to=` | `{ metric, points: [{ ts, value }] }` |
| `POST /api/alerts/webhook` | receiver dos alertas do Grafana — valida `payload.alerts[]`, **grava** em `alerts` via writer e retorna `{ ok, saved }` (JSON inválido ou sem alertas → 400) |

## Página resumo leve

- `GET /` — HTML/JS estático servido por Express (`src/web/public/`).
- Consome `/api/latest` em polling de 5s; cards para CPU, Memória, Disco,
  Rede + status do coletor.
- Sem framework frontend (vanilla HTML/CSS/JS).

## Docker + Grafana

`docker-compose.yml` com um serviço:

- `grafana/grafana:latest`, porta `3000:3000`, com o plugin
  **`frser-sqlite-datasource`** instalado via `GF_INSTALL_PLUGINS`.
- Volume: `./data:/data:ro` (**diretório**, não o arquivo isolado — assim o
  Grafana também enxerga `metrics.db-wal`/`-shm`; o SQLite ≥ 3.22 lê um banco
  WAL em read-only quando `-shm`/`-wal` existem e são legíveis — caso em que o
  Node está rodando).
- Provisionamento montado de `./grafana/provisioning/`.
- Limitação documentada: se o processo Node parar, o `-shm` some e o Grafana
  não consegue reabrir o banco — subir o Node primeiro resolve.

### Provisionamento Grafana

1. **Data source** `sqlite.yml` → tipo `frser-sqlite-datasource`,
   `jsonData.path: /data/metrics.db` (o plugin acrescenta
   `_pragma=query_only(1)` por padrão — reforço da regra de escrita única).
2. **4 dashboards JSON** (CPU, Memória, Disco, Rede). O plugin **não** tem
   `$timeFilter`; o filtro de período é
   `ts >= $__from / 1000 AND ts < $__to / 1000`. Séries com nomes dinâmicos
   (`cpu.core.N`, `disk.usage.<vol>`, `net.rx.<iface>`) usam **variáveis de
   dashboard** (`$core`, `$mount`, `$iface`) populadas por
   `SELECT DISTINCT metric FROM samples WHERE metric LIKE '...'`.
3. **Alertas unificados**: regras provisionadas com thresholds
   (CPU > 90%, RAM > 90%, disco > 85%) e contact point webhook apontando para
   `POST /api/alerts/webhook` (via `host.docker.internal`).

## Estrutura do projeto

```
GuidePC2/
├── package.json / eslint.config.js / .gitignore
├── src/
│   ├── server.js            # bootstrap Express + coletor + retenção
│   ├── app.js               # factory do app Express (testável)
│   ├── config.js            # portas, intervalo, retenção (env)
│   ├── collector/
│   │   ├── index.js         # scheduler de 5s com try/catch
│   │   └── metrics.js       # definicoes: nome → coletor systeminformation
│   ├── db/
│   │   ├── index.js         # conexão, PRAGMAs, schema
│   │   ├── writer.js        # ÚNICO ponto de escrita (insertBatch, purge)
│   │   └── queries.js       # leituras usadas pela API
│   ├── api/routes.js        # rotas GET + webhook POST (grava alerts)
│   └── web/public/          # index.html da página resumo
├── data/metrics.db          # gitignored
├── docker-compose.yml
├── grafana/provisioning/
│   ├── datasources/sqlite.yml
│   ├── dashboards/{cpu,memory,disk,network}.json
│   └── alerting/alerts.yml
└── test/                    # vitest + supertest
```

## Testes e verificação

- **Unitários (vitest):** normalização do coletor (mock de
  `systeminformation`), writer (insert/purge), queries da API.
- **Integração (supertest):** rotas da API com banco temporário.
- **Verificação manual:** `npm run lint`, `npm test`,
  `docker compose up -d` → dashboards e alertas provisionados,
  página resumo validada com a skill `visual-qa`.

## Critérios de aceite

1. Coleta roda a cada 5s e grava em `data/metrics.db` (WAL) — único escritor.
2. Grafana sobe via docker-compose com o `.db` montado `:ro` e mostra os
   4 dashboards com dados.
3. Alertas provisionados aparecem ativos no Grafana.
4. `/api/latest` e `/api/health` respondem com dados frescos; página resumo
   atualiza sozinha.
5. Retenção remove amostras > 7 dias.
6. `npm test` e `npm run lint` passam.
