import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { imagesDir, loadConfig, uploadsDir, workDir } from '../src/config.js';

let fakeHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: (): string => fakeHome,
  };
});

describe('loadConfig', () => {
  let dataDir: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), 'imagegen-home-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'imagegen-data-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('フラグもファイルも無ければデフォルト値を返す', () => {
    const c = loadConfig(['--data-dir', dataDir]);
    expect(c.port).toBe(7878);
    expect(c.host).toBe('127.0.0.1');
    expect(c.concurrency).toBe(3);
    expect(c.codexBin).toBe('codex');
    expect(c.dataDir).toBe(dataDir);
    expect(c.turnModel).toBeUndefined();
  });

  it('dataDir の既定は ~/.imagegen-server', () => {
    const c = loadConfig([]);
    expect(c.dataDir).toBe(path.join(fakeHome, '.imagegen-server'));
  });

  it('config.json の部分上書きを反映する(無いキーはデフォルトのまま)', () => {
    writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ port: 8080, turnModel: 'gpt-5.1' }),
    );
    const c = loadConfig(['--data-dir', dataDir]);
    expect(c.port).toBe(8080);
    expect(c.turnModel).toBe('gpt-5.1');
    expect(c.concurrency).toBe(3);
    expect(c.codexBin).toBe('codex');
  });

  it('CLI フラグはファイルより優先される', () => {
    writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        port: 8080,
        concurrency: 5,
        turnModel: 'file-model',
        codexBin: '/opt/codex',
      }),
    );
    const c = loadConfig([
      '--data-dir', dataDir,
      '--port', '9090',
      '--concurrency', '2',
      '--model', 'flag-model',
      '--codex-bin', '/usr/bin/codex',
    ]);
    expect(c.port).toBe(9090);
    expect(c.concurrency).toBe(2);
    expect(c.turnModel).toBe('flag-model');
    expect(c.codexBin).toBe('/usr/bin/codex');
  });

  it('config.json が不正な JSON なら日本語メッセージで throw する', () => {
    writeFileSync(path.join(dataDir, 'config.json'), '{ こわれてる');
    expect(() => loadConfig(['--data-dir', dataDir])).toThrow(/JSON が不正/);
  });

  it('port が範囲外なら throw する', () => {
    expect(() => loadConfig(['--data-dir', dataDir, '--port', '70000'])).toThrow(/1〜65535/);
    expect(() => loadConfig(['--data-dir', dataDir, '--port', '0'])).toThrow(/1〜65535/);
  });

  it('concurrency が範囲外なら throw する', () => {
    expect(() => loadConfig(['--data-dir', dataDir, '--concurrency', '11'])).toThrow(/1〜10/);
  });

  it('派生パスヘルパーが dataDir 配下を返す', () => {
    const c = loadConfig(['--data-dir', dataDir]);
    expect(imagesDir(c)).toBe(path.join(dataDir, 'images'));
    expect(uploadsDir(c)).toBe(path.join(dataDir, 'uploads'));
    expect(workDir(c)).toBe(path.join(dataDir, 'work'));
  });
});
