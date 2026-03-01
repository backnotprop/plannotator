import type { PasteStore } from "../core/storage";

/**
 * Cloudflare KV-backed paste store.
 * Uses KV's native expirationTtl for automatic cleanup.
 */
export class KvPasteStore implements PasteStore {
  constructor(private kv: KVNamespace) {}

  async put(id: string, data: string, ttlSeconds: number): Promise<void> {
    await this.kv.put(`paste:${id}`, data, { expirationTtl: ttlSeconds });
  }

  async get(id: string): Promise<string | null> {
    return this.kv.get(`paste:${id}`);
  }
}
