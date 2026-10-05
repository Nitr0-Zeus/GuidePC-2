import os from 'node:os';

const round = (n, digits = 1) => Number(n.toFixed(digits));
const toGb = (bytes) => round(bytes / 1024 ** 3, 2);
const toMbPerSec = (bytesPerSec) => round(bytesPerSec / 1024 ** 2, 2);

export async function collectMetrics(si, state, nowMs = Date.now()) {
  const out = [];
  const push = (metric, value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    out.push({ metric, value });
  };

  try {
    const load = await si.currentLoad();
    push('cpu.total', round(load.currentLoad));
    (load.cpus ?? []).forEach((cpu, i) => push(`cpu.core.${i}`, round(cpu.load)));
  } catch {
    /* omitido */
  }

  if (process.platform !== 'win32') {
    const [l1, l5, l15] = os.loadavg();
    push('cpu.load.1', round(l1, 2));
    push('cpu.load.5', round(l5, 2));
    push('cpu.load.15', round(l15, 2));
  }

  try {
    const temp = await si.cpuTemperature();
    if (temp && temp.main > 0) push('cpu.temp', round(temp.main));
  } catch {
    /* omitido */
  }

  try {
    const mem = await si.mem();
    if (mem.total > 0) push('mem.used', round((mem.active / mem.total) * 100));
    push('mem.available', toGb(mem.available));
    if (mem.swaptotal > 0) push('mem.swap', round((mem.swapused / mem.swaptotal) * 100));
    push('mem.cached', toGb(mem.buffcache ?? 0));
  } catch {
    /* omitido */
  }

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

  try {
    const filesystems = await si.fsSize();
    for (const fs of filesystems) {
      const key = String(fs.mount || fs.fs).replace(/[\\/\s]/g, '_');
      if (typeof fs.use === 'number') push(`disk.usage.${key}`, round(fs.use));
      if (typeof fs.available === 'number') push(`disk.free.${key}`, toGb(fs.available));
    }
  } catch {
    /* omitido */
  }

  if (process.platform !== 'win32') {
    try {
      const io = await si.fsStats();
      if (typeof io.rx_sec === 'number') push('disk.read', toMbPerSec(io.rx_sec));
      if (typeof io.wx_sec === 'number') push('disk.write', toMbPerSec(io.wx_sec));
    } catch {
      /* omitido */
    }
  }

  try {
    const stats = await si.networkStats('*');
    const prev = state.net ?? {};
    const current = {};
    let totalErrors = 0;
    for (const s of stats) {
      current[s.iface] = { rx: s.rx_bytes, tx: s.tx_bytes, at: nowMs };
      const before = prev[s.iface];
      if (before && nowMs > before.at) {
        const dtSec = (nowMs - before.at) / 1000;
        const rxDelta = s.rx_bytes - before.rx;
        const txDelta = s.tx_bytes - before.tx;
        push(`net.rx.${s.iface}`, round((rxDelta > 0 ? rxDelta : 0) / dtSec / 1024, 2));
        push(`net.tx.${s.iface}`, round((txDelta > 0 ? txDelta : 0) / dtSec / 1024, 2));
      }
      totalErrors +=
        (s.rx_errors ?? 0) + (s.tx_errors ?? 0) + (s.rx_dropped ?? 0) + (s.tx_dropped ?? 0);
    }
    if (stats.length > 0) push('net.errors', totalErrors);
    state.net = current;
  } catch {
    /* omitido */
  }

  try {
    const connections = await si.networkConnections();
    push(
      'net.conns.established',
      connections.filter((c) => c.state === 'ESTABLISHED').length
    );
  } catch {
    /* omitido */
  }

  return out;
}
