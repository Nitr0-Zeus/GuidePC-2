# GuidePC 2 — Pacotes A + B: Quick wins e utilidade

Data: 2026-10-05
Status: aprovado pelo usuário (design em chat; escopo A+B)
Base: auditoria comparativa contra `Nitr0-Zeus/GuidePC` v4.0 (Java/OSHI) +
spec original `2026-10-05-guidepc2-design.md`.

## Objetivo

Ampliar o GuidePC 2 com as features de maior valor identificadas na auditoria
do repositório GuidePC v4.0, **sem quebrar as regras centrais da arquitetura**
(escritor único via `db/writer.js`; métrica ausente é omitida, nunca 0 falso)
e sem entrar no Pacote C (testes de carga, SSE, PDF).

## Escopo

### Pacote A — Quick wins

| # | Feature | Origem | Decisão de design |
|---|---|---|---|
| A1 | Inventário de hardware | repo remoto (página "Hardware") | `GET /api/hardware`; cache em memória (10 min); **não grava no banco** (dado estático, não é série temporal) |
| A2 | Bateria | repo remoto (card de bateria) | métricas `battery.pct` (%), `battery.charging` (0/1) no coletor; **omitidas se não houver bateria** (desktop); `stat` + série no dashboard Memória do Grafana; card condicional na página |
| A3 | Tema claro/escuro | repo remoto (toggle) | CSS vars: `:root` light padrão + `[data-theme="dark"]`; toggle no header; `localStorage`; default `prefers-color-scheme` |
| A4 | Sparklines nos vitais | nosso endpoint órfão `/api/metrics/:metric` | SVG inline (sem lib de gráfico); janela 60 min; refresh 60s; 4 vitais (CPU, Memória, Disco, Rede) |
| A5 | Top processos | **nem no repo remoto** (lacuna de ambos) | `GET /api/processes` → `si.processes()`, top 10 por CPU e top 10 por memória; cache server-side 10s (chamada custa ~1s no Windows); **nunca persistido** |
| A6 | HOST configurável | auditoria (segurança) | env `HOST`, default `0.0.0.0` (comportamento atual preservado); doc: `HOST=127.0.0.1` quando não houver Docker (webhook do Grafana precisa alcançar o host) |

### Pacote B — Utilidade

| # | Feature | Decisão de design |
|---|---|---|
| B1 | Export CSV | `GET /api/export.csv?from=&to=` formato longo `ts,metric,value`, streaming, `Content-Disposition: attachment`; sem dependência nova; leitura via `range()` |
| B2 | Histórico de alertas | tabela `alerts (id INTEGER PK, ts INTEGER NOT NULL, alertname TEXT NOT NULL, state TEXT NOT NULL, value REAL)`; `ts` = epoch segundos de `startsAt` do alerta (fallback: `now`); `state` = `status` do payload (`firing`/`resolved`); `value` aceita NULL (payload nem sempre traz); escrita **via `db/writer.js`** pelo webhook; `GET /api/alerts?limit=` (default 20, máx 200); purge na rotina diária (mesma retenção de 7 dias) |
| B3 | Saúde do Grafana | `GET /api/health/grafana` → proxy server-side para `localhost:3000/api/health`, timeout 2s, cache 15s → `{ online: boolean }`; chip na página ("Gráficos online/offline — `docker compose up -d`") |
| B4 | Thresholds unificados | `config/thresholds.json` (caminho resolvido a partir da raiz do projeto, via `config.js`; se o arquivo faltar ou estiver inválido, usam-se os defaults embutidos) (`cpu`/`mem`/`disk` → `warn`/`crit`); `GET /api/config/thresholds` com merge sobre defaults embutidos; página lê da API em vez do `THRESHOLDS` hardcoded (fallback para defaults se a API falhar) |

### Layout da página (decisão do usuário)

Mesma página, **seções empilhadas** — sem menu, sem rota nova. Ordem:

1. Topbar (marca + idade da leitura + **toggle de tema**)
2. Veredito + 4 vitais (fluxo leigo de 10s **inalterado**; vitais ganham sparkline)
3. Processador por núcleo / Discos e rede (existentes)
4. **Meu computador** (A1)
5. **Bateria** (A2, só aparece se existir)
6. **O que está usando seu PC** — top processos (A5)
7. **Histórico de alertas** (B2)
8. Rodapé: chip **Gráficos online/offline** (B3) + **Baixar CSV** (B1) + links existentes

## Mudança de contrato (explícita)

- **Webhook passa a gravar**: `POST /api/alerts/webhook` deixa de ser "apenas
  loga" e passa a inserir uma linha em `alerts` **por alerta** de
  `payload.alerts[]` (`alertname` = `labels.alertname`, `ts` = epoch de
  `startsAt` com fallback `now`, `state` = `status` (`firing`/`resolved`),
  `value` = primeiro número encontrado em `values`/`data`, senão NULL).
  Payload sem `alerts[]` ou JSON inválido → 400, nada gravado. Log do payload
  é mantido. Escritor único **mantido** (toda escrita passa por `writer.js`).
- **Escritas na API**: continuam sendo apenas as do webhook — que agora, além
  de logar, grava em `alerts`. Nenhuma rota GET escreve; nenhum componente
  além de `writer.js` toca no banco. A spec original será atualizada para
  refletir isso.

## Limitações assumidas

