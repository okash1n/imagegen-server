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
