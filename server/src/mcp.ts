import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ImageMeta, Job, JobKind, JobRequest } from '@imagegen/shared';
import type { JobQueue } from './queue.js';
import type { ImageStore } from './store.js';

export interface McpDeps {
  queue: JobQueue;
  store: ImageStore;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const MAX_REF_IMAGES = 5;
const ALLOWED_REF_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Same shape as a list_recent_images entry: full ImageMeta plus the absolute file path. */
type GeneratedImageEntry = ImageMeta & { path: string };

interface FailedEntry {
  error: string;
}

/**
 * Validates reference image paths before any job is submitted.
 * Returns a Japanese error message, or undefined when all paths are valid.
 * Intentionally duplicates the REST API validation (Task 7) — about 10 lines
 * kept inline instead of a shared module, so the two layers stay independent.
 */
function validateRefImagePaths(paths: string[]): string | undefined {
  if (paths.length > MAX_REF_IMAGES) {
    return 'ref_image_paths は最大 5 件までです';
  }
  for (const p of paths) {
    const ext = extname(p).toLowerCase();
    if (!ALLOWED_REF_EXTENSIONS.has(ext)) {
      return `参照画像の拡張子は .png / .jpg / .jpeg / .webp のいずれかにしてください: ${p}`;
    }
    if (!existsSync(p)) {
      return `参照画像が見つかりません: ${p}`;
    }
  }
  return undefined;
}

/**
 * Resolves when the job reaches a terminal state (succeeded/failed), or rejects
 * if the optional signal aborts first (e.g. the MCP client disconnected). The
 * 'update' listener is always removed on settle so listeners cannot accumulate.
 */
function waitForJob(queue: JobQueue, jobId: string, signal?: AbortSignal): Promise<Job> {
  return new Promise((resolve, reject) => {
    const current = queue.get(jobId);
    if (current !== undefined && (current.state === 'succeeded' || current.state === 'failed')) {
      resolve(current);
      return;
    }
    if (signal?.aborted === true) {
      reject(new Error('クライアントが切断されました'));
      return;
    }
    const onUpdate = (job: Job): void => {
      if (job.id === jobId && (job.state === 'succeeded' || job.state === 'failed')) {
        cleanup();
        resolve(job);
      }
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error('クライアントが切断されました'));
    };
    const cleanup = (): void => {
      queue.off('update', onUpdate);
      signal?.removeEventListener('abort', onAbort);
    };
    queue.on('update', onUpdate);
    signal?.addEventListener('abort', onAbort);
  });
}

function registerTools(server: McpServer, deps: McpDeps, signal?: AbortSignal): void {
  server.registerTool(
    'generate_image',
    {
      title: '画像生成',
      description:
        'プロンプトから画像を生成する。ref_image_paths(最大5)を渡すと参照画像を使った編集になる。' +
        '全ジョブの完了までブロックし、保存済み PNG の絶対パスとメタを JSON 文字列で返す。',
      inputSchema: {
        prompt: z.string().min(1),
        count: z.number().int().min(1).max(10).optional(),
        ref_image_paths: z.array(z.string()).max(5).optional(),
      },
    },
    async ({ prompt, count, ref_image_paths }) => {
      const refImagePaths = ref_image_paths ?? [];
      const validationError = validateRefImagePaths(refImagePaths);
      if (validationError !== undefined) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${validationError}` }],
          isError: true,
        };
      }
      const kind: JobKind = refImagePaths.length > 0 ? 'edit' : 'generate';
      const total = count ?? 1;
      const jobs: Job[] = [];
      for (let i = 0; i < total; i += 1) {
        const request: JobRequest =
          kind === 'edit' ? { kind, prompt, refImagePaths } : { kind, prompt };
        jobs.push(deps.queue.submit(request));
      }
      const finished = await Promise.all(
        jobs.map((job) => waitForJob(deps.queue, job.id, signal)),
      );
      const images: GeneratedImageEntry[] = [];
      const failed: FailedEntry[] = [];
      for (const job of finished) {
        if (job.state === 'succeeded' && job.imageId !== undefined) {
          const meta = await deps.store.get(job.imageId);
          if (meta === undefined) {
            failed.push({ error: `画像メタデータが見つかりません: ${job.imageId}` });
            continue;
          }
          // Same entry shape as list_recent_images: full ImageMeta + absolute path
          const entry: GeneratedImageEntry = {
            ...meta,
            path: deps.store.imagePath(job.imageId),
          };
          images.push(entry);
        } else {
          failed.push({ error: job.error ?? '原因不明のエラーで失敗しました' });
        }
      }
      const text = JSON.stringify({ images, failed });
      if (images.length === 0) {
        return { content: [{ type: 'text' as const, text }], isError: true };
      }
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.registerTool(
    'list_recent_images',
    {
      title: '最近の画像一覧',
      description: '生成済み画像のメタデータと絶対パスを新しい順に JSON 文字列で返す。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ limit }) => {
      const metas = await deps.store.list(limit);
      const entries = metas.map((meta) => ({ ...meta, path: deps.store.imagePath(meta.id) }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(entries) }] };
    },
  );
}

export function createMcpServer(deps: McpDeps, signal?: AbortSignal): McpServer {
  const server = new McpServer({ name: 'imagegen-server', version: '0.1.0' });
  registerTools(server, deps, signal);
  return server;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('リクエストボディが大きすぎます(上限 1MB)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('リクエストボディが JSON として不正です'));
      }
    });
    req.on('error', reject);
  });
}

export function createMcpHandler(
  deps: McpDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        }),
      );
      return;
    }
    // Stateless: a fresh server + transport per POST request.
    // Abort in-flight waitForJob calls when the client disconnects, so the
    // queue's 'update' listeners do not accumulate across slow requests.
    const abortController = new AbortController();
    const server = createMcpServer(deps, abortController.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      abortController.abort();
      void transport.close();
      void server.close();
    });
    try {
      const body = await readJsonBody(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : '内部エラーが発生しました';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null }),
        );
      }
    }
  };
}
