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
