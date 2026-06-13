export type JobKind = 'generate' | 'edit';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobRequest {
  kind: JobKind;
  prompt: string;
  /** kind === 'edit' のとき必須。サーバーから読める絶対パス(最大5) */
  refImagePaths?: string[];
}

export interface Job {
  id: string; // crypto.randomUUID()
  kind: JobKind;
  prompt: string;
  refImagePaths?: string[];
  state: JobState;
  /** state === 'failed' のときのみ */
  error?: string;
  createdAt: string; // ISO 8601
  startedAt?: string;
  finishedAt?: string;
  /** state === 'succeeded' のとき。画像IDは jobId と同値 */
  imageId?: string;
}

export interface ImageMeta {
  /** jobId と同値。画像ファイルは <id>.png */
  id: string;
  kind: JobKind;
  prompt: string;
  /** モデルが実際にツールへ渡した prompt(取得できた場合) */
  revisedPrompt?: string;
  refImagePaths?: string[];
  createdAt: string; // ISO 8601
  durationMs: number;
  engine: 'app-server';
}

export interface AuthStatus {
  loggedIn: boolean;
  /** 例: 'chatgpt' | 'apikey' など app-server の応答に準ずる */
  method?: string;
  /** ユーザー向け説明(未ログイン時は「codex login が必要」等) */
  message?: string;
}

export interface HealthResponse {
  ok: boolean;
  auth: AuthStatus;
  queuedJobs: number;
  runningJobs: number;
}

/** POST /api/jobs リクエストボディ */
export interface CreateJobsRequest {
  kind?: JobKind; // 省略時 'generate'
  prompt: string;
  count?: number; // 1..10, 省略時 1
  refImagePaths?: string[];
}

/** SSE: event: job / data: Job のJSON */
export interface JobEvent {
  type: 'job';
  job: Job;
}
