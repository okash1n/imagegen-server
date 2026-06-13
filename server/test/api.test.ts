import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { ImageMeta, Job, JobState } from '@imagegen/shared';
import { createApi } from '../src/api.js';
import { JobQueue, type JobRunner } from '../src/queue.js';
import { ImageStore } from '../src/store.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'));

interface Deferred {
  job: Job;
  resolve: (result: { imageId: string }) => void;
  reject: (err: Error) => void;
}

let app: Hono;
let queue: JobQueue;
let store: ImageStore;
let tmpRoot: string;
let uploadsDir: string;
let deferreds: Deferred[];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'imagegen-api-'));
  uploadsDir = join(tmpRoot, 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  store = new ImageStore(join(tmpRoot, 'images'));
  deferreds = [];
  const runner: JobRunner = (job) =>
    new Promise<{ imageId: string }>((resolve, reject) => {
      deferreds.push({ job, resolve, reject });
    });
  queue = new JobQueue({ concurrency: 3, runner });
  app = createApi({
    queue,
    store,
    engine: { authStatus: async () => ({ loggedIn: true, method: 'chatgpt' }) },
    uploadsDir,
  });
});

function writeTempPng(name: string): string {
  const p = join(tmpRoot, name);
  writeFileSync(p, PNG_BYTES);
  return p;
}

function waitForState(id: string, state: JobState): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (queue.get(id)?.state === state) {
        queue.off('update', check);
        resolve();
      }
    };
    queue.on('update', check);
    check();
  });
}

function postJson(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json()) as { error: string };
  return body.error;
}

describe('POST /api/jobs', () => {
  it('prompt が空なら 400 と日本語エラーを返す', async () => {
    const res = await postJson('/api/jobs', { prompt: '' });
    expect(res.status).toBe(400);
    expect(await readError(res)).toBe('prompt は必須です(空文字は指定できません)');
  });

  it('count が 0 なら 400 を返す', async () => {
    const res = await postJson('/api/jobs', { prompt: 'a cat', count: 0 });
    expect(res.status).toBe(400);
    expect(await readError(res)).toBe('count は 1〜10 の整数で指定してください');
  });

  it('count が 11 なら 400 を返す', async () => {
    const res = await postJson('/api/jobs', { prompt: 'a cat', count: 11 });
    expect(res.status).toBe(400);
    expect(await readError(res)).toBe('count は 1〜10 の整数で指定してください');
  });

  it('kind=edit で refImagePaths が無ければ 400 を返す', async () => {
    const res = await postJson('/api/jobs', { kind: 'edit', prompt: 'make it blue' });
    expect(res.status).toBe(400);
    expect(await readError(res)).toContain('refImagePaths');
  });

  it('参照画像のパスが存在しなければ 400 を返す', async () => {
    const missing = join(tmpRoot, 'missing.png');
    const res = await postJson('/api/jobs', {
      kind: 'edit',
      prompt: 'make it blue',
      refImagePaths: [missing],
    });
    expect(res.status).toBe(400);
    expect(await readError(res)).toBe(`参照画像が見つかりません: ${missing}`);
  });

  it('参照画像の拡張子が許可外なら 400 を返す', async () => {
    const gif = join(tmpRoot, 'ref.gif');
    writeFileSync(gif, PNG_BYTES);
    const res = await postJson('/api/jobs', {
      kind: 'edit',
      prompt: 'make it blue',
      refImagePaths: [gif],
    });
    expect(res.status).toBe(400);
    expect(await readError(res)).toContain('拡張子');
  });

  it('count=3 なら 201 で 3 件の Job を返す', async () => {
    const res = await postJson('/api/jobs', { prompt: 'a watercolor cat', count: 3 });
    expect(res.status).toBe(201);
    const jobs = (await res.json()) as Job[];
    expect(jobs).toHaveLength(3);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(3);
    for (const job of jobs) {
      expect(job.kind).toBe('generate');
      expect(job.prompt).toBe('a watercolor cat');
      // submit 直後に drain が走るため queued か running のどちらか
      expect(['queued', 'running']).toContain(job.state);
    }
  });
});

describe('GET /api/jobs', () => {
  it('submit 済みの全ジョブを返す', async () => {
    const created = await postJson('/api/jobs', { prompt: 'list me', count: 2 });
    const submitted = (await created.json()) as Job[];
    const res = await app.request('/api/jobs');
    expect(res.status).toBe(200);
    const jobs = (await res.json()) as Job[];
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.id))).toEqual(new Set(submitted.map((j) => j.id)));
  });
});

describe('POST /api/jobs/:id/retry', () => {
  it('存在しない id なら 404 を返す', async () => {
    const res = await app.request('/api/jobs/no-such-id/retry', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await readError(res)).toBe('ジョブが見つかりません');
  });

  it('failed でないジョブなら 409 を返す', async () => {
    const created = await postJson('/api/jobs', { prompt: 'still running' });
    const createdJobs = (await created.json()) as Job[];
    const job = createdJobs[0]!;
    await waitForState(job.id, 'running');
    const res = await app.request(`/api/jobs/${job.id}/retry`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await readError(res)).toBe('failed 状態のジョブのみリトライできます');
  });

  it('failed のジョブなら 201 で新しい Job を返す', async () => {
    const created = await postJson('/api/jobs', { prompt: 'will fail' });
    const createdJobs = (await created.json()) as Job[];
    const job = createdJobs[0]!;
    await waitForState(job.id, 'running');
    expect(deferreds).toHaveLength(1);
    deferreds[0]?.reject(new Error('エンジン故障'));
    await waitForState(job.id, 'failed');
    const res = await app.request(`/api/jobs/${job.id}/retry`, { method: 'POST' });
    expect(res.status).toBe(201);
    const retried = (await res.json()) as Job;
    expect(retried.id).not.toBe(job.id);
    expect(retried.prompt).toBe('will fail');
    expect(retried.kind).toBe('generate');
  });
});

