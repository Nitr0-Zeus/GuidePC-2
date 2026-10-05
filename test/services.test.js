import { describe, it, expect } from 'vitest';
import { createHardwareService } from '../src/services/hardware.js';
import { createProcessesService } from '../src/services/processes.js';

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
