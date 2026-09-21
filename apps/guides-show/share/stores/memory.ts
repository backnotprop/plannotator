/**
 * In-memory GuideStore for tests and throwaway local runs. Expiry is checked
 * lazily on read, exactly like the durable stores.
 */
import { isStoredGuideExpired, type GuideStore, type StoredGuideMeta } from '../core/storage';

export class MemoryGuideStore implements GuideStore {
  private readonly entries = new Map<string, { body: string; meta: StoredGuideMeta }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async put(id: string, body: string, meta: StoredGuideMeta): Promise<void> {
    this.entries.set(id, { body, meta });
  }

  async get(id: string): Promise<{ body: string; meta: StoredGuideMeta } | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (isStoredGuideExpired(entry.meta, this.now())) {
      this.entries.delete(id);
      return null;
    }
    return entry;
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  /** Test helper: what is currently held, expired or not. */
  get size(): number {
    return this.entries.size;
  }
}
