import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Job, JobRequest } from '@imagegen/shared';

export type JobRunner = (job: Job) => Promise<{ imageId: string }>;

export class JobQueue extends EventEmitter {
  private readonly concurrency: number;
  private readonly runner: JobRunner;
  /** Insertion order == createdAt ascending. */
  private readonly jobs = new Map<string, Job>();
  /** FIFO of job ids waiting to run. */
  private readonly pending: string[] = [];
  private runningCount = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(opts: { concurrency: number; runner: JobRunner }) {
    super();
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
      throw new Error(`concurrency は 1 以上の整数を指定してください: ${String(opts.concurrency)}`);
    }
    this.concurrency = opts.concurrency;
    this.runner = opts.runner;
  }

  submit(req: JobRequest): Job {
    const job: Job = {
      id: randomUUID(),
      kind: req.kind,
      prompt: req.prompt,
      state: 'queued',
      createdAt: new Date().toISOString(),
    };
    if (req.refImagePaths !== undefined) {
      job.refImagePaths = [...req.refImagePaths];
    }
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.emit('update', { ...job });
    const snapshot: Job = { ...job };
    this.drain();
    return snapshot;
  }

  list(): Job[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  get(id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job === undefined ? undefined : { ...job };
  }

  retry(id: string): Job {
    const job = this.jobs.get(id);
    if (job === undefined) {
      throw new Error(`ジョブが見つかりません: ${id}`);
    }
    if (job.state !== 'failed') {
      throw new Error(`failed 状態のジョブのみリトライできます(現在: ${job.state})`);
    }
    const req: JobRequest = { kind: job.kind, prompt: job.prompt };
    if (job.refImagePaths !== undefined) {
      req.refImagePaths = [...job.refImagePaths];
    }
    return this.submit(req);
  }

  /** Resolves once there are no queued or running jobs. */
  onIdle(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private isIdle(): boolean {
    return this.pending.length === 0 && this.runningCount === 0;
  }

  private drain(): void {
    while (this.runningCount < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift();
      if (id === undefined) {
        break;
      }
      const job = this.jobs.get(id);
      if (job === undefined) {
        continue;
      }
      this.runningCount += 1;
      job.state = 'running';
      job.startedAt = new Date().toISOString();
      this.emit('update', { ...job });
      void this.execute(job);
    }
  }

  /** Runner failures are captured here; nothing ever escapes to the caller. */
  private async execute(job: Job): Promise<void> {
    try {
      const result = await this.runner({ ...job });
      job.state = 'succeeded';
      job.imageId = result.imageId;
    } catch (err) {
      job.state = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    }
    job.finishedAt = new Date().toISOString();
    this.emit('update', { ...job });
    this.runningCount -= 1;
    this.notifyIfIdle();
    this.drain();
  }

  private notifyIfIdle(): void {
    if (!this.isIdle()) {
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
