# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Dono leigo deste PC (não-técnico). Usa o GuidePC 2 em situações de dúvida
operacional: o PC está lento, está faltando recurso, algo está em alerta.

## Product Purpose

Mostrar, em tempo real (coleta a cada 5s), a saúde do sistema para apoiar três
decisões: diagnosticar lentidão, auditar recursos (disco/memória/rede ao longo
do tempo) e reagir a alertas. Sucesso = o usuário leigo entende em poucos
segundos se o PC está bem e o que pode estar causando lentidão.

## Positioning

Monitoramento 100% local, caixa única (Node + SQLite + Grafana em Docker), sem
nuvem e sem agentes remotos: o dado nunca sai da máquina.

## Operating Context

- Windows local; app Node na porta 3001; Grafana via Docker Desktop na 3000.
- Coleta a cada 5s, retenção de 7 dias com limpeza diária.
- Processo Node é o único escritor de `data/metrics.db`; Grafana só lê
  (volume `:ro`).
- Métricas indisponíveis no host são omitidas (ex.: load average e I/O de
  disco não existem no Windows; temperatura pode vir `null`).

## Capabilities and Constraints

- 4 dashboards no Grafana (CPU, Memória, Disco, Rede) com ~12 métricas,
  provisionados por arquivo (uid `guidepc2-*`).
- Página resumo leve no Express com polling de 5s para o público leigo.
- API somente leitura (`/api/health`, `/api/latest`, `/api/metrics/:metric`) +
  webhook de alertas.
- 3 alertas provisionados no Grafana: CPU > 90%, Memória > 90%, Disco > 85%.
- Idioma da interface: PT-BR. Nomes técnicos de métrica ficam visíveis apenas
  como referência secundária.

## Brand Commitments

Nome: **GuidePC 2**. Idioma PT-BR em toda a interface.

## Evidence on Hand

- Dados reais coletados em `data/metrics.db` (27 métricas por ciclo nesta
  máquina: 16 núcleos, volumes C: e D:, 6 interfaces de rede).
- Spec e plano em `docs/superpowers/`.
- Ausências que não devem ser inventadas: sem logo, sem paleta de marca, sem
  fonte própria, sem depoimentos/benchmarks.

## Product Principles

1. Clareza para leigo: rótulos em linguagem simples; jargão técnico só como
   detalhe secundário.
2. Dado local, sem nuvem: nada sai desta máquina.
3. Sempre atualizado: a leitura mais importa se estiver fresca (5s).
4. Honestidade sobre o que não existe: métrica ausente aparece como "não
   disponível", nunca como zero falso.
5. Um único responsável pela escrita do banco: regra de arquitetura
   não-negociável.

## Accessibility & Inclusion

Valores devem ser legíveis a um braço de distância (alvo leigo em pé na
frente do monitor); contraste AA nos textos principais.
