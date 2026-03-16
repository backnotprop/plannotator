import type { PasteStore } from "../core/storage";
import type { ReviewSession } from "@plannotator/ui/types";

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

  // Review Session methods

  async putSession(id: string, session: ReviewSession, ttlSeconds: number): Promise<void> {
    await this.kv.put(`session:${id}`, JSON.stringify(session), {
      expirationTtl: ttlSeconds,
    });
  }

  async getSession(id: string): Promise<ReviewSession | null> {
    const data = await this.kv.get(`session:${id}`);
    return data ? JSON.parse(data) : null;
  }

  async updateSession(id: string, session: ReviewSession, ttlSeconds: number): Promise<boolean> {
    try {
      // KV doesn't support atomic compare-and-swap, so we use get-then-put
      // (risk of race condition in high-concurrency scenarios, but acceptable for this use case)
      const existing = await this.getSession(id);

      if (!existing) {
        return false; // Session not found
      }

      // Optimistic locking check
      if (existing.version !== session.version - 1) {
        return false; // Version mismatch
      }

      await this.putSession(id, session, ttlSeconds);
      return true;
    } catch {
      return false;
    }
  }
}