1. **Espelho manual de thresholds**: os alertas do Grafana vivem em
   `grafana/provisioning/alerting/alerts.yml` (provisionado, sem hot-reload).
   `config/thresholds.json` é a fonte para a **página**; seus defaults são os
   `THRESHOLDS` atuais da página (CPU 70/90, Mem 75/90, Disco 70/85) e o README
   documenta a tabela de espelho com os limiares dos alertas do Grafana
   (CPU 90, Mem 90, Disco 85 — valores diferentes, propósitos diferentes:
   página = aviso visual leigo; Grafana = alerta formal). Gerar o YAML a
   partir do JSON é YAGNI nesta rodada.
2. **`battery.charging` como 0/1** (numérico) — o schema exige `value REAL`;
   a página converte em "carregando/descarregando".
3. **CSV em formato longo** (uma linha por amostra) — fiel ao schema, aceito
   pelo Excel/LibreOffice; pivot não é escopo.

## Fora de escopo (confirmado com o usuário)

- **Pacote C**: testes de estresse/disco, histórico/comparação de testes,
  tempo real via SSE/WebSocket, export PDF.
- Geração automática do YAML de alertas do Grafana a partir do thresholds.json.
- Autenticação, notificações externas (e-mail/Slack), multi-host.
- Dependência nova de gráfico (Chart.js etc.) — sparklines são SVG inline.

## Arquitetura (mantida + adições)

```
[coletor 5s] → systeminformation → db/writer.js (único escritor, WAL)
                                        ↓
                                   data/metrics.db
                                     ↙          ↘
              Express (API + página)          Grafana (:ro)
                ├─ GET /api/hardware   (cache memória, sem banco)
                ├─ GET /api/processes  (cache memória 10s, sem banco)
                ├─ GET /api/export.csv (leitura range())
                ├─ GET /api/alerts     (leitura)
                ├─ GET /api/config/thresholds (arquivo + defaults)
                ├─ GET /api/health/grafana (proxy HTTP, cache 15s)
                └─ POST /api/alerts/webhook (ESCREVE alerts via writer.js)
```

- Tabela nova `alerts` é invisível aos painéis atuais (eles consultam
  `samples` explicitamente); volume `:ro` do Grafana não muda.
- Dado estático/histórico curto (hardware, processos) **fica fora do banco** —
  só vira série temporal o que muda ao longo do tempo (bateria).

## Frontend

- Vanilla HTML/CSS/JS (sem framework), como hoje.
- Tema: variáveis CSS `--bg`, `--fg`, `--card`, `--border`, `--accent`, etc.
  definidas em `:root` (light) e redefinidas em `[data-theme="dark"]`;
  script de tema inline no `<head>` (evita flash of wrong theme) lendo
  `localStorage` antes do primeiro paint.
- Toda chamada nova usa `fetch` com `cache: 'no-store'`; estados de falha
  seguem o padrão existente (mensagem em PT-BR, nunca dado inventado).
- Idioma PT-BR; contraste AA; `prefers-reduced-motion` respeitado (já existe).

## Testes e verificação

- **Novos testes (vitest + supertest, banco temporário):**
  - `collector.test.js`: bateria presente grava `battery.pct`/`battery.charging`;
    bateria ausente (null) **omite** as duas métricas.
  - `db.test.js`: schema da tabela `alerts`; `insertAlerts` + `listAlerts`;
    purge remove alertas > retenção.
  - `api.test.js`:
    - `/api/hardware` → 200 com campos esperados (mock de `si.*`);
    - `/api/processes` → 200 com `cpu[]` e `mem[]` ordenados desc, cache;
    - `/api/export.csv` → 200 com header CSV e `Content-Disposition`;
    período inválido → 400;
    - webhook → 200 **e grava** linha em `alerts`; JSON inválido → 400 e 0
    linhas;
    - `/api/alerts?limit=` → lista ordenada por ts desc;
    - `/api/config/thresholds` → 200 com `cpu/mem/disk` e `warn/crit`;
    - `/api/health/grafana` → 200 `{ online: boolean }` (up/down mockado).
- **Gate**: `npm test` e `npm run lint` zerados.
- **QA visual (obrigatório)**: subagente `visual-qa` em `localhost:3001`,
  temas light e dark, desktop e ~500px; checar contraste AA, overflow,
  veredito e estados de falha.

## Critérios de aceite

1. `GET /api/hardware` devolve inventário completo sem tocar no banco.
2. Com bateria: `battery.pct`/`battery.charging` em `/api/latest`, card na
   página e painéis no dashboard Memória. Sem bateria: nada é gravado e a
   página não mostra a seção.
3. Tema alterna light/dark, persiste em `localStorage` e respeita
   `prefers-color-scheme` na primeira visita; sem flash de tema errado.
4. Os 4 vitais mostram sparkline de 60 min alimentada por
   `/api/metrics/:metric`.
5. Top processos mostra 10 por CPU e 10 por memória; resposta ≤ ~1s em
   condições normais (cache de 10s).
6. `GET /api/export.csv?from=&to=` baixa CSV válido; período inválido → 400.
7. Alerta disparado no Grafana gera linha em `/api/alerts` e aparece na
   página; purge diário remove linhas > 7 dias.
8. Chip da página reflete o estado real do Grafana (online/offline).
9. `GET /api/config/thresholds` é a única fonte de thresholds da página
   (fallback para defaults embutidos se falhar).
10. `HOST` respeitado no boot; default inalterado (`0.0.0.0`).
11. `npm test` e `npm run lint` passam; QA visual sem achados críticos.
