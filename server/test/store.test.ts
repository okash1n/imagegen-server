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
