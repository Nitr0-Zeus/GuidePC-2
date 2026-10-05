import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete process.env.HOST;
});

describe('config', () => {
  it('host tem default 0.0.0.0 quando a env HOST não existe', async () => {
    delete process.env.HOST;
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.host).toBe('0.0.0.0');
  });

  it('host é sobrescrito pela variável de ambiente HOST', async () => {
    vi.stubEnv('HOST', '127.0.0.1');
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.host).toBe('127.0.0.1');
  });

  it('expõe thresholdsPath e grafanaHealthUrl com defaults locais', async () => {
    const { config } = await import('../src/config.js');
    expect(config.thresholdsPath.replace(/\\/g, '/')).toMatch(/config\/thresholds\.json$/);
    expect(config.grafanaHealthUrl).toBe('http://localhost:3000/api/health');
  });
});
