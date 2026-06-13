import { useState } from 'react';
import type { Job } from '@imagegen/shared';
import { retryJob } from '../api';

const STATE_LABEL: Record<Job['state'], string> = {
  queued: '待機中',
  running: '実行中',
  succeeded: '成功',
  failed: '失敗',
};

interface JobListProps {
  jobs: Job[];
  /** called with the new Job returned by POST /api/jobs/:id/retry */
  onRetried: (job: Job) => void;
}

export function JobList({ jobs, onRetried }: JobListProps) {
  const [retryError, setRetryError] = useState('');
  // newest first (createdAt is ISO 8601, so string compare is chronological)
  const sorted = [...jobs].sort((a, b) =>
    a.createdAt === b.createdAt
      ? b.id.localeCompare(a.id)
      : b.createdAt.localeCompare(a.createdAt),
  );

  const handleRetry = async (id: string) => {
    setRetryError('');
    try {
      onRetried(await retryJob(id));
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    }
  };

  if (sorted.length === 0) {
    return <p className="empty">ジョブはまだありません</p>;
  }
  return (
    <div className="job-list">
      {retryError !== '' && <p className="form-error">{retryError}</p>}
      <ul>
        {sorted.map((job) => (
          <li key={job.id} className="job-row">
            <span className={`badge badge-${job.state}`}>{STATE_LABEL[job.state]}</span>
            <span className="job-prompt" title={job.prompt}>
              {job.prompt}
            </span>
            {job.state === 'failed' && (
              <>
                <span className="job-error" title={job.error}>
                  {job.error}
                </span>
                <button type="button" onClick={() => void handleRetry(job.id)}>
                  リトライ
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
