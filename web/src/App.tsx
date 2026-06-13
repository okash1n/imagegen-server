import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreateJobsRequest, Job, JobKind } from '@imagegen/shared';
import { createJobs, getHealth, listImages, subscribeEvents } from './api';
import type { ImageItem } from './api';
import { PromptForm } from './components/PromptForm';
import { JobList } from './components/JobList';
import { Gallery } from './components/Gallery';
import { ImageModal } from './components/ImageModal';

const GALLERY_LIMIT = 100;
const MAX_REFS = 5;

export function App() {
  const [jobs, setJobs] = useState<Map<string, Job>>(new Map());
  // Mirror of `jobs` for transition detection inside event handlers
  // (avoids side effects inside setState updaters).
  const jobsRef = useRef(jobs);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [selected, setSelected] = useState<ImageItem | null>(null);
  const [authWarning, setAuthWarning] = useState('');

  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [refs, setRefs] = useState<string[]>([]);
  const [formError, setFormError] = useState('');

  const refreshImages = useCallback(async () => {
    try {
      setImages(await listImages(GALLERY_LIMIT));
    } catch {
      // keep the current list; the next succeeded job triggers a retry
    }
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const health = await getHealth();
      // auth.message is optional in HealthResponse, so fall back to a fixed text.
      setAuthWarning(health.auth.loggedIn ? '' : (health.auth.message ?? 'codex login が必要です'));
    } catch {
      // /api/health unreachable: keep the current banner state
    }
  }, []);

  const handleJobEvent = useCallback(
    (job: Job) => {
      const prev = jobsRef.current.get(job.id);
      const next = new Map(jobsRef.current);
      next.set(job.id, job);
      jobsRef.current = next;
      setJobs(next);
      // Refresh only on an observed transition into `succeeded`;
      // the initial mount fetch covers historical images.
      if (job.state === 'succeeded' && prev !== undefined && prev.state !== 'succeeded') {
        void refreshImages();
      }
      // A failure may be caused by an expired login, so re-check
      // /api/health on an observed transition into `failed` (the same
      // guard keeps the reconnect snapshot from re-triggering fetches).
      if (job.state === 'failed' && prev !== undefined && prev.state !== 'failed') {
        void refreshAuth();
      }
    },
    [refreshImages, refreshAuth],
  );

  useEffect(() => {
    void refreshImages();
    void refreshAuth();
  }, [refreshImages, refreshAuth]);

  useEffect(() => {
    // subscribeEvents reconnects 2s after a fatal error (see api.ts) and the
    // server re-sends a job snapshot on connect, so this effect only needs
    // to subscribe once and clean up.
    return subscribeEvents(handleJobEvent);
  }, [handleJobEvent]);

  const addRef = (path: string) => {
    if (refs.includes(path)) return;
    if (refs.length >= MAX_REFS) {
      setFormError(`参照画像は最大 ${MAX_REFS} 枚までです`);
      return;
    }
    setFormError('');
    setRefs([...refs, path]);
  };

  const submit = async () => {
    const kind: JobKind = refs.length > 0 ? 'edit' : 'generate';
    const req: CreateJobsRequest = {
      kind,
      prompt,
      count,
      ...(refs.length > 0 ? { refImagePaths: refs } : {}),
    };
    setFormError('');
    try {
      const created = await createJobs(req);
      for (const job of created) handleJobEvent(job);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="layout">
      <header className="header">
        <h1>imagegen-server</h1>
      </header>
      {authWarning !== '' && (
        <div className="auth-banner" role="alert">
          {authWarning}
        </div>
      )}
      <main className="main">
        <section className="panel">
          <h2>生成</h2>
          <PromptForm
            prompt={prompt}
            count={count}
            refs={refs}
            error={formError}
            onPromptChange={setPrompt}
            onCountChange={setCount}
            onAddRef={addRef}
            onRemoveRef={(path) => setRefs(refs.filter((p) => p !== path))}
            onSubmit={() => void submit()}
          />
          <h2>ジョブ</h2>
          <JobList jobs={[...jobs.values()]} onRetried={handleJobEvent} />
        </section>
        <section className="panel">
          <h2>ギャラリー</h2>
          <Gallery images={images} onSelect={setSelected} onUseAsRef={addRef} />
        </section>
      </main>
      {selected !== null && <ImageModal image={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
