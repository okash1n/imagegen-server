import type { CreateJobsRequest, HealthResponse, ImageMeta, Job } from '@imagegen/shared';

/** GET /api/images item: ImageMeta + server-side absolute file path. */
export type ImageItem = ImageMeta & { path: string };

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `サーバーエラー(HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // keep the default message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function createJobs(req: CreateJobsRequest): Promise<Job[]> {
  return fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  }).then((res) => readJson<Job[]>(res));
}

export function listJobs(): Promise<Job[]> {
  return fetch('/api/jobs').then((res) => readJson<Job[]>(res));
}

export function retryJob(id: string): Promise<Job> {
  return fetch(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }).then((res) =>
    readJson<Job>(res),
  );
}

export function getHealth(): Promise<HealthResponse> {
  return fetch('/api/health').then((res) => readJson<HealthResponse>(res));
}

export function listImages(limit?: number): Promise<ImageItem[]> {
  const qs = limit !== undefined ? `?limit=${limit}` : '';
  return fetch(`/api/images${qs}`).then((res) => readJson<ImageItem[]>(res));
}

export function imageUrl(id: string): string {
  return `/api/images/${encodeURIComponent(id)}`;
}

export function uploadFile(file: File): Promise<{ path: string }> {
  const form = new FormData();
  form.append('file', file);
  return fetch('/api/uploads', { method: 'POST', body: form }).then((res) =>
    readJson<{ path: string }>(res),
  );
}

const SSE_RETRY_MS = 2_000;

/**
 * Subscribes to /api/events ("job" events carry a Job JSON).
 * Owns the EventSource: on error it closes and reconnects after 2s
 * (the server re-sends a full job snapshot on connect).
 * Returns a cleanup function.
 */
export function subscribeEvents(onJob: (job: Job) => void): () => void {
  let source: EventSource | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const connect = (): void => {
    if (closed) return;
    source = new EventSource('/api/events');
    source.addEventListener('job', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      try {
        onJob(JSON.parse(ev.data) as Job);
      } catch {
        // ignore malformed frames
      }
    });
    source.onerror = () => {
      source?.close();
      source = undefined;
      if (closed) return;
      retryTimer = setTimeout(connect, SSE_RETRY_MS);
    };
  };

  connect();
  return () => {
    closed = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    source?.close();
    source = undefined;
  };
}
