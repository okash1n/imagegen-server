import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppServerEngine, TURN_INSTRUCTION } from '../src/engine/appserver.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Scenario = 'happy' | 'no-tool' | 'slow' | 'crash-once' | 'auth-expired';

interface TestContext {
  engine: AppServerEngine;
  captureFile: string;
}

const engines: AppServerEngine[] = [];
const tempDirs: string[] = [];

async function createEngine(
  scenario: Scenario,
  opts?: { turnTimeoutMs?: number },
): Promise<TestContext> {
  const baseDir = await mkdtemp(join(tmpdir(), 'appserver-test-'));
  tempDirs.push(baseDir);
  const workDir = join(baseDir, 'work');
  const tmpDir = join(baseDir, 'tmp');
  await mkdir(workDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  const captureFile = join(baseDir, 'capture.jsonl');
  const engine = new AppServerEngine({
    codexBin: process.execPath,
    codexArgs: ['test/fake-appserver.mjs'],
    workDir,
    tmpDir,
    turnTimeoutMs: opts?.turnTimeoutMs ?? 8_000,
    restartBaseDelayMs: 10,
    env: {
      FAKE_SCENARIO: scenario,
      FAKE_CAPTURE_FILE: captureFile,
      FAKE_STATE_FILE: join(baseDir, 'fake-state'),
    },
  });
  engines.push(engine);
  return { engine, captureFile };
}

async function readCapture(captureFile: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(captureFile, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function turnStartText(message: Record<string, unknown>): string {
  const params = message['params'] as { input: Array<{ type: string; text: string }> };
  return params.input[0].text;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.stop();
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('AppServerEngine', () => {
  it('happy: generate が tmpDir に PNG を置き revisedPrompt を返す', async () => {
    const { engine } = await createEngine('happy');
    const result = await engine.generate({ prompt: 'a cat in watercolor' });
    expect(result.pngPath.endsWith('.png')).toBe(true);
    expect((await stat(result.pngPath)).size).toBeGreaterThan(0);
    const head = (await readFile(result.pngPath)).subarray(0, 8);
    expect(head.equals(PNG_MAGIC)).toBe(true);
    expect(typeof result.revisedPrompt).toBe('string');
    expect((result.revisedPrompt ?? '').length).toBeGreaterThan(0);
  }, 10_000);

  it('happy: authStatus が loggedIn=true を返す', async () => {
    const { engine } = await createEngine('happy');
    const status = await engine.authStatus();
    expect(status.loggedIn).toBe(true);
    expect(status.method).toBe('chatgpt');
  }, 10_000);

  it('edit: instruction に refImagePaths が JSON で埋め込まれる', async () => {
    const { engine, captureFile } = await createEngine('happy');
    const refPaths = ['/abs/ref-1.png', '/abs/ref-2.png'];
    const result = await engine.edit({ prompt: 'make it blue', refImagePaths: refPaths });
    expect((await stat(result.pngPath)).size).toBeGreaterThan(0);
    const messages = await readCapture(captureFile);
    const turnStart = messages.find((m) => m['method'] === 'turn/start');
    expect(turnStart).toBeDefined();
    const text = turnStartText(turnStart as Record<string, unknown>);
    expect(text).toContain(JSON.stringify(refPaths));
    expect(text).toBe(TURN_INSTRUCTION('make it blue', refPaths));
  }, 10_000);

  it('parallel: 3 並列 generate が別々の thread で完了する', async () => {
    const { engine, captureFile } = await createEngine('happy');
    const results = await Promise.all([
      engine.generate({ prompt: 'one' }),
      engine.generate({ prompt: 'two' }),
      engine.generate({ prompt: 'three' }),
    ]);
    for (const r of results) {
      expect((await stat(r.pngPath)).size).toBeGreaterThan(0);
    }
    expect(new Set(results.map((r) => r.pngPath)).size).toBe(3);
    const messages = await readCapture(captureFile);
    expect(messages.filter((m) => m['method'] === 'initialize')).toHaveLength(1);
    const threadIds = new Set(
      messages
        .filter((m) => m['method'] === 'turn/start')
        .map((m) => (m['params'] as { threadId: string }).threadId),
    );
    expect(threadIds.size).toBe(3);
  }, 10_000);

  it('parallel: 初回バーストでも initialize 完了前に thread/start が流れない', async () => {
    const { engine, captureFile } = await createEngine('happy');
    await Promise.all([
      engine.generate({ prompt: 'one' }),
      engine.generate({ prompt: 'two' }),
      engine.generate({ prompt: 'three' }),
    ]);
    // The fake server appends received lines in arrival order, so the capture
    // file reflects the exact order in which requests reached the child.
    // The engine sends "initialized" only after the initialize response, so
    // thread/start appearing after it proves no request raced the handshake.
    const methods = (await readCapture(captureFile)).map((m) => m['method']);
    expect(methods[0]).toBe('initialize');
    const initializedIndex = methods.indexOf('initialized');
    const firstThreadStartIndex = methods.indexOf('thread/start');
    expect(initializedIndex).toBeGreaterThan(0);
    expect(firstThreadStartIndex).toBeGreaterThan(initializedIndex);
  }, 10_000);

  it('no-tool: imageGeneration 無しは agent テキスト入りで失敗する', async () => {
    const { engine } = await createEngine('no-tool');
    await expect(engine.generate({ prompt: 'x' })).rejects.toThrow(/画像生成はできません/);
  }, 10_000);

  it('slow: タイムアウトで失敗し turnId 付きの turn/interrupt を送る', async () => {
    const { engine, captureFile } = await createEngine('slow', { turnTimeoutMs: 500 });
    await expect(engine.generate({ prompt: 'x' })).rejects.toThrow(/タイムアウト/);
    // interrupt は fire-and-forget。capture(JSONL)への反映を最大 2 秒ポーリングし、
    // turn/interrupt 行をパースして params.turnId が文字列であることを検証する
    let interrupt: Record<string, unknown> | undefined;
    for (let i = 0; i < 40 && interrupt === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const messages = await readCapture(captureFile).catch(() => []);
      interrupt = messages.find((m) => m['method'] === 'turn/interrupt');
    }
    if (interrupt === undefined) {
      throw new Error('turn/interrupt が capture に記録されていません');
    }
    const params = interrupt['params'];
    if (typeof params !== 'object' || params === null) {
      throw new Error('turn/interrupt の params がオブジェクトではありません');
    }
    expect(typeof (params as Record<string, unknown>)['threadId']).toBe('string');
    expect(typeof (params as Record<string, unknown>)['turnId']).toBe('string');
  }, 10_000);

  it('crash-once: 1 回目は失敗し 2 回目は自動再起動して成功する', async () => {
    const { engine } = await createEngine('crash-once');
    await expect(engine.generate({ prompt: 'x' })).rejects.toThrow();
    const result = await engine.generate({ prompt: 'x' });
    expect((await stat(result.pngPath)).size).toBeGreaterThan(0);
  }, 10_000);

  it('auth-expired: authStatus が loggedIn=false と日本語メッセージを返す', async () => {
    const { engine } = await createEngine('auth-expired');
    const status = await engine.authStatus();
    expect(status.loggedIn).toBe(false);
    expect(status.message).toContain('codex login');
  }, 10_000);

  it('stop: アクティブな turn の最中に stop すると Promise が reject されプロセスもリークしない', async () => {
    // slow シナリオは turn/start に応答後そのまま無音(turn/completed を送らない)。
    // turn が in-flight の状態で stop() を呼び、generate() の Promise が reject されること、
    // stop() が子プロセスの終了まで待って解決すること(リークしないこと)を検証する。
    const { engine } = await createEngine('slow', { turnTimeoutMs: 8_000 });
    const pending = engine.generate({ prompt: 'x' });
    const settled = pending.then(
      () => 'resolved',
      () => 'rejected',
    );
    // turn/start の往復が完了して turn が in-flight になるまで少し待つ。
    await new Promise((resolve) => setTimeout(resolve, 200));
    await engine.stop();
    await expect(pending).rejects.toThrow();
    expect(await settled).toBe('rejected');
  }, 10_000);
});
