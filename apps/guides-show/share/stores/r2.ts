/**
 * Cloudflare R2 GuideStore. Two objects per guide so neither the body nor the
 * metadata is bounded by R2's custom-metadata size limit:
 *
 *   g/<id>       the body (ciphertext or snapshot JSON)
 *   g/<id>.meta  the StoredGuideMeta record as JSON
 *
 * The meta object is written FIRST and deleted LAST, so a reader that finds a
 * body always finds its meta, and a half-deleted guide reads as absent rather
 * than as a body with no way to know its mode. Expired guides are deleted
 * lazily on read.
 */
import { isStoredGuideExpired, type GuideStore, type StoredGuideMeta } from '../core/storage';

/** The slice of `R2Bucket` this store touches; typed structurally so tests can hand in a fake without the Workers types. */
export interface R2GuideBucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(keys: string | string[]): Promise<void>;
}

export class R2GuideStore implements GuideStore {
  constructor(
    private readonly bucket: R2GuideBucket,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private bodyKey(id: string): string {
    return `g/${id}`;
  }

  private metaKey(id: string): string {
    return `g/${id}.meta`;
  }

  async put(id: string, body: string, meta: StoredGuideMeta): Promise<void> {
    await this.bucket.put(this.metaKey(id), JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } });
    await this.bucket.put(this.bodyKey(id), body, {
      httpMetadata: { contentType: meta.mode === 'plain' ? 'application/json' : 'text/plain' },
    });
  }

  async get(id: string): Promise<{ body: string; meta: StoredGuideMeta } | null> {
    const metaObject = await this.bucket.get(this.metaKey(id));
    if (!metaObject) return null;
    let meta: StoredGuideMeta;
    try {
      meta = JSON.parse(await metaObject.text()) as StoredGuideMeta;
    } catch {
      return null;
    }
    if (isStoredGuideExpired(meta, this.now())) {
      await this.delete(id);
      return null;
    }
    const bodyObject = await this.bucket.get(this.bodyKey(id));
    if (!bodyObject) return null;
    return { body: await bodyObject.text(), meta };
  }

  async delete(id: string): Promise<void> {
    await this.bucket.delete([this.bodyKey(id), this.metaKey(id)]);
  }
}
