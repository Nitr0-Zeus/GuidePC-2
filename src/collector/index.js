import { collectMetrics } from './metrics.js';

export function createCollector({ si, writer, intervalMs, onError = console.error }) {
  const state = {};
  let timer = null;
  let running = false;

  async function runOnce(nowMs = Date.now()) {
    const samples = await collectMetrics(si, state, nowMs);
    if (samples.length > 0) {
      const ts = Math.floor(nowMs / 1000);
      writer.insertBatch(samples.map((s) => ({ ts, metric: s.metric, value: s.value })));
    }
    return samples;
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer === null) timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce,
  };
}
