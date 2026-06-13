import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ImageMeta } from '@imagegen/shared';
import { JobQueue, type JobRunner } from '../src/queue.js';
import { ImageStore } from '../src/store.js';
import { createMcpHandler, createMcpServer } from '../src/mcp.js';

// Real 1x1 PNG (same constant as fake-appserver)
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    await fn();
  }
  cleanups = [];
});

async function makeBaseDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'mcp-test-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  return base;
}

async function writeSourcePng(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, Buffer.from(PNG_1X1_BASE64, 'base64'));
  return path;
}

interface Ctx {
  store: ImageStore;
  queue: JobQueue;
  client: Client;
  srcDir: string;
  /** kinds the runner observed, in call order */
  kinds: string[];
}

interface SetupOpts {
  /** every runner call throws */
  alwaysFail?: boolean;
  /** the N-th runner call (1-based) throws */
  failOnCall?: number;
}

async function setup(opts: SetupOpts = {}): Promise<Ctx> {
  const base = await makeBaseDir();
  const srcDir = join(base, 'src');
  await mkdir(srcDir, { recursive: true });
  const store = new ImageStore(join(base, 'images'));
  const kinds: string[] = [];
  let calls = 0;
  const runner: JobRunner = async (job) => {
    calls += 1;
    kinds.push(job.kind);
    if (opts.alwaysFail === true) {
      throw new Error('生成に失敗しました');
    }
    if (opts.failOnCall !== undefined && calls === opts.failOnCall) {
      throw new Error('2件目の生成に失敗しました');
    }
    const src = await writeSourcePng(srcDir, `${job.id}-src.png`);
    const meta: ImageMeta = {
      id: job.id,
      kind: job.kind,
      prompt: job.prompt,
      revisedPrompt: `revised: ${job.prompt}`,
      createdAt: new Date().toISOString(),
      durationMs: 5,
      engine: 'app-server',
    };
    if (job.refImagePaths !== undefined) {
      meta.refImagePaths = job.refImagePaths;
    }
    await store.save(meta, src);
    return { imageId: job.id };
  };
  const queue = new JobQueue({ concurrency: 2, runner });
  const server = createMcpServer({ queue, store });
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(() => client.close());
  return { store, queue, client, srcDir, kinds };
}

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

function asToolResult(value: unknown): ToolResult {
  return value as ToolResult;
}

function firstText(result: ToolResult): string {
  const text = result.content[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('text コンテンツがありません');
  }
  return text;
}

interface GenerateResultBody {
  // Success entries share the list_recent_images shape: full ImageMeta + path
  images: (ImageMeta & { path: string })[];
  failed: { error: string }[];
}

async function callGenerate(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ result: ToolResult; body: GenerateResultBody }> {
  const result = asToolResult(await client.callTool({ name: 'generate_image', arguments: args }));
  return { result, body: JSON.parse(firstText(result)) as GenerateResultBody };
}

