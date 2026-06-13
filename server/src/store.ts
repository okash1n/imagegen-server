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
