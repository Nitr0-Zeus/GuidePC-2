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
