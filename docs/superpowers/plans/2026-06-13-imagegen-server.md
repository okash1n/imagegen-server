# imagegen-server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex の画像生成(imagegen)を、Claude Code / Codex から MCP で呼べてブラウザ GUI から並列実行もできるローカルサーバーとして実装する。

**Architecture:** 単一 Node プロセスが `codex app-server` を子プロセスとして常駐させ、画像 1 件ごとに ephemeral thread + 1 ターンで imagegen ツールを呼ばせる(認証は codex 任せ、サブスク準拠)。インメモリ JobQueue(worker pool)が REST/SSE(GUI 用)と MCP streamable HTTP(エージェント用)の両方から共有される。エンジンは `ImageEngine` interface の背後に置き、将来の差し替えに備える。

**Tech Stack:** TypeScript + Node.js >= 22.18 + pnpm workspace。サーバー: Hono + @modelcontextprotocol/sdk(v1 系)+ zod 4。GUI: React 19 + Vite。テスト: vitest + 台本式の偽 app-server。

**Spec:** `docs/superpowers/specs/2026-06-13-imagegen-server-design.md`(承認済み)

---

## 実行順序と並列性

```
Task 0(足場)
  → Task 1(実機検証 probe)★手動ゲート: 失敗したらここで停止しユーザーに報告
    → Task 2(store) / Task 3(queue) / Task 4(jsonrpc) … 相互独立・並列可
      → Task 5(偽 app-server)… Task 4 の後
        → Task 6(エンジン)… Task 4,5 の後
      → Task 8(MCP)… Task 2,3 の後
      → Task 7(REST API)… Task 2,3,6 の後(ApiDeps が engine/types.ts の型を参照するため)
        → Task 9(設定と合成)… Task 2,3,6,7,8 の後
          → Task 10(Web GUI)
            → Task 11(README と仕上げ)
```

**Task 1 は実サブスクで実際に画像を 1〜2 枚生成する手動ゲート。** スペック §9-1(ephemeral thread で imagegen が有効か)と §9-2(prompt 遵守率)の検証であり、ここが通らない場合は以降の前提が崩れるため、計画を進めず結果を添えてユーザーに報告すること。

## スペックからの v1 逸脱事項(承認時に確認済みであること)

実装を v1 の規模に保つため、以下はスペックの字句から意図的に逸脱する。いずれもスペック側に注記を反映済み。

1. **失敗ジョブのメタは永続化しない**(スペック §5.4 の「エラー(失敗時)」)。失敗はインメモリのジョブ一覧と SSE/GUI 上でのみ可視。サーバー再起動で失敗記録は消える。リトライは稼働中のみ可能
2. **再起動時、実行中だったジョブは「failed 表示」ではなく一覧から消える**(スペック §5.1)。揮発キューでは構造的に failed マークを残せないため
3. **config.json で保存先(dataDir)は設定不可**。config.json 自体が dataDir 配下にあるため循環する。保存先の変更は `--data-dir` フラグのみ
4. **REST / MCP 入口の参照画像は、存在 + 画像拡張子を検証した上で任意の絶対パスを許容**(スペック §5.3 の「管理ディレクトリ内に配置」より緩い)。GUI 経由は uploads/images 配下に閉じる。read-only sandbox からの読み取り可否は Task 1 の probe で検証する

## 「spine §N」参照について

本計画の各 Task は契約文書(通称 spine)の節番号を参照する。**spine の全文は本計画末尾の「付録: 契約と早見表(spine)」に収録**しており、「spine §N」は付録の §N を指す。コードはすべて各 Task にインラインで完結しているため、付録は照合・検証用である。

## 全タスク共通の規約

- すべて ESM(`"type": "module"`)。TypeScript strict。`any` 禁止(`unknown` + 絞り込み)
- server パッケージの tsconfig は `module: "nodenext"` — **相対 import に必ず `.js` 拡張子を付ける**(例: `import { JobQueue } from './queue.js'`)
- `shared/` は型のみ。consumer は必ず `import type { ... } from '@imagegen/shared'`
- テスト実行コマンド: `pnpm --filter @imagegen/server exec vitest run test/<file>`
- コード内コメントは最小限・英語。ユーザー向けエラーメッセージは日本語
- コミットメッセージは Conventional Commits + 日本語説明(例: `feat: JobQueue を追加`)
- 依存注入はコンストラクタ引数で行い、グローバル状態を作らない

## App Server プロトコル要点(全タスクの前提知識)

`codex app-server` は stdio 上の行区切り JSON。**`"jsonrpc":"2.0"` フィールドは送らない・来ない**。

