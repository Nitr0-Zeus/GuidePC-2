# GuidePC 2

Monitoramento de sistema em tempo real para a sua máquina Windows: um processo
Node coleta métricas do computador a cada 5 segundos, grava em SQLite local e
alimenta **4 dashboards interativos no Grafana** + uma **página resumo em
linguagem simples**, com **alertas automáticos** para CPU, memória e disco.

Tudo roda **100% local** — nenhum dado sai do seu computador.

- **Página resumo:** http://localhost:3001/
- **Grafana:** http://localhost:3000/ (login `admin` / `guidepc2`)
- **Stack:** Node.js 22 · Express 5 · systeminformation · better-sqlite3 ·
  Grafana 13 (Docker)

---

## Sumário

1. [Arquitetura](#1-arquitetura)
2. [Tecnologias e por que cada uma](#2-tecnologias-e-por-que-cada-uma)
3. [Como funciona cada implementação](#3-como-funciona-cada-implementação)
4. [Métricas coletadas](#4-métricas-coletadas)
5. [Estrutura do projeto](#5-estrutura-do-projeto)
6. [Como rodar](#6-como-rodar)
7. [Configuração](#7-configuração)
8. [Testes e lint](#8-testes-e-lint)
9. [Referência da API](#9-referência-da-api)
10. [Limitações conhecidas](#10-limitações-conhecidas)
11. **[Manual do Operador](#11-manual-do-operador)**

---

## 1. Arquitetura

```
┌────────────────────────── processo Node (único escritor) ──────────────────────────┐
│                                                                                    │
│  systeminformation ──► coletor (5s) ──► db/writer.js ──► data/metrics.db (WAL)      │
│         ▲                                  │                     │                 │
│         │ ciclos com try/catch             │ INSERT/DELETE       │ leitura         │
│  scheduler (intervalo, sem sobreposição)   ▼                     ▼                 │
│                                src/api/routes.js        Grafana (Docker)           │
│                                Express :3001            container                  │
│                                  │                       ./data:/data:ro           │
│                                  ▼                       plugin frser-sqlite       │
│                          página resumo (HTML)           dashboards + alertas       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Regra central (não negociável):** o processo Node é o **único** que escreve
em `data/metrics.db`. Todo `INSERT`/`DELETE` passa exclusivamente por
`src/db/writer.js`. O Grafana monta a pasta `data/` como **somente leitura**
(`:ro`) e o plugin SQLite abre o arquivo com `_pragma=query_only(1)` — dupla
garantia de que ninguém além do coletor escreve no banco.

Por que o volume é montado como **diretório** e não só o arquivo: o SQLite em
modo WAL usa os arquivos `metrics.db-wal` e `metrics.db-shm` ao lado do banco;
sem eles visíveis, um leitor não consegue abrir o banco (regra do SQLite ≥
3.22: leitura de WAL em read-only funciona quando `-wal`/`-shm` existem e são
legíveis — é o caso enquanto o Node está rodando). **Por isso o Node deve
subir antes do Grafana.**

## 2. Tecnologias e por que cada uma

| Tecnologia | Versão | Papel | Por que |
|---|---|---|---|
| **Node.js** | ≥ 20 (testado em 22.18) | Runtime do coletor e da API | Ecossistema JS completo; roda como processo único de longa duração |
| **Express** | 5.2.1 | Servidor HTTP | Minimalista; serve a API somente-leitura e a página resumo (HTML estático) |
| **systeminformation** | 5.33.15 | Coleta de métricas de hardware/SO | Sem dependências nativas, multiplataforma, cobre CPU, memória, disco e rede |
| **better-sqlite3** | 13.0.3 | Banco SQLite | API síncrona (sem callback hell nas gravações), binários pré-compilados no Windows, transações embutidas |
| **SQLite (modo WAL)** | embutido | Persistência | Write-Ahead Logging permite leitor (Grafana) e escritor (Node) simultâneos sem bloqueio |
| **Grafana** | 13 (imagem `latest`) | Dashboards e alertas | Visualização de séries temporais madura, provisionamento por arquivo, unified alerting |
| **Plugin `frser-sqlite-datasource`** | instalado via `GF_INSTALL_PLUGINS` | Data source SQLite no Grafana | Plugin oficial de backend que lê SQLite direto do filesystem, com macros de tempo e suporte a alertas |
| **Docker Compose** | — | Orquestra o Grafana | Isola o Grafana, permite montar o banco como `:ro` e versionar todo o provisionamento |
| **vitest + supertest** | 5 / 7 | Testes | Testes unitários rápidos das camadas de dados/coletor + integração da API |
| **ESLint** | 10 (flat config) | Lint | Padrão moderno, zero configuração de arquivos antigos |

### Por que SQLite e não outra coisa?

O requisito era ter o banco local, sem servidor. SQLite atende com um arquivo
só; o Grafana lê o mesmo arquivo por volume — **não existe nenhuma API de
escrita para o Grafana usar**, o que torna a regra "escritor único" física
(volume `:ro`) e não apenas de convenção de código.

## 3. Como funciona cada implementação

### 3.1 Coletor (`src/collector/`)

- `metrics.js` — `collectMetrics(si, state, nowMs)` executa as consultas do
  `systeminformation` e normaliza tudo para uma lista plana
  `{ metric, value }`. Cada bloco tem `try/catch` próprio: **métrica que
  falha é omitida** (nunca gravada como 0), sem derrubar as demais.
- `index.js` — `createCollector(...)` agenda um ciclo a cada `intervalMs`
  (5s) com **guarda de sobreposição**: se o ciclo anterior ainda rodava (no
  Windows `networkStats` demora ~5s na primeira chamada), o novo é ignorado.
  Falhas de escrita vão para `onError` (log), nunca derrubam o scheduler.
- **Taxas de rede** são calculadas por **delta** entre amostras
  (`rx_bytes`/`tx_bytes` ÷ tempo), em KB/s. A primeira amostra não tem taxa
  (sem base de comparação) e é omitida; se o contador reiniciar, a taxa vira
  0 em vez de negativa.
- **`net.errors`** é a soma absoluta de erros + drops de todas as interfaces
  (acumulado desde o boot, uma única métrica global).

### 3.2 Camada de dados (`src/db/`)

- `index.js` — `openDatabase(path)`: cria o diretório, abre com
  `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`,
  `auto_vacuum=INCREMENTAL` e aplica o schema:

```sql
CREATE TABLE IF NOT EXISTS samples (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,   -- epoch em SEGUNDOS (exigência do plugin Grafana)
  metric TEXT    NOT NULL,   -- ex.: 'cpu.total', 'net.rx.Ethernet'
  value  REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_ts        ON samples(ts);          -- filtro de tempo puro + retenção
CREATE INDEX IF NOT EXISTS idx_samples_metric_ts ON samples(metric, ts);  -- consultas dos painéis
```

- `writer.js` — **o único ponto de escrita do projeto.** `insertBatch(rows)`
  roda tudo numa transação; `purgeOlderThan(cutoff)` apaga amostras antigas e
  dispara `incremental_vacuum` quando apaga algo.
- `queries.js` — leituras para a API: `latest()` (último valor por métrica
  numa janela), `range()` (série de uma métrica no período, com limite
  superior **inclusivo**), `maxTs()` e `countRecent()`.

**Retenção:** uma vez por dia o `server.js` calcula
`agora − 7 dias` e chama `purgeOlderThan`. Amostras de8 dias somem sozinhas;
o banco fica estável em ~tens de MB.

### 3.3 API (`src/api/routes.js`)

Somente leitura (a única rota POST é o receiver de alertas, que apenas loga o
payload — não toca no banco). Detalhes em [Referência da API](#9-referência-da-api).

### 3.4 Página resumo (`src/web/public/index.html`)

HTML/CSS/JS puro, servido pelo Express. Público-alvo: **usuário leigo** —
linguagem simples, sem jargão (o nome técnico da métrica aparece só como
referência secundária em fonte mono). Fluxo:

1. Busca `/api/latest` a cada 5s (polling) e mostra a **idade da leitura**
   ("Atualizado há Ns") com um ponto colorido.
2. Monta o **veredito** em frase: verde ("Seu PC está funcionando bem."),
   âmbar ("Memória: uso um pouco alto (88,8%).") ou vermelho
   ("Atenção: memória está no limite (92%).") — lógica e thresholds em
   `THRESHOLDS` no próprio arquivo.
3. Renderiza 4 **vitais** (Processador, Memória, Disco pior volume, Rede) com
   medidor colorido, depois **núcleos da CPU**, **volumes de disco** e
   **interfaces de rede** em detalhes.
4. Estados de falha: "Não consegui falar com o coletor" + dica de `npm start`.

### 3.5 Grafana provisionado (`grafana/provisioning/`)

Tudo declarado em arquivo — nada configurado à mão na UI:

- **`datasources/sqlite.yml`** — data source `guidepc2-metrics`
  (tipo `frser-sqlite-datasource`, `path: /data/metrics.db`, padrão,
  não editável).
- **`dashboards/provider.yml`** — carrega os JSONs da pasta numa pasta de
  dashboards chamada "GuidePC 2", com **polling de 15s** (o file-watch do
  Grafana não recebe eventos de bind-mount no Windows/Docker Desktop).
- **`dashboards/*.json`** — os 4 dashboards (CPU, Memória, Disco, Rede),
  refresh 5s. Cada painel executa SQL direto na tabela `samples`:

```sql
SELECT ts, value FROM samples
WHERE metric = 'cpu.total'
  AND ts >= $__from / 1000 AND ts < $__to / 1000   -- plugin não tem $timeFilter
ORDER BY ts ASC
```

  Séries com nomes dinâmicos usam **variáveis de dashboard** populadas por
  `SELECT DISTINCT substr(metric, N) ...`: `$core` (núcleos), `$mount`
  (volumes), `$iface` (interfaces). Painéis `stat` trazem
  `noValue: "Não disponível"` para quando a métrica não existe no host.

- **`alerting/alerts.yml`** — 3 regras de unified alerting:

| Regra | Condição | `for` | Query |
|---|---|---|---|
| `guidepc2-cpu-high` | média/redução de `cpu.total` > 90 | 2 min | série → `reduce LAST` → `threshold gt 90` |
| `guidepc2-mem-high` | `mem.used` > 90 | 5 min | idem, 90 |
| `guidepc2-disk-high` | `MAX(disk.usage.%)` > 85 | 5 min | `GROUP BY ts` → reduce → 85 |

  Todas com `noDataState: OK` / `execErrState: OK` (banco parado não gera
  alerta falso). Queries B/C (expressões) carregam
  `datasourceUid: __expr__` e `relativeTimeRange` — exigências do Grafana 13.

- **`alerting/notifications.yml`** — contact point `guidepc2-log` (webhook
  para `http://host.docker.internal:3001/api/alerts/webhook`) e policy
  agrupando por `alertname`.

### 3.6 Bootstrap (`src/server.js`)

Abre o banco → roda a retenção na largada → inicia o coletor → sobe o Express
na porta 3001 → `SIGINT/SIGTERM` param coletor, timer de retenção e fecham o
banco com elegância.

## 4. Métricas coletadas

~27 a39 métricas por ciclo nesta máquina (16 núcleos, 2 volumes, 6 interfaces):

| Dashboard | Métrica | Unidade | Origem | Windows |
|---|---|---|---|---|
| CPU | `cpu.total` | % | `currentLoad()` | ✅ |
| CPU | `cpu.core.N` | % | `currentLoad().cpus` | ✅ |
| CPU | `cpu.load.1/5/15` | load | `os.loadavg()` | ❌ omitido |
| CPU | `cpu.temp` | °C | `cpuTemperature()` | ⚠️ se houver sensor |
| Memória | `mem.used` | % | `mem().active/total` | ✅ |
| Memória | `mem.available` | GB | `mem().available` | ✅ |
| Memória | `mem.swap` | % | `swapused/swaptotal` | ✅ |
| Memória | `mem.cached` | GB | `mem().buffcache` | ✅ |
| Disco | `disk.usage.<vol>` | % | `fsSize().use` | ✅ |
| Disco | `disk.free.<vol>` | GB | `fsSize().available` | ✅ |
| Disco | `disk.read` / `disk.write` | MB/s | `fsStats()` | ❌ omitido |
| Rede | `net.rx.<iface>` / `net.tx.<iface>` | KB/s | delta de `networkStats()` | ✅ |
| Rede | `net.conns.established` | nº | `networkConnections()` | ✅ |
| Rede | `net.errors` | nº | soma de erros/drops | ✅ |

❌ = omitido (nunca vira 0 falso). Isso é intencional: melhor "sem dado" dado
inventado.

## 5. Estrutura do projeto

```
GuidePC2/
├── README.md                    # este arquivo (explicação + manual do operador)
├── PRODUCT.md                   # verdade do produto (contexto de design)
├── package.json                 # scripts: start / dev / test / lint
├── eslint.config.js
├── docker-compose.yml           # Grafana + plugin + volumes :ro
├── src/
│   ├── server.js                # bootstrap: banco + retenção + coletor + Express
│   ├── app.js                   # factory do app (testável)
│   ├── config.js                # PORT, INTERVAL_MS, RETENTION_DAYS, DB_PATH (env)
│   ├── collector/
│   │   ├── index.js             # scheduler de 5s com guarda de sobreposição
│   │   └── metrics.js           # definições e normalização das métricas
│   ├── db/
│   │   ├── index.js             # conexão, PRAGMAs, schema, índices
│   │   ├── writer.js            # ÚNICO ponto de escrita
│   │   └── queries.js           # leituras da API
│   ├── api/routes.js            # GET health/latest/metrics + POST webhook
│   └── web/public/              # página resumo (index.html + favicon.svg)
├── data/                        # metrics.db (+ -wal/-shm) — gitignored
├── grafana/provisioning/
│   ├── datasources/sqlite.yml
│   ├── dashboards/provider.yml + {cpu,memory,disk,network}.json
│   └── alerting/{alerts,notifications}.yml
├── test/                        # vitest: smoke, db, collector, api (21 testes)
└── docs/superpowers/
    ├── specs/2026-10-05-guidepc2-design.md   # spec de design
    └── plans/2026-10-05-guidepc2.md          # plano de implementação (8 tasks)
```

## 6. Como rodar

**Pré-requisitos:** Node.js ≥ 20, Docker Desktop instalado **e rodando**.

```powershell
# 1) Terminal A — sobe o coletor e a API (IMPORTANTE: este primeiro!)
cd C:\Users\User\Desktop\GuidePC2
npm start            # esperar até "GuidePC 2 em http://localhost:3001"

# 2) Terminal B — só depois, sobe o Grafana
docker compose up -d  # primeira vez baixa a imagem + instala o plugin (~1-2 min)

# 3) Abrir no navegador
#    Página resumo: http://localhost:3001/
#    Grafana:       http://localhost:3000/   (admin / guidepc2)
```

**Por essa ordem?** O Grafana só consegue abrir o banco em modo read-only se
os arquivos `-wal`/`-shm` existirem — e quem os cria é o Node. Node parado =
dashboards do Grafana sem conexão (veja [tratamento](#82-grafana-falha-ao-ler-o-banco)).

```powershell
docker compose down     # para o Grafana (o Node continua)
# Ctrl+C no terminal A  # para o Node
docker compose logs -f  # acompanha logs do Grafana
```

## 7. Configuração

Variáveis de ambiente (todas opcionais, com default em `src/config.js`):

| Variável | Default | O que faz |
|---|---|---|
| `PORT` | `3001` | Porta do Express |
| `METRICS_INTERVAL_MS` | `5000` | Intervalo de coleta (ms) |
| `RETENTION_DAYS` | `7` | Dias de histórico mantidos |
| `DB_PATH` | `./data/metrics.db` | Caminho do banco |

Grafana: credenciais e portas estão em `docker-compose.yml`
(`GF_SECURITY_ADMIN_USER/PASSWORD`). Para expor em rede, **troque a senha
antes** — as portas estão em `0.0.0.0`.

## 8. Testes e lint

```powershell
npm test        # 21 testes: smoke, camada de dados, coletor (mock), API (supertest)
npm run lint    # ESLint 10 flat config — zero erros
```

Os testes usam bancos temporários em `%TEMP%` e mocks do `systeminformation`
— não tocam no `data/metrics.db` real.

### 8.1 Problemas comuns ao desenvolver

| Sintoma | Causa provável | Ação |
|---|---|---|
| `npm test` falha com `EBUSY ... metrics.db` | teste anterior não fechou o banco | os helpers de teste fecham sozinhos; rode de novo |
| `EADDRINUSE :3001` | processo antigo ainda vivo | `Get-NetTCPConnection -LocalPort 3001` → `Stop-Process -Id <pid>` |
| Lint aponta `tmp-*.cjs` | scripts descartáveis | `Remove-Item tmp-*` |

### 8.2 Grafana falha ao ler o banco

Sintoma: painéis vazios / `attempt to write a readonly database` /
`unable to open database file` nos logs.

1. O Node está rodando? (`curl http://localhost:3001/api/health`)
2. Existem `data/metrics.db-wal` e `data/metrics.db-shm`?
3. Reinicie na ordem: `Ctrl+C` no Node → `docker compose restart grafana` →
   `npm start`.
4. Logs: `docker compose logs grafana | findstr /i error`

## 9. Referência da API

Base: `http://localhost:3001`

| Método | Rota | Retorno |
|---|---|---|
| `GET` | `/api/health` | `{ status, uptime, lastCollectionAt, metricsCount }` |
| `GET` | `/api/latest` | `{ ts, values: { "cpu.total": 61.9, ... } }` |
| `GET` | `/api/metrics/:metric?from=&to=` | `{ metric, points: [{ ts, value }] }` — époche **segundos**, `from`/`to` inclusivos, padrão última 1h; período inválido → `400` |
| `POST` | `/api/alerts/webhook` | receiver dos alertas do Grafana: loga o JSON e devolve `{ ok: true }`; JSON inválido → `400` |

Exemplos:

```powershell
curl http://localhost:3001/api/health
curl "http://localhost:3001/api/metrics/cpu.total?from=1791200000&to=1791240000"
```

## 10. Limitações conhecidas

1. **Windows não expõe** load average (`cpu.load.*`) nem I/O de disco
   (`disk.read/write`) — esses painéis mostram "Não disponível". Temperatura
   depende de sensor (pode vir `null` → omitida).
2. **Um host, um banco** — não há agente remoto; monitorar outra máquina
   exigiria novo projeto.
3. **Separador decimal misto** em alguns painéis do Grafana (89.7% vs 1,17 GiB)
   — comportamento de locale do Grafana, cosmético.
4. **Sparkline do "Livre (C:)"** cruza o valor no stat do dashboard Disco —
   cosmético, conhecido.
5. **Leitura exige Node vivo** — parar o Node derruba a leitura do Grafana
   (WAL sem `-shm`). É o trade-off da regra de escritor único.

---

# 11. Manual do Operador

> Para quem **usa** o GuidePC 2 no dia a dia — não precisa saber programar.

## 11.1 Ligar o sistema (ordem importa)

1. Confira se o **Docker Desktop** está aberto (ícone na bandeja).
2. Abra o terminal na pasta do projeto e rode **`npm start`**.
   - Confira a mensagem: `GuidePC 2 em http://localhost:3001`
   - Deixe este terminal aberto (fechar = parar a coleta).
3. Em outro terminal: **`docker compose up -d`**.
4. Pronto. Abrir:
   - **Resumo** → http://localhost:3001/  ← comece por aqui
   - **Gráficos** → http://localhost:3000/ (`admin` / `guidepc2`)

> ⚠️ Se inverter a ordem (Grafana antes do Node), os painéis ficam vazios até
> você reiniciar o Grafana: `docker compose restart grafana`.

## 11.2 Ler a página resumo

A página responde, em linguagem simples, **"meu PC está bem?"**:

| Elemento | O que significa |
|---|---|
| **Veredito grande no topo** | Frase única: verde = tudo bem · âmbar = algo alto mas dá para trabalhar · vermelho = algo no limite, aja |
| **"Atualizado há Ns"** (canto) | Idade da última leitura. Até ~10s é normal. "Sem resposta" = coletor parado |
| **4 indicadores** | Processador, Memória, Disco (pior volume), Rede — valor + barra colorida |
| **Processador por núcleo** | Se só 1–2 núcleos estão em 100% sempre, algo específico está sugando a CPU |
| **Discos e rede** | Uso/livre de cada volume e tráfego por interface |

**Cores das barras:** verde < limite de atenção · âmbar = atenção ·
vermelho = no limite.

## 11.3 Usar os dashboards do Grafana

1. Entre com `admin` / `guidepc2`.
2. Pasta **"GuidePC 2"** → CPU, Memória, Disco, Rede (refresh automático 5s).
3. Úteis em todos:
   - **Seletor de tempo** (canto superior direito): `Last 15 minutes` para
     "o que está acontecendo agora"; `Last 7 days` para tendências.
   - **Variáveis** no topo: `$core` (núcleo da CPU), `$mount` (volume do
     disco), `$iface` (interface de rede).
   - Passe o mouse nos gráficos para ver valores exatos; clique na legenda
     para isolar uma série.

## 11.4 Alertas — o que fazer quando um disparar

Os alertas ficam em **Alerting → Alert rules** (pasta "GuidePC 2"). Quando
disparam, chegam ao webhook e aparecem no log do terminal do Node como
`[alerta Grafana] {...}`.

| Alerta | Limite | Antes de agir, verifique | Ação sugerida |
|---|---|---|---|
| **CPU > 90%** por 2 min | processador saturado | Painel CPU → *Núcleo*: é tudo ou um núcleo? | Feche pesadelos (aba/programa). Se persiste com o PC ocioso, escaneie antivírus/malware |
| **Memória > 90%** por 5 min | RAM no fim | Painel Memória → *Disponível* | Feche programas grandes (navegadores com muitas abas). Se recorrente, é hora de mais RAM |
| **Disco > 85%** por 5 min | volume quase cheio | Painel Disco → qual `$mount` | Limpe downloads/temp, rode a Limpeza de Disco do Windows. **Este PC tem o volume D: pequeno** — priorize ele |

Enquanto o sistema estiver com tudo abaixo do limite, **nenhum alerta deve
existir** — se aparecer alerta sem motivo, veja [11.5](#115-solução-de-problemas).

## 11.5 Solução de problemas

| Sintoma | Causa | O que fazer |
|---|---|---|
| Página diz "Não consegui falar com o coletor" | Terminal do `npm start` fechou/crashou | Rode `npm start` de novo |
| Página congela em "Sem resposta há Ns" | Node parado ou travado | Reinicie o Node (`Ctrl+C` e `npm start`) |
| Grafana não abre (site off) | Container parado | `docker compose up -d` ou `docker compose restart grafana` |
| Dashboards vazios, títulos ok | Node subiu depois / sem `-shm` | Node primeiro, depois `docker compose restart grafana` |
| "Não disponível" em Temperatura/Load/I/O | Normal no Windows | Essas métricas não existem aqui — não é defeito |
| Alerta disparou sem motivo | Métrica chegou ao limite de verdade | Confira o valor atual na página resumo; use o gráfico para ver há quanto tempo |
| Porta 3001 ocupada | Processo antigo | `Get-NetTCPConnection -LocalPort 3001` → mate o PID e suba de novo |
| Quer começar do zero | Banco com histórico antigo | Pare o Node, apague `data\metrics.db*`, suba o Node de novo |

## 11.6 Rotina sugerida

- **Todo dia:** dá uma olhada na página resumo (10 segundos) — veredito verde
  é tudo que precisa.
- **Semanal:** abra o Grafana com `Last 7 days` nos painéis de Disco e
  Memória para ver tendência (espaço caindo? RAM subindo?).
- **Mensal:** confira o tamanho de `data\metrics.db` (a retenção de 7 dias
  cuida disso, mas vale olhar).
- **Ao trocar de máquina/reinstalar:** siga a [seção 6](#6-como-rodar).

## 11.7 Backup e manutenção

- **Backup do histórico:** pare o Node (garante fechamento limpo do WAL) e
  copie `data\metrics.db`. Restaurar: parar tudo, colocar o arquivo de volta,
  subir Node → Grafana.
- **Reduzir retenção/espaço:** `RETENTION_DAYS=3 npm start`.
- **Atualizar o Grafana:** `docker compose pull && docker compose up -d`
  (os provisionamentos são reaplicados sozinhos).

## 11.8 Segurança

- Credenciais padrão do Grafana: `admin` / `guidepc2` — **troque** em
  `docker-compose.yml` se a porta3000 for acessível de fora.
- Portas expostas: 3001 (API/página) e 3000 (Grafana) em todas as interfaces.
  Para uso pessoal atrás do roteador, tudo bem; em rede compartilhada,
  restrinja com firewall.
- O webhook aceita qualquer JSON e só loga — não expõe dados nem escreve no
  banco.

---

**Documentação de design:** a spec está em
`docs/superpowers/specs/2026-10-05-guidepc2-design.md` e o plano de
implementação (8 tasks com TDD) em `docs/superpowers/plans/2026-10-05-guidepc2.md`.
A verdade do produto está em `PRODUCT.md`.
