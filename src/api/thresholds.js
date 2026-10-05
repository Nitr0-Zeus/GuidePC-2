import fs from 'node:fs';

export const DEFAULT_THRESHOLDS = {
  cpu: { warn: 70, crit: 90 },
  mem: { warn: 75, crit: 90 },
  disk: { warn: 70, crit: 85 },
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function readThresholds(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return structuredClone(DEFAULT_THRESHOLDS);
  }
  const out = structuredClone(DEFAULT_THRESHOLDS);
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
      const entry = raw[key];
      if (!entry || typeof entry !== 'object') continue;
      if (isNum(entry.warn)) out[key].warn = entry.warn;
      if (isNum(entry.crit)) out[key].crit = entry.crit;
    }
  }
  return out;
}
