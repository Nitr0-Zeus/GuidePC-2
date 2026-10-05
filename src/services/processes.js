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
