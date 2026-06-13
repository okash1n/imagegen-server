import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { HealthResponse, Job } from '@imagegen/shared';
import type { Config } from '../src/config.js';
import { composeServer } from '../src/index.js';
import type { ComposedServer } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAppServerPath = path.join(here, 'fake-appserver.mjs');

describe('統合スモーク(composeServer + 偽 app-server)', () => {
  let dataDir: string;
  let composed: ComposedServer;
  let baseUrl: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'imagegen-it-'));
    const config: Config = {
      port: 0,
      host: '127.0.0.1',
      concurrency: 2,
      dataDir,
      codexBin: process.execPath,
    };
    composed = composeServer(config, {
      codexBin: process.execPath,
      codexArgs: [fakeAppServerPath],
      env: { FAKE_SCENARIO: 'happy' },
    });
    await new Promise<void>((resolve) => {
      composed.server.listen(config.port, config.host, () => resolve());
    });
    const address = composed.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await composed.engine.stop();
    await new Promise<void>((resolve, reject) => {
      composed.server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('POST /api/jobs → succeeded → GET /api/images/:id が PNG を返す', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Job[];
    expect(created).toHaveLength(1);
    const first = created[0];
    if (!first) throw new Error('ジョブが返らなかった');
    const jobId = first.id;
    expect(first.state).toBe('queued');

    const deadline = Date.now() + 5_000;
    let job: Job | undefined;
    while (Date.now() < deadline) {
      const listRes = await fetch(`${baseUrl}/api/jobs`);
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Job[];
      job = list.find((j) => j.id === jobId);
      if (job && (job.state === 'succeeded' || job.state === 'failed')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(job?.state).toBe('succeeded');
    expect(job?.imageId).toBe(jobId);

    const imageRes = await fetch(`${baseUrl}/api/images/${jobId}`);
    expect(imageRes.status).toBe(200);
    expect(imageRes.headers.get('content-type')).toContain('image/png');
    const body = new Uint8Array(await imageRes.arrayBuffer());
    expect(body.byteLength).toBeGreaterThan(0);
  }, 15_000);

  it('GET /api/events が接続直後に初期スナップショットを 1 フレーム配信する', async () => {
    // The endpoint sends one `event: job` frame per existing job on connect.
    // Create a job first so the initial snapshot is guaranteed non-empty.
    const postRes = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'sse snapshot' }),
    });
    expect(postRes.status).toBe(201);

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    if (!res.body) throw new Error('SSE のレスポンス body が空');
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: job');
    // Live updates are covered by the Task 10 manual browser check; abort here.
    await reader.cancel().catch(() => undefined);
    controller.abort();
  }, 10_000);

  it('GET /api/health が ok を返す', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const health = (await res.json()) as HealthResponse;
    expect(health.ok).toBe(true);
    expect(health.auth.loggedIn).toBe(true);
  });

  it('GET /mcp は 405 を返す', async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(405);
  });
});
