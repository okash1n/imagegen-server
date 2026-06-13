import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { AuthStatus } from '@imagegen/shared';
import { JsonRpcConnection } from './jsonrpc.js';
import type { EngineResult, ImageEngine } from './types.js';

export interface AppServerEngineOpts {
  codexBin: string;          // 'codex' または偽サーバー実行コマンド
  codexArgs?: string[];      // default ['app-server'](テストでは偽サーバーのパスに差し替え)
  workDir: string;           // thread の cwd に使う空ディレクトリ
  tmpDir: string;            // EngineResult.pngPath の置き場
  turnModel?: string;
  turnTimeoutMs?: number;    // default 180_000
  env?: Record<string, string>; // 子プロセス追加環境変数(テスト用)
  /**
   * 再起動バックオフの基準遅延(ms)。default 1000。
   * テストがクラッシュ→再起動を実時間 1 秒待たずに検証するための内部オプション。
   */
  restartBaseDelayMs?: number;
}

export const TURN_INSTRUCTION = (prompt: string, refPaths?: string[]) => `You have an image generation tool (imagegen).
Call the imagegen tool EXACTLY ONCE with the arguments below, then stop.
- Use the prompt below VERBATIM as the \`prompt\` argument. Do not rephrase, translate, expand, or shorten it.
${refPaths && refPaths.length > 0 ? `- Pass \`referenced_image_paths\` as exactly: ${JSON.stringify(refPaths)}\n` : ''}- Do not run any other tool. Do not write files. Do not explain.

