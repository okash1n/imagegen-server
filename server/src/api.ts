import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AuthStatus, HealthResponse, Job, JobRequest } from '@imagegen/shared';
import type { ImageEngine } from './engine/types.js';
import type { JobQueue } from './queue.js';
import type { ImageStore } from './store.js';

export interface ApiDeps {
  queue: JobQueue;
  store: ImageStore;
  /** api uses only authStatus; a full ImageEngine is assignable as-is */
  engine: Pick<ImageEngine, 'authStatus'>;
  uploadsDir: string;
}

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_REF_IMAGES = 5;

type ParsedCreateJobs =
  | { ok: true; request: JobRequest; count: number }
  | { ok: false; error: string };

/** Validates a CreateJobsRequest-shaped body (shared §2). */
function parseCreateJobsBody(body: unknown): ParsedCreateJobs {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'リクエストボディは JSON オブジェクトで指定してください' };
  }
  const b = body as Record<string, unknown>;

  const kindRaw = b['kind'];
  if (kindRaw !== undefined && kindRaw !== 'generate' && kindRaw !== 'edit') {
    return { ok: false, error: "kind は 'generate' または 'edit' を指定してください" };
  }
  const kind = kindRaw === 'edit' ? 'edit' : 'generate';

  const prompt = b['prompt'];
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, error: 'prompt は必須です(空文字は指定できません)' };
  }

  const countRaw = b['count'];
  const count = countRaw === undefined ? 1 : countRaw;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 10) {
    return { ok: false, error: 'count は 1〜10 の整数で指定してください' };
  }

  const refsRaw = b['refImagePaths'];
  let refImagePaths: string[] | undefined;
  if (refsRaw !== undefined) {
    if (!Array.isArray(refsRaw) || !refsRaw.every((p): p is string => typeof p === 'string')) {
      return { ok: false, error: 'refImagePaths は文字列の配列で指定してください' };
    }
    refImagePaths = refsRaw;
  }

  if (kind === 'edit') {
    if (!refImagePaths || refImagePaths.length === 0) {
      return { ok: false, error: "kind が 'edit' の場合は refImagePaths を 1 件以上指定してください" };
    }
    if (refImagePaths.length > MAX_REF_IMAGES) {
      return { ok: false, error: 'refImagePaths は最大 5 件までです' };
    }
    for (const p of refImagePaths) {
      const ext = extname(p).toLowerCase();
      if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
        return {
          ok: false,
          error: `参照画像の拡張子は .png / .jpg / .jpeg / .webp のいずれかにしてください: ${p}`,
        };
      }
      if (!existsSync(p)) {
        return { ok: false, error: `参照画像が見つかりません: ${p}` };
      }
    }
    return { ok: true, request: { kind, prompt, refImagePaths }, count };
  }
  return { ok: true, request: { kind, prompt }, count };
}

export function createApi(deps: ApiDeps): Hono {
  const app = new Hono();

  app.post('/api/jobs', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'リクエストボディを JSON として解釈できません' }, 400);
    }
    const parsed = parseCreateJobsBody(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }
    const jobs: Job[] = [];
    for (let i = 0; i < parsed.count; i += 1) {
      jobs.push(deps.queue.submit(parsed.request));
    }
    return c.json(jobs, 201);
  });

  app.get('/api/jobs', (c) => c.json(deps.queue.list()));

  app.post('/api/jobs/:id/retry', (c) => {
    const id = c.req.param('id');
    const job = deps.queue.get(id);
    if (!job) {
      return c.json({ error: 'ジョブが見つかりません' }, 404);
    }
    if (job.state !== 'failed') {
      return c.json({ error: 'failed 状態のジョブのみリトライできます' }, 409);
    }
    return c.json(deps.queue.retry(id), 201);
  });

  app.get('/api/images', async (c) => {
    const limitRaw = c.req.query('limit');
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1) {
        return c.json({ error: 'limit は 1 以上の整数で指定してください' }, 400);
      }
      limit = n;
    }
    return c.json(await deps.store.list(limit));
  });

  app.get('/api/images/:id', async (c) => {
    const id = c.req.param('id');
    let filePath: string;
    try {
      filePath = deps.store.imagePath(id); // throws on non-UUID ids
    } catch {
      return c.json({ error: '画像 ID が不正です' }, 400);
    }
    if (!existsSync(filePath)) {
      return c.json({ error: '画像が見つかりません' }, 404);
    }
    const data = await readFile(filePath);
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    });
  });

  app.post('/api/uploads', async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'multipart/form-data 形式で送信してください' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: 'file フィールドにファイルを指定してください' }, 400);
    }
    const ext = extname(file.name).toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
      return c.json({ error: 'アップロードできる拡張子は .png / .jpg / .jpeg / .webp のみです' }, 400);
    }
    const destPath = join(deps.uploadsDir, `${randomUUID()}${ext}`);
    await writeFile(destPath, new Uint8Array(await file.arrayBuffer()));
    return c.json({ path: destPath }, 201);
  });

  app.get('/api/health', async (c) => {
    let auth: AuthStatus;
    try {
      auth = await deps.engine.authStatus();
    } catch (err) {
      auth = {
        loggedIn: false,
        message: `認証状態の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const jobs = deps.queue.list();
    const health: HealthResponse = {
      ok: auth.loggedIn,
      auth,
      queuedJobs: jobs.filter((j) => j.state === 'queued').length,
      runningJobs: jobs.filter((j) => j.state === 'running').length,
    };
    return c.json(health);
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      // initial snapshot: all current jobs as `event: job`
      for (const job of deps.queue.list()) {
        await stream.writeSSE({ event: 'job', data: JSON.stringify(job) });
      }
      const onUpdate = (job: Job): void => {
        stream.writeSSE({ event: 'job', data: JSON.stringify(job) }).catch(() => {
          // client is gone; cleanup happens via onAbort
        });
      };
      deps.queue.on('update', onUpdate);
      // hold the stream open until the client disconnects
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          deps.queue.off('update', onUpdate);
          resolve();
        });
      });
    }),
  );

  return app;
}
