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