- request `{"id":1,"method":"...","params":{...}}` / response `{"id":1,"result":{...}}` / error `{"id":1,"error":{"code":-32601,"message":"..."}}` / notification `{"method":"...","params":{...}}`
- ハンドシェイク: `initialize`(clientInfo 必須)→ response → client から `initialized` 通知
- `thread/start` params: `{"cwd":"...","approvalPolicy":"never","sandbox":"read-only","ephemeral":true}`(+任意で `"model"`)。enum はソース準拠の kebab-case(README の例とは食い違いがある — Task 1 の probe で実機確認する)
- `turn/start` params: `{"threadId":"...","input":[{"type":"text","text":"..."}]}`
- ターン中の通知: `turn/started` / `item/started` / `item/completed` / `turn/completed`(すべて params 直下に `threadId`)
- **`turn/failed` は存在しない**。失敗は `turn/completed` の `turn.status === "failed"` + `turn.error.message` で判定
- `turn/started`・`turn/completed` の `items` は常に空配列。アイテムは item/* 通知だけが正
- imageGeneration アイテム完成形: `{"type":"imageGeneration","id":"...","status":"completed","revisedPrompt":"...","result":"<base64>","savedPath":"/.../codex/generated_images/..."}`。`savedPath` は省略されうる(null ではなくフィールドごと無い)→ 無ければ `result` をデコード
- 認証確認: `getAuthStatus` → `{"authMethod":"chatgpt"|"apikey"|null,...}`。imagegen は ChatGPT サブスク認証(chatgpt 系)でのみ有効
- サーバー→クライアントの request(承認要求等)が来たら一律 `-32601` でエラー応答(approvalPolicy "never" + read-only では本来発生しない)

---
### Task 0: ワークスペース足場

**目的:** pnpm workspace のルート設定・共有 TypeScript 設定・`@imagegen/shared`(型のみパッケージ)・`@imagegen/server` の骨格を作り、`pnpm install` と `tsc --noEmit` が通る状態にする。以降の全タスクの土台。

**Files:**
- Create: `package.json`(workspace ルート)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `shared/package.json`
- Create: `shared/src/index.ts`(全共有型)
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/index.ts`(仮実装。Task 9 で本実装に置き換える)

注意:
- `web/` はこのタスクでは**作らない**(Task 10 で作成)。`pnpm-workspace.yaml` には先に `web` を書いておくが、pnpm はマッチしないエントリを無視するので問題ない。
- 設定ファイル中心のタスクなので TDD は行わない。「作る → 検証コマンド → コミット」で進める。

- [ ] **Step 1: ツールチェーンの確認**

Run: `node --version`
Expected: PASS — `v22.18.0` 以上が表示される。それ未満なら Node を更新してから進む(ルート package.json の `engines` で `>=22.18` を要求する)。

Run: `pnpm --version`
Expected: PASS — バージョン文字列(例 `10.x.y`)が表示される。表示されなければ `corepack enable pnpm` などで pnpm を導入してから進む。この値は Step 2 で `packageManager` フィールドに反映する。

- [ ] **Step 2: ルート package.json と pnpm-workspace.yaml を作成**

リポジトリルートに `package.json` を作成する:

```json
{
  "name": "imagegen-server-workspace",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.0.0",
  "engines": {
    "node": ">=22.18"
  },
  "scripts": {
    "dev": "pnpm --filter @imagegen/server dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test"
  }
}
```

`packageManager` を実際にインストールされている pnpm のバージョンに合わせる(`pnpm@10.0.0` は仮置きの初期値):

Run: `npm pkg set packageManager="pnpm@$(pnpm --version)"`
Expected: PASS — 出力なし・exit 0。

Run: `node -p "require('./package.json').packageManager"`
Expected: PASS — `pnpm@<Step 1 で確認したバージョン>` が表示される。

リポジトリルートに `pnpm-workspace.yaml` を作成する:

```yaml
packages:
  - server
  - web
  - shared
```

`pnpm -r build` / `pnpm -r test` は該当スクリプトを持つパッケージだけで実行される(shared には build/test スクリプトが無いが、それで正しい。shared は型のみでビルド不要)。

- [ ] **Step 3: tsconfig.base.json と .gitignore を作成**

リポジトリルートに `tsconfig.base.json` を作成する。strict + ES2023 + NodeNext を基底とし、server はこれをそのまま継承する(web は Task 10 で `module` 等を bundler 向けに上書きする):

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "esModuleInterop": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  }
}
```

リポジトリルートに `.gitignore` を作成する:

```gitignore
node_modules/
dist/
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 4: shared パッケージを作成**

`shared/package.json` を作成する。型のみのパッケージなので `main` / `exports` / build スクリプトは持たず、`types` で TypeScript ソースを直接指す(consumer は必ず `import type { ... } from '@imagegen/shared'` を使う規約のため、ビルド成果物が不要):

```json
{
  "name": "@imagegen/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "types": "./src/index.ts"
}
```

`shared/src/index.ts` を作成する(全共有型。interface / type alias のみで、実行時コードは置かない):

```ts
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
```

- [ ] **Step 5: server パッケージを作成**

`server/package.json` を作成する。`@imagegen/shared` は型としてしか使わない(実行時コードを含まない)ため devDependencies に置く:

```json
{
  "name": "@imagegen/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@hono/node-server": "^2.0.4",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "hono": "^4.12.25",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@imagegen/shared": "workspace:*",
    "@types/node": "^25.9.3",
    "tsx": "^4.22.4",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
  }
}
```

`server/tsconfig.json` を作成する:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**`include` は意図的に `src` のみ**にする。`server/test/` はこの tsconfig に含めない:
- `build`(= `tsc`)の成果物 `dist/` にテストコードを混入させないため(`rootDir: src` とも整合する)
- テストの TypeScript は vitest が実行時に直接トランスパイルするため、ビルド設定に含める必要がない

`server/src/index.ts` を仮実装として作成する(Task 9 で合成ルートの本実装に**丸ごと置き換える**):

```ts
console.log('imagegen-server: not wired yet');
```

- [ ] **Step 6: pnpm install で依存解決を検証**

Run: `pnpm install`(リポジトリルートで実行)
Expected: PASS — `pnpm-lock.yaml` が生成され、`Packages: +NNN` と `Done in N.Ns` のような出力で exit 0。`ERR_PNPM_PEER_DEP_ISSUES` 等のエラーが出ないこと。`@imagegen/shared` が `server/node_modules/@imagegen/shared` に workspace リンクされる。

**peer 依存の注意(vitest 4 / vite 8):** vitest 4 は内部で vite に依存する。このタスクの時点では web パッケージが無いので通常は衝突しないが、もし `pnpm install` が vitest と vite の peer 互換エラーで失敗した場合、また Task 10 で `vite: ^8.0.16` を追加した際に vitest 4 との peer 互換が合わずエラーになった場合は、**web 側の vite を `^7` に下げて(`"vite": "^7"`)解決する**。vite を実際に使うのは Task 10 だけなので、ここでは方針として記録しておく。

- [ ] **Step 7: 型チェックと仮実装の動作確認**

Run: `pnpm --filter @imagegen/server exec tsc --noEmit`
Expected: PASS — 出力なしで exit 0(`server/src/index.ts` が strict + NodeNext で型チェックされる)。

Run: `pnpm --filter @imagegen/server exec tsc --noEmit --strict --target es2023 --module nodenext ../shared/src/index.ts`
Expected: PASS — 出力なしで exit 0。仮実装の `index.ts` はまだ shared を import しないため、shared の型定義そのものをここで単体チェックしておく(転記ミスの早期検出)。

Run: `pnpm --filter @imagegen/server exec tsx src/index.ts`
Expected: PASS — `imagegen-server: not wired yet` が 1 行出力されて exit 0(`dev` スクリプトの実行経路が機能していることの確認)。

- [ ] **Step 8: コミット**

Run: `git status --short`
Expected: 上記で作成した 9 ファイル + `pnpm-lock.yaml` のみが未追跡/変更として表示される(`node_modules/` が表示されないこと = .gitignore が効いている)。

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .gitignore shared/package.json shared/src/index.ts server/package.json server/tsconfig.json server/src/index.ts
git commit -m "chore: pnpm workspace の足場を追加"
```
### Task 1: 実機検証 probe(手動ゲート)

**目的:** 依存ゼロの素の Node スクリプト `scripts/probe.mjs` で、本物の `codex app-server` に対してスペック §9-1(ephemeral thread で imagegen 拡張が有効か・read-only sandbox から cwd 外の参照画像が読めるか)と §9-2(「prompt をそのまま使え」指示の遵守率)を検証する。**このタスクは手動ゲートであり、合格するまで Task 2 以降に着手しない。**

このタスクは実機(ChatGPT サブスク認証済みの codex CLI)に対する検証スクリプトなので TDD は不自然。「作る → 検証 → コミット → 実機ゲート実行」の構成とする。実機実行は 1 回につきモデルターン 1 回分のサブスク利用枠を消費する(スペック §9-4)。

**前提:**
- Task 0 完了(リポジトリ直下に `.gitignore` が存在する)
- システムの Node >= 22(`node --version` で確認)
- `codex` CLI がインストール済みで、`codex login`(ChatGPT サブスク認証)済みであること。未ログインでも probe は動くが、getAuthStatus の警告が出て生成は失敗する見込み

**Files:**
- Create: `scripts/probe.mjs`
- Modify: `.gitignore`(`probe-output.png` を追加)

- [ ] **Step 1: scripts/probe.mjs を作成**

依存ゼロ(`node:` 組み込みのみ)。プロトコルは spine §5 のワイヤ形式に厳密準拠(`"jsonrpc":"2.0"` フィールドは送らない・来ない。1 行 1 JSON)。

```js
#!/usr/bin/env node
// Real-machine probe for spec §9-1 / §9-2 against `codex app-server`.
// Zero dependencies. Requires system Node >= 22 and `codex` on PATH.
//
// Usage:
//   node scripts/probe.mjs "a watercolor cat"
//   node scripts/probe.mjs "<prompt>" --model <model>
//   node scripts/probe.mjs "<prompt>" --ref /abs/path/to.png [--ref ...]
//
// Exit codes: 0 = PASS, 1 = FAIL, 2 = usage error.
// stderr = full wire log (-> sent / <- received / !! codex stderr),
// stdout = human-readable report lines prefixed with [probe].

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const OVERALL_TIMEOUT_MS = 240_000;
const MAX_LOG_LINE = 400;

// Same instruction template the engine will use. Keep byte-identical with the engine.
const TURN_INSTRUCTION = (prompt, refPaths) => `You have an image generation tool (imagegen).
Call the imagegen tool EXACTLY ONCE with the arguments below, then stop.
- Use the prompt below VERBATIM as the \`prompt\` argument. Do not rephrase, translate, expand, or shorten it.
${refPaths && refPaths.length > 0 ? `- Pass \`referenced_image_paths\` as exactly: ${JSON.stringify(refPaths)}\n` : ''}- Do not run any other tool. Do not write files. Do not explain.

PROMPT (between the markers, exclusive):
<<<PROMPT_START>>>
${prompt}
<<<PROMPT_END>>>`;

class RpcError extends Error {
  constructor(rpcError) {
    super(`JSON-RPC error response: ${JSON.stringify(rpcError)}`);
    this.rpcError = rpcError;
  }
}

function report(msg) {
  process.stdout.write(`[probe] ${msg}\n`);
}

function logLine(marker, line) {
  // Truncate huge lines (imageGeneration items carry base64 PNGs).
  const text =
    line.length > MAX_LOG_LINE
      ? `${line.slice(0, MAX_LOG_LINE)} ...[truncated; original length ${line.length} chars]`
      : line;
  process.stderr.write(`${marker} ${text}\n`);
}

// ---- argv parsing -----------------------------------------------------------
const args = process.argv.slice(2);
let prompt;
let model;
const refPaths = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--model' || a === '--ref') {
    const v = args[i + 1];
    if (v === undefined) {
      process.stderr.write(`${a} には値が必要です\n`);
      process.exit(2);
    }
    i += 1;
    if (a === '--model') model = v;
    else refPaths.push(isAbsolute(v) ? v : resolve(process.cwd(), v));
  } else if (prompt === undefined) {
    prompt = a;
  } else {
    process.stderr.write(`不明な引数です: ${a}\n`);
    process.exit(2);
  }
}
if (prompt === undefined || prompt.trim() === '') {
  process.stderr.write(
    'usage: node scripts/probe.mjs "<prompt>" [--model <model>] [--ref </path/to.png> ...]\n',
  );
  process.exit(2);
}
for (const p of refPaths) {
  if (!existsSync(p)) {
    process.stderr.write(`参照画像が見つかりません: ${p}\n`);
    process.exit(2);
  }
}

// ---- 1. codex --version -----------------------------------------------------
let codexVersion;
try {
  codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
} catch (err) {
  report(`FAIL: codex CLI を実行できません: ${err instanceof Error ? err.message : String(err)}`);
  report('codex をインストールして PATH を通してから再実行してください。');
  process.exit(1);
}
report(`codex --version: ${codexVersion}`);

// ---- 2. spawn `codex app-server` (stdio) ------------------------------------
const workDir = mkdtempSync(join(tmpdir(), 'imagegen-probe-'));
report(`thread cwd (fresh temp dir): ${workDir}`);

const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.on('error', () => {
  // EPIPE after child death: surfaced via 'exit' handler instead.
});

let finished = false;
let currentThreadId;
let currentTurnId;
let imageItem;
let turnResult;
let nextId = 0;
const pending = new Map();

let settleTurn;
const turnDone = new Promise((r) => {
  settleTurn = r;
});

function shutdown(code) {
  if (finished) return;
  finished = true;
  clearTimeout(overallTimer);
  try {
    child.kill();
  } catch {
    // already dead
  }
  process.exit(code);
}

const overallTimer = setTimeout(() => {
  report(`FAIL: 全体タイムアウト(${OVERALL_TIMEOUT_MS / 1000}s)。可能なら turn/interrupt を送って終了します`);
  if (currentThreadId !== undefined && currentTurnId !== undefined) {
    try {
      // turn/interrupt requires BOTH threadId and turnId (TurnInterruptParams).
      // Fire-and-forget: we exit shortly after without awaiting the response.
      send({
        id: nextId++,
        method: 'turn/interrupt',
        params: { threadId: currentThreadId, turnId: currentTurnId },
      });
    } catch {
      // best effort
    }
  } else {
    report('turn/interrupt はスキップ(threadId または turnId が未取得のため送信できない)');
  }
  setTimeout(() => shutdown(1), 200);
}, OVERALL_TIMEOUT_MS);

function send(obj) {
  const line = JSON.stringify(obj);
  logLine('->', line);
  child.stdin.write(`${line}\n`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    send({ id, method, params });
  });
}

child.on('error', (err) => {
  report(`FAIL: codex app-server を起動できません: ${err.message}`);
  shutdown(1);
});
child.on('exit', (code, signal) => {
  if (!finished) {
    report(`FAIL: codex app-server が予期せず終了しました (code=${code}, signal=${signal})`);
    shutdown(1);
  }
});

createInterface({ input: child.stderr }).on('line', (line) => {
  logLine('!!', line);
});

createInterface({ input: child.stdout }).on('line', (line) => {
  logLine('<-', line);
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // non-JSON line: wire log only
  }
  if (msg.id !== undefined && msg.method !== undefined) {
    // A message with both id and method is a server->client request (e.g. an
    // approval prompt). Refuse uniformly with a JSON-RPC "method not found" error.
    send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
    return;
  }
  if (msg.id !== undefined) {
    const entry = pending.get(msg.id);
    if (entry === undefined) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) entry.reject(new RpcError(msg.error));
    else entry.resolve(msg.result);
    return;
  }
  if (msg.method !== undefined) handleNotification(msg.method, msg.params);
});

function handleNotification(method, params) {
  if (method === 'item/completed' && params?.item?.type === 'imageGeneration') {
    imageItem = params.item;
    report('imageGeneration item/completed:');
    report(`  status        = ${JSON.stringify(imageItem.status)}`);
    report(`  revisedPrompt = ${JSON.stringify(imageItem.revisedPrompt)}`);
    report(
      `  savedPath     = ${'savedPath' in imageItem ? JSON.stringify(imageItem.savedPath) : '(フィールド省略)'}`,
    );
    report(
      `  result length = ${typeof imageItem.result === 'string' ? imageItem.result.length : 0} chars (base64)`,
    );
  } else if (method === 'turn/completed') {
    turnResult = params?.turn;
    report(
      `turn/completed: status=${JSON.stringify(turnResult?.status)} error=${JSON.stringify(turnResult?.error)}`,
    );
    settleTurn();
  } else if (method === 'error') {
    report(`ターン途中エラー通知: ${JSON.stringify(params)}`);
  }
}

// ---- 3. main flow -----------------------------------------------------------
async function main() {
  // Handshake: send initialize, await its result, then emit the
  // `initialized` notification before any other request.
  const initResult = await request('initialize', {
    clientInfo: { name: 'imagegen-server', title: 'imagegen-server', version: '0.1.0' },
  });
  report(`initialize result: ${JSON.stringify(initResult)}`);
  send({ method: 'initialized' });

  // Auth check: imagegen requires ChatGPT subscription auth.
  // Print the raw getAuthStatus / account/read responses for the record.
  const auth = await request('getAuthStatus', {});
  report(`getAuthStatus raw: ${JSON.stringify(auth)}`);
  const authMethod = auth !== null && typeof auth === 'object' ? auth.authMethod : undefined;
  if (authMethod !== 'chatgpt' && authMethod !== 'chatgptAuthTokens') {
    report(
      `警告: authMethod=${JSON.stringify(authMethod)}。imagegen は ChatGPT サブスク認証でのみ有効です。生成が失敗したら codex login 後に再実行してください。`,
    );
  }
  try {
    const account = await request('account/read', {});
    report(`account/read raw: ${JSON.stringify(account)}`);
  } catch (err) {
    const detail = err instanceof RpcError ? JSON.stringify(err.rpcError) : String(err);
    report(`account/read は失敗(非致命的・記録のみ): ${detail}`);
  }

  // thread/start: ephemeral thread, read-only sandbox, fresh temp cwd.
  // Enum values use kebab-case on the wire (e.g. "read-only").
  const threadParams = {
    cwd: workDir,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
  };
  if (model !== undefined) threadParams.model = model;
  const threadResult = await request('thread/start', threadParams);
  currentThreadId = threadResult?.thread?.id;
  report(`thread/start result: threadId=${JSON.stringify(currentThreadId)}`);
  if (typeof currentThreadId !== 'string') {
    throw new Error(`thread/start 応答に thread.id がありません: ${JSON.stringify(threadResult)}`);
  }

  // turn/start: a single text input item carrying the full instruction.
  // The response's result.turn.id is required later by turn/interrupt.
  const instruction = TURN_INSTRUCTION(prompt, refPaths.length > 0 ? refPaths : undefined);
  const turnStartResult = await request('turn/start', {
    threadId: currentThreadId,
    input: [{ type: 'text', text: instruction }],
  });
  currentTurnId = turnStartResult?.turn?.id;
  report(`turn/start 受理(turnId=${JSON.stringify(currentTurnId)})。turn/completed まで待機します...`);
  await turnDone;
}

function evaluateAndExit() {
  let ok = true;
  if (imageItem === undefined) {
    report(
      'FAIL: imageGeneration の item/completed を受信していません(モデルが imagegen を呼ばなかった可能性。スペック §9-1 の前提が崩れています)',
    );
    ok = false;
  } else if (imageItem.status !== 'completed') {
    report(`FAIL: imageGeneration の status が completed ではありません: ${JSON.stringify(imageItem.status)}`);
    ok = false;
  }
  if (turnResult?.status !== 'completed') {
    report(
      `FAIL: turn.status が completed ではありません: ${JSON.stringify(turnResult?.status)} error=${JSON.stringify(turnResult?.error)}`,
    );
    ok = false;
  }
  if (ok) {
    if (typeof imageItem.savedPath === 'string' && existsSync(imageItem.savedPath)) {
      report(`画像は savedPath に保存済み: ${imageItem.savedPath}`);
    } else if (typeof imageItem.result === 'string' && imageItem.result.length > 0) {
      const out = resolve(process.cwd(), 'probe-output.png');
      writeFileSync(out, Buffer.from(imageItem.result, 'base64'));
      report(`savedPath が無い(または実在しない)ため base64 result をデコードして保存: ${out}`);
    } else {
      report('FAIL: savedPath も result(base64)もありません');
      ok = false;
    }
  }
  report(`PROBE RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  shutdown(ok ? 0 : 1);
}

main()
  .then(evaluateAndExit)
  .catch((err) => {
    if (err instanceof RpcError) {
      report(`FAIL: JSON-RPC エラー応答(全文): ${JSON.stringify(err.rpcError)}`);
      report(
        'このエラー全文が検証データです(README/ソース間の enum 表記食い違い等の判定に使う)。そのまま記録してユーザーに報告してください。',
      );
    } else {
      report(`FAIL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    shutdown(1);
  });
```

- [ ] **Step 2: 構文と引数検証を確認(実機を使わない範囲)**

Run:

```bash
node --check scripts/probe.mjs && echo "syntax OK"
node scripts/probe.mjs; echo "exit=$?"
node scripts/probe.mjs "x" --ref /no/such/file.png; echo "exit=$?"
```

Expected:
- 1 行目: `syntax OK`(構文エラーなし)
- 2 行目: stderr に `usage: node scripts/probe.mjs "<prompt>" ...` が出て `exit=2`(prompt 必須の検証が効いている)
- 3 行目: stderr に `参照画像が見つかりません: /no/such/file.png` が出て `exit=2`

いずれかが違えば FAIL(スクリプトの写し間違い)。修正してから先へ進む。

- [ ] **Step 3: .gitignore に probe-output.png を追加(Modify)**

probe は savedPath が無い場合にカレントディレクトリへ `probe-output.png` を書く。これをコミット対象から除外する。Task 0 で作成済みの `.gitignore` の末尾に次の 1 行を追記する:

```gitignore
probe-output.png
```

Run(追記と確認を兼ねる):

```bash
grep -qx 'probe-output.png' .gitignore || printf 'probe-output.png\n' >> .gitignore
git check-ignore -v probe-output.png
```

Expected: `git check-ignore -v` が `.gitignore:<行番号>:probe-output.png	probe-output.png` を出力し exit 0(無視されている)。何も出力されず exit 1 なら FAIL(追記に失敗している)。

- [ ] **Step 4: コミット**

```bash
git add scripts/probe.mjs .gitignore
git commit -m "feat: 実機検証用 probe スクリプトを追加"
```

- [ ] **Step 5: 手動ゲート 1 回目 — 生成(スペック §9-1 前半 + §9-2)**

Run:

```bash
node scripts/probe.mjs "a watercolor cat"
echo "exit=$?"
```

(モデル既定値の検討が必要な場合のみ、追加で `node scripts/probe.mjs "a watercolor cat" --model <モデル名>` を試してよい。モデル名は手元の codex の設定に合わせる。本計画の既定は「モデル未指定 = codex デフォルト」。)

所要時間は数十秒〜数分(全体タイムアウト 240 秒)。Expected(PASS の場合、stdout。`...` 部分は環境依存):

```
[probe] codex --version: codex-cli x.y.z
[probe] thread cwd (fresh temp dir): /var/folders/.../imagegen-probe-XXXXXX
[probe] initialize result: {"userAgent":"...","codexHome":"...","platformFamily":"...","platformOs":"..."}
[probe] getAuthStatus raw: {"authMethod":"chatgpt","authToken":null,"requiresOpenaiAuth":false}
[probe] account/read raw: {"account":{...},"requiresOpenaiAuth":false}
[probe] thread/start result: threadId="thr_..."
[probe] turn/start 受理(turnId="...")。turn/completed まで待機します...
[probe] imageGeneration item/completed:
[probe]   status        = "completed"
[probe]   revisedPrompt = "a watercolor cat"
[probe]   savedPath     = "/Users/.../.codex/generated_images/.../....png"
[probe]   result length = 1234567 chars (base64)
[probe] turn/completed: status="completed" error=null
[probe] 画像は savedPath に保存済み: /Users/.../.codex/generated_images/.../....png
[probe] PROBE RESULT: PASS
exit=0
```

同時に stderr には全送受信行が `->` / `<-`(codex 自身のログは `!!`)付きで流れる。base64 を含む行は 400 文字で切られ `...[truncated; original length N chars]` が付く。なお `getAuthStatus` の生応答では `"authToken":null` が常にシリアライズされる(null でもフィールドは省略されない)。

判定:
- PASS: `PROBE RESULT: PASS` かつ `exit=0`。savedPath が無く `probe-output.png` へのデコード保存にフォールバックした場合も PASS(その事実を記録する)。`open probe-output.png` または savedPath を開いて実画像であることを目視確認する
- FAIL: `exit=1`。代表的なパターン:
  - `thread/start` が invalid params 系の JSON-RPC エラー → spine §5.3 の注意(README は camelCase、ソースは kebab-case)に関わる事象。**出力されたエラー全文がそのまま検証データ**。表記を書き換えて再試行せず、全文を記録して報告する
  - JSON-RPC エラーメッセージに `requires experimentalApi capability` が含まれる → `scripts/probe.mjs` の initialize params に `capabilities: { experimentalApi: true }` を追加して **1 回だけ**再実行し、結果(成功/失敗とエラー全文)を記録する。再実行で PASS した場合はゲート通過として扱ってよいが、**Task 6 の AppServerEngine の initialize にも同じ `capabilities: { experimentalApi: true }` を反映する**ことを記録に明記し、Task 6 実装時に必ず反映する
  - `imageGeneration の item/completed を受信していません` → ephemeral thread で imagegen 拡張が無効(スペック §9-1 の核心が崩れている)
  - `turn.status` が `"failed"` → `error` の内容(認証・レート制限など)を記録
  - 全体タイムアウト(240s)→ 実行時間も記録

- [ ] **Step 6: 手動ゲート 2 回目 — 参照画像つき編集(スペック §9-1 後半)**

1 回目の生成画像を参照画像として編集を流す。参照画像は thread の cwd(temp ディレクトリ)の**外**にあるため、read-only sandbox から cwd 外ファイルが読めるかの検証を兼ねる。

Run(1 回目で `savedPath` が表示された場合はそのパスを、`probe-output.png` にフォールバックした場合は 2 つ目の形を使う):

```bash
node scripts/probe.mjs "make the cat wear a tiny red hat" --ref "/Users/<you>/.codex/generated_images/<session>/<call>.png"
echo "exit=$?"
# または
node scripts/probe.mjs "make the cat wear a tiny red hat" --ref "$PWD/probe-output.png"
echo "exit=$?"
```

Expected: Step 5 と同形の出力で `PROBE RESULT: PASS` / `exit=0`。加えて:
- stderr の `->` 行のうち turn/start の instruction 内に `- Pass \`referenced_image_paths\` as exactly: ["/...png"]` が含まれていること(`--ref` が指示文に反映されている証拠)
- 出力画像が参照画像(猫)を元にした編集結果であることを目視確認

FAIL の場合(例: ターンが「ファイルを読めない」旨で失敗、imagegen が参照画像なしの新規生成として動く等)はその内容を記録する。参照画像が読めない場合、スペック §9-1 後半の前提(read-only sandbox + `referenced_image_paths` で cwd 外画像を渡せる)が崩れる。

- [ ] **Step 7: 検証結果の記録とゲート判定**

以下のチェックリストを埋めて記録する(Task 11 の README で「検証済み codex バージョン」として転記するため、結果はユーザーへの報告に含める。リポジトリへのコミットは不要):

- [ ] `codex --version` の出力文字列
- [ ] thread/start の enum 表記: kebab-case(`"approvalPolicy":"never"` / `"sandbox":"read-only"`)が受理されたか。エラーになった場合は JSON-RPC エラー全文
- [ ] `getAuthStatus` の生応答(authMethod の値)と `account/read` の生応答(成否含む)
- [ ] `savedPath` の有無。有: パスの形式($CODEX_HOME/generated_images/ 配下か)。無: `probe-output.png` フォールバックが動いたか
- [ ] `revisedPrompt` と入力 prompt の一致度(完全一致か。差異があれば原文と差分 — スペック §9-2 の遵守率の実測値)
- [ ] 1 ターンの所要時間の目安(エンジン既定 turnTimeoutMs 180s の妥当性確認)
- [ ] 2 回目(--ref): read-only sandbox から cwd 外の参照画像が読めたか。出力が参照画像を反映した編集になっていたか

ゲート判定:

> **2 回の実行のいずれかが FAIL(exit 1)の場合、ここで計画を止めてユーザーに報告すること。スペック §9-1 が崩れるため、以降のタスク(Task 2〜11)には進まない。** 報告には stdout の `[probe] FAIL: ...` 行、JSON-RPC エラー全文、stderr の wire ログ(関連部分)、上記チェックリストの埋まった項目を添える。

両方 PASS なら、チェックリストの記録を添えてゲート通過を報告し、Task 2 以降(2〜8 は並列実行可)へ進む。
### Task 2: ImageStore

**目的:** 生成画像(PNG)とメタデータ(JSON)を `<dataDir>/images/` にファイルとして永続化する `ImageStore` クラスを TDD で実装する。ギャラリー(`GET /api/images`)・MCP の `list_recent_images`・画像配信(`GET /api/images/:id`)の土台になる。

**Files:**
- Create: `server/src/store.ts`
- Test: `server/test/store.test.ts`

**前提:** Task 0 完了(pnpm workspace + `pnpm install` 済み)。Task 1 とは独立しており、Task 3・4 と並列に進めてよい。

**設計上の決定(コードに反映する):**
- `save(meta, sourcePngPath)` は **ソース PNG を消費(consume)する**。`fs.promises.copyFile` で `<dir>/<meta.id>.png` へコピーし、メタ JSON を書いた後に `fs.promises.rm(sourcePngPath, { force: true })` でソースを削除する。エンジン(§3.4 `EngineResult.pngPath` は「呼び出し側が move する」契約)の一時ファイル後始末は ImageStore が担い、呼び出し側(Task 9 の runner)は `save` 後に `sourcePngPath` を参照してはならない。`fs.rename` でなく copy + rm にするのは、tmpDir と dataDir が別ファイルシステムにある場合の `EXDEV` エラーを避けるため。削除を最後にするのは、メタ書き込みが失敗してもソース(成果物)を失わないため。
- メタ JSON は `JSON.stringify(meta, null, 2)` で整形して書く(人間が直接読めるように)。
- `list()` は ディレクトリ内の `*.json` をスキャンし、**読めない・パースできない・形が違うファイルは黙ってスキップ**する(1 個の破損ファイルでギャラリー全体を壊さない)。並び順は `createdAt` の文字列降順(ISO 8601 なので文字列比較で時系列順になる)、同時刻は `id` 昇順でタイブレークして安定させる。
- `imagePath(id)` は ID を正規表現 `/^[0-9a-fA-F-]{36}$/` で検証し、不正なら日本語メッセージで throw する(`../` 等によるパストラバーサル防止)。存在チェックはしない。
- `get(id)` は不正な ID・ファイル欠損・破損 JSON のいずれも `undefined` を返す(throw は `imagePath` のみ。`list` の破損スキップと一貫した挙動)。

- [ ] **Step 1: 失敗するテストを書く**

`server/test/store.test.ts` を作成する。一時ディレクトリは `fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'))` で毎テスト独立に作る(OS の tmp 領域なので後始末は不要):

```ts
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ImageMeta } from '@imagegen/shared';
import { ImageStore } from '../src/store.js';

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, 'base64');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
}

function makeMeta(overrides: Partial<ImageMeta> = {}): ImageMeta {
  return {
    id: randomUUID(),
    kind: 'generate',
    prompt: 'a watercolor cat',
    createdAt: '2026-06-13T00:00:00.000Z',
    durationMs: 1234,
    engine: 'app-server',
    ...overrides,
  };
}

function writeSourcePng(dir: string): string {
  const sourcePath = path.join(dir, `src-${randomUUID()}.png`);
  fs.writeFileSync(sourcePath, PNG_1X1);
  return sourcePath;
}

describe('ImageStore', () => {
  it('constructor creates the images dir recursively', () => {
    const tmp = makeTempDir();
    const dir = path.join(tmp, 'nested', 'images');
    new ImageStore(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('save copies the png, writes meta json, and consumes the source file', async () => {
    const tmp = makeTempDir();
    const store = new ImageStore(path.join(tmp, 'images'));
    const meta = makeMeta();
    const sourcePath = writeSourcePng(tmp);

    await store.save(meta, sourcePath);

    const savedPng = fs.readFileSync(path.join(tmp, 'images', `${meta.id}.png`));
    expect(savedPng.equals(PNG_1X1)).toBe(true);
    const savedJson: unknown = JSON.parse(
      fs.readFileSync(path.join(tmp, 'images', `${meta.id}.json`), 'utf8'),
    );
    expect(savedJson).toEqual(meta);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it('list returns metas in createdAt descending order with limit', async () => {
    const tmp = makeTempDir();
    const store = new ImageStore(path.join(tmp, 'images'));
    const m1 = makeMeta({ createdAt: '2026-06-13T00:00:01.000Z' });
    const m2 = makeMeta({ createdAt: '2026-06-13T00:00:02.000Z' });
    const m3 = makeMeta({ createdAt: '2026-06-13T00:00:03.000Z' });
    for (const m of [m2, m1, m3]) {
      await store.save(m, writeSourcePng(tmp));
    }

    expect(await store.list()).toEqual([m3, m2, m1]);
    expect(await store.list(2)).toEqual([m3, m2]);
  });

  it('list breaks createdAt ties by id ascending (stable order)', async () => {
    const tmp = makeTempDir();
    const store = new ImageStore(path.join(tmp, 'images'));
    const createdAt = '2026-06-13T00:00:00.000Z';
    const a = makeMeta({ id: '00000000-0000-4000-8000-00000000000a', createdAt });
    const b = makeMeta({ id: '00000000-0000-4000-8000-00000000000b', createdAt });
    await store.save(b, writeSourcePng(tmp));
    await store.save(a, writeSourcePng(tmp));

    expect((await store.list()).map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it('get returns the saved meta, and undefined for a missing id', async () => {
    const tmp = makeTempDir();
    const store = new ImageStore(path.join(tmp, 'images'));
    const meta = makeMeta();
    await store.save(meta, writeSourcePng(tmp));

    expect(await store.get(meta.id)).toEqual(meta);
    expect(await store.get(randomUUID())).toBeUndefined();
  });

  it('imagePath returns <dir>/<id>.png for a valid id without touching the fs', () => {
    const tmp = makeTempDir();
    const dir = path.join(tmp, 'images');
    const store = new ImageStore(dir);
    const id = randomUUID();
    expect(store.imagePath(id)).toBe(path.join(dir, `${id}.png`));
  });

  it('imagePath throws a Japanese error for non-UUID ids', () => {
    const tmp = makeTempDir();
    const store = new ImageStore(path.join(tmp, 'images'));
    const badIds = ['../../../etc/passwd', 'abc', `${randomUUID()}/x`, 'g'.repeat(36)];
    for (const bad of badIds) {
      expect(() => store.imagePath(bad)).toThrow(/不正な画像ID/);
    }
  });

  it('list skips corrupt json files without throwing', async () => {
    const tmp = makeTempDir();
    const dir = path.join(tmp, 'images');
    const store = new ImageStore(dir);
    const meta = makeMeta();
    await store.save(meta, writeSourcePng(tmp));
    fs.writeFileSync(path.join(dir, `${randomUUID()}.json`), '{ this is not json');

    await expect(store.list()).resolves.toEqual([meta]);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/store.test.ts`
Expected: FAIL — `src/store.ts` がまだ存在しないため、`Failed to resolve import "../src/store.js" from "test/store.test.ts"` のような import 解決エラーで全テストが落ちる。これ以外の理由(構文エラー等)で落ちた場合はテストコードの転記ミスなので先に直す。

- [ ] **Step 3: 最小実装**

`server/src/store.ts` を作成する(spine §3.2 のシグネチャ通り。相対 import は無し、共有型は `import type`):

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImageMeta } from '@imagegen/shared';

// Allow only UUID-shaped ids to prevent path traversal.
const ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isImageMeta(value: unknown): value is ImageMeta {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.prompt === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.durationMs === 'number'
  );
}

export class ImageStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Persists the PNG and its meta json. The source file (the engine's tmp
   * file) is CONSUMED: it is copied into the store and then removed, so the
   * caller must not use sourcePngPath afterwards. copyFile + rm is used
   * instead of rename to survive cross-filesystem moves (EXDEV). The source
   * is removed last so a failed meta write does not lose the artifact.
   */
  async save(meta: ImageMeta, sourcePngPath: string): Promise<void> {
    await fs.promises.copyFile(sourcePngPath, this.imagePath(meta.id));
    await fs.promises.writeFile(
      this.metaPath(meta.id),
      JSON.stringify(meta, null, 2),
      'utf8',
    );
    await fs.promises.rm(sourcePngPath, { force: true });
  }

  async list(limit?: number): Promise<ImageMeta[]> {
    const names = await fs.promises.readdir(this.dir);
    const metas: ImageMeta[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await fs.promises.readFile(path.join(this.dir, name), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (isImageMeta(parsed)) metas.push(parsed);
      } catch {
        // Skip unreadable or corrupt meta files; one bad file must not break the gallery.
      }
    }
    metas.sort(
      (a, b) => compareStrings(b.createdAt, a.createdAt) || compareStrings(a.id, b.id),
    );
    return limit === undefined ? metas : metas.slice(0, Math.max(0, limit));
  }

  async get(id: string): Promise<ImageMeta | undefined> {
    if (!ID_PATTERN.test(id)) return undefined;
    try {
      const raw = await fs.promises.readFile(path.join(this.dir, `${id}.json`), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isImageMeta(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  imagePath(id: string): string {
    this.assertValidId(id);
    return path.join(this.dir, `${id}.png`);
  }

  private metaPath(id: string): string {
    this.assertValidId(id);
    return path.join(this.dir, `${id}.json`);
  }

  private assertValidId(id: string): void {
    if (!ID_PATTERN.test(id)) {
      throw new Error(`不正な画像IDです(UUID形式のみ許可): ${id}`);
    }
  }
}
```

実装メモ:
- `save` は `imagePath(meta.id)` / `metaPath(meta.id)` 経由でパスを得るので、不正な `meta.id` はコピー前に throw で弾かれる(検証ロジックの一元化)。
- `list(limit)` の `Math.max(0, limit)` は負数 `limit` で `slice(0, -1)` が末尾を削る事故を防ぐ防御。limit の本検証(1..N 等)は API 層(Task 7)の責務。

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/store.test.ts`
Expected: PASS — `Test Files  1 passed (1)` / `Tests  8 passed (8)`。

Run: `pnpm --filter @imagegen/server exec tsc --noEmit`
Expected: PASS — 出力なしで exit 0(`store.ts` が strict + NodeNext で型エラーなし。`server/test/` は tsconfig の `include` 外なので vitest 実行が型面の検証を兼ねる)。

- [ ] **Step 5: コミット**

Run: `git status --short`
Expected: `server/src/store.ts` と `server/test/store.test.ts` の 2 ファイルのみが未追跡として表示される。

```bash
git add server/src/store.ts server/test/store.test.ts
git commit -m "feat: ImageStore(画像とメタデータのファイル永続化)を追加"
```
### Task 3: JobQueue

**目的:** インメモリ FIFO + worker pool の `JobQueue` を実装する。ジョブの投入・状態遷移(`queued → running → succeeded | failed`)・手動リトライ・全完了待ちを提供し、状態遷移のたびに `'update'` イベントでジョブのスナップショット(コピー)を発火する。

**Files:**
- Create: `server/src/queue.ts`
- Test: `server/test/queue.test.ts`

**前提:** Task 0 完了(pnpm workspace、`@imagegen/shared` の型、`server` パッケージと vitest が利用可能)。Task 1, 2, 4 とは独立して並列に進められる。コマンドはすべてリポジトリルートで実行する。

- [ ] **Step 1: 失敗するテストを書く**

`server/test/queue.test.ts` を以下の内容で作成する。手動で resolve/reject できる `Deferred<T>` ヘルパーをテストファイル内に定義し、worker pool の同時実行数・開始順を決定的に検証する。

```ts
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/queue.test.ts`
Expected: FAIL(`server/src/queue.ts` が未作成のため、import `../src/queue.js` の解決エラーでテストファイル自体がロードできない)

- [ ] **Step 3: 最小実装**

`server/src/queue.ts` を以下の内容で作成する。

```ts
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
```

実装の要点:

- ジョブ本体は挿入順を保持する `Map<string, Job>` に置き、待ち行列は id の配列(`pending`)で FIFO 管理する。`list()` は Map の挿入順 = `createdAt` 昇順をそのまま返す
- `drain()` は「running 数 < concurrency なら次の queued を開始」を満たすまで回すループで、`submit()` 時と各ジョブの完了時(`execute()` の末尾)に呼ぶ
- runner の同期 throw / 非同期 reject はどちらも `execute()` 内の `try/catch` で捕捉し、`failed` + `error = err.message` に変換する。`JobQueue` の外へは決して伝播させない
- 状態を変更したら必ず直後に `this.emit('update', { ...job })` でコピーを発火する。`submit()` / `list()` / `get()` / `retry()` の戻り値もすべてコピーであり、呼び出し側・リスナーから内部状態を変更できない
- `retry()` は元ジョブの `kind` / `prompt` / `refImagePaths` で `submit()` し直すだけ(新しい id・新しい `createdAt`)。元ジョブは `failed` のまま履歴に残る

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/queue.test.ts`
Expected: PASS(`Test Files  1 passed (1)` / `Tests  9 passed (9)`)

- [ ] **Step 5: コミット**

```bash
git add server/src/queue.ts server/test/queue.test.ts
git commit -m "feat: JobQueue(FIFO worker pool・手動リトライ・update イベント)を追加"
```
### Task 4: JsonRpcConnection

**目的:** codex app-server と stdio で会話するための行区切り JSON-RPC コネクション(`JsonRpcConnection`)を TDD で実装する。ワイヤ形式は spine §5.1 のとおり **`"jsonrpc":"2.0"` フィールドを送らない・期待しない** 1 行 1 メッセージの JSON(JSONL)。子プロセスは不要で、`node:stream` の `PassThrough` ペアだけでテストする。

**前提:** Task 0(ワークスペース足場)が完了していること。Task 2/3 とは独立で、並列に進めてよい。

**Files:**
- Create: `server/src/engine/jsonrpc.ts`
- Test: `server/test/jsonrpc.test.ts`

このコネクションが守る契約(実装前に把握しておく):

- request 送信: `{"id": <1始まりの連番整数>, "method": "...", "params": {...}}` + `\n`。`params` が `undefined` ならフィールドごと省略
- notification 送信: `{"method": "...", "params": {...}}` + `\n`(同じく `params` 省略可)
- response 受信: `{"id": ..., "result": ...}` で resolve、`{"id": ..., "error": {"code", "message", "data"?}}` で `JsonRpcError` として reject。id で照合するので順不同でよい
- notification 受信(`method` あり・`id` なし): 登録済みハンドラ全員に配送
- **server→client の request**(`id` と `method` の両方あり): 承認要求などは扱わないので、一律 `{"id": <同じid>, "error": {"code": -32601, "message": "method not found"}}` を書き返す(spine §5.7 の安全網)
- 受信はチャンク境界に依存しない(部分行をバッファし、`\n` で確定した行だけ処理)。JSON として壊れた行はログして無視し、接続は生かす
- `request` の `timeoutMs` オプション: 期限内に response が来なければ reject
- `close(reason?)`: pending の request を全部 reject(エンジンが子プロセスのクラッシュ時に呼ぶ)

- [ ] **Step 1: 失敗するテストを書く**

`server/test/jsonrpc.test.ts` を以下の内容で作成する。`PassThrough` は `Readable` でも `Writable` でもあるので、`toServer`(コネクションが書く側)と `fromServer`(コネクションが読む側)の 2 本を作り、`toServer` の `'data'` を捕まえて「コネクションが何を書いたか」を検証する。`PassThrough` の `'data'` 発火は非同期なので、書き込み内容の検証前に `tick()`(setImmediate 1 回分)を待つ。

```ts
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcConnection, JsonRpcError } from '../src/engine/jsonrpc.js';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createConn() {
  const toServer = new PassThrough();
  toServer.setEncoding('utf8');
  const fromServer = new PassThrough();
  const chunks: string[] = [];
  toServer.on('data', (chunk: string) => chunks.push(chunk));
  const conn = new JsonRpcConnection(toServer, fromServer);
  const writtenLines = (): unknown[] =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as unknown);
  return { conn, fromServer, chunks, writtenLines };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('JsonRpcConnection', () => {
  it('request: {id:1,method,params} + 改行を書き、{id:1,result} で resolve する', async () => {
    const { conn, fromServer, chunks } = createConn();
    const promise = conn.request<{ ok: boolean }>('thread/start', { cwd: '/tmp/work' });
    await tick();
    expect(chunks.join('')).toBe(
      '{"id":1,"method":"thread/start","params":{"cwd":"/tmp/work"}}\n',
    );
    fromServer.write('{"id":1,"result":{"ok":true}}\n');
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('params が undefined のときは params フィールドを書かない', async () => {
    const { conn, fromServer, chunks } = createConn();
    const promise = conn.request<null>('getAuthStatus');
    await tick();
    expect(chunks.join('')).toBe('{"id":1,"method":"getAuthStatus"}\n');
    fromServer.write('{"id":1,"result":null}\n');
    await expect(promise).resolves.toBeNull();
  });

  it('順不同の response を id で対応付ける', async () => {
    const { conn, fromServer } = createConn();
    const p1 = conn.request<string>('first/method');
    const p2 = conn.request<string>('second/method');
    fromServer.write('{"id":2,"result":"second"}\n{"id":1,"result":"first"}\n');
    await expect(p2).resolves.toBe('second');
    await expect(p1).resolves.toBe('first');
  });

  it('error response は JsonRpcError(code/message/data 付き)で reject する', async () => {
    const { conn, fromServer } = createConn();
    const promise = conn.request('turn/start', { threadId: 'thr_1' });
    fromServer.write(
      '{"id":1,"error":{"code":-32001,"message":"Server overloaded; retry later.","data":{"retryAfter":5}}}\n',
    );
    const err: unknown = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonRpcError);
    const rpcError = err as JsonRpcError;
    expect(rpcError.code).toBe(-32001);
    expect(rpcError.message).toBe('Server overloaded; retry later.');
    expect(rpcError.data).toEqual({ retryAfter: 5 });
  });

  it('notification はハンドラに配送され、解除関数で購読解除できる', async () => {
    const { conn, fromServer } = createConn();
    const received: Array<[string, unknown]> = [];
    const unsubscribe = conn.onNotification((method, params) => {
      received.push([method, params]);
    });
    fromServer.write('{"method":"thread/started","params":{"threadId":"thr_1"}}\n');
    await tick();
    expect(received).toEqual([['thread/started', { threadId: 'thr_1' }]]);
    unsubscribe();
    fromServer.write('{"method":"turn/completed","params":{"threadId":"thr_1"}}\n');
    await tick();
    expect(received).toHaveLength(1);
  });

  it('server→client request には {id, error:{code:-32601}} を自動応答する', async () => {
    const { fromServer, writtenLines } = createConn();
    fromServer.write(
      '{"id":99,"method":"item/commandExecution/requestApproval","params":{"command":"rm"}}\n',
    );
    await tick();
    expect(writtenLines()).toEqual([
      { id: 99, error: { code: -32601, message: 'method not found' } },
    ]);
  });

  it('1 メッセージが 2 チャンクに分割されても再組み立てして処理する', async () => {
    const { conn, fromServer } = createConn();
    const promise = conn.request<string>('chunked/method');
    fromServer.write('{"id":1,"res');
    await tick();
    fromServer.write('ult":"done"}\n');
    await expect(promise).resolves.toBe('done');
  });

  it('1 チャンクに 2 メッセージが入っていても両方処理する', async () => {
    const { conn, fromServer } = createConn();
    const p1 = conn.request<string>('a/method');
    const p2 = conn.request<string>('b/method');
    fromServer.write('{"id":1,"result":"one"}\n{"id":2,"result":"two"}\n');
    await expect(p1).resolves.toBe('one');
    await expect(p2).resolves.toBe('two');
  });

  it('JSON でない行はログして無視し、接続は生き続ける', async () => {
    const { conn, fromServer } = createConn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const promise = conn.request<string>('still/alive');
    fromServer.write('this is not json\n{"id":1,"result":"ok"}\n');
    await expect(promise).resolves.toBe('ok');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('timeoutMs 指定時、応答が無ければ reject する', async () => {
    const { conn } = createConn();
    const promise = conn.request('slow/method', undefined, { timeoutMs: 50 });
    await expect(promise).rejects.toThrow('タイムアウト');
  });

  it('close() は pending を指定した reason で全 reject する', async () => {
    const { conn } = createConn();
    const p1 = conn.request('a/method');
    const p2 = conn.request('b/method');
    conn.close('子プロセスが終了しました');
    await expect(p1).rejects.toThrow('子プロセスが終了しました');
    await expect(p2).rejects.toThrow('子プロセスが終了しました');
  });
});
```

注意点:

- タイムアウトのテストは **fake timer を使わない**。fake timer はストリームの非同期配送(`setImmediate` / microtask)と干渉して不安定になるため、50ms の実時間タイムアウトで reject を待つ
- 「request が `{"id":1,...}` を書く」の検証は `chunks.join('')` の完全一致で行う(改行込み)。キー順は実装が `{ id, method, params }` の挿入順で組み立てるので決定的

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/jsonrpc.test.ts`
Expected: FAIL(`../src/engine/jsonrpc.js` の import 解決に失敗する。`server/src/engine/jsonrpc.ts` がまだ存在しないため)

- [ ] **Step 3: 最小実装**

`server/src/engine/jsonrpc.ts` を以下の内容で作成する(`server/src/engine/` ディレクトリはこのファイル作成時に新規作成される)。受信は readline を使わず、文字列バッファに `+=` して `\n` で split し、最後の未完了行だけ残す方式。pending は `Map<number, { resolve, reject, timer }>`、id は 1 始まりの連番。

```ts
import type { Readable, Writable } from 'node:stream';

export class JsonRpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export type NotificationHandler = (method: string, params: unknown) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class JsonRpcConnection {
  private buffer = '';
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly handlers = new Set<NotificationHandler>();
  private readonly toServer: Writable;

  constructor(toServer: Writable, fromServer: Readable) {
    this.toServer = toServer;
    fromServer.setEncoding('utf8');
    fromServer.on('data', (chunk: string) => {
      this.onData(chunk);
    });
  }

  request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('JSON-RPC 接続は既に閉じられています'));
    }
    const id = this.nextId;
    this.nextId += 1;
    const msg: Record<string, unknown> = { id, method };
    if (params !== undefined) {
      msg['params'] = params;
    }
    const timeoutMs = opts?.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new Error(
              `JSON-RPC リクエスト「${method}」が ${timeoutMs}ms 以内に応答せずタイムアウトしました`,
            ),
          );
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.writeLine(msg);
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = { method };
    if (params !== undefined) {
      msg['params'] = params;
    }
    this.writeLine(msg);
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  close(reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const err = new Error(reason ?? 'JSON-RPC 接続が閉じられました');
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }
      entry.reject(err);
    }
    this.pending.clear();
  }

  private writeLine(msg: Record<string, unknown>): void {
    this.toServer.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: string): void {
    if (this.closed) {
      return;
    }
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error('jsonrpc: JSON として解析できない行を無視します:', line);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) {
      console.error('jsonrpc: オブジェクトでないメッセージを無視します:', JSON.stringify(msg));
      return;
    }
    const m = msg as Record<string, unknown>;
    const hasId = m['id'] !== undefined;
    const hasMethod = typeof m['method'] === 'string';

    if (hasId && hasMethod) {
      // Server-to-client request (e.g. approval). Always refuse — safety net per spec.
      this.writeLine({ id: m['id'], error: { code: -32601, message: 'method not found' } });
      return;
    }
    if (hasMethod) {
      const method = m['method'] as string;
      // Iterate over a copy so handlers may unsubscribe during dispatch.
      for (const handler of [...this.handlers]) {
        handler(method, m['params']);
      }
      return;
    }
    if (hasId) {
      this.handleResponse(m);
      return;
    }
    console.error('jsonrpc: id も method も無いメッセージを無視します:', JSON.stringify(m));
  }

  private handleResponse(m: Record<string, unknown>): void {
    const id = m['id'];
    if (typeof id !== 'number') {
      console.error('jsonrpc: 数値でない id の response を無視します:', JSON.stringify(m));
      return;
    }
    const entry = this.pending.get(id);
    if (entry === undefined) {
      console.error(`jsonrpc: 未知の id=${id} の response を無視します`);
      return;
    }
    this.pending.delete(id);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    if (m['error'] !== undefined && m['error'] !== null) {
      const e = (typeof m['error'] === 'object' ? m['error'] : {}) as Record<string, unknown>;
      const code = typeof e['code'] === 'number' ? e['code'] : -32603;
      const message =
        typeof e['message'] === 'string' ? e['message'] : JSON.stringify(m['error']);
      entry.reject(new JsonRpcError(code, message, e['data']));
      return;
    }
    entry.resolve(m['result']);
  }
}
```

実装の要点:

- `"jsonrpc":"2.0"` は一切書かない(spine §5.1。codex app-server は jsonrpc-lite 形式)
- 受信メッセージの分類は「`id` と `method` 両方 → server→client request(拒否応答)」「`method` のみ → notification」「`id` のみ → response」の順に判定
- タイムアウト発火時は pending から削除してから reject(後から遅れて response が来ても「未知の id」としてログされるだけで無害)
- response 到着時・close 時は必ず `clearTimeout` し、タイマーのリークを防ぐ
- 壊れた行・未知の id・形のおかしいメッセージはすべて `console.error` でログして無視(接続は殺さない)

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/jsonrpc.test.ts`
Expected: PASS(Test Files 1 passed / Tests 11 passed。タイムアウトのテストが実時間 50ms 待つため全体で 100ms 程度かかるのは正常)

- [ ] **Step 5: コミット**

```bash
git add server/src/engine/jsonrpc.ts server/test/jsonrpc.test.ts
git commit -m "feat: 行区切り JSON-RPC コネクション JsonRpcConnection を追加"
```
### Task 5: 偽 app-server

**目的:** codex app-server のプロトコル(計画 spine §5)を台本どおりに喋る依存ゼロの偽サーバー `server/test/fake-appserver.mjs` を作り、Task 6(AppServerEngine)の統合テストを実サブスクなし・CI 可能にする。あわせて偽サーバー自体の煙テストを `JsonRpcConnection`(Task 4)経由で書き、JSON の形が早見表どおりであることを固定する。

**前提:** Task 0(ワークスペース足場)と Task 4(`server/src/engine/jsonrpc.ts` + そのテスト)が完了していること。

**Files:**
- Create: `server/test/fake-appserver.mjs`
- Test: `server/test/fake-appserver.smoke.test.ts`

**偽サーバーの仕様(spine §3.10 準拠の要約):**

| 環境変数 | 意味 |
| --- | --- |
| `FAKE_SCENARIO` | `happy`(既定)/ `no-tool` / `slow` / `crash-once` / `auth-expired` |
| `FAKE_CAPTURE_FILE` | 指定時、受信した全行をそのまま JSONL で追記する(テスト側が turn/start の instruction 内容や turn/interrupt の送信を検証するために使う) |
| `FAKE_STATE_FILE` | crash-once 用マーカー。存在しなければ作成して thread/start 応答直後に `process.exit(1)`、存在すれば happy と同じ動作 |
| `FAKE_DELAY_MS` | turn/start 受信から通知列送出までの遅延(既定 10ms)。turn ごとに独立した `setTimeout` なので複数 thread の並行 turn を独立に処理できる |

- 起動時に 1x1 PNG(spine §3.10 の base64 定数)を `os.tmpdir()/fake-appserver-<process.pid>.png` に実書き込みし、happy の `savedPath` として返す(プロセスごとに一意なので並列テストでも衝突しない)
- ワイヤ形式は行区切り JSON(JSONL)で **`"jsonrpc":"2.0"` フィールドは送らない・期待しない**(spine §5.1)
- `initialized` などの notification(id 無し)は無視。未知の request には `-32601`(method not found)エラーを返す
- `turn/interrupt` は `threadId` と `turnId` の両方(文字列)を必須とし、欠落時は `-32602`(invalid params)エラー、充足時は空オブジェクト `{}` を応答する(原典 `TurnInterruptParams` は両方必須・応答は空オブジェクト)

---

- [ ] **Step 1: 失敗するスモークテストを書く**

`server/test/fake-appserver.smoke.test.ts` を以下の内容で作成する。`JsonRpcConnection` で偽サーバーを子プロセスとして駆動し、happy シナリオの generate 一式(initialize → initialized → getAuthStatus → thread/start → turn/start → item/* → turn/completed)を end-to-end で検証する。

注意: vitest の cwd は `server/` パッケージディレクトリなので、spawn のパスは `'test/fake-appserver.mjs'`(`server/` からの相対)でよい。

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonRpcConnection } from '../src/engine/jsonrpc.js';

interface InitializeResult {
  userAgent: string;
}

interface AuthStatusResult {
  authMethod: string | null;
  requiresOpenaiAuth: boolean;
}

interface ThreadStartResult {
  thread: { id: string; ephemeral?: boolean };
}

interface TurnStartResult {
  turn: { id: string; status: string };
}

interface CapturedNotification {
  method: string;
  params: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function waitForNotification(
  conn: JsonRpcConnection,
  predicate: (method: string, params: unknown) => boolean,
  timeoutMs: number,
): Promise<CapturedNotification> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`通知待ちがタイムアウトしました(${timeoutMs}ms)`));
    }, timeoutMs);
    const unsubscribe = conn.onNotification((method, params) => {
      if (!predicate(method, params)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve({ method, params });
    });
  });
}

describe('fake-appserver smoke', () => {
  let child: ChildProcess | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('happy シナリオで generate 一式のハンドシェイクが通る', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fake-appserver-smoke-'));
    const captureFile = path.join(tmpDir, 'capture.jsonl');

    // vitest cwd is the server/ package dir, so this relative path works.
    child = spawn(process.execPath, ['test/fake-appserver.mjs'], {
      env: { ...process.env, FAKE_SCENARIO: 'happy', FAKE_CAPTURE_FILE: captureFile },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    if (!child.stdin || !child.stdout) {
      throw new Error('子プロセスの stdio を取得できませんでした');
    }
    const conn = new JsonRpcConnection(child.stdin, child.stdout);

    const notifications: CapturedNotification[] = [];
    conn.onNotification((method, params) => {
      notifications.push({ method, params });
    });

    // -- handshake: initialize request, then the initialized notification --
    const init = await conn.request<InitializeResult>(
      'initialize',
      { clientInfo: { name: 'imagegen-server', title: 'imagegen-server', version: '0.1.0' } },
      { timeoutMs: 2000 },
    );
    expect(init.userAgent).toBe('fake-app-server/0.0.0');
    conn.notify('initialized');

    // -- auth: getAuthStatus reports authMethod and requiresOpenaiAuth --
    const auth = await conn.request<AuthStatusResult>('getAuthStatus', {}, { timeoutMs: 2000 });
    expect(auth).toEqual({ authMethod: 'chatgpt', requiresOpenaiAuth: false });

    // -- thread/start: the response carries the new thread id --
    const started = await conn.request<ThreadStartResult>(
      'thread/start',
      { cwd: tmpDir, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true },
      { timeoutMs: 2000 },
    );
    const threadId = started.thread.id;
    expect(threadId).toMatch(/^thr_\d+$/);

    // Register the waiter BEFORE turn/start to avoid a race.
    const turnCompletedPromise = waitForNotification(
      conn,
      (method, params) =>
        method === 'turn/completed' && isRecord(params) && params.threadId === threadId,
      5000,
    );

    // -- turn/start: the response returns the turn with status "inProgress" --
    const prompt = 'a 1x1 smoke test pixel';
    const turnStarted = await conn.request<TurnStartResult>(
      'turn/start',
      { threadId, input: [{ type: 'text', text: prompt }] },
      { timeoutMs: 2000 },
    );
    expect(turnStarted.turn.status).toBe('inProgress');

    // -- turn/completed: status "completed" --
    const turnCompleted = await turnCompletedPromise;
    if (!isRecord(turnCompleted.params) || !isRecord(turnCompleted.params.turn)) {
      throw new Error('turn/completed の params が想定外の形です');
    }
    expect(turnCompleted.params.turn.status).toBe('completed');

    // -- item/completed (imageGeneration): savedPath exists on disk, result (base64) is non-empty --
    const itemCompleted = notifications.find(
      (n) =>
        n.method === 'item/completed' &&
        isRecord(n.params) &&
        n.params.threadId === threadId &&
        isRecord(n.params.item) &&
        n.params.item.type === 'imageGeneration',
    );
    if (!itemCompleted || !isRecord(itemCompleted.params) || !isRecord(itemCompleted.params.item)) {
      throw new Error('imageGeneration の item/completed 通知が来ていません');
    }
    const item = itemCompleted.params.item;
    expect(item.status).toBe('completed');
    const savedPath = item.savedPath;
    if (typeof savedPath !== 'string') {
      throw new Error('savedPath が文字列ではありません');
    }
    expect(existsSync(savedPath)).toBe(true);
    const png = readFileSync(savedPath);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const result = item.result;
    if (typeof result !== 'string') {
      throw new Error('result が文字列ではありません');
    }
    expect(result.length).toBeGreaterThan(0);

    // -- FAKE_CAPTURE_FILE: 受信した turn/start 行が JSONL で記録されている --
    const capturedMessages = readFileSync(captureFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    const capturedTurnStart = capturedMessages.find(
      (m) => isRecord(m) && m.method === 'turn/start',
    );
    if (!capturedTurnStart || !isRecord(capturedTurnStart) || !isRecord(capturedTurnStart.params)) {
      throw new Error('FAKE_CAPTURE_FILE に turn/start が記録されていません');
    }
    expect(JSON.stringify(capturedTurnStart.params)).toContain(prompt);

    conn.close();
  }, 15_000);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/fake-appserver.smoke.test.ts`

Expected: FAIL(`test/fake-appserver.mjs` がまだ存在しないため、spawn された node が "Cannot find module" を stderr に出して即終了し、`initialize` の request が応答を得られず `timeoutMs: 2000` で reject される。エラーメッセージ文言は Task 4 の `JsonRpcConnection` のタイムアウト/クローズ実装に依存するが、いずれにせよ 1 件 FAIL になること)

- [ ] **Step 3: 偽 app-server を実装する**

`server/test/fake-appserver.mjs` を以下の内容で作成する(依存ゼロの素の Node ESM。JSON の形は spine §5 に厳密準拠 — ここがズレるとテストの意味がない)。

```js
#!/usr/bin/env node
// Scripted fake `codex app-server` for integration tests. Zero dependencies.
// Wire format: line-delimited JSON; messages carry NO "jsonrpc" version field.
//
// Scenarios via FAKE_SCENARIO: happy | no-tool | slow | crash-once | auth-expired
//   FAKE_CAPTURE_FILE: append every received raw line as JSONL (for assertions)
//   FAKE_STATE_FILE:   crash-once marker (absent => crash after thread/start response)
//   FAKE_DELAY_MS:     delay before turn notifications (default 10ms)

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const scenario = process.env.FAKE_SCENARIO ?? 'happy';
const captureFile = process.env.FAKE_CAPTURE_FILE;
const stateFile = process.env.FAKE_STATE_FILE;
const parsedDelay = Number(process.env.FAKE_DELAY_MS ?? '10');
const delayMs = Number.isFinite(parsedDelay) ? parsedDelay : 10;

// Write a real 1x1 PNG at startup; used as `savedPath` in happy turns.
// Unique per process so parallel test runs never collide.
const savedPngPath = path.join(os.tmpdir(), `fake-appserver-${process.pid}.png`);
writeFileSync(savedPngPath, Buffer.from(PNG_BASE64, 'base64'));

let threadSeq = 0;
let turnSeq = 0;
let itemSeq = 0;

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function respondError(id, code, message) {
  send({ id, error: { code, message } });
}

function handleInitialize(id) {
  // initialize: identify the server (userAgent, codexHome, platform info).
  respond(id, {
    userAgent: 'fake-app-server/0.0.0',
    codexHome: os.tmpdir(),
    platformFamily: 'fake',
    platformOs: process.platform,
  });
}

function handleGetAuthStatus(id) {
  // getAuthStatus: authMethod is null when logged out, "chatgpt" when subscribed.
  if (scenario === 'auth-expired') {
    respond(id, { authMethod: null, requiresOpenaiAuth: true });
    return;
  }
  respond(id, { authMethod: 'chatgpt', requiresOpenaiAuth: false });
}

function handleThreadStart(id, params) {
  // thread/start: respond with the created thread, then emit thread/started.
  threadSeq += 1;
  const thread = { id: `thr_${threadSeq}`, ephemeral: true };
  const result = {
    thread,
    model: typeof params?.model === 'string' ? params.model : 'fake-model',
    approvalPolicy: params?.approvalPolicy ?? 'never',
    sandbox: { type: 'readOnly', networkAccess: false },
  };
  if (scenario === 'crash-once' && stateFile && !existsSync(stateFile)) {
    writeFileSync(stateFile, 'crashed\n');
    // Flush the response, then die. Next spawn finds the marker => acts happy.
    process.stdout.write(`${JSON.stringify({ id, result })}\n`, () => process.exit(1));
    return;
  }
  respond(id, result);
  send({ method: 'thread/started', params: { thread } });
}

function emitHappyItems(threadId, turnId) {
  // Happy turn: item/started then item/completed for one imageGeneration item.
  itemSeq += 1;
  const callId = `call_${itemSeq}`;
  send({
    method: 'item/started',
    params: {
      item: {
        type: 'imageGeneration',
        id: callId,
        status: 'in_progress',
        revisedPrompt: null,
        result: '',
      },
      threadId,
      turnId,
      startedAtMs: Date.now(),
    },
  });
  send({
    method: 'item/completed',
    params: {
      item: {
        type: 'imageGeneration',
        id: callId,
        status: 'completed',
        revisedPrompt: 'fake revised prompt',
        result: PNG_BASE64,
        savedPath: savedPngPath,
      },
      threadId,
      turnId,
      completedAtMs: Date.now(),
    },
  });
}

function emitNoToolItems(threadId, turnId) {
  itemSeq += 1;
  send({
    method: 'item/completed',
    params: {
      item: { type: 'agentMessage', id: `msg_${itemSeq}`, text: '画像生成はできません' },
      threadId,
      turnId,
      completedAtMs: Date.now(),
    },
  });
}

function handleTurnStart(id, params) {
  // turn/start: respond immediately with an inProgress turn; notifications follow async.
  const threadId = typeof params?.threadId === 'string' ? params.threadId : 'thr_unknown';
  turnSeq += 1;
  const turnId = `turn_${turnSeq}`;
  respond(id, { turn: { id: turnId, items: [], status: 'inProgress', error: null } });
  if (scenario === 'slow') return; // response only; never completes (timeout tests)

  // One independent timer per turn => concurrent turns on multiple threads work.
  setTimeout(() => {
    send({
      method: 'turn/started',
      params: { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } },
    });
    if (scenario === 'no-tool') {
      emitNoToolItems(threadId, turnId);
    } else {
      emitHappyItems(threadId, turnId);
    }
    send({
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'completed', error: null },
      },
    });
  }, delayMs);
}

function handleTurnInterrupt(id, params) {
  // turn/interrupt requires BOTH threadId and turnId; the success response is
  // an empty object.
  if (typeof params?.threadId !== 'string' || typeof params?.turnId !== 'string') {
    respondError(id, -32602, 'invalid params: threadId and turnId are required');
    return;
  }
  respond(id, {});
}

function handleLine(line) {
  const raw = line.trim();
  if (raw === '') return;
  if (captureFile) appendFileSync(captureFile, `${raw}\n`);
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return; // ignore malformed lines
  }
  if (typeof msg !== 'object' || msg === null || typeof msg.method !== 'string') return;
  const { id, method, params } = msg;
  // Notifications (no id) such as "initialized" are ignored (still captured above).
  if (id === undefined || id === null) return;
  switch (method) {
    case 'initialize':
      handleInitialize(id);
      return;
    case 'getAuthStatus':
      handleGetAuthStatus(id);
      return;
    case 'thread/start':
      handleThreadStart(id, params);
      return;
    case 'turn/start':
      handleTurnStart(id, params);
      return;
    case 'turn/interrupt':
      handleTurnInterrupt(id, params);
      return;
    default:
      respondError(id, -32601, 'method not found');
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', handleLine);
rl.on('close', () => process.exit(0));
```

- [ ] **Step 4: 単体で手動煙確認(1 行流して応答形を見る)**

リポジトリルートで:

```bash
printf '%s\n' '{"id":0,"method":"initialize","params":{"clientInfo":{"name":"imagegen-server","title":"imagegen-server","version":"0.1.0"}}}' | node server/test/fake-appserver.mjs
```

Expected: 標準出力に 1 行だけ、以下の形(`platformOs` は環境により異なる。`jsonrpc` フィールドが**無い**ことを確認):

```json
{"id":0,"result":{"userAgent":"fake-app-server/0.0.0","codexHome":"/var/folders/...","platformFamily":"fake","platformOs":"darwin"}}
```

stdin が閉じるとプロセスは exit code 0 で終了する。

- [ ] **Step 5: スモークテストが通ることを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/fake-appserver.smoke.test.ts`

Expected: PASS

```
✓ test/fake-appserver.smoke.test.ts (1 test)
Test Files  1 passed (1)
     Tests  1 passed (1)
```

PASS で確認できたこと: thread id が `thr_<連番>` 形/ `item/completed` の imageGeneration に実在する `savedPath` と非空 `result`(base64)が乗る / `turn/completed` の `turn.status === "completed"` / `FAKE_CAPTURE_FILE` に turn/start の受信行がそのまま記録される。

`no-tool` / `slow` / `crash-once` / `auth-expired` の各シナリオはここでは煙確認のみ(コード上の分岐)とし、実際の検証は Task 6 の AppServerEngine 統合テストがエンジン挙動と合わせて行う。

- [ ] **Step 6: コミット**

```bash
git add server/test/fake-appserver.mjs server/test/fake-appserver.smoke.test.ts
git commit -m "test: 台本式の偽 app-server とスモークテストを追加"
```
### Task 6: AppServerEngine

**目的:** `codex app-server` 子プロセスを JSON-RPC(stdio)で管理し、`ImageEngine` 契約(start / generate / edit / authStatus / stop)を実装する。テストは Task 5 の偽 app-server を子プロセスとして使い、実サブスクなしで E2E 検証する。

**前提:** Task 0(ワークスペース)、Task 4(`server/src/engine/jsonrpc.ts` の `JsonRpcConnection`)、Task 5(`server/test/fake-appserver.mjs`)が完了していること。

**Files:**
- Create: `server/src/engine/types.ts`
- Create: `server/src/engine/appserver.ts`
- Test: `server/test/appserver.test.ts`

**実装方針(内部設計の要点):**
- 子プロセスは lazy 起動。最初の generate / edit / authStatus 呼び出し時に spawn → `initialize`(§5.2)→ `initialized` 通知、の順でハンドシェイクする。並行呼び出し時は起動 Promise を共有して spawn を 1 回にする。`this.conn` への公開は `initialize` 応答の受信と `initialized` 通知の送信が済んだ後に行う(早く公開すると並行呼び出しがハンドシェイク未完了の接続を直接掴み、initialize 応答前に `thread/start` が流れうる。公開前の並行呼び出しは必ず共有の起動 Promise を await する)
- 1 ジョブ = `thread/start`(§5.3: ephemeral / approvalPolicy "never" / sandbox "read-only" / cwd = workDir)→ `turn/start`(§5.4: `TURN_INSTRUCTION` を text input で送る)→ 通知待ち。通知は `params.threadId` で `Map<threadId, handler>` にデマルチプレクスする
- 成果回収(§5.5): `item/completed` の imageGeneration アイテムについて `savedPath` を優先して tmpDir に `<random>.png` としてコピー。無ければ `result` の base64 をデコードして書く。imageGeneration が無いまま `turn/completed`(status "completed")なら、収集済みの agentMessage テキストを含むエラーで reject(`item.text` が文字列でなければ `JSON.stringify(item)` を使う防御)
- `turn/completed` の `turn.status === "failed"` → `turn.error.message` で reject(`turn/failed` という通知は存在しない)
- ターンタイムアウト(`turnTimeoutMs`、既定 180,000ms): `turn/interrupt` は `threadId` と `turnId` の両方が必須で、応答は空オブジェクト `{}`(原典 `TurnInterruptParams` 準拠)。`turn/start` 応答の `turn.id` を保持しておき、タイムアウト時に `{ threadId, turnId }` を fire-and-forget で送ってから reject する。`turnId` 未取得(`turn/start` 応答前)の場合は送信をスキップして reject のみ(§5.9)
- 子プロセスのクラッシュ: in-flight 全 reject → 次の要求で再 spawn。連続失敗は 1s, 2s, 4s... 最大 30s のバックオフ。**バックオフ基準遅延はテストで短縮できるよう内部オプション `restartBaseDelayMs?`(既定 1000)を `AppServerEngineOpts` に追加する**(spine §3.6 に無いフィールドの追加。crash-once テストが実時間 1 秒待たないために必要。本番では未指定 = 既定 1000ms で spine の規律どおり)
- `TURN_INSTRUCTION` は §5.8 の定義のまま `export` する(テストが instruction の完全一致を検証するため)
- spawn 時に `cwd` オプションは渡さない(プロセスの cwd を継承)。テストでは vitest が `server/` を cwd に実行するため、`codexArgs: ['test/fake-appserver.mjs']` の相対パスがそのまま解決される

- [ ] **Step 1: エンジン契約 `server/src/engine/types.ts` を作成(spine §3.4 そのまま)**

```ts
import type { AuthStatus } from '@imagegen/shared';

export interface EngineResult {
  /** エンジンが所有する一時ファイルへの絶対パス(呼び出し側が move する) */
  pngPath: string;
  revisedPrompt?: string;
}

export interface ImageEngine {
  start(): Promise<void>;
  generate(req: { prompt: string }): Promise<EngineResult>;
  edit(req: { prompt: string; refImagePaths: string[] }): Promise<EngineResult>;
  authStatus(): Promise<AuthStatus>;
  stop(): Promise<void>;
}
```

- [ ] **Step 2: 型チェックが通ることを確認**

Run: `pnpm --filter @imagegen/server exec tsc --noEmit`
Expected: PASS(出力なし・終了コード 0。types.ts は型のみで他ファイルに影響しない)

- [ ] **Step 3: 失敗する統合テストを書く(`server/test/appserver.test.ts`)**

偽 app-server(Task 5)を `codexBin: process.execPath` + `codexArgs: ['test/fake-appserver.mjs']` で子プロセスとして起動し、シナリオは環境変数 `FAKE_SCENARIO` で切り替える。`FAKE_CAPTURE_FILE` は偽サーバーが受信した全行を JSONL で追記するファイルで、instruction の中身、`turn/interrupt` の params(`threadId` / `turnId`)、初期化と `thread/start` の到達順序の検証に使う。`FAKE_STATE_FILE` は crash-once 専用(他シナリオでは無視されるので常に渡してよい)。

```ts
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppServerEngine, TURN_INSTRUCTION } from '../src/engine/appserver.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Scenario = 'happy' | 'no-tool' | 'slow' | 'crash-once' | 'auth-expired';

interface TestContext {
  engine: AppServerEngine;
  captureFile: string;
}

const engines: AppServerEngine[] = [];
const tempDirs: string[] = [];

async function createEngine(
  scenario: Scenario,
  opts?: { turnTimeoutMs?: number },
): Promise<TestContext> {
  const baseDir = await mkdtemp(join(tmpdir(), 'appserver-test-'));
  tempDirs.push(baseDir);
  const workDir = join(baseDir, 'work');
  const tmpDir = join(baseDir, 'tmp');
  await mkdir(workDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  const captureFile = join(baseDir, 'capture.jsonl');
  const engine = new AppServerEngine({
    codexBin: process.execPath,
    codexArgs: ['test/fake-appserver.mjs'],
    workDir,
    tmpDir,
    turnTimeoutMs: opts?.turnTimeoutMs ?? 8_000,
    restartBaseDelayMs: 10,
    env: {
      FAKE_SCENARIO: scenario,
      FAKE_CAPTURE_FILE: captureFile,
      FAKE_STATE_FILE: join(baseDir, 'fake-state'),
    },
  });
  engines.push(engine);
  return { engine, captureFile };
}

async function readCapture(captureFile: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(captureFile, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function turnStartText(message: Record<string, unknown>): string {
  const params = message['params'] as { input: Array<{ type: string; text: string }> };
  return params.input[0].text;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.stop();
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('AppServerEngine', () => {
  it('happy: generate が tmpDir に PNG を置き revisedPrompt を返す', async () => {
    const { engine } = await createEngine('happy');
    const result = await engine.generate({ prompt: 'a cat in watercolor' });
    expect(result.pngPath.endsWith('.png')).toBe(true);
    expect((await stat(result.pngPath)).size).toBeGreaterThan(0);
    const head = (await readFile(result.pngPath)).subarray(0, 8);
    expect(head.equals(PNG_MAGIC)).toBe(true);
    expect(typeof result.revisedPrompt).toBe('string');
    expect((result.revisedPrompt ?? '').length).toBeGreaterThan(0);
  }, 10_000);

  it('happy: authStatus が loggedIn=true を返す', async () => {
    const { engine } = await createEngine('happy');
    const status = await engine.authStatus();
    expect(status.loggedIn).toBe(true);
    expect(status.method).toBe('chatgpt');
  }, 10_000);

  it('edit: instruction に refImagePaths が JSON で埋め込まれる', async () => {
    const { engine, captureFile } = await createEngine('happy');
    const refPaths = ['/abs/ref-1.png', '/abs/ref-2.png'];
    const result = await engine.edit({ prompt: 'make it blue', refImagePaths: refPaths });
    expect((await stat(result.pngPath)).size).toBeGreaterThan(0);
    const messages = await readCapture(captureFile);
    const turnStart = messages.find((m) => m['method'] === 'turn/start');
    expect(turnStart).toBeDefined();
    const text = turnStartText(turnStart as Record<string, unknown>);
    expect(text).toContain(JSON.stringify(refPaths));
    expect(text).toBe(TURN_INSTRUCTION('make it blue', refPaths));
  }, 10_000);

  it('parallel: 3 並列 generate が別々の thread で完了する', async () => {
    const { engine, captureFile } = await createEngine('happy');
    const results = await Promise.all([
      engine.generate({ prompt: 'one' }),
      engine.generate({ prompt: 'two' }),
      engine.generate({ prompt: 'three' }),
    ]);
    for (const r of results) {
      expect((await stat(r.pngPath)).size).toBeGreaterThan(0);
    }
    expect(new Set(results.map((r) => r.pngPath)).size).toBe(3);
    const messages = await readCapture(captureFile);
    expect(messages.filter((m) => m['method'] === 'initialize')).toHaveLength(1);
    const threadIds = new Set(
      messages
        .filter((m) => m['method'] === 'turn/start')
        .map((m) => (m['params'] as { threadId: string }).threadId),
    );
    expect(threadIds.size).toBe(3);
  }, 10_000);

  it('parallel: 初回バーストでも initialize 完了前に thread/start が流れない', async () => {
    const { engine, captureFile } = await createEngine('happy');
    await Promise.all([
      engine.generate({ prompt: 'one' }),
      engine.generate({ prompt: 'two' }),
      engine.generate({ prompt: 'three' }),
    ]);
    // The fake server appends received lines in arrival order, so the capture
    // file reflects the exact order in which requests reached the child.
    // The engine sends "initialized" only after the initialize response, so
    // thread/start appearing after it proves no request raced the handshake.
    const methods = (await readCapture(captureFile)).map((m) => m['method']);
    expect(methods[0]).toBe('initialize');
    const initializedIndex = methods.indexOf('initialized');
    const firstThreadStartIndex = methods.indexOf('thread/start');
    expect(initializedIndex).toBeGreaterThan(0);
    expect(firstThreadStartIndex).toBeGreaterThan(initializedIndex);
  }, 10_000);

  it('no-tool: imageGeneration 無しは agent テキスト入りで失敗する', async () => {
    const { engine } = await createEngine('no-tool');
    await expect(engine.generate({ prompt: 'x' })).rejects.toThrow(/画像生成はできません/);
  }, 10_000);

  it('slow: タイムアウトで失敗し turnId 付きの turn/interrupt を送る', async () => {
    const { engine, captureFile } = await createEngine('slow', { turnTimeoutMs: 500 });
    await expect(engine.generate({ prompt: 'x' })).rejects.toThrow(/タイムアウト/);
    // interrupt は fire-and-forget。capture(JSONL)への反映を最大 2 秒ポーリングし、
    // turn/interrupt 行をパースして params.turnId が文字列であることを検証する
    let interrupt: Record<string, unknown> | undefined;
    for (let i = 0; i < 40 && interrupt === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const messages = await readCapture(captureFile).catch(() => []);
      interrupt = messages.find((m) => m['method'] === 'turn/interrupt');
    }
    if (interrupt === undefined) {
      throw new Error('turn/interrupt が capture に記録されていません');
    }
    const params = interrupt['params'];
    if (typeof params !== 'object' || params === null) {
      throw new Error('turn/interrupt の params がオブジェクトではありません');
    }
    expect(typeof (params as Record<string, unknown>)['turnId']).toBe('string');
  }, 10_000);

  it('crash-once: 1 回目は失敗し 2 回目は自動再起動して成功する', async () => {
    const { engine } = await createEngine('crash-once');
    await expect(engine.generate({ prompt: 'x' })).rejects.toThrow();
    const result = await engine.generate({ prompt: 'x' });
    expect((await stat(result.pngPath)).size).toBeGreaterThan(0);
  }, 10_000);

  it('auth-expired: authStatus が loggedIn=false と日本語メッセージを返す', async () => {
    const { engine } = await createEngine('auth-expired');
    const status = await engine.authStatus();
    expect(status.loggedIn).toBe(false);
    expect(status.message).toContain('codex login');
  }, 10_000);
});
```

- [ ] **Step 4: テストが失敗することを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/appserver.test.ts`
Expected: FAIL(`src/engine/appserver.ts` が存在しないため、テストファイルのロード時に `Failed to resolve import "../src/engine/appserver.js"` でエラー。`Test Files 1 failed`)

- [ ] **Step 5: `server/src/engine/appserver.ts` を実装**

```ts
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { AuthStatus } from '@imagegen/shared';
import { JsonRpcConnection } from './jsonrpc.js';
import type { EngineResult, ImageEngine } from './types.js';

export interface AppServerEngineOpts {
  codexBin: string;          // 'codex' または偽サーバー実行コマンド
  codexArgs?: string[];      // default ['app-server'](テストでは偽サーバーのパスに差し替え)
  workDir: string;           // thread の cwd に使う空ディレクトリ
  tmpDir: string;            // EngineResult.pngPath の置き場
  turnModel?: string;
  turnTimeoutMs?: number;    // default 180_000
  env?: Record<string, string>; // 子プロセス追加環境変数(テスト用)
  /**
   * 再起動バックオフの基準遅延(ms)。default 1000。
   * テストがクラッシュ→再起動を実時間 1 秒待たずに検証するための内部オプション。
   */
  restartBaseDelayMs?: number;
}

export const TURN_INSTRUCTION = (prompt: string, refPaths?: string[]) => `You have an image generation tool (imagegen).
Call the imagegen tool EXACTLY ONCE with the arguments below, then stop.
- Use the prompt below VERBATIM as the \`prompt\` argument. Do not rephrase, translate, expand, or shorten it.
${refPaths && refPaths.length > 0 ? `- Pass \`referenced_image_paths\` as exactly: ${JSON.stringify(refPaths)}\n` : ''}- Do not run any other tool. Do not write files. Do not explain.

PROMPT (between the markers, exclusive):
<<<PROMPT_START>>>
${prompt}
<<<PROMPT_END>>>`;

const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const DEFAULT_RESTART_BASE_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const THREAD_START_TIMEOUT_MS = 30_000;
const STOP_FORCE_KILL_MS = 2_000;

type ChildProc = ChildProcessByStdio<Writable, Readable, null>;

type ThreadNotificationHandler = (method: string, params: Record<string, unknown>) => void;

interface ImageGenerationResult {
  savedPath?: string;
  result?: string;
  revisedPrompt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AppServerEngine implements ImageEngine {
  private child: ChildProc | undefined;
  private conn: JsonRpcConnection | undefined;
  private connecting: Promise<JsonRpcConnection> | undefined;
  private readonly threadHandlers = new Map<string, ThreadNotificationHandler>();
  private readonly inFlight = new Set<(err: Error) => void>();
  private consecutiveFailures = 0;

  constructor(private readonly opts: AppServerEngineOpts) {}

  async start(): Promise<void> {
    // Lazy by design: the child process is spawned on the first request.
  }

  async generate(req: { prompt: string }): Promise<EngineResult> {
    return this.runTurn(req.prompt, undefined);
  }

  async edit(req: { prompt: string; refImagePaths: string[] }): Promise<EngineResult> {
    return this.runTurn(req.prompt, req.refImagePaths);
  }

  async authStatus(): Promise<AuthStatus> {
    const conn = await this.ensureConnection();
    const res = await conn.request<unknown>('getAuthStatus', {}, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
    const authMethod = isRecord(res) && typeof res['authMethod'] === 'string' ? res['authMethod'] : undefined;
    if (authMethod === 'chatgpt' || authMethod === 'chatgptAuthTokens') {
      return { loggedIn: true, method: authMethod };
    }
    if (authMethod === 'apikey') {
      return {
        loggedIn: false,
        method: authMethod,
        message: '画像生成には ChatGPT サブスクリプション認証(codex login)が必要です(API キー認証では不可)',
      };
    }
    const status: AuthStatus = { loggedIn: false, message: 'codex login が必要です' };
    if (authMethod !== undefined) {
      status.method = authMethod;
    }
    return status;
  }

  async stop(): Promise<void> {
    const child = this.child;
    const conn = this.conn;
    this.child = undefined;
    this.conn = undefined;
    this.connecting = undefined;
    if (conn) {
      conn.close('エンジンを停止しました');
    }
    const err = new Error('エンジンを停止しました');
    for (const reject of this.inFlight) {
      reject(err);
    }
    this.inFlight.clear();
    this.threadHandlers.clear();
    if (!child || child.exitCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        child.kill('SIGKILL');
      }, STOP_FORCE_KILL_MS);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  private async ensureConnection(): Promise<JsonRpcConnection> {
    if (this.conn) {
      return this.conn;
    }
    if (!this.connecting) {
      this.connecting = this.spawnAndInitialize().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private async spawnAndInitialize(): Promise<JsonRpcConnection> {
    if (this.consecutiveFailures > 0) {
      const base = this.opts.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
      const delay = Math.min(base * 2 ** (this.consecutiveFailures - 1), MAX_RESTART_DELAY_MS);
      await sleep(delay);
    }
    // No cwd option: inherit the process cwd (tests rely on relative fake path).
    const child = spawn(this.opts.codexBin, this.opts.codexArgs ?? ['app-server'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...this.opts.env },
    });
    // Writes to a dead child's stdin emit EPIPE; swallow to avoid crashing the host.
    child.stdin.on('error', () => {});
    const conn = new JsonRpcConnection(child.stdin, child.stdout);
    conn.onNotification((method, params) => {
      this.dispatchNotification(method, params);
    });
    child.once('error', () => {
      this.handleUnexpectedExit(child, conn);
    });
    child.once('exit', () => {
      this.handleUnexpectedExit(child, conn);
    });
    this.child = child;
    try {
      await conn.request(
        'initialize',
        { clientInfo: { name: 'imagegen-server', title: 'imagegen-server', version: '0.1.0' } },
        { timeoutMs: HANDSHAKE_TIMEOUT_MS },
      );
      conn.notify('initialized');
    } catch (err) {
      if (this.child === child) {
        // Exit handler has not cleaned up yet (e.g. handshake timeout).
        this.consecutiveFailures += 1;
        this.child = undefined;
        this.conn = undefined;
        conn.close('initialize に失敗しました');
        child.kill('SIGKILL');
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
    // Publish the connection only after the handshake completed (initialize
    // response received and the "initialized" notification sent). Concurrent
    // first callers therefore always await the shared this.connecting promise
    // and can never grab a half-initialized connection.
    this.conn = conn;
    this.consecutiveFailures = 0;
    return conn;
  }

  private handleUnexpectedExit(child: ChildProc, conn: JsonRpcConnection): void {
    if (this.child !== child) {
      return; // stop() or a newer child already took over
    }
    this.child = undefined;
    this.conn = undefined;
    this.consecutiveFailures += 1;
    conn.close('app-server プロセスが終了しました');
    const err = new Error('app-server プロセスが予期せず終了しました');
    for (const reject of this.inFlight) {
      reject(err);
    }
    this.inFlight.clear();
    this.threadHandlers.clear();
  }

  private dispatchNotification(method: string, params: unknown): void {
    if (!isRecord(params)) {
      return;
    }
    const threadId = params['threadId'];
    if (typeof threadId !== 'string') {
      return;
    }
    const handler = this.threadHandlers.get(threadId);
    if (handler) {
      handler(method, params);
    }
  }

  private async runTurn(prompt: string, refPaths: string[] | undefined): Promise<EngineResult> {
    const conn = await this.ensureConnection();
    let inFlightReject: ((err: Error) => void) | undefined;
    let threadId: string | undefined;
    try {
      return await new Promise<EngineResult>((resolve, reject) => {
        inFlightReject = reject;
        this.inFlight.add(reject);
        this.executeTurn(conn, prompt, refPaths, (id) => {
          threadId = id;
        }).then(resolve, reject);
      });
    } finally {
      if (inFlightReject) {
        this.inFlight.delete(inFlightReject);
      }
      if (threadId !== undefined) {
        this.threadHandlers.delete(threadId);
      }
    }
  }

  private async executeTurn(
    conn: JsonRpcConnection,
    prompt: string,
    refPaths: string[] | undefined,
    onThreadId: (threadId: string) => void,
  ): Promise<EngineResult> {
    const threadParams: Record<string, unknown> = {
      cwd: this.opts.workDir,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
    };
    if (this.opts.turnModel !== undefined) {
      threadParams['model'] = this.opts.turnModel;
    }
    const startResult = await conn.request<unknown>('thread/start', threadParams, {
      timeoutMs: THREAD_START_TIMEOUT_MS,
    });
    const threadId = this.readThreadId(startResult);
    onThreadId(threadId);

    const agentTexts: string[] = [];
    let image: ImageGenerationResult | undefined;
    const turnDone = new Promise<void>((resolve, reject) => {
      this.threadHandlers.set(threadId, (method, params) => {
        if (method === 'item/completed') {
          const item = params['item'];
          if (!isRecord(item)) {
            return;
          }
          if (item['type'] === 'imageGeneration' && item['status'] === 'completed') {
            image = {
              savedPath: typeof item['savedPath'] === 'string' ? item['savedPath'] : undefined,
              result: typeof item['result'] === 'string' ? item['result'] : undefined,
              revisedPrompt: typeof item['revisedPrompt'] === 'string' ? item['revisedPrompt'] : undefined,
            };
          } else if (item['type'] === 'agentMessage') {
            agentTexts.push(typeof item['text'] === 'string' ? item['text'] : JSON.stringify(item));
          }
          return;
        }
        if (method === 'turn/completed') {
          const turn = params['turn'];
          const status = isRecord(turn) ? turn['status'] : undefined;
          if (status === 'completed') {
            resolve();
            return;
          }
          if (status === 'failed') {
            const error = isRecord(turn) ? turn['error'] : undefined;
            const message =
              isRecord(error) && typeof error['message'] === 'string'
                ? error['message']
                : 'ターンが失敗しました(詳細不明)';
            reject(new Error(message));
            return;
          }
          reject(new Error(`ターンが完了しませんでした(status: ${String(status)})`));
        }
      });
    });

    const timeoutMs = this.opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    let turnId: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // turn/interrupt requires BOTH threadId and turnId; the success
        // response is an empty object. Fire-and-forget: do not await it.
        // If the turn/start response has not arrived yet, there is no turnId,
        // so skip the interrupt and just reject.
        if (turnId !== undefined) {
          conn.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5_000 }).catch(() => {});
        }
        reject(new Error(`ターンが ${timeoutMs}ms 以内に完了しませんでした(タイムアウト)`));
      }, timeoutMs);
    });

    try {
      await Promise.race([
        (async () => {
          const turnStarted = await conn.request<unknown>(
            'turn/start',
            { threadId, input: [{ type: 'text', text: TURN_INSTRUCTION(prompt, refPaths) }] },
            { timeoutMs },
          );
          turnId = this.readTurnId(turnStarted);
          await turnDone;
        })(),
        timedOut,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    if (image === undefined) {
      const detail = agentTexts.join('\n').trim();
      throw new Error(
        detail.length > 0
          ? `モデルが imagegen ツールを呼びませんでした: ${detail}`
          : 'モデルが imagegen ツールを呼びませんでした',
      );
    }
    return this.collectResult(image);
  }

  private async collectResult(image: ImageGenerationResult): Promise<EngineResult> {
    const pngPath = join(this.opts.tmpDir, `${randomUUID()}.png`);
    if (image.savedPath !== undefined) {
      try {
        await copyFile(image.savedPath, pngPath);
        return this.buildResult(pngPath, image.revisedPrompt);
      } catch {
        // savedPath が読めない場合は base64 にフォールバックする
      }
    }
    if (image.result !== undefined && image.result.length > 0) {
      await writeFile(pngPath, Buffer.from(image.result, 'base64'));
      return this.buildResult(pngPath, image.revisedPrompt);
    }
    throw new Error('imageGeneration アイテムから画像を取得できませんでした(savedPath も result もありません)');
  }

  private buildResult(pngPath: string, revisedPrompt: string | undefined): EngineResult {
    const result: EngineResult = { pngPath };
    if (revisedPrompt !== undefined) {
      result.revisedPrompt = revisedPrompt;
    }
    return result;
  }

  private readThreadId(result: unknown): string {
    if (isRecord(result)) {
      const thread = result['thread'];
      if (isRecord(thread) && typeof thread['id'] === 'string') {
        return thread['id'];
      }
    }
    throw new Error('thread/start の応答に thread.id が含まれていません');
  }

  private readTurnId(result: unknown): string {
    if (isRecord(result)) {
      const turn = result['turn'];
      if (isRecord(turn) && typeof turn['id'] === 'string') {
        return turn['id'];
      }
    }
    throw new Error('turn/start の応答に turn.id が含まれていません');
  }
}
```

実装の補足(読み合わせ用):
- `runTurn` は外側 Promise の `reject` を `inFlight` に登録してから `executeTurn` を走らせる。子プロセスが死んだら `handleUnexpectedExit` が `inFlight` を全 reject するので、通知待ちのままハングしない(`conn.close` が pending の request も全 reject するため二重に守られる。Promise は最初の settle が勝つので二重 reject は無害)
- `threadHandlers` のエントリは `runTurn` の `finally` で必ず削除する(成功・失敗・タイムアウトのどれでもリークしない)
- `turn/interrupt` の params は `{ threadId, turnId }`(両方必須・応答は空オブジェクト `{}`)。request として送るが応答は待たない(`.catch(() => {})` で握りつぶす)。`turnId` は `turn/start` 応答の `turn.id` を `readTurnId` で取り出して保持したもので、未取得(`turn/start` 応答前)の場合は送信せず reject のみ。偽サーバーの capture ファイル(JSONL)には受信行が記録されるので、slow テストはこれをパースして `params.turnId` が文字列であることを検証する
- `this.child = child` は spawn 直後に代入する(exit ハンドラの世代判定に必要)が、`this.conn = conn` の公開はハンドシェイク成功後。初回の並行バーストでは全呼び出しが `this.connecting` を await するため、capture(受信順の JSONL)上で先頭が `initialize` になり、`thread/start` は `initialized` より後に現れる(parallel の初回バーストテストがこの順序を検証する)

- [ ] **Step 6: テストが通ることを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/appserver.test.ts`
Expected: PASS(`Test Files 1 passed (1)` / `Tests 9 passed (9)`。slow テストの 500ms タイムアウトと crash-once の再起動を含め、全体で数秒以内に完了する)

- [ ] **Step 7: 型チェック**

Run: `pnpm --filter @imagegen/server exec tsc --noEmit`
Expected: PASS(出力なし・終了コード 0)

- [ ] **Step 8: コミット**

```bash
git add server/src/engine/types.ts server/src/engine/appserver.ts server/test/appserver.test.ts
git commit -m "feat: AppServerEngine を追加(codex app-server 子プロセスで画像生成ターンを実行)"
```
### Task 7: REST API + SSE

**目的:** GUI が使う REST API(ジョブ投入・一覧・リトライ・画像一覧/配信・参照画像アップロード・ヘルスチェック)と、ジョブ状態変化をリアルタイム配信する SSE エンドポイントを Hono で実装する。

**Files:**
- Create: `server/src/api.ts`
- Test: `server/test/api.test.ts`

**前提:**
- Task 0 完了(pnpm workspace、`server/package.json` に `hono ^4.12.25` / `vitest ^4.1.8` が入っている)
- Task 2 完了(`server/src/store.ts` の `ImageStore`)
- Task 3 完了(`server/src/queue.ts` の `JobQueue` / `JobRunner`)
- 型 import のために Task 6 が作る `server/src/engine/types.ts`(`ImageEngine` interface)が存在すること。Task 7 を Task 6 と並列で進める場合は、Task 6 の `engine/types.ts` 作成ステップ(型定義のみ)だけ先に済ませる

**設計メモ(実装前に読むこと):**
- `ApiDeps.engine` は spine §3.7 では `ImageEngine` だが、api が実際に使うのは `authStatus()` だけなので `Pick<ImageEngine, 'authStatus'>` に絞る。完全な `ImageEngine`(Task 6 の `AppServerEngine`)はそのまま代入できるため、Task 9 の合成コードには影響しない
- テストは Hono の `app.request()` を使い、実ポートを一切開かない。`JobQueue` は本物を使い、runner だけを deferred スタブ(テスト側から手動で resolve / reject できる)に差し替える。`ImageStore` も本物を一時ディレクトリ上で使う
- multipart テストは Node 22 のグローバル `FormData` / `File`(undici 由来)を使う。追加依存は不要
- SSE のテストは「接続直後に既存ジョブのスナップショットが 1 フレーム届く」ことだけを検証する。更新イベントのライブ配信・切断時の購読解除を含むフルの SSE 挙動は、Task 9 の起動煙テストと手動確認(GUI 結線時)でカバーする
- エラーレスポンスはすべて `{ error: string }`(日本語メッセージ)で統一する

- [ ] **Step 1: 失敗するテストを書く**

`server/test/api.test.ts` を以下の内容で作成する。

```ts
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/api.test.ts`
Expected: FAIL(`../src/api.js` が解決できない — `server/src/api.ts` が未作成のため。`Failed to load url ../src/api.js` 等のモジュール解決エラー)

- [ ] **Step 3: 最小実装(api.ts)**

`server/src/api.ts` を以下の内容で作成する。

```ts
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
```

実装上の注意:
- `GET /api/images/:id` は `store.imagePath(id)` が不正 ID(UUID 文字以外)で throw することを 400 に変換する。パストラバーサル防止は ImageStore 側(Task 2)の責務で、api はそれを利用するだけ
- `GET /api/events` のコールバックは、最後の `await new Promise(...)` で abort まで返らないようにしている。コールバックが return すると Hono がストリームを閉じてしまうため必須
- `POST /api/jobs` の prompt は検証(trim 空チェック)にのみ trim を使い、submit には原文をそのまま渡す(プロンプトは一字一句保持する契約のため)
- ディレクトリ作成(uploadsDir 等)は Task 9 の `index.ts` の責務。api は存在を前提にする(テストでは beforeEach で作成)

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/api.test.ts`
Expected: PASS(`Test Files 1 passed (1)` / `Tests 22 passed (22)`)

- [ ] **Step 5: 型チェック**

Run: `pnpm --filter @imagegen/server exec tsc --noEmit`
Expected: 出力なし(終了コード 0)。エラーが出る場合は import パスの `.js` 拡張子漏れ、または `engine/types.ts`(Task 6)未作成を疑う

- [ ] **Step 6: コミット**

```bash
git add server/src/api.ts server/test/api.test.ts
git commit -m "feat: REST API と SSE エンドポイントを追加"
```
### Task 8: MCP サーバー

**目的:** `/mcp` で提供する MCP(streamable HTTP, stateless)サーバーを実装する。ツールは `generate_image`(ジョブ投入→全完了までブロック→保存パスを返す)と `list_recent_images` の 2 つ。テストは `InMemoryTransport` + `Client` で実プロトコル越しに検証する。

**依存:** Task 2(`server/src/store.ts` の `ImageStore`)と Task 3(`server/src/queue.ts` の `JobQueue` / `JobRunner`)が完了していること。エンジン(Task 6)には依存しない — MCP 層は queue と store しか見ない。

**Files:**
- Create: `server/src/mcp.ts`
- Create: `server/test/mcp.test.ts`
- Modify: `server/package.json`(`@modelcontextprotocol/sdk` / `zod` が未追加の場合のみ)

**設計メモ(コードを書く前に把握する点):**
- 公開 API は spine §3.8 の 2 関数のみ: `createMcpServer(deps): McpServer`(テスト対象)と `createMcpHandler(deps)`(本番用 node:http ハンドラ)。
- stateless パターン(spine §6.2): POST ごとに**新しい** `McpServer` + `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` を生成し、自前で JSON parse した body を `transport.handleRequest(req, res, body)` に渡す。body は 1MB 上限。GET/DELETE は 405 + JSON-RPC エラー `{code:-32000,message:'Method not allowed.'}`。処理中の例外は 500 + JSON-RPC エラー。`res` の `'close'` で `transport.close()` / `server.close()`。
- `inputSchema` は zod の **raw shape**(`z.object()` で包まない)。
- ジョブ完了待ちは `waitForJob(queue, jobId): Promise<Job>` ヘルパー(mcp.ts 内のモジュールプライベート)。`'update'` イベント購読の前に現在状態を確認し、既に終端状態なら即 resolve(購読前に完了する競合の防止)。
- `generate_image` はジョブ投入前に参照画像を検証する: mcp.ts 内ヘルパー `validateRefImagePaths(paths: string[]): string | undefined`(`fs.existsSync` による存在チェック、拡張子 `.png` / `.jpg` / `.jpeg` / `.webp`、最大 5 件。エラーなら日本語メッセージを返す)。不正時は `{ content: [{type:'text', text: 'Error: <メッセージ>'}], isError: true }` を即返してジョブを投入しない。これは REST API(Task 7 の `parseCreateJobsBody`)と同等の検証であり、10 行程度の**意図的な重複**とする — 共有モジュール化はしない(REST 層と MCP 層の独立性を優先)。
- `generate_image` の成功エントリは `list_recent_images` と同形: `ImageMeta` の全フィールドに `path`(絶対パス)を付与した `{ ...ImageMeta, path: string }`。実装は `store.get(job.imageId)` の結果をスプレッドして `path` を加える。
- `generate_image` の `isError: true` は**参照画像の検証エラー時と全件失敗のときのみ**。一部成功なら `isError` なしで `failed` 配列に失敗分を載せる。

- [ ] **Step 1: 依存パッケージを追加(未追加の場合)**

Task 0 で既に `server/package.json` に入っていればこのコマンドは実質 no-op(バージョンレンジの確認になる)。

```bash
pnpm --filter @imagegen/server add '@modelcontextprotocol/sdk@^1.29.0' 'zod@^4.4.3'
```

検証:

Run: `pnpm --filter @imagegen/server exec node -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(() => console.log('mcp sdk ok'))"`
Expected: `mcp sdk ok` が出力される(出なければ install 失敗。エラーを確認して再実行)

- [ ] **Step 2: 失敗するテストを書く**

`server/test/mcp.test.ts` を以下の内容で作成する。ポイント:
- `setup()` がテストごとに一時ディレクトリ + `ImageStore` + スタブ runner 付き `JobQueue` + `createMcpServer` を組み、`InMemoryTransport.createLinkedPair()` で `Client` を接続する。
- 成功 runner は実在する 1x1 PNG(spine §3.10 の base64 定数)を一時ファイルに書き、`store.save()` を呼んでから `{ imageId: job.id }` を返す — 本番 runner(Task 9 の `buildRunner`)と同じ契約。
- ハンドラレベルのテストは `node:http` の実サーバーを port 0 で起動し、`GET /mcp` が 405 になることだけを最小限に確認する。

```ts
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ImageMeta } from '@imagegen/shared';
import { JobQueue, type JobRunner } from '../src/queue.js';
import { ImageStore } from '../src/store.js';
import { createMcpHandler, createMcpServer } from '../src/mcp.js';

// Real 1x1 PNG (same constant as fake-appserver)
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    await fn();
  }
  cleanups = [];
});

async function makeBaseDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'mcp-test-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  return base;
}

async function writeSourcePng(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, Buffer.from(PNG_1X1_BASE64, 'base64'));
  return path;
}

interface Ctx {
  store: ImageStore;
  queue: JobQueue;
  client: Client;
  srcDir: string;
  /** kinds the runner observed, in call order */
  kinds: string[];
}

interface SetupOpts {
  /** every runner call throws */
  alwaysFail?: boolean;
  /** the N-th runner call (1-based) throws */
  failOnCall?: number;
}

async function setup(opts: SetupOpts = {}): Promise<Ctx> {
  const base = await makeBaseDir();
  const srcDir = join(base, 'src');
  await mkdir(srcDir, { recursive: true });
  const store = new ImageStore(join(base, 'images'));
  const kinds: string[] = [];
  let calls = 0;
  const runner: JobRunner = async (job) => {
    calls += 1;
    kinds.push(job.kind);
    if (opts.alwaysFail === true) {
      throw new Error('生成に失敗しました');
    }
    if (opts.failOnCall !== undefined && calls === opts.failOnCall) {
      throw new Error('2件目の生成に失敗しました');
    }
    const src = await writeSourcePng(srcDir, `${job.id}-src.png`);
    const meta: ImageMeta = {
      id: job.id,
      kind: job.kind,
      prompt: job.prompt,
      revisedPrompt: `revised: ${job.prompt}`,
      createdAt: new Date().toISOString(),
      durationMs: 5,
      engine: 'app-server',
    };
    if (job.refImagePaths !== undefined) {
      meta.refImagePaths = job.refImagePaths;
    }
    await store.save(meta, src);
    return { imageId: job.id };
  };
  const queue = new JobQueue({ concurrency: 2, runner });
  const server = createMcpServer({ queue, store });
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(() => client.close());
  return { store, queue, client, srcDir, kinds };
}

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

function asToolResult(value: unknown): ToolResult {
  return value as ToolResult;
}

function firstText(result: ToolResult): string {
  const text = result.content[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('text コンテンツがありません');
  }
  return text;
}

interface GenerateResultBody {
  // Success entries share the list_recent_images shape: full ImageMeta + path
  images: (ImageMeta & { path: string })[];
  failed: { error: string }[];
}

async function callGenerate(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ result: ToolResult; body: GenerateResultBody }> {
  const result = asToolResult(await client.callTool({ name: 'generate_image', arguments: args }));
  return { result, body: JSON.parse(firstText(result)) as GenerateResultBody };
}

describe('createMcpServer', () => {
  it('generate_image と list_recent_images がツール一覧に載る', async () => {
    const ctx = await setup();
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['generate_image', 'list_recent_images']);
  });

  it('generate_image: 1件成功で ImageMeta 全体と実在する PNG の絶対パスを返す', async () => {
    const ctx = await setup();
    const { result, body } = await callGenerate(ctx.client, { prompt: '水彩画の猫' });
    expect(result.isError).not.toBe(true);
    expect(body.failed).toEqual([]);
    expect(body.images).toHaveLength(1);
    const image = body.images[0]!;
    expect(image.prompt).toBe('水彩画の猫');
    expect(image.revisedPrompt).toBe('revised: 水彩画の猫');
    expect(image.kind).toBe('generate');
    expect(image.engine).toBe('app-server');
    expect(image.path).toBe(ctx.store.imagePath(image.id));
    expect(isAbsolute(image.path)).toBe(true);
    await access(image.path); // throws if the file does not exist
  });

  it('generate_image: count 2 で 2 枚の画像を返す', async () => {
    const ctx = await setup();
    const { result, body } = await callGenerate(ctx.client, { prompt: 'dog', count: 2 });
    expect(result.isError).not.toBe(true);
    expect(body.failed).toEqual([]);
    expect(body.images).toHaveLength(2);
    const paths = body.images.map((i) => i.path);
    expect(new Set(paths).size).toBe(2);
    for (const p of paths) {
      await access(p);
    }
  });

  it('generate_image: ref_image_paths があると edit ジョブとして投入される', async () => {
    const ctx = await setup();
    const ref = await writeSourcePng(ctx.srcDir, 'ref.png');
    const { body } = await callGenerate(ctx.client, { prompt: '青くして', ref_image_paths: [ref] });
    expect(body.images).toHaveLength(1);
    expect(ctx.kinds).toEqual(['edit']);
  });

  it('generate_image: 存在しない参照画像パスは isError: true で即エラーを返す', async () => {
    const ctx = await setup();
    const missing = join(ctx.srcDir, 'missing.png');
    const result = asToolResult(
      await ctx.client.callTool({
        name: 'generate_image',
        arguments: { prompt: '青くして', ref_image_paths: [missing] },
      }),
    );
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe(`Error: 参照画像が見つかりません: ${missing}`);
    // Validation rejects before submit, so the runner must never be called
    expect(ctx.kinds).toEqual([]);
  });

  it('generate_image: 全件失敗なら isError: true とエラーメッセージを返す', async () => {
    const ctx = await setup({ alwaysFail: true });
    const { result, body } = await callGenerate(ctx.client, { prompt: 'x', count: 2 });
    expect(result.isError).toBe(true);
    expect(body.images).toEqual([]);
    expect(body.failed).toHaveLength(2);
    expect(body.failed[0]!.error).toBe('生成に失敗しました');
  });

  it('generate_image: 一部失敗は isError なしで failed に載る', async () => {
    const ctx = await setup({ failOnCall: 2 });
    const { result, body } = await callGenerate(ctx.client, { prompt: 'y', count: 2 });
    expect(result.isError).not.toBe(true);
    expect(body.images).toHaveLength(1);
    expect(body.failed).toEqual([{ error: '2件目の生成に失敗しました' }]);
  });

  it('list_recent_images: 保存済みメタに絶対パスを付けて新しい順に返す', async () => {
    const ctx = await setup();
    const older: ImageMeta = {
      id: randomUUID(),
      kind: 'generate',
      prompt: 'older',
      createdAt: '2026-06-13T00:00:00.000Z',
      durationMs: 10,
      engine: 'app-server',
    };
    const newer: ImageMeta = {
      id: randomUUID(),
      kind: 'generate',
      prompt: 'newer',
      createdAt: '2026-06-13T01:00:00.000Z',
      durationMs: 10,
      engine: 'app-server',
    };
    await ctx.store.save(older, await writeSourcePng(ctx.srcDir, 'older.png'));
    await ctx.store.save(newer, await writeSourcePng(ctx.srcDir, 'newer.png'));
    const result = asToolResult(
      await ctx.client.callTool({ name: 'list_recent_images', arguments: { limit: 1 } }),
    );
    const entries = JSON.parse(firstText(result)) as Array<ImageMeta & { path: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(newer.id);
    expect(entries[0]!.prompt).toBe('newer');
    expect(entries[0]!.path).toBe(ctx.store.imagePath(newer.id));
    expect(isAbsolute(entries[0]!.path)).toBe(true);
  });
});

describe('createMcpHandler', () => {
  it('GET /mcp は 405 と JSON-RPC エラーを返す', async () => {
    const base = await makeBaseDir();
    const store = new ImageStore(join(base, 'images'));
    const queue = new JobQueue({
      concurrency: 1,
      runner: async () => ({ imageId: randomUUID() }),
    });
    const handler = createMcpHandler({ queue, store });
    const httpServer: Server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          httpServer.close((err) => (err ? reject(err) : resolve())),
        ),
    );
    const address = httpServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('ポート取得に失敗しました');
    }
    const res = await fetch(`http://127.0.0.1:${address.port}/mcp`);
    expect(res.status).toBe(405);
    const bodyJson = (await res.json()) as { error?: { code?: number; message?: string } };
    expect(bodyJson.error?.code).toBe(-32000);
    expect(bodyJson.error?.message).toBe('Method not allowed.');
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/mcp.test.ts`
Expected: FAIL(`../src/mcp.js` が存在しないため、テストファイルのロード自体がモジュール解決エラーで落ちる。例: `Failed to resolve import "../src/mcp.js" from "test/mcp.test.ts"`)

- [ ] **Step 4: 最小実装 — server/src/mcp.ts**

```ts
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ImageMeta, Job, JobKind, JobRequest } from '@imagegen/shared';
import type { JobQueue } from './queue.js';
import type { ImageStore } from './store.js';

export interface McpDeps {
  queue: JobQueue;
  store: ImageStore;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const MAX_REF_IMAGES = 5;
const ALLOWED_REF_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Same shape as a list_recent_images entry: full ImageMeta plus the absolute file path. */
type GeneratedImageEntry = ImageMeta & { path: string };

interface FailedEntry {
  error: string;
}

/**
 * Validates reference image paths before any job is submitted.
 * Returns a Japanese error message, or undefined when all paths are valid.
 * Intentionally duplicates the REST API validation (Task 7) — about 10 lines
 * kept inline instead of a shared module, so the two layers stay independent.
 */
function validateRefImagePaths(paths: string[]): string | undefined {
  if (paths.length > MAX_REF_IMAGES) {
    return 'ref_image_paths は最大 5 件までです';
  }
  for (const p of paths) {
    const ext = extname(p).toLowerCase();
    if (!ALLOWED_REF_EXTENSIONS.has(ext)) {
      return `参照画像の拡張子は .png / .jpg / .jpeg / .webp のいずれかにしてください: ${p}`;
    }
    if (!existsSync(p)) {
      return `参照画像が見つかりません: ${p}`;
    }
  }
  return undefined;
}

/** Resolves when the job reaches a terminal state (succeeded/failed). */
function waitForJob(queue: JobQueue, jobId: string): Promise<Job> {
  return new Promise((resolve) => {
    const current = queue.get(jobId);
    if (current !== undefined && (current.state === 'succeeded' || current.state === 'failed')) {
      resolve(current);
      return;
    }
    const onUpdate = (job: Job): void => {
      if (job.id === jobId && (job.state === 'succeeded' || job.state === 'failed')) {
        queue.off('update', onUpdate);
        resolve(job);
      }
    };
    queue.on('update', onUpdate);
  });
}

function registerTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'generate_image',
    {
      title: '画像生成',
      description:
        'プロンプトから画像を生成する。ref_image_paths(最大5)を渡すと参照画像を使った編集になる。' +
        '全ジョブの完了までブロックし、保存済み PNG の絶対パスとメタを JSON 文字列で返す。',
      inputSchema: {
        prompt: z.string().min(1),
        count: z.number().int().min(1).max(10).optional(),
        ref_image_paths: z.array(z.string()).max(5).optional(),
      },
    },
    async ({ prompt, count, ref_image_paths }) => {
      const refImagePaths = ref_image_paths ?? [];
      const validationError = validateRefImagePaths(refImagePaths);
      if (validationError !== undefined) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${validationError}` }],
          isError: true,
        };
      }
      const kind: JobKind = refImagePaths.length > 0 ? 'edit' : 'generate';
      const total = count ?? 1;
      const jobs: Job[] = [];
      for (let i = 0; i < total; i += 1) {
        const request: JobRequest =
          kind === 'edit' ? { kind, prompt, refImagePaths } : { kind, prompt };
        jobs.push(deps.queue.submit(request));
      }
      const finished = await Promise.all(jobs.map((job) => waitForJob(deps.queue, job.id)));
      const images: GeneratedImageEntry[] = [];
      const failed: FailedEntry[] = [];
      for (const job of finished) {
        if (job.state === 'succeeded' && job.imageId !== undefined) {
          const meta = await deps.store.get(job.imageId);
          if (meta === undefined) {
            failed.push({ error: `画像メタデータが見つかりません: ${job.imageId}` });
            continue;
          }
          // Same entry shape as list_recent_images: full ImageMeta + absolute path
          const entry: GeneratedImageEntry = {
            ...meta,
            path: deps.store.imagePath(job.imageId),
          };
          images.push(entry);
        } else {
          failed.push({ error: job.error ?? '原因不明のエラーで失敗しました' });
        }
      }
      const text = JSON.stringify({ images, failed });
      if (images.length === 0) {
        return { content: [{ type: 'text' as const, text }], isError: true };
      }
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.registerTool(
    'list_recent_images',
    {
      title: '最近の画像一覧',
      description: '生成済み画像のメタデータと絶対パスを新しい順に JSON 文字列で返す。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ limit }) => {
      const metas = await deps.store.list(limit);
      const entries = metas.map((meta) => ({ ...meta, path: deps.store.imagePath(meta.id) }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(entries) }] };
    },
  );
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'imagegen-server', version: '0.1.0' });
  registerTools(server, deps);
  return server;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('リクエストボディが大きすぎます(上限 1MB)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('リクエストボディが JSON として不正です'));
      }
    });
    req.on('error', reject);
  });
}

export function createMcpHandler(
  deps: McpDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        }),
      );
      return;
    }
    // Stateless: a fresh server + transport per POST request.
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      const body = await readJsonBody(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : '内部エラーが発生しました';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null }),
        );
      }
    }
  };
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/mcp.test.ts`
Expected: PASS — 9 件すべて成功(ツール一覧 1 / generate_image 6 / list_recent_images 1 / ハンドラ 405 1)。出力例:

```
 ✓ test/mcp.test.ts (9 tests)
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

失敗した場合の典型原因:
- `MaxListenersExceededWarning` ではなくエラーで落ちる場合: `waitForJob` の解除漏れ(`queue.off`)を確認
- `text コンテンツがありません`: ツールが `content: [{ type: 'text', ... }]` 以外を返している
- 405 テストの失敗: `req.method !== 'POST'` 分岐が `handleRequest` より前にあるか確認

- [ ] **Step 6: 型チェック**

Run: `pnpm --filter @imagegen/server exec tsc --noEmit`
Expected: 出力なし・終了コード 0(型エラー 0 件)

- [ ] **Step 7: コミット**

```bash
git add server/src/mcp.ts server/test/mcp.test.ts server/package.json pnpm-lock.yaml
git commit -m "feat: MCP サーバー(generate_image / list_recent_images)を追加"
```

注記(このタスクで触れない範囲):
- `/mcp` への実際のルーティング(`req.url?.startsWith('/mcp')`)と本番 runner の合成は Task 9(`server/src/index.ts`)で行う。このタスクの `createMcpHandler` はそこから呼ばれる。
- Claude Code / Codex への MCP 登録手順は Task 11(README)に記載する。
- MCP クライアント側のタイムアウト(`generate_image` は count 最大 10 で数分かかりうる、スペック §9-5)は実機スモーク(Task 11)で確認する。本タスクのテストは即時完了するスタブ runner のため影響しない。
### Task 9: 設定と合成ルート

**目的:** 設定ロード(`config.ts`)を TDD で実装し、これまでの全部品(store / queue / engine / api / mcp)を 1 つの HTTP サーバーに合成する `index.ts` を作る。合成配線そのものは偽 app-server を使った統合スモークテストで検証する。

**前提:** Task 2(ImageStore)、Task 3(JobQueue)、Task 6(AppServerEngine + fake-appserver.mjs)、Task 7(REST API)、Task 8(MCP)が完了していること。このタスク以降は直列で進める。

**Files:**
- Create: `server/src/config.ts`
- Create: `server/test/config.test.ts`
- Modify: `server/src/index.ts`(Task 0 の仮実装 `console.log('imagegen-server: not wired yet')` を本実装に丸ごと置き換える)
- Create: `server/test/integration.test.ts`
- Modify(必要時のみ): `package.json`(ルート)、`server/package.json`(scripts 配線の確認)

**設計メモ(実装前に読むこと):**

1. **設定の解決順序(`loadConfig`)。** config.json は `<dataDir>/config.json` に置かれるため、ファイルを読む前に dataDir を確定しなければならない。順序は固定:
   1. CLI フラグ(`--port` `--concurrency` `--model` `--data-dir` `--codex-bin`)を解析する
   2. dataDir を確定する(`--data-dir` > 既定 `~/.imagegen-server`)
   3. `<dataDir>/config.json` を読む(無ければ空扱い。JSON として不正なら日本語メッセージで throw)
   4. 値ごとに「フラグ > ファイル > デフォルト」で合成し、最後に範囲検証(port 1..65535、concurrency 1..10)
   - config.json で上書きできるキーは `port` / `concurrency` / `turnModel` / `codexBin` のみ。`dataDir` をファイルで動かすと「ファイルの場所が dataDir に依存する」循環になるため、ファイル内の `dataDir` キーは無視する(dataDir はフラグか既定値でのみ決まる)。`host` は常に `127.0.0.1` で設定不可(spine §3.1)
2. **`index.ts` は直接ユニットテストしない。** 配線ミスは統合スモーク(`integration.test.ts`)で検出する。そのためにテストから再利用できる `composeServer(config, engineOverrides?)` を export し、CLI 起動時のみ `main()` が走るように `import.meta.url === pathToFileURL(process.argv[1]).href` でガードする(vitest が import しても副作用ゼロ)
3. **`/mcp` 分岐では body を読まない。** raw body の読み取りは `createMcpHandler`(Task 8)の内部で行う。`index.ts` の `createServer` コールバックは `req`/`res` をそのまま渡すだけにする(ここで stream を消費すると MCP ハンドラが body を読めなくなる)
4. **静的配信の root は cwd 相対。** `serveStatic`(@hono/node-server)の `root` はプロセスの cwd 起点の相対パスとして解釈されるため、`path.relative(process.cwd(), webDistDir)` を渡す(spine §6.3)。`web/dist` が無ければ日本語の案内テキストを返す
5. **エンジンは lazy 起動 + 認証確認(スペック §6)。** `AppServerEngine` は最初の generate / edit / authStatus 呼び出し時に子プロセスを spawn する(Task 6)ので、`index.ts` で `engine.start()` を呼ぶ必要はない。codex 未インストールでもサーバー自体は起動できる。スペック §6 の「起動時とジョブ失敗時に getAuthStatus で確認」には次の 2 箇所で対応する:
   - `main()`: listen 完了後に `void engine.authStatus().then(...)` を fire-and-forget で呼び、`loggedIn === false` なら `auth.message`(例「codex login が必要です」)を `console.error` で起動ログに出す。起動自体は失敗させない(失敗・拒否は無視)。注記: この呼び出しがエンジン子プロセスの初回 spawn になるが、lazy spawn と両立する範囲として許容する
   - `buildRunner`: catch 節でエラーを再 throw する前に `engine.authStatus()` を確認し(確認自体の失敗は無視)、`loggedIn === false` なら `job.error` の先頭に「codex login が必要です: 」を付加する
6. **createApi のルートは `/api` 込み。** Task 7 の `createApi` は `app.post('/api/jobs', ...)` のように `/api` プレフィックス込みでルートを定義しているので、index.ts では `app.route('/', apiApp)` でそのままマージする(`app.route('/api', apiApp)` にすると `/api/api/jobs` になる)

- [ ] **Step 1: config の失敗するテストを書く**

`server/test/config.test.ts` を作成する。`homedir()` は `vi.mock('node:os')` で一時ディレクトリに差し替え、実機の `~/.imagegen-server/config.json` に依存しないようにする(このために `config.ts` 側は `import { homedir } from 'node:os'` の名前付き import を使うこと)。

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { imagesDir, loadConfig, uploadsDir, workDir } from '../src/config.js';

let fakeHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: (): string => fakeHome,
  };
});

describe('loadConfig', () => {
  let dataDir: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), 'imagegen-home-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'imagegen-data-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('フラグもファイルも無ければデフォルト値を返す', () => {
    const c = loadConfig(['--data-dir', dataDir]);
    expect(c.port).toBe(7878);
    expect(c.host).toBe('127.0.0.1');
    expect(c.concurrency).toBe(3);
    expect(c.codexBin).toBe('codex');
    expect(c.dataDir).toBe(dataDir);
    expect(c.turnModel).toBeUndefined();
  });

  it('dataDir の既定は ~/.imagegen-server', () => {
    const c = loadConfig([]);
    expect(c.dataDir).toBe(path.join(fakeHome, '.imagegen-server'));
  });

  it('config.json の部分上書きを反映する(無いキーはデフォルトのまま)', () => {
    writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ port: 8080, turnModel: 'gpt-5.1' }),
    );
    const c = loadConfig(['--data-dir', dataDir]);
    expect(c.port).toBe(8080);
    expect(c.turnModel).toBe('gpt-5.1');
    expect(c.concurrency).toBe(3);
    expect(c.codexBin).toBe('codex');
  });

  it('CLI フラグはファイルより優先される', () => {
    writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        port: 8080,
        concurrency: 5,
        turnModel: 'file-model',
        codexBin: '/opt/codex',
      }),
    );
    const c = loadConfig([
      '--data-dir', dataDir,
      '--port', '9090',
      '--concurrency', '2',
      '--model', 'flag-model',
      '--codex-bin', '/usr/bin/codex',
    ]);
    expect(c.port).toBe(9090);
    expect(c.concurrency).toBe(2);
    expect(c.turnModel).toBe('flag-model');
    expect(c.codexBin).toBe('/usr/bin/codex');
  });

  it('config.json が不正な JSON なら日本語メッセージで throw する', () => {
    writeFileSync(path.join(dataDir, 'config.json'), '{ こわれてる');
    expect(() => loadConfig(['--data-dir', dataDir])).toThrow(/JSON が不正/);
  });

  it('port が範囲外なら throw する', () => {
    expect(() => loadConfig(['--data-dir', dataDir, '--port', '70000'])).toThrow(/1〜65535/);
    expect(() => loadConfig(['--data-dir', dataDir, '--port', '0'])).toThrow(/1〜65535/);
  });

  it('concurrency が範囲外なら throw する', () => {
    expect(() => loadConfig(['--data-dir', dataDir, '--concurrency', '11'])).toThrow(/1〜10/);
  });

  it('派生パスヘルパーが dataDir 配下を返す', () => {
    const c = loadConfig(['--data-dir', dataDir]);
    expect(imagesDir(c)).toBe(path.join(dataDir, 'images'));
    expect(uploadsDir(c)).toBe(path.join(dataDir, 'uploads'));
    expect(workDir(c)).toBe(path.join(dataDir, 'work'));
  });
});
```

- [ ] **Step 2: config テストが失敗することを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/config.test.ts`
Expected: FAIL(`../src/config.js` がまだ存在しないため import の解決に失敗する: `Failed to resolve import "../src/config.js"`)

- [ ] **Step 3: config.ts を実装**

`server/src/config.ts` を作成する。フラグ解析は自前の文字列処理ではなく `node:util` の `parseArgs` を使う。

```ts
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

export interface Config {
  port: number; // default 7878
  host: string; // always '127.0.0.1' (not configurable)
  concurrency: number; // default 3
  turnModel?: string; // codex default model when omitted
  dataDir: string; // default ~/.imagegen-server
  codexBin: string; // default 'codex'
}

const DEFAULT_PORT = 7878;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_CODEX_BIN = 'codex';

interface CliFlags {
  port?: number;
  concurrency?: number;
  model?: string;
  dataDir?: string;
  codexBin?: string;
}

interface FileConfig {
  port?: number;
  concurrency?: number;
  turnModel?: string;
  codexBin?: string;
}

function toInteger(raw: string, label: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${label} は整数で指定してください: ${raw}`);
  }
  return Number(raw);
}

function rawParse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      concurrency: { type: 'string' },
      model: { type: 'string' },
      'data-dir': { type: 'string' },
      'codex-bin': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
}

function parseCliFlags(argv: string[]): CliFlags {
  let values: ReturnType<typeof rawParse>['values'];
  try {
    ({ values } = rawParse(argv));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`コマンドライン引数を解析できません: ${detail}`);
  }
  const flags: CliFlags = {};
  if (values.port !== undefined) flags.port = toInteger(values.port, 'port');
  if (values.concurrency !== undefined) {
    flags.concurrency = toInteger(values.concurrency, 'concurrency');
  }
  if (values.model !== undefined) flags.model = values.model;
  if (values['data-dir'] !== undefined) flags.dataDir = path.resolve(values['data-dir']);
  if (values['codex-bin'] !== undefined) flags.codexBin = values['codex-bin'];
  return flags;
}

function readFileConfig(filePath: string): FileConfig {
  if (!existsSync(filePath)) return {};
  const text = readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`設定ファイルの JSON が不正です: ${filePath}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`設定ファイルは JSON オブジェクトで記述してください: ${filePath}`);
  }
  const obj = parsed as Record<string, unknown>;
  const out: FileConfig = {};
  if (obj['port'] !== undefined) {
    if (typeof obj['port'] !== 'number') {
      throw new Error(`設定ファイルの port は数値で指定してください: ${filePath}`);
    }
    out.port = obj['port'];
  }
  if (obj['concurrency'] !== undefined) {
    if (typeof obj['concurrency'] !== 'number') {
      throw new Error(`設定ファイルの concurrency は数値で指定してください: ${filePath}`);
    }
    out.concurrency = obj['concurrency'];
  }
  if (obj['turnModel'] !== undefined) {
    if (typeof obj['turnModel'] !== 'string') {
      throw new Error(`設定ファイルの turnModel は文字列で指定してください: ${filePath}`);
    }
    out.turnModel = obj['turnModel'];
  }
  if (obj['codexBin'] !== undefined) {
    if (typeof obj['codexBin'] !== 'string') {
      throw new Error(`設定ファイルの codexBin は文字列で指定してください: ${filePath}`);
    }
    out.codexBin = obj['codexBin'];
  }
  // NOTE: a 'dataDir' key in the file is intentionally ignored:
  // the file location itself depends on dataDir (flag or default only).
  return out;
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`port は 1〜65535 の整数で指定してください: ${port}`);
  }
}

function validateConcurrency(concurrency: number): void {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new Error(`concurrency は 1〜10 の整数で指定してください: ${concurrency}`);
  }
}

// Resolution order (fixed):
//   1. parse CLI flags
//   2. resolve dataDir (--data-dir > default ~/.imagegen-server)
//      BEFORE reading config.json, because the file lives in <dataDir>
//   3. read <dataDir>/config.json (empty when missing)
//   4. merge per key: flag > file > default, then validate ranges
export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const flags = parseCliFlags(argv);
  const dataDir = flags.dataDir ?? path.join(homedir(), '.imagegen-server');
  const file = readFileConfig(path.join(dataDir, 'config.json'));

  const port = flags.port ?? file.port ?? DEFAULT_PORT;
  const concurrency = flags.concurrency ?? file.concurrency ?? DEFAULT_CONCURRENCY;
  const turnModel = flags.model ?? file.turnModel;
  const codexBin = flags.codexBin ?? file.codexBin ?? DEFAULT_CODEX_BIN;

  validatePort(port);
  validateConcurrency(concurrency);

  return {
    port,
    host: '127.0.0.1',
    concurrency,
    ...(turnModel !== undefined ? { turnModel } : {}),
    dataDir,
    codexBin,
  };
}

export function imagesDir(c: Config): string {
  return path.join(c.dataDir, 'images');
}

export function uploadsDir(c: Config): string {
  return path.join(c.dataDir, 'uploads');
}

export function workDir(c: Config): string {
  return path.join(c.dataDir, 'work');
}
```

- [ ] **Step 4: config テストが通ることを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/config.test.ts`
Expected: PASS(8 tests)

- [ ] **Step 5: config をコミット**

```bash
git add server/src/config.ts server/test/config.test.ts
git commit -m "feat: 設定ロード config.ts を追加(ファイル+CLIフラグ、検証付き)"
```

- [ ] **Step 6: 統合スモークの失敗するテストを書く**

`server/test/integration.test.ts` を作成する。`index.ts` の `composeServer` を実際の配線のまま使い、エンジンだけ `engineOverrides` で偽 app-server(Task 5 の `fake-appserver.mjs`、happy シナリオ)に差し替える。ポートは `listen(0)` のエフェメラルポートを使う(`Config` を直接構築するので `loadConfig` の範囲検証は通らず、`port: 0` を書ける)。SSE(`/api/events`)は接続直後の初期スナップショット 1 フレームのみここで検証し、ライブ配信は Task 10 のブラウザ手動確認でカバーする。

```ts
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
```

- [ ] **Step 7: 統合テストが失敗することを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/integration.test.ts`
Expected: FAIL(`server/src/index.ts` は Task 0 の仮実装のままで `composeServer` を export していないため、`SyntaxError: The requested module '../src/index.js' does not provide an export named 'composeServer'` 相当のエラーになる)

- [ ] **Step 8: index.ts を本実装に置き換える**

`server/src/index.ts` を以下の内容で**丸ごと置き換える**。`web/dist` の位置は `import.meta.url` から `../../web/dist` で求める(`server/src/index.ts` 実行時も、ビルド後の `server/dist/index.js` 実行時も、リポジトリルートからの深さが同じなので両方で正しく解決される)。

```ts
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
```

- [ ] **Step 9: 統合テストが通ることを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/integration.test.ts`
Expected: PASS(4 tests。1 本目でジョブ投入→ポーリング→PNG 取得、2 本目で /api/events の初期スナップショット 1 フレーム受信、3 本目で health ok、4 本目で /mcp GET 405)

FAIL する場合の典型原因:
- `/mcp` 分岐より前に body を読んでいる(MCP ハンドラがハングする)
- `app.route('/', apiApp)` ではなく `app.route('/api', apiApp)` にしてしまい `/api/api/jobs` になっている(Task 7 の `createApi` は `/api` 込みのパスでルートを定義している)
- `engineOverrides` が `codexBin` を上書きできていない(`composeServer` 内のスプレッドの順序が逆。`...engineOverrides` を最後に置く)
- health が `ok: false` を返す: 偽サーバーの `FAKE_SCENARIO` が `happy` 以外になっている(`auth-expired` だと loggedIn=false)

- [ ] **Step 10: scripts 配線を確認(必要なら追記)**

ルートと server の package.json に以下の scripts が揃っていることを確認する。**Task 0 で作成済みなので、揃っていれば変更不要**(このステップは確認のみ)。欠けているキーがあれば下記の形に合わせて追記する。

`server/package.json`(scripts 部分の期待形 — Task 0 と同一):

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "test": "vitest run"
  }
}
```

ルート `package.json`(scripts 部分の期待形 — Task 0 と同一):

```json
{
  "scripts": {
    "dev": "pnpm --filter @imagegen/server dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test"
  }
}
```

Run: `cat package.json server/package.json`
Expected: 上記 scripts が存在する(無いキーがあれば追記してから再確認)

- [ ] **Step 11: 型チェック(ビルド)と全テストを実行**

Run: `pnpm --filter @imagegen/server build`
Expected: 終了コード 0(型エラーなし。`server/dist/` に `index.js` / `config.js` ほかが生成される)

Run: `pnpm --filter @imagegen/server exec vitest run`
Expected: PASS(store / queue / jsonrpc / fake-appserver.smoke / appserver / api / mcp / config / integration の全テストファイルが成功)

- [ ] **Step 12: 手動起動スモーク(起動ログと graceful shutdown)**

データディレクトリを一時パスに向けて起動する(実機の `~/.imagegen-server` を汚さない。codex 未インストールでも起動はできる — listen 後の authStatus 確認は失敗しても無視されるため。codex がインストール済みで未ログインの場合は、起動ログに「codex login が必要です」系の警告が `console.error` で出る)。`pnpm dev` は watch モード(`tsx watch`)で Ctrl-C の挙動確認に向かないため、ここでは watch なしの `tsx` を直接使う。

Run: `pnpm --filter @imagegen/server exec tsx src/index.ts --data-dir /tmp/imagegen-smoke`
Expected: 起動ログ `imagegen-server: http://127.0.0.1:7878 (GUI/API) , /mcp (MCP)` が表示され、プロセスが常駐する