describe('GET /api/images', () => {
  async function seedImage(createdAt: string): Promise<ImageMeta> {
    const meta: ImageMeta = {
      id: randomUUID(),
      kind: 'generate',
      prompt: 'seeded image',
      createdAt,
      durationMs: 1200,
      engine: 'app-server',
    };
    await store.save(meta, writeTempPng(`seed-${meta.id}.png`));
    return meta;
  }

  it('メタ一覧を createdAt 降順で返し limit を適用する', async () => {
    const older = await seedImage('2026-06-13T00:00:00.000Z');
    const newer = await seedImage('2026-06-13T01:00:00.000Z');
    const all = await app.request('/api/images');
    expect(all.status).toBe(200);
    const metas = (await all.json()) as ImageMeta[];
    expect(metas.map((m) => m.id)).toEqual([newer.id, older.id]);

    const limited = await app.request('/api/images?limit=1');
    expect(limited.status).toBe(200);
    const limitedMetas = (await limited.json()) as ImageMeta[];
    expect(limitedMetas.map((m) => m.id)).toEqual([newer.id]);
  });

  it('GET /api/images/:id は PNG バイナリを返す', async () => {
    const meta = await seedImage('2026-06-13T02:00:00.000Z');
    const res = await app.request(`/api/images/${meta.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(body).toString('base64')).toBe(PNG_BASE64);
  });

  it('存在しない id なら 404 を返す', async () => {
    const res = await app.request('/api/images/123e4567-e89b-12d3-a456-426614174000');
    expect(res.status).toBe(404);
  });

  it('UUID 形式でない id なら 400 を返す', async () => {
    const res = await app.request('/api/images/NOT_A_UUID');
    expect(res.status).toBe(400);
  });

  it('各アイテムにサーバー側絶対パス path を含める(GUI の再生成・コピー用)', async () => {
    const meta = await seedImage('2026-06-13T03:00:00.000Z');
    const res = await app.request('/api/images');
    expect(res.status).toBe(200);
    const items = (await res.json()) as Array<ImageMeta & { path: string }>;
    const item = items.find((m) => m.id === meta.id);
    expect(item?.path).toBe(store.imagePath(meta.id));
  });
});

describe('POST /api/uploads', () => {
  async function upload(name: string): Promise<Response> {
    const form = new FormData();
    form.append('file', new File([PNG_BYTES], name, { type: 'application/octet-stream' }));
    return app.request('/api/uploads', { method: 'POST', body: form });
  }

  it('.png を uploadsDir に保存しパスを返す', async () => {
    const res = await upload('sample.png');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string };
    expect(dirname(body.path)).toBe(uploadsDir);
    expect(body.path.endsWith('.png')).toBe(true);
    expect(existsSync(body.path)).toBe(true);
  });

  it('.webp など許可された拡張子を維持する', async () => {
    const res = await upload('texture.webp');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string };
    expect(body.path.endsWith('.webp')).toBe(true);
  });

  it('許可されない拡張子なら 400 を返す', async () => {
    const res = await upload('malware.exe');
    expect(res.status).toBe(400);
    expect(await readError(res)).toContain('拡張子');
  });

  it('file フィールドが無ければ 400 を返す', async () => {
    const form = new FormData();
    form.append('note', 'no file here');
    const res = await app.request('/api/uploads', { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/health', () => {
  it('認証状態とキュー件数を返す', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      auth: { loggedIn: true, method: 'chatgpt' },
      queuedJobs: 0,
      runningJobs: 0,
    });
  });

  it('running / queued の件数を反映する', async () => {
    // concurrency 3 のキューに 4 件投入 → FIFO なので先頭 3 件が running、1 件が queued
    const created = await postJson('/api/jobs', { prompt: 'busy', count: 4 });
    const jobs = (await created.json()) as Job[];
    await Promise.all(jobs.slice(0, 3).map((j) => waitForState(j.id, 'running')));
    const res = await app.request('/api/health');
    const health = (await res.json()) as { queuedJobs: number; runningJobs: number };
    expect(health.runningJobs).toBe(3);
    expect(health.queuedJobs).toBe(1);
  });
});

describe('GET /api/events', () => {
  // NOTE: ここでは「接続直後に既存ジョブのスナップショットが SSE で届く」ことだけを
  // 検証する。queue 'update' のライブ配信・切断時の購読解除を含むフルの SSE 挙動は、
  // Task 9 の起動煙テストと手動確認(GUI 結線時)でカバーする。
  it('接続時に既存ジョブを event: job で送る', async () => {
    const created = await postJson('/api/jobs', { prompt: 'sse snapshot' });
    const createdJobs = (await created.json()) as Job[];
    const job = createdJobs[0]!;

    const res = await app.request('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    // 最初の SSE フレーム(空行区切り)が揃うまで読む
    while (!text.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain('event: job');
    expect(text).toContain(job.id);
    await reader.cancel();
  });
});
