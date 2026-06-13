import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonRpcConnection } from '../src/engine/jsonrpc.js';

interface InitializeResult {
  userAgent: string;
}

interface AuthStatusResult {
  authMethod: string | null;
  requiresOpenaiAuth: boolean;
}

interface ThreadStartResult {
  thread: { id: string; ephemeral?: boolean };
}

interface TurnStartResult {
  turn: { id: string; status: string };
}

interface CapturedNotification {
  method: string;
  params: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function waitForNotification(
  conn: JsonRpcConnection,
  predicate: (method: string, params: unknown) => boolean,
  timeoutMs: number,
): Promise<CapturedNotification> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`通知待ちがタイムアウトしました(${timeoutMs}ms)`));
    }, timeoutMs);
    const unsubscribe = conn.onNotification((method, params) => {
      if (!predicate(method, params)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve({ method, params });
    });
  });
}

describe('fake-appserver smoke', () => {
  let child: ChildProcess | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('happy シナリオで generate 一式のハンドシェイクが通る', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fake-appserver-smoke-'));
    const captureFile = path.join(tmpDir, 'capture.jsonl');

    // vitest cwd is the server/ package dir, so this relative path works.
    child = spawn(process.execPath, ['test/fake-appserver.mjs'], {
      env: { ...process.env, FAKE_SCENARIO: 'happy', FAKE_CAPTURE_FILE: captureFile },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    if (!child.stdin || !child.stdout) {
      throw new Error('子プロセスの stdio を取得できませんでした');
    }
    const conn = new JsonRpcConnection(child.stdin, child.stdout);

    const notifications: CapturedNotification[] = [];
    conn.onNotification((method, params) => {
      notifications.push({ method, params });
    });

    // -- handshake: initialize request, then the initialized notification --
    const init = await conn.request<InitializeResult>(
      'initialize',
      { clientInfo: { name: 'imagegen-server', title: 'imagegen-server', version: '0.1.0' } },
      { timeoutMs: 2000 },
    );
    expect(init.userAgent).toBe('fake-app-server/0.0.0');
    conn.notify('initialized');

    // -- auth: getAuthStatus reports authMethod and requiresOpenaiAuth --
    const auth = await conn.request<AuthStatusResult>('getAuthStatus', {}, { timeoutMs: 2000 });
    expect(auth).toEqual({ authMethod: 'chatgpt', requiresOpenaiAuth: false });

    // -- thread/start: the response carries the new thread id --
    const started = await conn.request<ThreadStartResult>(
      'thread/start',
      { cwd: tmpDir, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true },
      { timeoutMs: 2000 },
    );
    const threadId = started.thread.id;
    expect(threadId).toMatch(/^thr_\d+$/);

    // Register the waiter BEFORE turn/start to avoid a race.
    const turnCompletedPromise = waitForNotification(
      conn,
      (method, params) =>
        method === 'turn/completed' && isRecord(params) && params.threadId === threadId,
      5000,
    );

    // -- turn/start: the response returns the turn with status "inProgress" --
    const prompt = 'a 1x1 smoke test pixel';
    const turnStarted = await conn.request<TurnStartResult>(
      'turn/start',
      { threadId, input: [{ type: 'text', text: prompt }] },
      { timeoutMs: 2000 },
    );
    expect(turnStarted.turn.status).toBe('inProgress');

    // -- turn/completed: status "completed" --
    const turnCompleted = await turnCompletedPromise;
    if (!isRecord(turnCompleted.params) || !isRecord(turnCompleted.params.turn)) {
      throw new Error('turn/completed の params が想定外の形です');
    }
    expect(turnCompleted.params.turn.status).toBe('completed');

    // -- item/completed (imageGeneration): savedPath exists on disk, result (base64) is non-empty --
    const itemCompleted = notifications.find(
      (n) =>
        n.method === 'item/completed' &&
        isRecord(n.params) &&
        n.params.threadId === threadId &&
        isRecord(n.params.item) &&
        n.params.item.type === 'imageGeneration',
    );
    if (!itemCompleted || !isRecord(itemCompleted.params) || !isRecord(itemCompleted.params.item)) {
      throw new Error('imageGeneration の item/completed 通知が来ていません');
    }
    const item = itemCompleted.params.item;
    // Real codex emits the terminal imageGeneration item with status "generating";
    // the fake matches that. item/completed (the method) is the completion signal.
    expect(item.status).toBe('generating');
    const savedPath = item.savedPath;
    if (typeof savedPath !== 'string') {
      throw new Error('savedPath が文字列ではありません');
    }
    expect(existsSync(savedPath)).toBe(true);
    const png = readFileSync(savedPath);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const result = item.result;
    if (typeof result !== 'string') {
      throw new Error('result が文字列ではありません');
    }
    expect(result.length).toBeGreaterThan(0);

    // -- FAKE_CAPTURE_FILE: 受信した turn/start 行が JSONL で記録されている --
    const capturedMessages = readFileSync(captureFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    const capturedTurnStart = capturedMessages.find(
      (m) => isRecord(m) && m.method === 'turn/start',
    );
    if (!capturedTurnStart || !isRecord(capturedTurnStart) || !isRecord(capturedTurnStart.params)) {
      throw new Error('FAKE_CAPTURE_FILE に turn/start が記録されていません');
    }
    expect(JSON.stringify(capturedTurnStart.params)).toContain(prompt);

    conn.close();
  }, 15_000);
});