別ターミナルで:

```bash
curl -s http://127.0.0.1:7878/api/jobs
# Expected: []
curl -s http://127.0.0.1:7878/
# Expected: GUI は未ビルド(pnpm --filter @imagegen/web build)
#(この時点では web/dist が無いため。Task 10 完了後は index.html が返る)
```

元のターミナルで Ctrl-C:
Expected: `SIGINT を受信したため終了します` と表示されてプロセスが終了する(ハングしない)

確認後に後始末: `rm -rf /tmp/imagegen-smoke`

- [ ] **Step 13: コミット**

```bash
git add server/src/index.ts server/test/integration.test.ts
# Step 10 で package.json / server/package.json を変更した場合のみ加える:
# git add package.json server/package.json
git commit -m "feat: 合成ルート index.ts と統合スモークテストを追加"
```
### Task 10: Web GUI

**目的:** React + Vite の SPA(プロンプト投入・ジョブのリアルタイム表示・ギャラリー・参照画像による再生成・認証状態の明示)を `web/` パッケージとして実装し、`pnpm --filter @imagegen/web build` で `web/dist` を生成して Task 9 の静的配信に載せる。

**前提:**
- Task 0 完了(pnpm workspace。`pnpm-workspace.yaml` には `web` が既に書かれている)
- Task 7 完了(REST API の形状。本タスク冒頭で `server/src/api.ts` に小さな変更を入れる)
- Task 9 完了(手動確認 Step 15〜16 でサーバー本体を使う。Step 14 までは Task 9 なしでも進められる)

