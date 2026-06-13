import { describe, expect, it } from 'vitest';
import type { Job } from '@imagegen/shared';
import { JobQueue, type JobRunner } from '../src/queue.js';

/** Manually controllable promise for driving the worker pool in tests. */
class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

/** Flush all pending microtasks (one macrotask turn). */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('JobQueue', () => {
  it('submit は queued の Job を即座に返し、queued→running→succeeded の update をコピーで発火する', async () => {
    const queue = new JobQueue({
      concurrency: 1,
      runner: async () => ({ imageId: 'img-1' }),
    });
    const events: Job[] = [];
    queue.on('update', (job: Job) => events.push(job));

    const job = queue.submit({ kind: 'generate', prompt: 'a watercolor cat' });

    // 戻り値は queued 時点のスナップショット
    expect(job.state).toBe('queued');
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.kind).toBe('generate');
    expect(job.prompt).toBe('a watercolor cat');
    expect(Number.isNaN(Date.parse(job.createdAt))).toBe(false);

    await queue.onIdle();

    // 状態遷移ごとに 1 イベント(queued 含む)
    expect(events.map((e) => e.state)).toEqual(['queued', 'running', 'succeeded']);
    expect(events.every((e) => e.id === job.id)).toBe(true);
    expect(events[2]?.imageId).toBe('img-1');

    // 各イベントはコピー: 後続の状態変化が過去イベントへ波及しない
    expect(events[0]?.state).toBe('queued');
    expect(events[1]?.state).toBe('running');

    // submit の戻り値もコピー: 内部状態は succeeded に進んでいる
    expect(job.state).toBe('queued');
    const after = queue.get(job.id);
    expect(after?.state).toBe('succeeded');
    expect(after?.imageId).toBe('img-1');
    expect(after?.startedAt).toBeDefined();
    expect(after?.finishedAt).toBeDefined();
  });

  it('concurrency 2 では同時実行が最大 2 で、開始順は FIFO(投入順)', async () => {
    const deferreds: Deferred<{ imageId: string }>[] = [];
    const startOrder: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const runner: JobRunner = (job) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      startOrder.push(job.prompt);
      const d = new Deferred<{ imageId: string }>();
      deferreds.push(d);
      return d.promise.finally(() => {
        running -= 1;
      });
    };
    const queue = new JobQueue({ concurrency: 2, runner });
    queue.submit({ kind: 'generate', prompt: 'p1' });
    queue.submit({ kind: 'generate', prompt: 'p2' });
    queue.submit({ kind: 'generate', prompt: 'p3' });
    queue.submit({ kind: 'generate', prompt: 'p4' });

    // submit 直後: 先頭 2 件だけが開始済み
    expect(startOrder).toEqual(['p1', 'p2']);
    expect(maxRunning).toBe(2);

    deferreds[0]?.resolve({ imageId: 'i1' });
    await tick();
    expect(startOrder).toEqual(['p1', 'p2', 'p3']);
    expect(maxRunning).toBe(2);

    deferreds[1]?.resolve({ imageId: 'i2' });
    await tick();
    expect(startOrder).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(maxRunning).toBe(2);

    deferreds[2]?.resolve({ imageId: 'i3' });
    deferreds[3]?.resolve({ imageId: 'i4' });
    await queue.onIdle();
    expect(maxRunning).toBe(2);
    expect(queue.list().every((j) => j.state === 'succeeded')).toBe(true);
  });

  it('runner の reject で failed になり error に err.message が入る', async () => {
    const queue = new JobQueue({
      concurrency: 1,
      runner: async () => {
        throw new Error('エンジンが応答しません');
      },
    });
    const job = queue.submit({ kind: 'generate', prompt: 'x' });
    await queue.onIdle();
    const after = queue.get(job.id);
    expect(after?.state).toBe('failed');
    expect(after?.error).toBe('エンジンが応答しません');
    expect(after?.finishedAt).toBeDefined();
  });

  it('retry は failed ジョブを同パラメータ・別 id の新規ジョブとして再投入し、元ジョブは failed のまま残る', async () => {
    let failNext = true;
    const runner: JobRunner = async () => {
      if (failNext) {
        failNext = false;
        throw new Error('一時的な失敗');
      }
      return { imageId: 'img-retry' };
    };
    const queue = new JobQueue({ concurrency: 1, runner });
    const original = queue.submit({
      kind: 'edit',
      prompt: 'make it blue',
      refImagePaths: ['/tmp/ref.png'],
    });
    await queue.onIdle();
    expect(queue.get(original.id)?.state).toBe('failed');

    const retried = queue.retry(original.id);
    expect(retried.id).not.toBe(original.id);
    expect(retried.state).toBe('queued');
    expect(retried.kind).toBe('edit');
    expect(retried.prompt).toBe('make it blue');
    expect(retried.refImagePaths).toEqual(['/tmp/ref.png']);

    await queue.onIdle();
    expect(queue.get(retried.id)?.state).toBe('succeeded');
    expect(queue.get(retried.id)?.imageId).toBe('img-retry');
    // 元ジョブは failed のまま
    expect(queue.get(original.id)?.state).toBe('failed');
    expect(queue.list()).toHaveLength(2);
  });

  it('failed でないジョブの retry は日本語メッセージで throw する', async () => {
    const d = new Deferred<{ imageId: string }>();
    const queue = new JobQueue({ concurrency: 1, runner: () => d.promise });
    const job = queue.submit({ kind: 'generate', prompt: 'x' });

    // submit 直後は running
    expect(queue.get(job.id)?.state).toBe('running');
    expect(() => queue.retry(job.id)).toThrowError(/failed 状態のジョブのみリトライできます/);

    d.resolve({ imageId: 'i' });
    await queue.onIdle();
    // succeeded でも同様に throw
    expect(() => queue.retry(job.id)).toThrowError(/failed 状態のジョブのみリトライできます/);
  });

  it('存在しない id の retry は日本語メッセージで throw する', () => {
    const queue = new JobQueue({
      concurrency: 1,
      runner: async () => ({ imageId: 'i' }),
    });
    expect(() => queue.retry('no-such-id')).toThrowError(/ジョブが見つかりません/);
  });

  it('list は createdAt 昇順(投入順)で返す', async () => {
    const queue = new JobQueue({
      concurrency: 1,
      runner: async () => ({ imageId: 'i' }),
    });
    const a = queue.submit({ kind: 'generate', prompt: 'a' });
    const b = queue.submit({ kind: 'generate', prompt: 'b' });
    const c = queue.submit({ kind: 'generate', prompt: 'c' });

    expect(queue.list().map((j) => j.id)).toEqual([a.id, b.id, c.id]);
    await queue.onIdle();
    // 完了後も順序は不変
    expect(queue.list().map((j) => j.id)).toEqual([a.id, b.id, c.id]);
    // ISO 8601 文字列は辞書順 = 時刻順
    const created = queue.list().map((j) => j.createdAt);
    expect([...created].sort()).toEqual(created);
  });

  it('onIdle は全ジョブが完了するまで resolve しない', async () => {
    const d1 = new Deferred<{ imageId: string }>();
    const d2 = new Deferred<{ imageId: string }>();
    const promises = [d1.promise, d2.promise];
    let calls = 0;
    const runner: JobRunner = () => {
      const p = promises[calls];
      calls += 1;
      if (p === undefined) throw new Error('想定外の runner 呼び出し');
      return p;
    };
    const queue = new JobQueue({ concurrency: 2, runner });
    queue.submit({ kind: 'generate', prompt: 'x' });
    queue.submit({ kind: 'generate', prompt: 'y' });

    let idle = false;
    const waiting = queue.onIdle().then(() => {
      idle = true;
    });

    d1.resolve({ imageId: 'a' });
    await tick();
    expect(idle).toBe(false); // d2 が未完了なので resolve しない

    d2.resolve({ imageId: 'b' });
    await waiting;
    expect(idle).toBe(true);

    // すでに idle なら即 resolve する
    await queue.onIdle();
  });

  it('concurrency が 1 未満なら日本語メッセージで throw する', () => {
    expect(
      () => new JobQueue({ concurrency: 0, runner: async () => ({ imageId: 'i' }) }),
    ).toThrowError(/concurrency は 1 以上の整数/);
  });
});