describe('createMcpServer', () => {
  it('generate_image と list_recent_images がツール一覧に載る', async () => {
    const ctx = await setup();
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['generate_image', 'list_recent_images']);
  });

  it('generate_image: 1件成功で ImageMeta 全体と実在する PNG の絶対パスを返す', async () => {
    const ctx = await setup();
    const { result, body } = await callGenerate(ctx.client, { prompt: '水彩画の猫' });
    expect(result.isError).not.toBe(true);
    expect(body.failed).toEqual([]);
    expect(body.images).toHaveLength(1);
    const image = body.images[0]!;
    expect(image.prompt).toBe('水彩画の猫');
    expect(image.revisedPrompt).toBe('revised: 水彩画の猫');
    expect(image.kind).toBe('generate');
    expect(image.engine).toBe('app-server');
    expect(image.path).toBe(ctx.store.imagePath(image.id));
    expect(isAbsolute(image.path)).toBe(true);
    await access(image.path); // throws if the file does not exist
  });

  it('generate_image: count 2 で 2 枚の画像を返す', async () => {
    const ctx = await setup();
    const { result, body } = await callGenerate(ctx.client, { prompt: 'dog', count: 2 });
    expect(result.isError).not.toBe(true);
    expect(body.failed).toEqual([]);
    expect(body.images).toHaveLength(2);
    const paths = body.images.map((i) => i.path);
    expect(new Set(paths).size).toBe(2);
    for (const p of paths) {
      await access(p);
    }
  });

  it('generate_image: ref_image_paths があると edit ジョブとして投入される', async () => {
    const ctx = await setup();
    const ref = await writeSourcePng(ctx.srcDir, 'ref.png');
    const { body } = await callGenerate(ctx.client, { prompt: '青くして', ref_image_paths: [ref] });
    expect(body.images).toHaveLength(1);
    expect(ctx.kinds).toEqual(['edit']);
  });

  it('generate_image: 存在しない参照画像パスは isError: true で即エラーを返す', async () => {
    const ctx = await setup();
    const missing = join(ctx.srcDir, 'missing.png');
    const result = asToolResult(
      await ctx.client.callTool({
        name: 'generate_image',
        arguments: { prompt: '青くして', ref_image_paths: [missing] },
      }),
    );
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe(`Error: 参照画像が見つかりません: ${missing}`);
    // Validation rejects before submit, so the runner must never be called
    expect(ctx.kinds).toEqual([]);
  });

  it('generate_image: 全件失敗なら isError: true とエラーメッセージを返す', async () => {
    const ctx = await setup({ alwaysFail: true });
    const { result, body } = await callGenerate(ctx.client, { prompt: 'x', count: 2 });
    expect(result.isError).toBe(true);
    expect(body.images).toEqual([]);
    expect(body.failed).toHaveLength(2);
    expect(body.failed[0]!.error).toBe('生成に失敗しました');
  });

  it('generate_image: 一部失敗は isError なしで failed に載る', async () => {
    const ctx = await setup({ failOnCall: 2 });
    const { result, body } = await callGenerate(ctx.client, { prompt: 'y', count: 2 });
    expect(result.isError).not.toBe(true);
    expect(body.images).toHaveLength(1);
    expect(body.failed).toEqual([{ error: '2件目の生成に失敗しました' }]);
  });

  it('list_recent_images: 保存済みメタに絶対パスを付けて新しい順に返す', async () => {
    const ctx = await setup();
    const older: ImageMeta = {
      id: randomUUID(),
      kind: 'generate',
      prompt: 'older',
      createdAt: '2026-06-13T00:00:00.000Z',
      durationMs: 10,
      engine: 'app-server',
    };
    const newer: ImageMeta = {
      id: randomUUID(),
      kind: 'generate',
      prompt: 'newer',
      createdAt: '2026-06-13T01:00:00.000Z',
      durationMs: 10,
      engine: 'app-server',
    };
    await ctx.store.save(older, await writeSourcePng(ctx.srcDir, 'older.png'));
    await ctx.store.save(newer, await writeSourcePng(ctx.srcDir, 'newer.png'));
    const result = asToolResult(
      await ctx.client.callTool({ name: 'list_recent_images', arguments: { limit: 1 } }),
    );
    const entries = JSON.parse(firstText(result)) as Array<ImageMeta & { path: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(newer.id);
    expect(entries[0]!.prompt).toBe('newer');
    expect(entries[0]!.path).toBe(ctx.store.imagePath(newer.id));
    expect(isAbsolute(entries[0]!.path)).toBe(true);
  });
});

describe('createMcpHandler', () => {
  it('GET /mcp は 405 と JSON-RPC エラーを返す', async () => {
    const base = await makeBaseDir();
    const store = new ImageStore(join(base, 'images'));
    const queue = new JobQueue({
      concurrency: 1,
      runner: async () => ({ imageId: randomUUID() }),
    });
    const handler = createMcpHandler({ queue, store });
    const httpServer: Server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          httpServer.close((err) => (err ? reject(err) : resolve())),
        ),
    );
    const address = httpServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('ポート取得に失敗しました');
    }
    const res = await fetch(`http://127.0.0.1:${address.port}/mcp`);
    expect(res.status).toBe(405);
    const bodyJson = (await res.json()) as { error?: { code?: number; message?: string } };
    expect(bodyJson.error?.code).toBe(-32000);
    expect(bodyJson.error?.message).toBe('Method not allowed.');
  });
});