**Files:**
- Modify: `server/test/api.test.ts`(GET /api/images の `path` フィールド検証を追加)
- Modify: `server/src/api.ts`(画像一覧の各アイテムに `path` を付与)
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/api.ts`
- Create: `web/src/App.tsx`
- Create: `web/src/components/PromptForm.tsx`
- Create: `web/src/components/JobList.tsx`
- Create: `web/src/components/Gallery.tsx`
- Create: `web/src/components/ImageModal.tsx`
- Create: `web/src/app.css`
- Modify: `pnpm-lock.yaml`(`pnpm install` による自動更新)

**設計メモ(実装前に読むこと):**

1. **GET /api/images に `path` を追加する(本タスク唯一のサーバー変更)。** GUI の「これを元に再生成」(画像をそのまま `refImagePaths` に入れる)と「パスをコピー」には、画像ファイルのサーバー側絶対パスが必要だが、共有型 `ImageMeta` には `path` が無い。そこで `GET /api/images` のレスポンスだけを `ImageMeta & { path: string }` の配列に拡張する(サーバー側で `store.imagePath(meta.id)` を付与)。共有型 `shared/src/index.ts` は変更しない(全タスク共通の固定全文のため)。GUI 側はローカル型 `ImageItem = ImageMeta & { path: string }` で受ける。既存フィールドの純増なので Task 8 (MCP) ほか既存コードには影響しない。これは Task 7 成果物への明示的なクロスタスク変更なので、TDD(Step 1〜5)で行う
2. **web の TypeScript 設定。** `tsconfig.base.json` を継承しつつ `module: ESNext` / `moduleResolution: bundler` / `jsx: react-jsx` に上書きする。bundler 解決なので **web 配下の相対 import に `.js` 拡張子は付けない**(`.js` 必須なのは server 配下のみ)。共有型は規約どおり `import type { ... } from '@imagegen/shared'`(型のみ参照なので vite のバンドルには一切入らない)
3. **SSE 購読と再接続。** `subscribeEvents(onJob)` が EventSource を所有し、`error` 時は close → 2 秒後に再接続する(EventSource 組み込みの再接続に任せず明示制御して挙動を決定的にする)。返り値は購読解除関数で、`App` の effect はそれを呼ぶだけ。サーバーは接続時に全ジョブのスナップショットを `event: job` で再送するため(Task 7)、再接続後も状態は自動復元される。なおサーバー再起動をまたぐとサーバー側キューは空になるので、再起動前の queued/running 行が画面に残り得る(リロードで消える。v1 許容)
4. **ギャラリー更新のタイミング。** `App` はジョブを `Map<string, Job>` で保持し、`useRef` のミラーで直前状態と比較する。「直前状態が存在し、succeeded 以外 → succeeded」へ遷移したときだけ `listImages` を再取得する。初回マウント時の一括取得が過去分を賄うので、接続直後のスナップショット(過去の succeeded ジョブ多数)で再取得が連発しない
5. **vite dev proxy。** `/api` と `/mcp` を `http://127.0.0.1:7878` へ proxy する。画像配信は `/api/images/:id` なので `/api` だけで賄える(`/images` という単独ルートは存在しない)
6. **peer 依存の注意(Task 0 の方針の再掲)。** `vite ^8` を追加した `pnpm install` が vitest 4 との peer 互換エラーになった場合は、web の `vite` を `^7` に下げて解決する
7. **コンポーネントの返り値型注釈は付けない。** @types/react 19 ではグローバル `JSX` 名前空間が無い(`React.JSX.Element`)ため、コンポーネント関数は型推論に任せる
8. **認証状態の GUI 明示(スペック §6)。** マウント時に `GET /api/health` を取得し、`auth.loggedIn === false` のとき `auth.message` をヘッダー直下の警告バナー(`role="alert"`、目立つ背景色)で表示する。ジョブが failed に遷移したタイミングでも再取得してバナーを更新する(ログイン切れによる失敗を即座に可視化するため)。Step 13 で api.ts / App.tsx / app.css に後付けする