PROMPT (between the markers, exclusive):
<<<PROMPT_START>>>
${prompt}
<<<PROMPT_END>>>`;

const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const DEFAULT_RESTART_BASE_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const THREAD_START_TIMEOUT_MS = 30_000;
const STOP_FORCE_KILL_MS = 2_000;

type ChildProc = ChildProcessByStdio<Writable, Readable, null>;

type ThreadNotificationHandler = (method: string, params: Record<string, unknown>) => void;

interface ImageGenerationResult {
  savedPath?: string;
  result?: string;
  revisedPrompt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AppServerEngine implements ImageEngine {
  private child: ChildProc | undefined;
  private conn: JsonRpcConnection | undefined;
  private connecting: Promise<JsonRpcConnection> | undefined;
  private readonly threadHandlers = new Map<string, ThreadNotificationHandler>();
  private readonly inFlight = new Set<(err: Error) => void>();
  private consecutiveFailures = 0;

  constructor(private readonly opts: AppServerEngineOpts) {}

  async start(): Promise<void> {
    // Lazy by design: the child process is spawned on the first request.
  }

  async generate(req: { prompt: string }): Promise<EngineResult> {
    return this.runTurn(req.prompt, undefined);
  }

  async edit(req: { prompt: string; refImagePaths: string[] }): Promise<EngineResult> {
    return this.runTurn(req.prompt, req.refImagePaths);
  }

  async authStatus(): Promise<AuthStatus> {
    const conn = await this.ensureConnection();
    const res = await conn.request<unknown>('getAuthStatus', {}, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
    const authMethod = isRecord(res) && typeof res['authMethod'] === 'string' ? res['authMethod'] : undefined;
    if (authMethod === 'chatgpt' || authMethod === 'chatgptAuthTokens') {
      return { loggedIn: true, method: authMethod };
    }
    if (authMethod === 'apikey') {
      return {
        loggedIn: false,
        method: authMethod,
        message: '画像生成には ChatGPT サブスクリプション認証(codex login)が必要です(API キー認証では不可)',
      };
    }
    const status: AuthStatus = { loggedIn: false, message: 'codex login が必要です' };
    if (authMethod !== undefined) {
      status.method = authMethod;
    }
    return status;
  }

  async stop(): Promise<void> {
    const child = this.child;
    const conn = this.conn;
    this.child = undefined;
    this.conn = undefined;
    this.connecting = undefined;
    if (conn) {
      conn.close('エンジンを停止しました');
    }
    const err = new Error('エンジンを停止しました');
    for (const reject of this.inFlight) {
      reject(err);
    }
    this.inFlight.clear();
    this.threadHandlers.clear();
    if (!child || child.exitCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        child.kill('SIGKILL');
      }, STOP_FORCE_KILL_MS);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  private async ensureConnection(): Promise<JsonRpcConnection> {
    if (this.conn) {
      return this.conn;
    }
    if (!this.connecting) {
      this.connecting = this.spawnAndInitialize().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private async spawnAndInitialize(): Promise<JsonRpcConnection> {
    if (this.consecutiveFailures > 0) {
      const base = this.opts.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
      const delay = Math.min(base * 2 ** (this.consecutiveFailures - 1), MAX_RESTART_DELAY_MS);
      await sleep(delay);
    }
    // No cwd option: inherit the process cwd (tests rely on relative fake path).
    const child = spawn(this.opts.codexBin, this.opts.codexArgs ?? ['app-server'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...this.opts.env },
    });
    // Writes to a dead child's stdin emit EPIPE; swallow to avoid crashing the host.
    child.stdin.on('error', () => {});
    const conn = new JsonRpcConnection(child.stdin, child.stdout);
    conn.onNotification((method, params) => {
      this.dispatchNotification(method, params);
    });
    child.once('error', () => {
      this.handleUnexpectedExit(child, conn);
    });
    child.once('exit', () => {
      this.handleUnexpectedExit(child, conn);
    });
    this.child = child;
    try {
      await conn.request(
        'initialize',
        { clientInfo: { name: 'imagegen-server', title: 'imagegen-server', version: '0.1.0' } },
        { timeoutMs: HANDSHAKE_TIMEOUT_MS },
      );
      conn.notify('initialized');
    } catch (err) {
      if (this.child === child) {
        // Exit handler has not cleaned up yet (e.g. handshake timeout).
        this.consecutiveFailures += 1;
        this.child = undefined;
        this.conn = undefined;
        conn.close('initialize に失敗しました');
        child.kill('SIGKILL');
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
    // Publish the connection only after the handshake completed (initialize
    // response received and the "initialized" notification sent). Concurrent
    // first callers therefore always await the shared this.connecting promise
    // and can never grab a half-initialized connection.
    this.conn = conn;
    this.consecutiveFailures = 0;
    return conn;
  }

  private handleUnexpectedExit(child: ChildProc, conn: JsonRpcConnection): void {
    if (this.child !== child) {
      return; // stop() or a newer child already took over
    }
    this.child = undefined;
    this.conn = undefined;
    this.consecutiveFailures += 1;
    conn.close('app-server プロセスが終了しました');
    const err = new Error('app-server プロセスが予期せず終了しました');
    for (const reject of this.inFlight) {
      reject(err);
    }
    this.inFlight.clear();
    this.threadHandlers.clear();
  }

  private dispatchNotification(method: string, params: unknown): void {
    if (!isRecord(params)) {
      return;
    }
    const threadId = params['threadId'];
    if (typeof threadId !== 'string') {
      return;
    }
    const handler = this.threadHandlers.get(threadId);
    if (handler) {
      handler(method, params);
    }
  }

  private async runTurn(prompt: string, refPaths: string[] | undefined): Promise<EngineResult> {
    const conn = await this.ensureConnection();
    let inFlightReject: ((err: Error) => void) | undefined;
    let threadId: string | undefined;
    try {
      return await new Promise<EngineResult>((resolve, reject) => {
        inFlightReject = reject;
        this.inFlight.add(reject);
        this.executeTurn(conn, prompt, refPaths, (id) => {
          threadId = id;
        }).then(resolve, reject);
      });
    } finally {
      if (inFlightReject) {
        this.inFlight.delete(inFlightReject);
      }
      if (threadId !== undefined) {
        this.threadHandlers.delete(threadId);
      }
    }
  }

  private async executeTurn(
    conn: JsonRpcConnection,
    prompt: string,
    refPaths: string[] | undefined,
    onThreadId: (threadId: string) => void,
  ): Promise<EngineResult> {
    const threadParams: Record<string, unknown> = {
      cwd: this.opts.workDir,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
    };
    if (this.opts.turnModel !== undefined) {
      threadParams['model'] = this.opts.turnModel;
    }
    const startResult = await conn.request<unknown>('thread/start', threadParams, {
      timeoutMs: THREAD_START_TIMEOUT_MS,
    });
    const threadId = this.readThreadId(startResult);
    onThreadId(threadId);

    const agentTexts: string[] = [];
    let image: ImageGenerationResult | undefined;
    const turnDone = new Promise<void>((resolve, reject) => {
      this.threadHandlers.set(threadId, (method, params) => {
        if (method === 'item/completed') {
          const item = params['item'];
          if (!isRecord(item)) {
            return;
          }
          // Completion is signalled by the item/completed method itself, not by
          // the item's status string. Real codex (0.139.0) emits the terminal
          // imageGeneration item with status "generating" (not "completed"),
          // carrying the full result and savedPath. So accept any imageGeneration
          // item/completed and let result/savedPath presence be the real gate.
          if (item['type'] === 'imageGeneration') {
            image = {
              savedPath: typeof item['savedPath'] === 'string' ? item['savedPath'] : undefined,
              result: typeof item['result'] === 'string' ? item['result'] : undefined,
              revisedPrompt: typeof item['revisedPrompt'] === 'string' ? item['revisedPrompt'] : undefined,
            };
          } else if (item['type'] === 'agentMessage') {
            agentTexts.push(typeof item['text'] === 'string' ? item['text'] : JSON.stringify(item));
          }
          return;
        }
        if (method === 'turn/completed') {
          const turn = params['turn'];
          const status = isRecord(turn) ? turn['status'] : undefined;
          if (status === 'completed') {
            resolve();
            return;
          }
          if (status === 'failed') {
            const error = isRecord(turn) ? turn['error'] : undefined;
            const message =
              isRecord(error) && typeof error['message'] === 'string'
                ? error['message']
                : 'ターンが失敗しました(詳細不明)';
            reject(new Error(message));
            return;
          }
          reject(new Error(`ターンが完了しませんでした(status: ${String(status)})`));
        }
      });
    });

    const timeoutMs = this.opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    let turnId: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // turn/interrupt requires BOTH threadId and turnId; the success
        // response is an empty object. Fire-and-forget: do not await it.
        // If the turn/start response has not arrived yet, there is no turnId,
        // so skip the interrupt and just reject.
        if (turnId !== undefined) {
          conn.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5_000 }).catch(() => {});
        }
        reject(new Error(`ターンが ${timeoutMs}ms 以内に完了しませんでした(タイムアウト)`));
      }, timeoutMs);
    });

    try {
      await Promise.race([
        (async () => {
          const turnStarted = await conn.request<unknown>(
            'turn/start',
            { threadId, input: [{ type: 'text', text: TURN_INSTRUCTION(prompt, refPaths) }] },
            { timeoutMs },
          );
          turnId = this.readTurnId(turnStarted);
          await turnDone;
        })(),
        timedOut,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    if (image === undefined) {
      const detail = agentTexts.join('\n').trim();
      throw new Error(
        detail.length > 0
          ? `モデルが imagegen ツールを呼びませんでした: ${detail}`
          : 'モデルが imagegen ツールを呼びませんでした',
      );
    }
    return this.collectResult(image);
  }

  private async collectResult(image: ImageGenerationResult): Promise<EngineResult> {
    const pngPath = join(this.opts.tmpDir, `${randomUUID()}.png`);
    if (image.savedPath !== undefined) {
      try {
        await copyFile(image.savedPath, pngPath);
        return this.buildResult(pngPath, image.revisedPrompt);
      } catch {
        // savedPath が読めない場合は base64 にフォールバックする
      }
    }
    if (image.result !== undefined && image.result.length > 0) {
      await writeFile(pngPath, Buffer.from(image.result, 'base64'));
      return this.buildResult(pngPath, image.revisedPrompt);
    }
    throw new Error('imageGeneration アイテムから画像を取得できませんでした(savedPath も result もありません)');
  }

  private buildResult(pngPath: string, revisedPrompt: string | undefined): EngineResult {
    const result: EngineResult = { pngPath };
    if (revisedPrompt !== undefined) {
      result.revisedPrompt = revisedPrompt;
    }
    return result;
  }

  private readThreadId(result: unknown): string {
    if (isRecord(result)) {
      const thread = result['thread'];
      if (isRecord(thread) && typeof thread['id'] === 'string') {
        return thread['id'];
      }
    }
    throw new Error('thread/start の応答に thread.id が含まれていません');
  }

  private readTurnId(result: unknown): string {
    if (isRecord(result)) {
      const turn = result['turn'];
      if (isRecord(turn) && typeof turn['id'] === 'string') {
        return turn['id'];
      }
    }
    throw new Error('turn/start の応答に turn.id が含まれていません');
  }
}
