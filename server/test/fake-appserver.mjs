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
        // Real codex (0.139.0) emits the terminal imageGeneration item via
        // item/completed with status "generating" (not "completed"); match it
        // so the engine is tested against real behavior.
        status: 'generating',
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
