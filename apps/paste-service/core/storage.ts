/**
 * PasteStore interface — pluggable storage backend for paste data.
 *
 * Implementations: FsPasteStore (filesystem), KvPasteStore (CF KV)
 */
export interface PasteStore {
  put(id: string, data: string, ttlSeconds: number): Promise<void>;
  get(id: string): Promise<string | null>;
}
