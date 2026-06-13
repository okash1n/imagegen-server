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