- [ ] **Step 1: GET /api/images の `path` を検証する失敗テストを追加**

`server/test/api.test.ts` の `describe('GET /api/images', ...)` ブロック末尾(`'UUID 形式でない id なら 400 を返す'` の `it` の直後)に、次の `it` を追加する:

```ts
  it('各アイテムにサーバー側絶対パス path を含める(GUI の再生成・コピー用)', async () => {
    const meta = await seedImage('2026-06-13T03:00:00.000Z');
    const res = await app.request('/api/images');
    expect(res.status).toBe(200);
    const items = (await res.json()) as Array<ImageMeta & { path: string }>;
    const item = items.find((m) => m.id === meta.id);
    expect(item?.path).toBe(store.imagePath(meta.id));
  });
```

(`seedImage` / `store` は同 describe 内の既存ヘルパー・既存変数をそのまま使う。import の追加は不要 — `ImageMeta` は import 済み)

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/api.test.ts`
Expected: FAIL(追加した 1 件のみ失敗。`expected undefined to be '/…/images/<uuid>.png'` — 現行ハンドラは `ImageMeta` をそのまま返していて `path` が無いため。既存 22 件は PASS のまま)

- [ ] **Step 3: api.ts の GET /api/images ハンドラを変更**

`server/src/api.ts` の `app.get('/api/images', ...)` ハンドラ全体を次の内容に置き換える(変更は `deps.store.list` の結果を map する最後の 2 行のみ。他のルートは触らない):

```ts
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
    // The GUI needs the server-side absolute file path ("re-generate from
    // this image" / "copy path"). ImageMeta itself stays unchanged.
    const metas = await deps.store.list(limit);
    return c.json(metas.map((meta) => ({ ...meta, path: deps.store.imagePath(meta.id) })));
  });
