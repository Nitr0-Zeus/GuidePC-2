export function createGrafanaHealth({
  url,
  fetchFn = globalThis.fetch,
  ttlMs = 15_000,
  timeoutMs = 2000,
}) {
  let cache = null;
  let cachedAt = 0;

  return {
    async get(nowMs = Date.now()) {
      if (cache && nowMs - cachedAt < ttlMs) return cache;
      let online;
      try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
        online = res.ok === true;
      } catch {
        online = false;
      }
      cache = { online };
      cachedAt = nowMs;
      return cache;
    },
  };
}
