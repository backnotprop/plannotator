import type { ReviewSession } from '@plannotator/ui/types';

/**
 * PasteStore interface — pluggable storage backend for paste data.
 *
 * Implementations: FsPasteStore (filesystem), KvPasteStore (CF KV), S3PasteStore (S3)
 */
export interface PasteStore {
  put(id: string, data: string, ttlSeconds: number): Promise<void>;
  get(id: string): Promise<string | null>;

  // Review Session methods
  putSession(id: string, session: ReviewSession, ttlSeconds: number): Promise<void>;
  getSession(id: string): Promise<ReviewSession | null>;
  updateSession(id: string, session: ReviewSession, ttlSeconds: number): Promise<boolean>;
}