```

- [ ] **Step 4: テストと型チェックが通ることを確認**

Run: `pnpm --filter @imagegen/server exec vitest run test/api.test.ts`
Expected: PASS(`Tests 23 passed (23)`)

Run: `pnpm --filter @imagegen/server exec tsc --noEmit`
Expected: 出力なしで exit 0

- [ ] **Step 5: API 変更をコミット**

```bash
git add server/src/api.ts server/test/api.test.ts
git commit -m "feat: 画像一覧 API にサーバー側絶対パスを追加(GUI の再生成・コピー用)"
```

- [ ] **Step 6: web パッケージの設定ファイル 4 つを作成**

`web/package.json` を作成する(バージョンは spine §6.1 のレンジ。`@imagegen/shared` は型のみ参照なので devDependencies):

```json
{
  "name": "@imagegen/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build"
  },
  "dependencies": {
    "react": "^19.2.7",
    "react-dom": "^19.2.7"
  },
  "devDependencies": {
    "@imagegen/shared": "workspace:*",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.2",
    "typescript": "^6.0.3",
    "vite": "^8.0.16"
  }
}
```

`web/tsconfig.json` を作成する(base を継承し、bundler 向けに上書き。`vite build` の前段 `tsc --noEmit` がこの設定で全 `.ts`/`.tsx` を検査する):

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "noEmit": true
  },
  "include": ["src", "vite.config.ts"]
}
```

`web/vite.config.ts` を作成する:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// /api covers image delivery too (/api/images/:id). /mcp is proxied so the
// MCP endpoint can be exercised from the dev origin as well.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7878',
      '/mcp': 'http://127.0.0.1:7878',
    },
  },
});
```

`web/index.html` を作成する:

```html
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>imagegen-server</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: pnpm install で依存解決を検証**

Run: `pnpm install`(リポジトリルートで実行)
Expected: PASS — `@imagegen/web` がワークスペースに認識され、react / vite ほかが追加されて exit 0(`Packages: +NNN`)。`pnpm-lock.yaml` が更新される。
**FAIL する場合:** `ERR_PNPM_PEER_DEP_ISSUES` で vitest 4 と vite 8 の互換が原因のときは、`web/package.json` の `"vite": "^8.0.16"` を `"vite": "^7"` に変更して再実行する(Task 0 で決めた方針)。

- [ ] **Step 8: 型付き fetch ラッパー + SSE 購読(web/src/api.ts)を作成**

`web/src/api.ts` を作成する:

```ts
import type { CreateJobsRequest, ImageMeta, Job } from '@imagegen/shared';

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
```

- [ ] **Step 9: エントリポイントと最上位コンポーネント(main.tsx / App.tsx)を作成**

`web/src/main.tsx` を作成する:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('GUI の初期化に失敗しました: #root 要素が見つかりません');
}
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`web/src/App.tsx` を作成する:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreateJobsRequest, Job, JobKind } from '@imagegen/shared';
import { createJobs, listImages, subscribeEvents } from './api';
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
    },
    [refreshImages],
  );

  useEffect(() => {
    void refreshImages();
  }, [refreshImages]);

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
```

- [ ] **Step 10: PromptForm.tsx と JobList.tsx を作成**

`web/src/components/PromptForm.tsx` を作成する:

```tsx
import { useRef, useState } from 'react';
import { uploadFile } from '../api';

interface PromptFormProps {
  prompt: string;
  count: number;
  refs: string[];
  error: string;
  onPromptChange: (value: string) => void;
  onCountChange: (value: number) => void;
  onAddRef: (path: string) => void;
  onRemoveRef: (path: string) => void;
  onSubmit: () => void;
}

