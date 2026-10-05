import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readThresholds, DEFAULT_THRESHOLDS } from '../src/api/thresholds.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});
function tempFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guidepc2-th-'));
  dirs.push(dir);
  const file = path.join(dir, 'thresholds.json');
  fs.writeFileSync(file, content);
  return file;
}

describe('readThresholds', () => {
  it('devolve os defaults quando o arquivo não existe', () => {
    const out = readThresholds(path.join(os.tmpdir(), 'nao-existe-guidepc2.json'));
    expect(out).toEqual(DEFAULT_THRESHOLDS);
    expect(out.cpu).toEqual({ warn: 70, crit: 90 });
    expect(out.mem).toEqual({ warn: 75, crit: 90 });
    expect(out.disk).toEqual({ warn: 70, crit: 85 });
  });

  it('devolve os defaults quando o JSON é inválido', () => {
    expect(readThresholds(tempFile('{quebrado'))).toEqual(DEFAULT_THRESHOLDS);
  });

  it('faz merge por chave: arquivo parcial sobrepõe só o que trouxe', () => {
    const file = tempFile(JSON.stringify({ cpu: { warn: 55, crit: 95 }, mem: 'lixo' }));
    const out = readThresholds(file);
    expect(out.cpu).toEqual({ warn: 55, crit: 95 });
    expect(out.mem).toEqual({ warn: 75, crit: 90 });
    expect(out.disk).toEqual({ warn: 70, crit: 85 });
  });

  it('ignora valores não numéricos mantendo o default da chave', () => {
    const file = tempFile(JSON.stringify({ disk: { warn: 'setenta', crit: 80 } }));
    const out = readThresholds(file);
    expect(out.disk).toEqual({ warn: 70, crit: 80 });
  });
});
