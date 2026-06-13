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
    // Real codex (0.139.0) delivers the terminal imageGeneration item via the
    // item/completed notification with status "generating" (not "completed").
    // The item/completed method itself is the completion signal, so we log the
    // status but do not fail on it; result/savedPath presence is the real gate.
    report(
      `注記: imageGeneration item/completed の status=${JSON.stringify(imageItem.status)}(item/completed が完了シグナルなので result/savedPath の有無で判定する)`,
    );
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