export function PromptForm(props: PromptFormProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const handleFile = async (file: File) => {
    setUploading(true);
    setUploadError('');
    try {
      const { path } = await uploadFile(file);
      props.onAddRef(path);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const submitDisabled = props.prompt.trim() === '' || uploading;

  return (
    <form
      className="prompt-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!submitDisabled) props.onSubmit();
      }}
    >
      <textarea
        className="prompt-input"
        value={props.prompt}
        rows={4}
        placeholder="生成したい画像の内容を書いてください"
        onChange={(e) => props.onPromptChange(e.target.value)}
      />
      <div className="form-row">
        <label className="count-label">
          枚数
          <input
            type="number"
            min={1}
            max={10}
            value={props.count}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 10) props.onCountChange(n);
            }}
          />
        </label>
        <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? 'アップロード中…' : '参照画像を追加'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".png,.jpg,.jpeg,.webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void handleFile(file);
          }}
        />
        <button type="submit" className="submit" disabled={submitDisabled}>
          生成
        </button>
      </div>
      {props.refs.length > 0 && (
        <ul className="ref-chips">
          {props.refs.map((path) => (
            <li key={path} className="ref-chip" title={path}>
              <span className="ref-chip-name">{path.split('/').pop() ?? path}</span>
              <button
                type="button"
                aria-label={`参照画像 ${path} を外す`}
                onClick={() => props.onRemoveRef(path)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {(props.error !== '' || uploadError !== '') && (
        <p className="form-error">{props.error !== '' ? props.error : uploadError}</p>
      )}
    </form>
  );
}
```

`web/src/components/JobList.tsx` を作成する:

```tsx
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
```

- [ ] **Step 11: Gallery.tsx と ImageModal.tsx を作成**

`web/src/components/Gallery.tsx` を作成する:

```tsx
import { imageUrl } from '../api';
import type { ImageItem } from '../api';

interface GalleryProps {
  images: ImageItem[];
  onSelect: (image: ImageItem) => void;
  /** lifts the image's server-side absolute path into the form refs */
  onUseAsRef: (path: string) => void;
}

export function Gallery({ images, onSelect, onUseAsRef }: GalleryProps) {
  if (images.length === 0) {
    return <p className="empty">画像はまだありません</p>;
  }
  return (
    <div className="gallery">
      {images.map((image) => (
        <figure key={image.id} className="card">
          <button type="button" className="card-thumb" onClick={() => onSelect(image)}>
            <img src={imageUrl(image.id)} alt={image.prompt} loading="lazy" />
          </button>
          <figcaption className="card-caption" title={image.prompt}>
            {image.prompt}
          </figcaption>
          <button type="button" className="card-action" onClick={() => onUseAsRef(image.path)}>
            これを元に再生成
          </button>
        </figure>
      ))}
    </div>
  );
}
```

`web/src/components/ImageModal.tsx` を作成する:

```tsx
import { useState } from 'react';
import { imageUrl } from '../api';
import type { ImageItem } from '../api';

interface ImageModalProps {
  image: ImageItem;
  onClose: () => void;
}

export function ImageModal({ image, onClose }: ImageModalProps) {
  const [copyResult, setCopyResult] = useState('');

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(image.path);
      setCopyResult('コピーしました');
    } catch {
      setCopyResult('コピーに失敗しました(ブラウザのクリップボード権限を確認してください)');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <img className="modal-image" src={imageUrl(image.id)} alt={image.prompt} />
        <table className="meta-table">
          <tbody>
            <tr>
              <th>ID</th>
              <td>{image.id}</td>
            </tr>
            <tr>
              <th>種別</th>
              <td>{image.kind}</td>
            </tr>
            <tr>
              <th>prompt</th>
              <td>{image.prompt}</td>
            </tr>
            {image.revisedPrompt !== undefined && (
              <tr>
                <th>revisedPrompt</th>
                <td>{image.revisedPrompt}</td>
              </tr>
            )}
            {image.refImagePaths !== undefined && image.refImagePaths.length > 0 && (
              <tr>
                <th>参照画像</th>
                <td className="meta-path">{image.refImagePaths.join('\n')}</td>
              </tr>
            )}
            <tr>
              <th>生成日時</th>
              <td>{new Date(image.createdAt).toLocaleString()}</td>
            </tr>
            <tr>
              <th>所要時間</th>
              <td>{(image.durationMs / 1000).toFixed(1)} 秒</td>
            </tr>
            <tr>
              <th>パス</th>
              <td className="meta-path">{image.path}</td>
            </tr>
          </tbody>
        </table>
        <div className="modal-actions">
          <button type="button" onClick={() => void copyPath()}>
            パスをコピー
          </button>
          {copyResult !== '' && <span className="copy-result">{copyResult}</span>}
          <button type="button" className="modal-close" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 12: スタイル(app.css)を作成**

`web/src/app.css` を作成する:

```css
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --panel: #181b22;
  --border: #2a2f3a;
  --text: #e6e9ef;
  --text-dim: #9aa3b2;
  --accent: #4f8cff;
  --ok: #3ecf8e;
  --danger: #ff6b6b;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: 'Hiragino Sans', 'Noto Sans JP', system-ui, sans-serif;
  font-size: 14px;
}

button {
  background: #232836;
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  font: inherit;
}

button:hover:not(:disabled) {
  border-color: var(--accent);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

textarea,
input[type='number'] {
  background: #11141b;
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font: inherit;
}

.layout {
  max-width: 1280px;
  margin: 0 auto;
  padding: 16px;
}

.header h1 {
  margin: 4px 0 16px;
  font-size: 20px;
}

.main {
  display: grid;
  grid-template-columns: 400px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 960px) {
  .main {
    grid-template-columns: 1fr;
  }
}

.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
}

.panel h2 {
  margin: 16px 0 10px;
  font-size: 13px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.panel h2:first-child {
  margin-top: 0;
}

.prompt-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.prompt-input {
  width: 100%;
  resize: vertical;
}

.form-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.count-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
}

.count-label input {
  width: 64px;
}

.submit {
  margin-left: auto;
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.ref-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.ref-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #232836;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 6px 2px 10px;
}

.ref-chip-name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ref-chip button {
  border: none;
  background: transparent;
  padding: 0 4px;
  color: var(--text-dim);
}

.form-error {
  color: var(--danger);
  margin: 0;
}

.empty {
  color: var(--text-dim);
}

.job-list ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.job-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.badge {
  flex-shrink: 0;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  color: #0f1115;
}

.badge-queued {
  background: var(--text-dim);
}

.badge-running {
  background: var(--accent);
}

.badge-succeeded {
  background: var(--ok);
}

.badge-failed {
  background: var(--danger);
}

.job-prompt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.job-error {
  color: var(--danger);
  margin-left: auto;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.card {
  margin: 0;
  background: #11141b;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.card-thumb {
  padding: 0;
  border: none;
  border-radius: 0;
  background: #000;
}

.card-thumb img {
  display: block;
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
}

.card-caption {
  padding: 6px 8px 0;
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-action {
  margin: 8px;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  max-width: min(920px, 100%);
  max-height: 100%;
  overflow: auto;
}

.modal-image {
  display: block;
  max-width: 100%;
  max-height: 60vh;
  margin: 0 auto 12px;
}

.meta-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 12px;
}

.meta-table th,
.meta-table td {
  text-align: left;
  vertical-align: top;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}

.meta-table th {
  color: var(--text-dim);
  white-space: nowrap;
  width: 110px;
}

.meta-path {
  word-break: break-all;
  white-space: pre-wrap;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}

.modal-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.copy-result {
  color: var(--ok);
}

.modal-close {
  margin-left: auto;
}
```

- [ ] **Step 13: 認証状態の GUI 明示(スペック §6)を追加**

`web/src/api.ts` の先頭の import 行を次に置き換える(`HealthResponse` を追加):

```ts
import type { CreateJobsRequest, HealthResponse, ImageMeta, Job } from '@imagegen/shared';
```

同じく `web/src/api.ts` の `listImages` の直前に次を追記する:

```ts
export function getHealth(): Promise<HealthResponse> {
  return fetch('/api/health').then((res) => readJson<HealthResponse>(res));
}
```

`web/src/App.tsx` を次のとおり変更する(変更箇所のみ。他はそのまま):

(1) `./api` からの import 行を置き換える:

```tsx
import { createJobs, getHealth, listImages, subscribeEvents } from './api';
```

(2) `const [selected, ...]` の行の直後に state を 1 つ追加する:

```tsx
  const [authWarning, setAuthWarning] = useState('');
```

(3) `refreshImages` の定義の直後に `refreshAuth` を追加する:

```tsx
  const refreshAuth = useCallback(async () => {
    try {
      const health = await getHealth();
      // auth.message is optional in HealthResponse, so fall back to a fixed text.
      setAuthWarning(health.auth.loggedIn ? '' : (health.auth.message ?? 'codex login が必要です'));
    } catch {
      // /api/health unreachable: keep the current banner state
    }
  }, []);
```

(4) `handleJobEvent` 全体を次に置き換える(failed 遷移時の再取得を追加。依存配列に `refreshAuth` を追加):

```tsx
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
```

(5) マウント時の effect を次に置き換える(認証状態も初回取得):

```tsx
  useEffect(() => {
    void refreshImages();
    void refreshAuth();
  }, [refreshImages, refreshAuth]);
```

(6) JSX の `<header>` ブロックを次に置き換える(ヘッダー直下に警告バナーを追加):

```tsx
      <header className="header">
        <h1>imagegen-server</h1>
      </header>
      {authWarning !== '' && (
        <div className="auth-banner" role="alert">
          {authWarning}
        </div>
      )}
```

`web/src/app.css` の末尾に次を追記する(目立つ警告色の背景):

```css
.auth-banner {
  background: var(--danger);
  color: #0f1115;
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 16px;
  font-weight: 600;
}
```

検証: 型チェックとビルドは次の Step 14 でまとめて行う。未ログイン時の表示は Step 16 の手動確認 6(`--codex-bin` を偽物に向ける失敗系チェック)で確認する。

- [ ] **Step 14: 型チェック + 本番ビルドを検証**

Run: `pnpm --filter @imagegen/web build`
Expected: PASS — 前段の `tsc --noEmit` が無出力で通り、続けて vite が概ね次の形で出力して exit 0:

```
vite v8.0.16 building for production...
✓ NN modules transformed.
dist/index.html                  0.4x kB │ gzip: ...
dist/assets/index-<hash>.css     x.xx kB │ gzip: ...
dist/assets/index-<hash>.js    1xx.xx kB │ gzip: ...
✓ built in x.xxs
```

`web/dist/index.html` と `web/dist/assets/` が生成されていることを確認する(`.gitignore` の `dist/` により Git 管理外)。
FAIL する場合: tsc の型エラーが先に出る。エラー位置のファイルを修正してから再実行(典型は import type の漏れ、`@imagegen/shared` が devDependencies に無い、tsconfig の `lib` に DOM が無い)。

- [ ] **Step 15: サーバーからの静的配信を確認**

Task 9 の合成ルートが `web/dist` を配信できることを確認する(一時 dataDir を使い実環境を汚さない)。

Run: `pnpm --filter @imagegen/server exec tsx src/index.ts --data-dir /tmp/imagegen-gui-smoke`
Expected: `imagegen-server: http://127.0.0.1:7878 (GUI/API) , /mcp (MCP)` が表示され常駐する

別ターミナルで:

```bash
curl -s http://127.0.0.1:7878/ | head -c 300
```

Expected: `<!doctype html>` で始まる HTML が返り、`/assets/index-` への参照を含む(「GUI は未ビルド…」のテキストでは**ない**)。確認後、元のターミナルで Ctrl-C で停止し `rm -rf /tmp/imagegen-gui-smoke`。

- [ ] **Step 16: ブラウザでの手動検証(6 項目)**

実エンジンを使うため **codex login 済み**であることが前提(スペック §6。確認: サーバー起動後に `curl -s http://127.0.0.1:7878/api/health` が `"loggedIn":true` を含むこと。false なら先に `codex login`)。画像生成 1 枚ごとにサブスク利用枠を 1 ターン分消費する点に留意する。

Run: `pnpm --filter @imagegen/server exec tsx src/index.ts`(既定の `~/.imagegen-server` を使う通常起動)
ブラウザで `http://127.0.0.1:7878/` を開き、以下を順に確認する:

1. **GUI 配信**: 「生成」フォーム・「ジョブ」・「ギャラリー」のレイアウトが表示される(プレーンテキストの未ビルド案内ではない)。ログイン済みなのでヘッダー直下に警告バナーは表示されない
2. **入力検証**: prompt が空のとき「生成」ボタンが disabled。1 文字入力で有効化、全削除(または空白のみ)で再び無効化される
3. **並列生成 + SSE**: prompt(例 `a watercolor cat`)・枚数 2 で送信 → ジョブ一覧の先頭に 2 行が「待機中/実行中」で即時に現れ、**ページをリロードせずに**順次「成功」(緑バッジ)へ遷移する。成功と同時にギャラリーへ画像が自動追加される
4. **モーダル + パスをコピー**: ギャラリーの画像をクリック → 原寸画像とメタ(prompt / revisedPrompt / 所要時間 / パス)が表示される。「パスをコピー」→「コピーしました」と表示され、ターミナルの `pbpaste` で `~/.imagegen-server/images/<uuid>.png` の絶対パスが貼り付けられる。モーダルの背景クリックで閉じる
5. **アップロード + これを元に再生成**: 「参照画像を追加」でローカルの PNG を選ぶ → チップが追加され、× で外せる。次にギャラリーの「これを元に再生成」→ その画像のパスがチップに追加される。prompt(例 `make it blue`)を入れて送信 → edit ジョブが成功し、参照画像を踏まえた画像がギャラリーに追加される(モーダルのメタに「参照画像」行が出る)
6. **失敗・リトライと未ログインバナー(スペック §6)**: サーバーを Ctrl-C で停止し、必ず失敗する構成で再起動する: `pnpm --filter @imagegen/server exec tsx src/index.ts --data-dir /tmp/imagegen-gui-fail --codex-bin /usr/bin/false`。ブラウザをリロード → ヘッダー直下に赤い警告バナー(`role="alert"`)が表示される(偽の codex バイナリでは authStatus が失敗し、`GET /api/health` が `loggedIn:false` とメッセージを返すため。未ログイン状態の GUI 明示の確認を兼ねる)。次にジョブを 1 件投入 → 「失敗」(赤バッジ)とエラーテキストが行内に表示され、バナーは表示されたまま(failed 遷移時の再取得でも `loggedIn:false`)。「リトライ」ボタンで新しいジョブが即座に追加される(リトライも失敗してよい — リトライ経路の確認が目的)。確認後 Ctrl-C で停止し `rm -rf /tmp/imagegen-gui-fail`、通常のサーバーを使う場合は起動し直す

開発時の補足(変更不要・参考): GUI を編集しながら確認する場合は、サーバーを起動したまま別ターミナルで `pnpm --filter @imagegen/web dev` を実行し `http://localhost:5173/` を開く(`/api` と `/mcp` は vite が `127.0.0.1:7878` へ proxy する)。

- [ ] **Step 17: コミット**

```bash
git add web/package.json web/tsconfig.json web/vite.config.ts web/index.html \
  web/src/main.tsx web/src/App.tsx web/src/api.ts web/src/app.css \
  web/src/components/PromptForm.tsx web/src/components/JobList.tsx \
  web/src/components/Gallery.tsx web/src/components/ImageModal.tsx \
  pnpm-lock.yaml
git commit -m "feat: Web GUI(React + Vite SPA)を追加"
```

`git status --short` で `web/dist/` が表示されない(= `.gitignore` の `dist/` が効いている)ことも確認する。
### Task 11: README と仕上げ

**目的:** 利用者向け README(概要・セットアップ・起動・MCP 登録・ツール仕様・トラブルシューティング・検証済み codex バージョン)を書き、全テスト → 全ビルド → 実機スモーク → リポジトリ衛生確認 → 最終コミットで仕上げる。

**前提:** Task 0〜10 がすべて完了し、各タスクのテストが通っていること。実機スモーク(Step 6)には ChatGPT サブスク認証済みの codex CLI と Claude Code が必要。

**Files:**
- Create: `README.md`

注: スペックのテスト戦略にある「実機スモーク: 環境変数フラグで opt-in した場合のみ本物の生成を流す(手動)」は、本タスクでは vitest の opt-in テストではなく**手動チェックリスト(Step 6)**として実施する。自動で検証すべき挙動は Task 2〜10 の偽 app-server テストで網羅済みであり、実機スモークの目的は「実サブスク認証で本当に画像が出る」ことの最終確認のみ。env フラグ付き vitest を増やしても、サブスク利用枠を消費する不安定なテストが CI 対象ファイルに混ざるだけで利点がないためこの形にする。

- [ ] **Step 1: README.md を作成する**

リポジトリルートに `README.md` を以下の内容**そのまま**で作成する。「検証済み codex バージョン」表に `(Task 1 で記録)` という記入欄が 2 箇所あるが、これは Step 2 で実際の値に置き換える:

````markdown
# imagegen-server

Codex の画像生成ツール(imagegen)を、Codex のセッション外から使えるようにするローカル常駐サーバー。

- Claude Code / Codex から MCP(streamable HTTP)経由で画像を生成できる
- ブラウザ GUI から複数枚を並列生成し、ギャラリーで一覧・再利用できる
- 新規生成(generate)と、参照画像を使った編集(edit)の両方に対応
- 生成はすべて ChatGPT サブスクリプション認証の範囲内で行う(API キー課金は使わない)

## アーキテクチャ

単一の Node.js プロセスが `codex app-server` を子プロセスとして 1 つだけ常駐させ、画像 1 件ごとに ephemeral thread + 1 ターンで imagegen ツールを呼ばせる。認証(ChatGPT サブスク)とトークン管理はすべて codex 子プロセスに委譲し、本サーバーは認証トークンに一切触れない。ジョブはインメモリの worker pool(既定: 同時 3)で並列処理され、完了した画像とメタデータだけがディスクに永続化される(キュー自体は揮発で、再起動するとジョブ一覧は消えるがギャラリーは残る)。サーバーは `127.0.0.1` にのみバインドし、認証機構を持たない(ローカル利用限定)。

```
Claude Code ──MCP(HTTP)──┐
Codex CLI  ──MCP(HTTP)──┤
ブラウザGUI ──REST/SSE──┼─→ JobQueue(worker pool, 同時3・設定可)
                          │        ↓
                          │   ImageEngine interface
                          │        ↓
                          │   AppServerEngine
                          │        ↓ JSON-RPC (stdio)
                          └── codex app-server 子プロセス(常駐1つ)
                                   ↓ ephemeral thread × 並列
                              ChatGPT バックエンド(サブスク認証)
```

## 前提

- Node.js >= 22.18
- pnpm
- codex CLI がインストール済みで、**`codex login` 済み(ChatGPT サブスクリプション認証)** であること
  - **API キー認証(`OPENAI_API_KEY`)では画像生成できない。** imagegen は ChatGPT サブスク認証でのみ有効
  - 現在の認証状態は、サーバー起動後に `curl -s http://127.0.0.1:7878/api/health` の `auth` フィールドで確認できる

## セットアップ

```bash
pnpm install
pnpm -r build
```

## 起動

```bash
node server/dist/index.js
```

起動に成功すると次のログが出る:

```
imagegen-server: http://127.0.0.1:7878 (GUI/API) , /mcp (MCP)
```

終了は Ctrl+C(graceful shutdown: エンジン停止 → HTTP クローズ)。

開発時はビルドなしで起動できる(サーバーを tsx で直接実行):

```bash
pnpm dev
```

GUI 側のホットリロードが必要な場合は、別ターミナルで `pnpm --filter @imagegen/web dev` を実行する(Vite の dev サーバーが `/api` と `/mcp` を 7878 に proxy する)。

### CLI フラグ

| フラグ | 既定値 | 説明 |
| --- | --- | --- |
| `--port` | `7878` | リッスンポート(1〜65535)。バインド先は常に `127.0.0.1`(変更不可) |
| `--concurrency` | `3` | 画像生成の同時実行数(1〜10) |
| `--model` | (codex の既定モデル) | 画像生成ターンに使うモデル |
| `--data-dir` | `~/.imagegen-server` | データディレクトリ(画像・設定・作業領域の置き場) |
| `--codex-bin` | `codex` | codex CLI の実行コマンド(PATH に無い場合は絶対パスを指定) |

例: `node server/dist/index.js --port 8080 --concurrency 5`

### config.json

`<data-dir>/config.json`(既定: `~/.imagegen-server/config.json`)でも設定できる。優先順位は **CLI フラグ > config.json > 既定値**。

```json
{
  "port": 7878,
  "concurrency": 3,
  "turnModel": "gpt-5.1",
  "codexBin": "codex"
}
```

- 利用できるキーは `port` / `concurrency` / `turnModel`(`--model` に対応)/ `codexBin` の 4 つ。すべて省略可
- `dataDir` を変えたい場合は `--data-dir` フラグを使う(config.json 自体が `<data-dir>` 配下から読まれるため、ファイル内の `dataDir` キーは無視される)
- config.json が JSON として壊れている場合、起動時に日本語のエラーメッセージで停止する

## GUI

ブラウザで http://127.0.0.1:7878 を開く(`--port` を変えた場合はそのポート)。

- プロンプト + 枚数(1〜10)を入力して一括投入
- ジョブ一覧(キュー待ち / 実行中 / 完了 / 失敗)が SSE でリアルタイム更新される
- ギャラリー: グリッド表示。クリックで原寸 + メタ表示、ファイルパスのコピー
- 画像ごとの「これを元に再生成」で、その画像を参照画像とした編集ジョブを投入できる。参照画像のアップロードも可
- 失敗ジョブはリトライボタンで同パラメータのまま再投入できる

## MCP 登録

### Claude Code

```bash
claude mcp add --transport http imagegen http://127.0.0.1:7878/mcp
```

### Codex

`~/.codex/config.toml` に追加する:

```toml
[mcp_servers.imagegen]
url = "http://127.0.0.1:7878/mcp"
```

> **注意:** codex の streamable HTTP MCP クライアントは実装が流動的で、`experimental_use_rmcp_client` の要否や `mcp_servers` での URL 指定方法は**バージョンによって異なる**。上記で接続できない場合は `codex mcp add --help` を確認し、使用中のバージョンに合った登録方法に読み替えること。バージョンによっては次の指定が必要になる:

```toml
experimental_use_rmcp_client = true

[mcp_servers.imagegen]
url = "http://127.0.0.1:7878/mcp"
```

## MCP ツール仕様

### generate_image

画像を生成し、**全ジョブの完了までブロックして**結果を返す。`count > 1` は内部で並列処理される。`count` が大きいと数分かかりうるので、MCP クライアント側のツールタイムアウト設定に注意。

入力:

| 引数 | 型 | 説明 |
| --- | --- | --- |
| `prompt` | string(必須・非空) | 画像生成プロンプト。一字一句そのまま imagegen ツールに渡すようモデルに指示される |
| `count` | number(任意、1〜10、既定 1) | 生成枚数 |
| `ref_image_paths` | string[](任意、最大 5) | 指定すると編集(edit)になる。サーバーから読める絶対パス(.png / .jpg / .jpeg / .webp) |

返り値: text コンテンツ(JSON 文字列)。`images` の各要素は ImageMeta の全フィールド(`id` / `kind` / `prompt` / `revisedPrompt?` / `refImagePaths?` / `createdAt` / `durationMs` / `engine`)に `path`(保存先絶対パス)を加えたオブジェクト:

```json
{
  "images": [
    {
      "id": "<id>",
      "kind": "generate",
      "prompt": "...",
      "revisedPrompt": "...",
      "createdAt": "...",
      "durationMs": 12345,
      "engine": "app-server",
      "path": "/Users/you/.imagegen-server/images/<id>.png"
    }
  ],
  "failed": [
    { "error": "..." }
  ]
}
```

- `path` は保存済み PNG の絶対パス
- `revisedPrompt` はモデルが実際にツールへ渡した prompt(取得できた場合のみ)
- 一部失敗は `failed` 配列に載る。**全件失敗の場合のみ** `isError: true` のエラー結果になる

### list_recent_images

生成済み画像のメタデータと絶対パスを新しい順に返す。

| 引数 | 型 | 説明 |
| --- | --- | --- |
| `limit` | number(任意、1〜100) | 返す件数の上限 |

返り値: text コンテンツ(JSON 文字列)。各要素はメタデータ(`id` / `kind` / `prompt` / `revisedPrompt?` / `refImagePaths?` / `createdAt` / `durationMs` / `engine`)に画像ファイルの絶対パス `path` を加えたオブジェクトの配列。

## 保存場所

- 画像: `~/.imagegen-server/images/<id>.png`
- メタデータ: `~/.imagegen-server/images/<id>.json`
- アップロードした参照画像: `~/.imagegen-server/uploads/`

(`--data-dir` を変更した場合はそのディレクトリ配下)

ギャラリーはこのディレクトリのメタファイルをスキャンして表示する。DB は無いので、ファイルを消せばギャラリーからも消える。

## 検証済み codex バージョン

本サーバーは `codex app-server` のプロトコル(行区切り JSON-RPC)に依存する。下表は実機検証スクリプト(`scripts/probe.mjs`)を通したバージョンの記録。codex CLI を更新したら `node scripts/probe.mjs "a watercolor cat"` を再実行し、この表を更新すること。

| 項目 | 値 |
| --- | --- |
| codex CLI バージョン | (Task 1 で記録) |
| 検証日 | (Task 1 で記録) |

## トラブルシューティング

### 「codex login が必要です」と表示される / 認証エラーで失敗する

`codex login` で ChatGPT アカウントにログインする。API キー認証になっている場合も画像生成は不可(「画像生成には ChatGPT サブスクリプション認証(codex login)が必要です(API キー認証では不可)」と表示される)なので、ChatGPT サブスクリプションでログインし直す。現在の認証状態は `curl -s http://127.0.0.1:7878/api/health` の `auth` で確認できる。

### レート制限・バックエンドエラーで失敗する

ジョブは failed になり、エラーメッセージが GUI / MCP の結果に表示される。自動リトライはしない。時間をおいて、GUI のリトライボタン(API なら `POST /api/jobs/:id/retry`、MCP なら再度 `generate_image`)で再実行する。

### 「モデルが imagegen ツールを呼びませんでした」と失敗する

モデルが指示に従わず、画像生成ツールを呼ばずにターンを終えたケース。エラーメッセージにモデルの応答文が含まれる。**再リトライで解消することが多い。** 続く場合は `--model` で別のモデルを試す。

### GUI が「GUI は未ビルド(pnpm --filter @imagegen/web build)」というテキストを返す

`pnpm --filter @imagegen/web build` を実行してからサーバーを再起動する。
````

- [ ] **Step 2: 検証済み codex バージョンを転記する**

Task 1 Step 7 のチェックリストで probe 実行時に記録した `codex --version` の出力文字列と実行日を、README の「検証済み codex バージョン」表の `(Task 1 で記録)` 2 箇所に転記する。記録が手元に見当たらない場合は、probe を通したのと同じ環境で再取得する:

Run: `codex --version`
Expected: バージョン文字列が 1 行出る(例: `codex-cli 0.137.0` — 実際の出力をそのまま使う)

転記後の表の形(値は実際のものに置き換える):

```markdown
| 項目 | 値 |
| --- | --- |
| codex CLI バージョン | codex-cli 0.137.0 |
| 検証日 | 2026-06-13 |
```

- [ ] **Step 3: 記入欄が残っていないことを確認する**

Run: `grep -n "Task 1 で記録" README.md; echo "exit=$?"`
Expected: PASS — grep の出力なしで `exit=1`(マッチなし)。何か行が表示されたら転記漏れなので Step 2 に戻る。

- [ ] **Step 4: 全テストを実行する**

Run: `pnpm -r test`
Expected: PASS — `@imagegen/server` の vitest が全 9 テストファイル成功(`Test Files  9 passed (9)`):

```
✓ test/store.test.ts
✓ test/queue.test.ts
✓ test/jsonrpc.test.ts
✓ test/fake-appserver.smoke.test.ts
✓ test/appserver.test.ts
✓ test/api.test.ts
✓ test/mcp.test.ts
✓ test/config.test.ts
✓ test/integration.test.ts
```

failed が 0 であること。`@imagegen/shared`(型のみで test スクリプトなし)はスキップされる。`@imagegen/web` も test スクリプトが無ければスキップされる(あれば一緒に実行され、すべて成功すること)。FAIL したら該当タスクの実装に戻って修正し、全テストが通るまで先へ進まない。

- [ ] **Step 5: 全ビルドを実行する**

Run: `pnpm -r build`
Expected: PASS — tsc(server)と vite build(web)がエラーなく完了する(exit 0)

Run: `ls server/dist/index.js web/dist/index.html`
Expected: PASS — 両ファイルのパスが表示される。`No such file or directory` が出たらビルド失敗なので前のコマンドのエラーを解消する。

- [ ] **Step 6: 実機スモーク(手動チェックリスト)**

実サブスク認証での end-to-end を最終確認する。環境変数や特別なフラグは不要で、README どおりの手順をそのまま通す。**ChatGPT サブスクの利用枠を画像 4〜5 枚分(モデルターン 4〜5 回分)消費する。** 途中で失敗したら README のトラブルシューティング章の該当項目に従い、解消してから続ける。

- [ ] 1. サーバー起動: `node server/dist/index.js`
  - Expected: `imagegen-server: http://127.0.0.1:7878 (GUI/API) , /mcp (MCP)` が表示され、プロセスが常駐する
- [ ] 2. ヘルスチェック(別ターミナル): `curl -s http://127.0.0.1:7878/api/health`
  - Expected: `"ok":true` かつ `auth.loggedIn` が `true`。`false` なら `codex login` してから 1. をやり直す
- [ ] 3. GUI で 1 枚生成: ブラウザで http://127.0.0.1:7878 を開き、プロンプト `a tiny watercolor cat`・枚数 1 で投入
  - Expected: ジョブ一覧が queued → running → succeeded と(リロードなしで)遷移し、ギャラリーに猫の画像が表示される
- [ ] 4. 生成物の確認: `ls ~/.imagegen-server/images/`
  - Expected: `<uuid>.png` と `<uuid>.json` のペアが存在する
- [ ] 5. Claude Code に MCP 登録: `claude mcp add --transport http imagegen http://127.0.0.1:7878/mcp` のあと `claude mcp list`
  - Expected: 一覧に `imagegen` が表示され、接続ステータスが正常(Connected 等)
- [ ] 6. MCP 経由で 1 枚生成: `claude` を起動し、「imagegen の generate_image ツールで "a pencil sketch of a lighthouse" を 1 枚生成して、返ってきた path を教えて」と依頼
  - Expected: ツール結果の `images[0].path` が返り、`ls <そのパス>` で PNG が実在する
- [ ] 7. MCP 経由で複数枚生成(スペック §9-5 の検証): Claude Code から `generate_image` を `count` 2〜3 で呼ぶ(サブスク枠を消費する点に注意)
  - Expected: MCP クライアントのタイムアウトで切断されずに全件完了する。所要時間を記録する。タイムアウトする場合はクライアント側タイムアウト設定で暫定対処し、頻発するなら非同期 API(ジョブ ID + ポーリング)への変更を検討事項としてユーザーに報告する
- [ ] 8. 終了: サーバーのターミナルで Ctrl+C
  - Expected: graceful shutdown(エンジン停止 → HTTP クローズ)でプロセスが終了し、ハングしない

- [ ] **Step 7: リポジトリに余計なファイルが混入していないことを確認する**

Run: `git status --short`
Expected: PASS — `?? README.md` の 1 行のみ(README はまだ未コミットのため)。以下が表示されたら FAIL — コミットせず原因を直す:

- `server/dist/` / `web/dist/` / `node_modules/` → Task 0 の `.gitignore` の不備。`.gitignore` を修正する
- `probe-output.png` → Task 1 Step 3 の `.gitignore` 追記の不備。追記し直す
- スモークで生成した画像・一時ファイルなど、本計画のタスクで作成していないファイル → リポジトリに含めない(削除するか .gitignore 対象へ)

- [ ] **Step 8: 最終コミット**

コミット前に README の全文(= 今回の差分のすべて)を目視確認する:

Run: `git add README.md && git diff --cached`
Expected: Step 1〜2 で書いた README の内容が `+` 行として表示され、`(Task 1 で記録)` が残っていない(目視確認)

```bash
git commit -m "docs: README を追加"
```

Run: `git status --short`
Expected: PASS — 出力なし(working tree clean)。これで全タスク完了。
---

# 付録: 契約と早見表(spine)

本計画の各 Task が参照する「spine §N」はこの付録の §N を指す。型名・メソッド名・ファイルパス・規約・プロトコル JSON 形の唯一の真実源。各 Task のインラインコードと食い違いがあれば、原則この付録が正(逸脱は各 Task の DEVIATIONS/設計メモに明記されている)。
スペック本体: docs/superpowers/specs/2026-06-13-imagegen-server-design.md

## 0. 全体規約

- パッケージマネージャ: pnpm workspace。ルート直下に `server/` `web/` `shared/`
- すべて ESM(`"type": "module"`)。TypeScript strict。`any` 禁止(`unknown` + 絞り込み)
- server の tsconfig: `"module": "nodenext"`, `"moduleResolution": "nodenext"` → **相対 import には必ず `.js` 拡張子を付ける**(例: `import { JobQueue } from './queue.js'`)
- shared は **型のみ**(interface / type alias のみ。実行時コードを置かない)。consumer は必ず `import type { ... } from '@imagegen/shared'` を使う(ビルド成果物が不要になる)
- テスト: vitest。テストファイルは `server/test/*.test.ts`
- コード内コメントは最小限・英語。エラーメッセージ(ユーザー向け)は日本語
- コミットメッセージ: Conventional Commits、説明は日本語(例: `feat: JobQueue を追加`)
- サーバーのコードはクラスベースで依存注入(コンストラクタ引数)。グローバル状態禁止
- 画像生成のターン用instructionなど長い文字列はテンプレートリテラル定数として定義

## 1. リポジトリ構成(最終形)

```
imagegen-server/
  package.json              # workspace ルート(scripts: dev, build, test)
  pnpm-workspace.yaml
  tsconfig.base.json
  .gitignore
  scripts/
    probe.mjs               # 実機検証スクリプト(依存ゼロの素の Node)
  shared/
    package.json            # name: @imagegen/shared, types: ./src/index.ts
    src/index.ts            # 全共有型(下記 §2 全文)
  server/
    package.json            # name: @imagegen/server
    tsconfig.json
    src/
      config.ts             # 設定ロード(ファイル+CLIフラグ)
      store.ts              # ImageStore(画像+メタ永続化)
      queue.ts              # JobQueue(worker pool)
      engine/
        types.ts            # ImageEngine interface ほかエンジン契約
        jsonrpc.ts          # JsonRpcConnection(行区切り JSON-RPC)
        appserver.ts        # AppServerEngine(codex app-server 子プロセス管理)
      api.ts                # Hono REST + SSE
      mcp.ts                # MCP サーバー(streamable HTTP, stateless)
      index.ts              # 合成ルート(http server, ルーティング, graceful shutdown)
    test/
      fake-appserver.mjs    # 台本式の偽 app-server(子プロセスとして起動される)
      store.test.ts
      queue.test.ts
      jsonrpc.test.ts
      appserver.test.ts     # AppServerEngine ×偽 app-server の統合テスト
      api.test.ts
      mcp.test.ts
  web/
    package.json            # name: @imagegen/web
    vite.config.ts          # /api と /images を 7878 に proxy
    index.html
    src/
      main.tsx
      App.tsx               # 状態の最上位(jobs, images, form)
      api.ts                # 型付き fetch ラッパー + SSE 購読
      components/
        PromptForm.tsx
        JobList.tsx
        Gallery.tsx
        ImageModal.tsx
      app.css
  docs/
    superpowers/specs/2026-06-13-imagegen-server-design.md   # 既存
    superpowers/plans/2026-06-13-imagegen-server.md          # 本計画
  README.md
```

## 2. 共有型 — shared/src/index.ts(全文・これをそのまま使う)

```ts
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
```

## 3. モジュール契約(公開 API。シグネチャはこの通りに実装)

### 3.1 server/src/config.ts

```ts
export interface Config {
  port: number;          // default 7878
  host: string;          // 常に '127.0.0.1'(設定不可)
  concurrency: number;   // default 3
  turnModel?: string;    // 未指定なら codex デフォルト
  dataDir: string;       // default ~/.imagegen-server
  codexBin: string;      // default 'codex'
}
export function loadConfig(argv?: string[]): Config;
// 優先順: CLIフラグ(--port, --concurrency, --model, --data-dir, --codex-bin)
//   > <dataDir>/config.json(JSONとして妥当でなければ日本語メッセージで throw)
//   > デフォルト値
// dataDir 既定は os.homedir() + '/.imagegen-server'
// 派生パス(Config には含めずヘルパー関数で提供):
export function imagesDir(c: Config): string;   // <dataDir>/images
export function uploadsDir(c: Config): string;  // <dataDir>/uploads
export function workDir(c: Config): string;     // <dataDir>/work
```

### 3.2 server/src/store.ts

```ts
import type { ImageMeta } from '@imagegen/shared';
export class ImageStore {
  constructor(dir: string); // imagesDir。コンストラクタで mkdir -p 済みにする(同期)
  /** sourcePngPath を <dir>/<meta.id>.png に move/copy し、<dir>/<meta.id>.json を書く */
  save(meta: ImageMeta, sourcePngPath: string): Promise<void>;
  list(limit?: number): Promise<ImageMeta[]>; // createdAt 降順
  get(id: string): Promise<ImageMeta | undefined>;
  imagePath(id: string): string; // 存在チェックはしない。idは [0-9a-f-]のUUIDのみ許可(パストラバーサル防止、不正なら throw)
}
```

### 3.3 server/src/queue.ts

```ts
import { EventEmitter } from 'node:events';
import type { Job, JobRequest } from '@imagegen/shared';
export type JobRunner = (job: Job) => Promise<{ imageId: string }>;
export class JobQueue extends EventEmitter {
  // emit('update', job: Job) を状態遷移のたびに発火(queued含む)
  constructor(opts: { concurrency: number; runner: JobRunner });
  submit(req: JobRequest): Job;        // 即座に queued の Job を返す
  list(): Job[];                       // createdAt 昇順
  get(id: string): Job | undefined;
  retry(id: string): Job;              // failed のジョブのみ。同パラメータで新規 submit。対象が無い/failed でないなら Error(日本語)
  /** テスト用: 全ジョブ終了を待つ */
  onIdle(): Promise<void>;
}
```

実装規律: worker pool は「running 数 < concurrency なら次の queued を実行」の drain ループ。
runner の resolve → succeeded(imageId 設定)、reject → failed(error は err.message)。

### 3.4 server/src/engine/types.ts

```ts
export interface EngineResult {
  /** エンジンが所有する一時ファイルへの絶対パス(呼び出し側が move する) */
  pngPath: string;
  revisedPrompt?: string;
}
export interface ImageEngine {
  start(): Promise<void>;
  generate(req: { prompt: string }): Promise<EngineResult>;
  edit(req: { prompt: string; refImagePaths: string[] }): Promise<EngineResult>;
  authStatus(): Promise<AuthStatus>; // import type { AuthStatus } from '@imagegen/shared'
  stop(): Promise<void>;
}
```

### 3.5 server/src/engine/jsonrpc.ts

```ts
import type { Readable, Writable } from 'node:stream';
export class JsonRpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown);
}
export type NotificationHandler = (method: string, params: unknown) => void;
export class JsonRpcConnection {
  constructor(toServer: Writable, fromServer: Readable);
  request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: NotificationHandler): () => void; // 解除関数を返す
  /** サーバー→クライアントの request には一律 -32601 (method not found) を返す */
  close(reason?: string): void; // pending を全 reject
}
```

フレーミング: 1行1メッセージの JSON(改行区切り)。`jsonrpc` フィールドの有無は
プロトコル早見表(§5)に従う。id は 1 始まりの連番整数。

### 3.6 server/src/engine/appserver.ts

```ts
import type { AuthStatus } from '@imagegen/shared';
import type { EngineResult, ImageEngine } from './types.js';
export interface AppServerEngineOpts {
  codexBin: string;          // 'codex' または偽サーバー実行コマンド
  codexArgs?: string[];      // default ['app-server'](テストでは偽サーバーのパスに差し替え)
  workDir: string;           // thread の cwd に使う空ディレクトリ
  tmpDir: string;            // EngineResult.pngPath の置き場
  turnModel?: string;
  turnTimeoutMs?: number;    // default 180_000
  env?: Record<string, string>; // 子プロセス追加環境変数(テスト用)
}
export class AppServerEngine implements ImageEngine { /* §3.4 を実装 */ }
```

内部規律:
- 子プロセスは lazy 起動(最初の要求時)+ クラッシュ時は in-flight 全 reject → 次の要求で再 spawn(連続失敗は 1s, 2s, 4s... 最大 30s のバックオフ)
- 並列 generate/edit は同一接続上の複数 thread で行う。通知は threadId でデマルチプレクスする
- turn instruction は定数 `TURN_INSTRUCTION` テンプレート(プロンプト本文はフェンスで囲んで埋め込み)
- 成果回収: imageGeneration アイテム完了通知の savedPath を優先、無ければ base64 result をデコードして tmpDir に書く。どちらも無ければ「モデルが imagegen を呼ばなかった」失敗として、収集済みの assistant テキストをエラーメッセージに含める

### 3.7 server/src/api.ts

```ts
import type { Hono } from 'hono';
export interface ApiDeps {
  queue: JobQueue;
  store: ImageStore;
  engine: ImageEngine;
  uploadsDir: string;
}
export function createApi(deps: ApiDeps): Hono;
```

ルート(スペック5.7 + uploads):
- `POST /api/jobs` body: CreateJobsRequest → 201 `Job[]`(count 件 submit)。検証: prompt 非空 / count 1..10 / kind 'edit' は refImagePaths 必須・各パス存在・拡張子 .png/.jpg/.jpeg/.webp。エラーは 400 `{ error: string }`(日本語)
- `GET /api/jobs` → `Job[]`
- `POST /api/jobs/:id/retry` → 201 `Job` / 404 / 409(failed でない)
- `GET /api/images` → `ImageMeta[]`(query: limit)
- `GET /api/images/:id` → PNG バイナリ(Content-Type: image/png)/ 404
- `POST /api/uploads` → multipart(field name: file)を uploadsDir/<uuid>.<ext> に保存 → 201 `{ path: string }`
- `GET /api/events` → SSE。接続時に現在の全ジョブを `event: job` で送ってから、queue の 'update' を購読して送出
- `GET /api/health` → `HealthResponse`

### 3.8 server/src/mcp.ts

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export interface McpDeps { queue: JobQueue; store: ImageStore; }
/** テストはこちらを InMemoryTransport に接続して行う */
export function createMcpServer(deps: McpDeps): McpServer;
/** 本番: POST ごとに createMcpServer + StreamableHTTPServerTransport(stateless) を生成 */
export function createMcpHandler(deps: McpDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
```

- ツール `generate_image`: 入力 { prompt: string, count?: number(1..10), ref_image_paths?: string[] }。ref_image_paths は冒頭で検証(存在 + 拡張子 .png/.jpg/.jpeg/.webp + 最大5、違反は isError で即返す)。count 件 submit し全完了を待ち、結果を text コンテンツ(JSON文字列: { images: [{ ...ImageMeta, path }], failed: [{ error: string }] })で返す。全件失敗なら isError: true
- ツール `list_recent_images`: 入力 { limit?: number } → ImageMeta[] と各画像の絶対パス(text, JSON文字列)
- inputSchema は zod の raw shape(`z.object()` で包まない)。`import { z } from 'zod'`(zod 4)
- stateless パターン: POST ごとに新しい McpServer + `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` を作り `transport.handleRequest(req, res, body)`(body は自前で JSON parse して渡す)。GET/DELETE には 405 + JSON-RPC error `{code:-32000,message:'Method not allowed.'}` を返す。res の 'close' で transport.close() / server.close()
- ジョブ完了待ちは queue の 'update' イベントを購読して Promise 化するヘルパー `waitForJob(queue, jobId): Promise<Job>` を mcp.ts 内に定義(succeeded/failed で resolve)

### 3.9 server/src/index.ts

- `loadConfig` → ディレクトリ作成(images/uploads/work)→ ImageStore / AppServerEngine / JobQueue(runner = engine 呼び出し + store.save + ImageMeta 構築)を合成
- runner 内: kind による generate/edit 分岐、durationMs 計測、ImageMeta 構築は index.ts の `buildRunner(deps)` 関数に閉じる
- node:http の createServer で受け、`req.url?.startsWith('/mcp')` → MCP ハンドラ、それ以外 → Hono(`getRequestListener(app.fetch)`)
- Hono 側: /api/* → createApi、それ以外 → web/dist の静的配信(存在しなければ 「GUI は未ビルド(pnpm --filter @imagegen/web build)」のテキスト)
- SIGINT/SIGTERM → engine.stop() → server.close() → exit
- 起動ログ: `imagegen-server: http://127.0.0.1:7878 (GUI/API) , /mcp (MCP)` 形式

### 3.10 test/fake-appserver.mjs(台本式偽サーバー)

- 依存ゼロの素の Node スクリプト。stdin を行単位で読み、シナリオに応じて応答
- シナリオは環境変数 `FAKE_SCENARIO` で指定: `happy` | `no-tool` | `slow` | `crash-once` | `auth-expired`
- 共通動作:
  - initialize → §5.2 の形で応答。initialized 通知は無視
  - getAuthStatus → 既定 `{"authMethod":"chatgpt","requiresOpenaiAuth":false}`(auth-expired のみ `{"authMethod":null,"requiresOpenaiAuth":true}`)
  - thread/start → `thr_<連番>` で応答 + thread/started 通知
  - 環境変数 `FAKE_CAPTURE_FILE` が設定されていれば、**受信した全行をそのまま JSONL で追記**(テスト側が turn/start の instruction 内容や turn/interrupt 送信を検証するために使う)
  - 複数 thread の並行 turn を独立に処理できること(turn ごとに `setTimeout(FAKE_DELAY_MS // 既定 10ms)` で応答)
- happy: turn/start 受信 → turn/started → item/started(imageGeneration, in_progress)→ item/completed(imageGeneration completed。savedPath = スクリプト起動時に os.tmpdir() に書いた実在 1x1 PNG のパス、result = 同 PNG の base64)→ turn/completed(status "completed")
- no-tool: turn/started → item/completed(agentMessage、text「画像生成はできません」)→ turn/completed(status "completed"。imageGeneration アイテム無し)
- slow: turn/start に response だけ返し、その後何も送らない(タイムアウトテスト用)
- crash-once: 環境変数 `FAKE_STATE_FILE` のファイルが**存在しなければ**作成してから thread/start 応答直後に process.exit(1)。**存在すれば** happy と同じ動作(=クラッシュ→自動再起動→成功、を 1 プロセスサイクルで検証できる)
- メッセージの正確な形はプロトコル早見表(§5)に厳密準拠(これがズレるとテストの意味がない)
- 1x1 PNG の base64 定数: `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`
- エンジンのテストでは `codexBin: process.execPath`, `codexArgs: ['test/fake-appserver.mjs']`, `env: { FAKE_SCENARIO: ... }` で差し替える

## 4. タスク分割(計画書のセクション構成)

| # | タスク | 主な成果物 | 依存 |
| --- | --- | --- | --- |
| 0 | ワークスペース足場 | ルート package.json / pnpm-workspace.yaml / tsconfig.base.json / .gitignore / shared パッケージ | - |
| 1 | 実機検証 probe(手動ゲート) | scripts/probe.mjs + 実行手順。**スペック §9-1,2 の検証。失敗したら計画を止めて報告** | 0 |
| 2 | ImageStore | server/src/store.ts + test | 0 |
| 3 | JobQueue | server/src/queue.ts + test | 0 |
| 4 | JsonRpcConnection | server/src/engine/jsonrpc.ts + test | 0 |
| 5 | 偽 app-server | server/test/fake-appserver.mjs(+それ自体の煙テスト) | 4 |
| 6 | AppServerEngine | server/src/engine/{types,appserver}.ts + 統合 test | 4,5 |
| 7 | REST API + SSE | server/src/api.ts + test | 2,3 |
| 8 | MCP サーバー | server/src/mcp.ts + test | 2,3 |
| 9 | 合成ルート | server/src/config.ts + index.ts + 起動煙テスト | 2,3,6,7,8 |
| 10 | Web GUI | web/ 一式 + ビルド統合 | 7(API 形状) |
| 11 | README + 仕上げ | README.md(登録手順・検証済み codex バージョン)+ 実機スモーク手順 | 全部 |

注: タスク2,3,4 は相互独立。計画書には「タスク0→1 を終えたら 2..8 は並列実行可、9 以降は直列」と明記する。

## 5. App Server プロトコル早見表(調査済み・openai/codex ソース準拠)

調査日 2026-06-13、対象 openai/codex @ 216dee11(タグ rust-v0.137.0 以降相当)。
**全執筆エージェントはこの節の JSON 形をそのまま使うこと。**

### 5.1 ワイヤ形式

- 行区切り JSON(JSONL)。**`"jsonrpc":"2.0"` フィールドは送らない・来ない**(codex-rs/app-server-protocol/src/jsonrpc_lite.rs:1-2)
- request: `{"id": <int|string>, "method": "...", "params": {...}}`(params 省略可)
- notification: `{"method": "...", "params": {...}}`
- response: `{"id": ..., "result": <任意のJSON>}`
- error response: `{"id": ..., "error": {"code": <int>, "message": "...", "data"?: ...}}`
- 過負荷時: error code -32001, message "Server overloaded; retry later."
- 起動コマンド: `codex app-server`(デフォルトで stdio)

### 5.2 ハンドシェイク

```json
{"id":0,"method":"initialize","params":{"clientInfo":{"name":"imagegen-server","title":"imagegen-server","version":"0.1.0"}}}
{"id":0,"result":{"userAgent":"...","codexHome":"/Users/x/.codex","platformFamily":"...","platformOs":"..."}}
{"method":"initialized"}
```

3行目はクライアント→サーバーの notification。initialize 前の他リクエストは "Not initialized" エラー。

### 5.3 thread/start(エンジンが送る形)

```json
{"id":1,"method":"thread/start","params":{"cwd":"/Users/x/.imagegen-server/work","approvalPolicy":"never","sandbox":"read-only","ephemeral":true}}
{"id":1,"result":{"thread":{"id":"thr_123","ephemeral":true,"...":"..."},"model":"...","approvalPolicy":"never","sandbox":{"type":"readOnly","networkAccess":false},"...":"..."}}
{"method":"thread/started","params":{"thread":{"id":"thr_123","...":"..."}}}
```

- turnModel 設定時は params に `"model": "<turnModel>"` を追加
- enum はソース準拠で kebab-case: approvalPolicy = `"untrusted" | "on-failure" | "on-request" | "never"`、sandbox = `"read-only" | "workspace-write" | "danger-full-access"`
- **注意(README との食い違い)**: README の例は `"workspaceWrite"` / `"unlessTrusted"` と camelCase だがソースの serde は kebab-case。probe(Task 1)で実機確認し、失敗したらエラー応答がそのまま出るようにしておく
- thread/start を呼んだ接続はその thread の turn/item イベントに自動購読される

### 5.4 turn/start と通知

```json
{"id":2,"method":"turn/start","params":{"threadId":"thr_123","input":[{"type":"text","text":"<instruction>"}]}}
{"id":2,"result":{"turn":{"id":"turn_1","items":[],"status":"inProgress","error":null,"...":"..."}}}
```

input アイテムの variant(タグは camelCase、**フィールドは snake_case**):
- `{"type":"text","text":"..."}`
- `{"type":"localImage","path":"/abs/file.png"}`
- `{"type":"image","url":"data:image/png;base64,..."}`

ターン中の通知(すべて params 直下に threadId がある):
- `{"method":"turn/started","params":{"threadId":"thr_123","turn":{...}}}`
- `{"method":"item/started","params":{"item":{<ThreadItem>},"threadId":"thr_123","turnId":"turn_1","startedAtMs":1234567890123}}`
- `{"method":"item/completed","params":{"item":{<ThreadItem>},"threadId":"thr_123","turnId":"turn_1","completedAtMs":1234567890123}}`
- `{"method":"turn/completed","params":{"threadId":"thr_123","turn":{"id":"turn_1","items":[],"itemsView":"notLoaded","status":"completed","error":null,"...":"..."}}}`

重要:
- **`turn/failed` という通知は存在しない**。失敗は `turn/completed` の `turn.status === "failed"` + `turn.error: {"message":"...","codexErrorInfo"?:...,"additionalDetails"?:...}` で判定する(status は `"completed" | "interrupted" | "failed" | "inProgress"`)
- turn/started・turn/completed の `items` は常に空配列。**アイテムは item/* 通知だけが正**
- `{"method":"error","params":{"error":{"message":"..."}}}` というターン途中エラー通知も来うる(ロギング用に拾う)

### 5.5 imageGeneration アイテム(ThreadItem。フィールドは camelCase)

item/completed に乗る完成形:
```json
{"type":"imageGeneration","id":"call_abc","status":"completed","revisedPrompt":"a watercolor cat","result":"<base64 PNG 文字列>","savedPath":"/Users/x/.codex/generated_images/<session>/<call>.png"}
```
- `savedPath` はディスク書き込み成功時のみ存在(失敗時は **null ではなくフィールドごと省略**)→ optional として扱い、無ければ `result` の base64 をデコードして使う
- item/started 時は `{"type":"imageGeneration","id":"...","status":"in_progress","revisedPrompt":null,"result":""}`(savedPath なし)
- agentMessage アイテム(no-tool 失敗時のテキスト回収に使う): `{"type":"agentMessage","id":"...","text":"..."}` を想定するが、**フィールド名は防御的に扱う**(`typeof item.text === 'string'` でなければ JSON.stringify(item) をエラーメッセージに使う)

### 5.6 認証確認

```json
{"id":3,"method":"getAuthStatus","params":{}}
{"id":3,"result":{"authMethod":"chatgpt","requiresOpenaiAuth":false}}
```
- `getAuthStatus` は experimental ゲートなし(deprecated だが現存)。authMethod は `"apikey" | "chatgpt" | "chatgptAuthTokens" | null` 等
- AuthStatus へのマッピング: `loggedIn = authMethod が "chatgpt" または "chatgptAuthTokens"`。null/undefined → `message: "codex login が必要です"`。`"apikey"` → loggedIn: false, `message: "画像生成には ChatGPT サブスクリプション認証(codex login)が必要です(API キー認証では不可)"`
- 新 API `account/read`(応答 `{"account":{"type":"chatgpt","email":"...","planType":"..."}|null,"requiresOpenaiAuth":bool}`)は probe で動作確認だけする(エンジンは getAuthStatus を使う)

### 5.7 server→client リクエスト(承認要求)への防御

approvalPolicy "never" + read-only でターン中の承認要求は発生しない想定だが、サーバー→クライアントの request(`item/commandExecution/requestApproval` 等)が来たら JsonRpcConnection は一律 `{"id":...,"error":{"code":-32601,"message":"method not found"}}` を返す(安全網)。

### 5.8 エンジンのターン instruction(定数 TURN_INSTRUCTION)

```ts
const TURN_INSTRUCTION = (prompt: string, refPaths?: string[]) => `You have an image generation tool (imagegen).
Call the imagegen tool EXACTLY ONCE with the arguments below, then stop.
- Use the prompt below VERBATIM as the \`prompt\` argument. Do not rephrase, translate, expand, or shorten it.
${refPaths && refPaths.length > 0 ? `- Pass \`referenced_image_paths\` as exactly: ${JSON.stringify(refPaths)}\n` : ''}- Do not run any other tool. Do not write files. Do not explain.

PROMPT (between the markers, exclusive):
<<<PROMPT_START>>>
${prompt}
<<<PROMPT_END>>>`;
```

### 5.9 タイムアウト・後始末

- turn タイムアウト時: `turn/interrupt`(params `{"threadId":"...","turnId":"..."}` — **threadId と turnId の両方が必須**。turnId は turn/start 応答の result.turn.id から保持)を応答無視で送ってから reject。turnId 未取得なら送信せず reject のみ。正常応答は空オブジェクト `{}`
- ephemeral thread は明示削除不要(無活動 30 分でサーバー側がアンロード)

## 6. 依存パッケージとバージョン / MCP SDK 実装パターン(2026-06-13 検証済み)

### 6.1 バージョン表(package.json にはこのレンジで書く)

| パッケージ | バージョン |
| --- | --- |
| typescript | ^6.0.3 |
| @types/node | ^25.9.3 |
| tsx | ^4.22.4 |
| vitest | ^4.1.8 |
| hono | ^4.12.25 |
| @hono/node-server | ^2.0.4 |
| @modelcontextprotocol/sdk | ^1.29.0 |
| zod | ^4.4.3 |
| react / react-dom | ^19.2.7 |
| vite | ^8.0.16 |
| @vitejs/plugin-react | ^6.0.2 |
| @types/react | ^19.2.17 |
| @types/react-dom | ^19.2.3 |

- Node は >= 22.18(engines に明記)。実行は tsx(dev)/ tsc → node(build)
- 注意: vitest 4 と vite 8 の peer 互換が合わない場合は vite を ^7 に下げる(Task 0 に明記)
- **MCP SDK は v1 系を使う**(npm latest = 1.29.0)。GitHub main ブランチは v2 pre-alpha で API が異なるため参照しない

### 6.2 MCP SDK v1 の確定 API(これをそのまま使う)

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';   // テスト用
import { Client } from '@modelcontextprotocol/sdk/client/index.js';          // テスト用
import { z } from 'zod';
```

- `server.registerTool(name, { title, description, inputSchema: { prompt: z.string(), ... } }, async (args) => ({ content: [{ type: 'text', text: '...' }] }))` — inputSchema は **zod raw shape**(z.object() で包まない)
- エラー返却: `{ content: [{ type: 'text', text: 'Error: ...' }], isError: true }`
- stateless HTTP: POST ごとに `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` + 新しい McpServer。`await server.connect(transport); await transport.handleRequest(req, res, parsedBody);`(req/res は node:http の素のオブジェクトで可。body は事前に JSON.parse して渡す)
- テスト: `const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();` → `await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);` → `await client.callTool({ name: 'generate_image', arguments: {...} })`

### 6.3 Hono(Node)

```ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve, getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
```

- index.ts では `serve` は使わず `node:http.createServer` + `getRequestListener(app.fetch)` を使う(/mcp 分岐のため)
- serveStatic の root は **プロセスの cwd 起点の相対パス**である点に注意(絶対パス化の工夫は Task 9 で行う: `relative(process.cwd(), webDistDir)` を root に渡す)
