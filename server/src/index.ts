import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ImageMeta } from '@imagegen/shared';
import { imagesDir, loadConfig, uploadsDir, workDir } from './config.js';
import type { Config } from './config.js';
import { ImageStore } from './store.js';
import { JobQueue } from './queue.js';
import type { JobRunner } from './queue.js';
import { AppServerEngine } from './engine/appserver.js';
import type { AppServerEngineOpts } from './engine/appserver.js';
import type { ImageEngine } from './engine/types.js';
import { createApi } from './api.js';
import { createMcpHandler } from './mcp.js';

// Resolves to <repo>/web/dist from both server/src (tsx) and server/dist (built).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = path.resolve(moduleDir, '../../web/dist');

const GUI_NOT_BUILT_MESSAGE = 'GUI は未ビルド(pnpm --filter @imagegen/web build)';

export function buildRunner(engine: ImageEngine, store: ImageStore): JobRunner {
  return async (job) => {
    const startMs = Date.now();
    try {
      const result =
        job.kind === 'edit'
          ? await engine.edit({
              prompt: job.prompt,
              refImagePaths: job.refImagePaths ?? [],
            })
          : await engine.generate({ prompt: job.prompt });
      const meta: ImageMeta = {
        id: job.id,
        kind: job.kind,
        prompt: job.prompt,
        ...(result.revisedPrompt !== undefined
          ? { revisedPrompt: result.revisedPrompt }
          : {}),
        ...(job.refImagePaths !== undefined
          ? { refImagePaths: job.refImagePaths }
          : {}),
        createdAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        engine: 'app-server',
      };
      await store.save(meta, result.pngPath);
      return { imageId: job.id };
    } catch (err) {
      // On job failure, check codex auth (getAuthStatus) so an expired or
      // missing login shows up in job.error as an actionable hint.
      // The auth check itself must never mask the original failure,
      // so its own errors are swallowed and the original error is rethrown.
      let loggedIn: boolean | undefined;
      try {
        ({ loggedIn } = await engine.authStatus());
      } catch {
        // ignore: keep the original error when the auth check fails
      }
      if (loggedIn === false) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`codex login が必要です: ${detail}`);
      }
      throw err;
    }
  };
}

export interface ComposedServer {
  server: Server;
  engine: ImageEngine;
  queue: JobQueue;
  store: ImageStore;
}

export function composeServer(
  config: Config,
  engineOverrides?: Partial<AppServerEngineOpts>,
): ComposedServer {
  const tmpDir = path.join(config.dataDir, 'tmp');
  for (const dir of [imagesDir(config), uploadsDir(config), workDir(config), tmpDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const store = new ImageStore(imagesDir(config));
  const engine = new AppServerEngine({
    codexBin: config.codexBin,
    workDir: workDir(config),
    tmpDir,
    ...(config.turnModel !== undefined ? { turnModel: config.turnModel } : {}),
    ...engineOverrides,
  });
  const queue = new JobQueue({
    concurrency: config.concurrency,
    runner: buildRunner(engine, store),
  });

  const apiApp = createApi({ queue, store, engine, uploadsDir: uploadsDir(config) });
  const mcpHandler = createMcpHandler({ queue, store });

  const app = new Hono();
  app.route('/', apiApp); // apiApp routes already start with /api
  if (existsSync(webDistDir)) {
    // serveStatic resolves root relative to process.cwd()
    const staticRoot = path.relative(process.cwd(), webDistDir);
    app.use('*', serveStatic({ root: staticRoot }));
    app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));
  } else {
    app.get('*', (c) => c.text(GUI_NOT_BUILT_MESSAGE));
  }

  const honoListener = getRequestListener(app.fetch);
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/mcp')) {
      // Do NOT read the body here; createMcpHandler consumes it itself.
      void mcpHandler(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'MCP ハンドラで内部エラーが発生しました' }));
        } else {
          res.end();
        }
      });
      return;
    }
    void honoListener(req, res);
  });

  return { server, engine, queue, store };
}

function main(): void {
  const config = loadConfig();
  const { server, engine } = composeServer(config);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} を受信したため終了します`);
    void engine
      .stop()
      .catch(() => undefined)
      .then(() => {
        server.close(() => {
          process.exit(0);
        });
        // safety net in case open connections keep close() pending
        setTimeout(() => process.exit(0), 3_000).unref();
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.listen(config.port, config.host, () => {
    console.log(
      `imagegen-server: http://${config.host}:${config.port} (GUI/API) , /mcp (MCP)`,
    );
    // Startup auth check (fire-and-forget): warn when codex is not logged in,
    // but never block or fail startup. Note: this is the first engine call,
    // so authStatus() spawns the codex child process here — an accepted
    // trade-off with lazy spawn. Failures (e.g. codex not installed) are ignored.
    void engine
      .authStatus()
      .then((auth) => {
        if (auth.loggedIn === false) {
          console.error(auth.message ?? 'codex login が必要です');
        }
      })
      .catch(() => undefined);
  });
}

// Run main() only when executed directly (tsx src/index.ts / node dist/index.js),
// not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
