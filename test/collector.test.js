import { describe, it, expect, vi, afterEach } from 'vitest';
import { collectMetrics } from '../src/collector/metrics.js';
import { createCollector } from '../src/collector/index.js';

function makeSi() {
  return {
    currentLoad: async () => ({ currentLoad: 42.5, cpus: [{ load: 30 }, { load: 55 }] }),
    cpuTemperature: async () => ({ main: 55 }),
    mem: async () => ({
      total: 16 * 1024 ** 3,
      active: 8 * 1024 ** 3,
      available: 6 * 1024 ** 3,
      swaptotal: 4 * 1024 ** 3,
      swapused: 1 * 1024 ** 3,
      buffcache: 2 * 1024 ** 3,
    }),
    fsSize: async () => [
      { fs: 'C:\\', mount: 'C:', size: 100 * 1024 ** 3, used: 60 * 1024 ** 3, available: 40 * 1024 ** 3, use: 60, rw: true },
    ],
    fsStats: async () => {
      throw new Error('not supported');
    },
    networkStats: async () => [
      { iface: 'Ethernet', rx_bytes: 1_000_000, tx_bytes: 500_000, rx_errors: 1, tx_errors: 0, rx_dropped: 0, tx_dropped: 2 },
    ],
    networkConnections: async () => [
      { state: 'ESTABLISHED' },
      { state: 'TIME_WAIT' },
      { state: 'ESTABLISHED' },
    ],
  };
}

const byName = (samples) => Object.fromEntries(samples.map((s) => [s.metric, s.value]));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collectMetrics', () => {
  it('produz as métricas básicas com nomes e valores esperados', async () => {
    const samples = await collectMetrics(makeSi(), {}, 1_000_000);
    const m = byName(samples);
    expect(m['cpu.total']).toBe(42.5);
    expect(m['cpu.core.0']).toBe(30);
    expect(m['cpu.core.1']).toBe(55);
    expect(m['cpu.temp']).toBe(55);
    expect(m['mem.used']).toBe(50);
    expect(m['mem.available']).toBe(6);
    expect(m['mem.swap']).toBe(25);
    expect(m['mem.cached']).toBe(2);
    expect(m['disk.usage.C:']).toBe(60);
    expect(m['disk.free.C:']).toBe(40);
    expect(m['net.conns.established']).toBe(2);
    expect(m['net.errors']).toBe(3);
    if (process.platform !== 'win32') {
      expect(m['cpu.load.1']).toBeTypeOf('number');
    }
  });

  it('omite temperatura quando indisponível (main = 0)', async () => {
    const si = makeSi();
    si.cpuTemperature = async () => ({ main: 0 });
    const samples = await collectMetrics(si, {}, 1_000_000);
    expect(byName(samples)['cpu.temp']).toBeUndefined();
  });

  it('omite métricas cuja coleta falha sem derrubar as demais', async () => {
    const si = makeSi();
    si.currentLoad = async () => {
      throw new Error('boom');
    };
    const samples = await collectMetrics(si, {}, 1_000_000);
    expect(samples.some((s) => s.metric.startsWith('cpu.core'))).toBe(false);
    expect(samples.some((s) => s.metric.startsWith('mem.'))).toBe(true);
  });

  it('calcula net.rx/net.tx em KB/s pelo delta entre amostras e omite a primeira', async () => {
    let rx = 1_000_000;
    let tx = 500_000;
    const si = makeSi();
    si.networkStats = async () => [
      { iface: 'eth0', rx_bytes: rx, tx_bytes: tx, rx_errors: 0, tx_errors: 0, rx_dropped: 0, tx_dropped: 0 },
    ];
    const state = {};
    const first = await collectMetrics(si, state, 1_000_000);
    expect(byName(first)['net.rx.eth0']).toBeUndefined();
    rx += 10_240;
    tx += 5_120;
    const second = await collectMetrics(si, state, 1_005_000);
    const m = byName(second);
    expect(m['net.rx.eth0']).toBe(2);
    expect(m['net.tx.eth0']).toBe(1);
  });

  it('zera a taxa de rede quando o contador reinicia', async () => {
    const si = makeSi();
    let rx = 5_000_000;
    si.networkStats = async () => [
      { iface: 'eth0', rx_bytes: rx, tx_bytes: 0, rx_errors: 0, tx_errors: 0, rx_dropped: 0, tx_dropped: 0 },
    ];
    const state = {};
    await collectMetrics(si, state, 1_000_000);
    rx = 1_000; // contador reiniciou
    const samples = await collectMetrics(si, state, 1_005_000);
    expect(byName(samples)['net.rx.eth0']).toBe(0);
  });
});

describe('createCollector', () => {
  it('runOnce grava as amostras via writer com ts em epoch seconds', async () => {
    const written = [];
    const writer = { insertBatch: (rows) => written.push(...rows), purgeOlderThan: () => 0 };
    const collector = createCollector({ si: makeSi(), writer, intervalMs: 5000 });
    const samples = await collector.runOnce(1_700_000_000_000);
    expect(written.length).toBe(samples.length);
    expect(written.every((s) => s.ts === 1_700_000_000)).toBe(true);
  });

  it('start/stop agenda coletas no intervalo e falhas de escrita vão para onError', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const writer = {
      insertBatch: vi.fn(() => {
        throw new Error('disco cheio');
      }),
      purgeOlderThan: vi.fn(),
    };
    const collector = createCollector({ si: makeSi(), writer, intervalMs: 5000, onError });
    collector.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toBe('disco cheio');
    expect(writer.insertBatch).toHaveBeenCalled();
    collector.stop();
    vi.useRealTimers();
  });
});
